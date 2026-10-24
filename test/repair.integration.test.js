import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { Store } from '../src/store.js';
import { KeyVault } from '../src/keys.js';
import { QueueEngine } from '../src/engine.js';
import { ReviewEngine } from '../src/quality.js';
import { QUALITY_VERSION, QUALITY_KINDS } from '../src/content-review.js';
import { createApp } from '../src/server.js';
import { planStudio, studioPrompt } from '../src/story.js';
import { ffmpeg, prepareSegments, normalizeResult, assemble, probe, previewFrame, detectSourceMotion } from '../src/media.js';

test('HTTP segment repair bills only one WAN task, preserves parent and reused bytes, then compares all joins', { timeout: 180000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yingti-repair-e2e-')), store = new Store(directory), vault = new KeyVault(directory); await vault.set('test-repair-only');
  const parentId = randomUUID(), root = path.join(directory, 'jobs', parentId); await mkdir(root, { recursive: true });
  let app; const server = createServer((req, res) => app(req, res)); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  const uploads = new Map(); let creates = 0, analyses = 0, submitted;
  const provider = {
    upload: async file => { const url = 'oss://fixture/' + randomUUID(); uploads.set(url, file); return url; },
    create: async body => { creates++; submitted = body; return 'new-segment-task'; }, status: async () => ({ status: 'completed' }),
    download: async (_id, output) => copyFile(uploads.get(submitted.metadata.input.media[0].url), output),
    analyzeVideo: async (url, prompt) => {
      analyses++; const info = await probe(uploads.get(url)); assert.equal(info.width, 720); assert.equal(info.height, 640); assert.equal(info.hasAudio, true);
      assert.match(prompt, /左半为原片/);
      return { complete: true, usage: { total_tokens: 10 }, text: JSON.stringify({
        speech: { audioAvailable: true, heardText: '', confidence: 'high', coverage: 'silent', observations: [] },
        subtitles: { visible: false, confidence: 'high', coverage: 'complete', absenceEvidence: '逐时刻检查只有测试图案，没有字幕或促销文字', observations: [] },
        products: { visible: false, confidence: 'high', coverage: 'complete', absenceEvidence: '逐时刻检查只有测试图案，没有商品、包装或袋内商品', observations: [] },
        material: { visible: false, confidence: 'high', coverage: 'complete', absenceEvidence: '左右整个区间只有合成测试图案，没有皮肤、手指接触、膏体或涂后残留', actionCoverage: [], observations: [] },
        checks: QUALITY_KINDS.map(kind => ({ kind, status: ['material', 'products'].includes(kind) ? 'not_applicable' : 'pass', time: null, detail: '合成测试素材，独立观察未发现异常' })),
      }) };
    },
  };
  const engine = new QueueEngine({ fundingGate: { ensure: async () => ({ state: 'approved' }) }, store, vault, directory, providerFactory: () => provider, pollInterval: 1 });
  const review = new ReviewEngine({ store, vault, directory, providerFactory: () => provider });
  app = createApp({ store, vault, engine, review, directory, port, toolsStatus: { ffmpeg: true, ffprobe: true } });
  const csrf = (await (await fetch(origin + '/api/bootstrap')).json()).csrf;
  const post = async (route, body) => { const response = await fetch(origin + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
  try {
    await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=240x136:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '18', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', path.join(root, 'source.mp4')]);
    const source = await probe(path.join(root, 'source.mp4'));
    const recipe = { source, story: { assets: [], shots: [{ id: 'SH1', start: 0, end: 9, characterIds: [], propIds: [], sceneId: null }, { id: 'SH2', start: 9, end: 18, characterIds: [], propIds: [], sceneId: null }], dialogues: [], actions: [], warnings: [] }, edits: { model: 'wan3.0-480p', assets: {}, dialogues: [], fullDialogue: { enabled: false, text: '', speakerId: 'auto' } } };
    const plan = planStudio(recipe);
    const parent = { id: parentId, created: new Date().toISOString(), keyHash: vault.hash(), projectId: randomUUID(), workflow: 'studio', title: '局部重做测试', model: 'wan3.0-480p', source, sourceFile: 'source.mp4', output: { width: 240, height: 136 }, audioMode: 'original', recipe, continuityVersion: 1, state: 'completed', events: [], segments: plan.segments };
    for (const segment of parent.segments) segment.prompt = studioPrompt(parent, segment);
    await prepareSegments(root, parent, async () => {});
    for (const part of parent.segments) { await copyFile(path.join(root, `segments/input-${part.index}.mp4`), path.join(root, `segments/generated-${part.index}.mp4`)); await normalizeResult(root, parent, part); part.state = 'completed'; part.taskId = 'old-' + part.index; }
    parent.prepared = true; parent.result = await assemble(root, parent); await previewFrame(path.join(root, 'source.mp4'), 0, path.join(root, 'reference.png')); store.create(parent);
    const motion = await detectSourceMotion(path.join(root, 'source.mp4')); assert.ok(Array.isArray(motion.cuts) && Array.isArray(motion.quietPoints));
    const parentBody = JSON.stringify(store.get(parentId)), parentHash = await hash(path.join(root, 'result.mp4')), reuseHash = await hash(path.join(root, 'segments/output-1.mp4'));
    const id = randomUUID(), route = `/api/jobs/${parentId}/segments/0/regenerate`;
    assert.equal((await post(route, { requestId: id, confirmNewCharge: false })).status, 400);
    const response = await post(route, { requestId: id, confirmNewCharge: true, notes: '保持原片接头构图' }); assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal((await post(route, { requestId: id, confirmNewCharge: true })).body.id, id);
    for (let i = 0; i < 900 && store.get(id).state !== 'completed' && store.get(id).state !== 'needs_attention'; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(store.get(id).state, 'completed', store.get(id).error); assert.equal(creates, 1); assert.match(submitted.prompt, /保持原片接头构图/);
    assert.equal(JSON.stringify(store.get(parentId)), parentBody); assert.equal(await hash(path.join(root, 'result.mp4')), parentHash);
    assert.equal(await hash(path.join(directory, 'jobs', id, 'segments/output-1.mp4')), reuseHash);
    assert.equal(store.get(id).result.frames, 540); assert.equal(store.get(id).billableSeconds, plan.segments[0].requestDuration);
    await review.pump(); assert.equal(analyses, 2); assert.equal(store.get(id).quality.version, QUALITY_VERSION); assert.equal(store.get(id).quality.verdict, 'no_issues_detected');
    const video = await fetch(origin + `/api/jobs/${id}/quality/1/video`); assert.equal(video.status, 200); assert.equal(video.headers.get('content-type'), 'video/mp4'); await video.arrayBuffer();
    assert.equal(creates, 1); assert.equal(JSON.stringify(store.get(parentId)), parentBody);
  } finally { engine.stop(); review.stop(); while (engine.active || review.active) await new Promise(r => setTimeout(r, 5)); await new Promise(resolve => server.close(resolve)); store.close(); await rm(directory, { recursive: true, force: true }); }
});
