import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, access, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/store.js';
import { KeyVault } from '../src/keys.js';
import { QueueEngine } from '../src/engine.js';
import { createApp } from '../src/server.js';
import { ffmpeg, probe, prepareSegments } from '../src/media.js';
import { QUALITY_VERSION } from '../src/content-review.js';
import { planStudio } from '../src/story.js';
import { regenerateSegment } from '../src/regenerate.js';
import { fullDialogueScriptHash } from '../src/full-dialogue.js';

function wav(duration, frequency = 900) {
  const rate = 48000, samples = Math.round(duration * rate), bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) bytes.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * frequency / rate) * 7000), 44 + index * 2);
  return bytes;
}

async function apiFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yingti-content-api-')), store = new Store(directory), vault = new KeyVault(directory);
  await vault.set('test-content-only');
  const id = randomUUID(), folder = path.join(directory, 'projects', id); await mkdir(folder, { recursive: true });
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=240x426:r=30', '-t', '3', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(folder, 'source.mp4')]);
  const source = await probe(path.join(folder, 'source.mp4'));
  store.createProject({ id, keyHash: vault.hash(), source, sourceFile: 'source.mp4', sourceName: '测试原片.mp4', created: new Date().toISOString(), title: '内容回归', revision: 0, state: 'ready', analysis: { windows: [] }, story: { assets: [], shots: [{ id: 'SH001', start: 0, end: 3, characterIds: [], propIds: [], sceneId: null }], dialogues: [], actions: [], warnings: [] }, edits: { model: 'wan3.0-480p', assets: {}, dialogues: [] } });
  let pumps = 0; const engine = { active: null, pump: () => { pumps++; } }, analysis = { active: null, pump: () => {} };
  let app; const server = createServer((request, response) => app(request, response)); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  app = createApp({ store, vault, directory, engine, analysis, port, toolsStatus: { ffmpeg: true, ffprobe: true } });
  const csrf = (await (await fetch(origin + '/api/bootstrap')).json()).csrf;
  const send = async (route, body, method = 'POST') => {
    const response = await fetch(origin + route, { method, headers: { 'X-CSRF-Token': csrf, ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }, body: body instanceof FormData ? body : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const upload = async duration => { const form = new FormData(); form.append('file', new Blob([wav(duration)], { type: 'audio/wav' }), '整篇口播.wav'); return send(`/api/projects/${id}/narration`, form); };
  return { directory, folder, id, store, vault, origin, send, upload, pumps: () => pumps, close: async () => { await new Promise(resolve => server.close(resolve)); store.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('recorded narration upload is server-owned, frozen with the script, copied into a new job and idempotent', { timeout: 90000 }, async () => {
  const s = await apiFixture();
  try {
    const script = '维希缇，只要99！';
    const edits = { model: 'wan3.0-480p', assets: {}, dialogues: [], narration: { file: '../../forged.wav', duration: 0.1 }, fullDialogue: { enabled: true, delivery: 'uploaded', speakerId: 'narrator', text: script, criticalTerms: '维希缇,99', subtitles: 'replace' } };
    const initial = await s.send(`/api/projects/${s.id}/edits`, { revision: 0, edits }, 'PUT'); assert.equal(initial.status, 200, JSON.stringify(initial.body));
    const uploaded = await s.upload(2.5); assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body)); assert.equal(uploaded.body.revision, 2);
    const recording = uploaded.body.edits.narration; assert.equal(recording.duration, 2.5); assert.ok(recording.file.endsWith('audio.wav'));
    assert.equal(recording.scriptHash, fullDialogueScriptHash(s.store.project(s.id)));
    const saved = await s.send(`/api/projects/${s.id}/edits`, { revision: uploaded.body.revision, edits }, 'PUT'); assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.equal(saved.body.edits.narration.file, recording.file);
    const id = randomUUID(), generated = await s.send(`/api/projects/${s.id}/generate`, { requestId: id, revision: saved.body.revision });
    assert.equal(generated.status, 201, JSON.stringify(generated.body)); assert.equal(generated.body.audioMode, 'narration'); assert.equal(generated.body.quality.version, QUALITY_VERSION);
    assert.equal(generated.body.recipe.dialoguePlan.spokenText, script); assert.equal(generated.body.recipe.edits.narration.file, recording.file);
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    assert.equal(hash(await readFile(path.join(s.directory, 'jobs', id, recording.file))), hash(await readFile(path.join(s.folder, recording.file))));
    const duplicate = await s.send(`/api/projects/${s.id}/generate`, { requestId: id, revision: 999 }); assert.equal(duplicate.status, 200); assert.equal(duplicate.body.id, id); assert.equal(s.pumps(), 1);
    const changed = await s.send(`/api/projects/${s.id}/edits`, { revision: saved.body.revision, edits: { ...edits, fullDialogue: { ...edits.fullDialogue, text: '只要129。' } } }, 'PUT'); assert.equal(changed.status, 200);
    assert.equal(s.store.get(id).recipe.dialoguePlan.spokenText, script);
    const stale = await s.send(`/api/projects/${s.id}/generate`, { requestId: randomUUID(), revision: saved.body.revision }); assert.equal(stale.status, 409); assert.equal(s.store.list().length, 1);
    const oldRecording = await s.send(`/api/projects/${s.id}/generate`, { requestId: randomUUID(), revision: changed.body.revision }); assert.equal(oldRecording.status, 422); assert.match(oldRecording.body.error, /全文已修改|录音尚未关联/); assert.equal(s.store.list().length, 1);
  } finally { await s.close(); }
});

test('overlong narration import is rejected without truncating or replacing the previously recorded track', { timeout: 90000 }, async () => {
  const s = await apiFixture();
  try {
    assert.equal((await s.upload(2.5)).status, 422, 'recording must be linked to a saved full script');
    const ready = await s.send(`/api/projects/${s.id}/edits`, { revision: 0, edits: { model: 'wan3.0-480p', assets: {}, dialogues: [], fullDialogue: { enabled: true, delivery: 'uploaded', speakerId: 'narrator', text: '维希缇，只要99！' } } }, 'PUT'); assert.equal(ready.status, 200);
    const first = await s.upload(2.5); assert.equal(first.status, 200);
    const recording = first.body.edits.narration, bytes = await readFile(path.join(s.folder, recording.file));
    const long = await s.upload(3.2); assert.equal(long.status, 422); assert.match(long.body.error, /不会自动截断/);
    const current = s.store.project(s.id); assert.equal(current.revision, first.body.revision); assert.equal(current.edits.narration.file, recording.file);
    assert.deepEqual(await readFile(path.join(s.folder, recording.file)), bytes); assert.equal(s.store.list().length, 0); assert.equal(s.pumps(), 0);
  } finally { await s.close(); }
});

test('actual overlong synthesized speech is saved intact and blocks every WAN submission on resume', { timeout: 90000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yingti-content-engine-')), store = new Store(directory), vault = new KeyVault(directory); await vault.set('test-content-only');
  const id = randomUUID(), jobDirectory = path.join(directory, 'jobs', id); await mkdir(jobDirectory, { recursive: true });
  let speechCalls = 0, wanCalls = 0, prepared = 0;
  const provider = { listVoices: async () => [{ id: 'voice_ready', status: 'ready' }], synthesizeSpeech: async (_request, file) => { speechCalls++; const bytes = wav(3.2); await writeFile(file, bytes); return { bytes: bytes.length, contentType: 'audio/wav' }; }, create: async () => { wanCalls++; return 'should-not-submit'; } };
  const engine = new QueueEngine({ fundingGate: { ensure: async () => ({ state: 'approved' }) }, store, vault, directory, providerFactory: () => provider, mediaTools: { prepareSegments: async () => { prepared++; } } });
  try {
    store.create({ id, keyHash: vault.hash(), created: new Date().toISOString(), state: 'queued', pauseRequested: false, audioMode: 'narration', events: [], segments: [{ index: 0, frames: 90, duration: 3, state: 'pending', taskId: null }], recipe: { story: { assets: [] }, edits: { fullDialogue: { enabled: true, delivery: 'voiceover', speakerId: 'narrator', voiceId: 'voice_ready', text: '维希缇，只要99！', speed: 1 } } } });
    await engine.pump(); const job = store.get(id);
    assert.equal(job.state, 'needs_attention'); assert.equal(job.narration.state, 'too_long'); assert.equal(job.narration.duration, 3.2); assert.equal(speechCalls, 1); assert.equal(wanCalls, 0); assert.equal(prepared, 0);
    const saved = await readFile(path.join(jobDirectory, job.narration.sourceFile)); assert.equal(saved.length, wav(3.2).length);
    engine.resume(id); while (engine.active) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(store.get(id).state, 'needs_attention'); assert.equal(speechCalls, 1); assert.equal(wanCalls, 0); assert.equal(prepared, 0);
    assert.deepEqual(await readFile(path.join(jobDirectory, job.narration.sourceFile)), saved);
  } finally { engine.stop(); while (engine.active) await new Promise(resolve => setTimeout(resolve, 5)); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a repaired uploaded-narration job copies its complete recording and rebuilds a legacy audible reference silently', { timeout: 90000 }, async () => {
  const s = await apiFixture();
  try {
    const project = s.store.project(s.id), script = '维希缇，只要99！';
    const recipe = { source: project.source, story: project.story, edits: { model: 'wan3.0-480p', assets: {}, dialogues: [], narration: { file: 'recorded.wav', duration: 2.5 }, fullDialogue: { enabled: true, delivery: 'uploaded', speakerId: 'narrator', text: script, subtitles: 'replace' } } };
    recipe.edits.narration.scriptHash = fullDialogueScriptHash(recipe);
    const plan = planStudio(recipe); recipe.dialoguePlan = plan.dialoguePlan;
    const parentId = randomUUID(), folder = path.join(s.directory, 'jobs', parentId); await mkdir(path.join(folder, 'segments'), { recursive: true });
    await copyFile(path.join(s.folder, 'source.mp4'), path.join(folder, 'source.mp4')); await copyFile(path.join(folder, 'source.mp4'), path.join(folder, 'canonical.mp4'));
    await ffmpeg(['-i', path.join(folder, 'source.mp4'), '-frames:v', '1', '-update', '1', path.join(folder, 'reference.png')]);
    await ffmpeg(['-i', path.join(folder, 'source.mp4'), '-f', 'lavfi', '-i', 'sine=frequency=500:sample_rate=48000', '-t', '3', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', path.join(folder, 'segments', 'input-0.mp4')]);
    await writeFile(path.join(folder, 'recorded.wav'), wav(2.5));
    const parent = { id: parentId, keyHash: s.vault.hash(), created: new Date().toISOString(), title: '配音局部修复', workflow: 'studio', state: 'completed', sourceFile: 'source.mp4', source: project.source, output: { width: 240, height: 426 }, audioMode: 'narration', continuityVersion: 2, recipe, narration: { file: 'recorded.wav', sourceFile: 'recorded.wav', duration: 2.5 }, segments: plan.segments.map(segment => ({ ...segment, state: 'completed', taskId: 'old-' + segment.index })) };
    s.store.create(parent); const childId = randomUUID();
    const child = await regenerateSegment({ store: s.store, vault: s.vault, directory: s.directory, engine: { pump: () => {} }, parent, index: 0, id: childId, notes: '保持完整新口播与薄层涂抹' });
    const root = path.join(s.directory, 'jobs', childId);
    assert.equal(child.quality.version, QUALITY_VERSION); assert.equal(child.prepared, false);
    assert.deepEqual(await readFile(path.join(root, 'recorded.wav')), await readFile(path.join(folder, 'recorded.wav')));
    await assert.rejects(access(path.join(root, 'segments', 'input-0.mp4')));
    assert.equal((await probe(path.join(folder, 'segments', 'input-0.mp4'))).hasAudio, true);
    await prepareSegments(root, child, async () => {}); assert.equal((await probe(path.join(root, 'segments', 'input-0.mp4'))).hasAudio, false);
    assert.equal(s.store.get(parentId).state, 'completed'); assert.equal(s.store.get(parentId).recipe.dialoguePlan.spokenText, script);
  } finally { await s.close(); }
});
