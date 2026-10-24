import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, copyFile, rm, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { KeyVault } from '../src/keys.js';
import { QueueEngine } from '../src/engine.js';
import { createReconstruction, reconstructionRange, reconstructionSegments, reconstructionPrompt, reconstructionStages, reconstructionStagePrompt } from '../src/reconstruction.js';
import { requestBody } from '../src/plan.js';
import * as media from '../src/media.js';

test('keyframe requests exclude all reference modes while existing edits retain prompt expansion', () => {
  const segment = { generationMode: 'keyframe_rebuild', requestDuration: 5, prompt: 'continuous smear' };
  const pair = [{ type: 'first_frame', url: 'oss://first' }, { type: 'last_frame', url: 'oss://last' }];
  const job = { model: 'wan3.0-720p', workflow: 'studio' };
  assert.equal(requestBody(job, segment, pair).prompt_extend, false);
  for (const bad of [pair.slice(0, 1), [...pair, { type: 'reference_image' }], [{ type: 'reference_video' }, ...pair], [...pair].reverse()]) assert.throws(() => requestBody(job, segment, bad), /只能提交首帧和尾帧/);
  assert.equal(requestBody(job, { ...segment, generationMode: undefined }, [{ type: 'reference_video' }]).prompt_extend, true);
});

test('reconstruction ranges use an exact source frame partition and an integer-only request duration', () => {
  const range = reconstructionRange(180, 2, 131 / 30);
  assert.equal(range.frames, 71); assert.equal(range.requestDuration, 3);
  const segments = reconstructionSegments(180, range, [], 'prompt');
  assert.deepEqual(segments.map(segment => [segment.startFrame, segment.frames, segment.generationMode]), [[0, 60, 'base_copy'], [60, 71, 'keyframe_rebuild'], [131, 49, 'base_copy']]);
  assert.equal(segments.reduce((total, segment) => total + segment.frames, 0), 180);
  for (const bounds of [[-1, 3], [0, 1.9], [3, 7], [NaN, 4], [0, 16]]) assert.throws(() => reconstructionRange(180, ...bounds));
  const prompt = reconstructionPrompt({ characterId: 'C001', requestDuration: 5 }, '目标人物', '0–2秒脸颊，2–4秒额头，最后收手');
  assert.match(prompt, /单一连续镜头/); assert.match(prompt, /不能换脸换装/); assert.match(prompt, /持续真实接触/);
  assert.doesNotMatch(prompt, /编辑视频1/);
});

async function fixture({ hasAudio = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yingti-rebuild-'));
  const store = new Store(directory), vault = new KeyVault(directory); await vault.set('test-keyframe-only');
  const parentId = randomUUID(), parentRoot = path.join(directory, 'jobs', parentId); await mkdir(parentRoot, { recursive: true });
  const base = path.join(parentRoot, 'result.mp4');
  const input = ['-f', 'lavfi', '-i', 'testsrc2=size=96x160:rate=30:duration=6'];
  if (hasAudio) input.push('-f', 'lavfi', '-i', 'sine=frequency=737:sample_rate=48000:duration=6', '-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac');
  else input.push('-an');
  await media.ffmpeg([...input, '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-t', '6', base]);
  const first = path.join(directory, 'first.png'), last = path.join(directory, 'last.png');
  await media.ffmpeg(['-f', 'lavfi', '-i', 'color=red:size=96x160', '-frames:v', '1', '-update', '1', first]);
  await media.ffmpeg(['-f', 'lavfi', '-i', 'color=blue:size=96x160', '-frames:v', '1', '-update', '1', last]);
  const parent = { id: parentId, created: new Date().toISOString(), updated: new Date().toISOString(), title: '已编辑成片',
    state: 'completed', workflow: 'studio', projectId: randomUUID(), model: 'wan3.0-720p', keyHash: vault.hash(), sourceName: 'old.mp4',
    recipe: { sourceCuts: [3, 5], story: { assets: [{ id: 'C001', type: 'character', name: '目标人物' }, { id: 'P001', type: 'prop', name: '面霜膏体' }],
      shots: [{ id: 'SH1', start: 0, end: 6, characterIds: ['C001'], propIds: ['P001'], sceneId: null }], dialogues: [], actions: [] },
    edits: { assets: {}, dialogues: [], continuity: { actions: {} } } }, source: await media.probe(base), segments: [], events: [] };
  store.create(parent);
  let pumps = 0;
  const args = { store, vault, directory, engine: { pump() { pumps++; } }, parent, id: randomUUID(), start: 2, end: 131 / 30,
    characterId: 'C001', materialAssetId: 'P001', first: { file: first, width: 96, height: 160 }, last: { file: last, width: 96, height: 160 }, notes: '真实连续推开' };
  return { ...args, args, parentRoot, base, pumps: () => pumps, close: async () => { store.close(); await rm(directory, { recursive: true, force: true }); } };
}

const frameHashes = async (file, filter) => {
  const output = await media.ffmpeg(['-i', file, '-map', '0:v:0', '-an', ...(filter ? ['-vf', filter] : []), '-f', 'framemd5', '-']);
  return output.split(/\r?\n/u).filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1).trim());
};

test('derived job freezes base and anchors, preserves parent, deduplicates concurrent creation and reuses outside frames losslessly', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const original = JSON.stringify(f.store.get(f.parent.id));
    const input = { ...f.args, analysisModel: 'Omni-Analysis' };
    const [job, same] = await Promise.all([createReconstruction(input), createReconstruction(input)]);
    assert.equal(same.id, job.id); assert.equal(f.pumps(), 1);
    assert.equal(f.store.list().length, 2); assert.equal(JSON.stringify(f.store.get(f.parent.id)), original);
    assert.equal(job.audioMode, 'original'); assert.equal(job.billableSeconds, 3);
    assert.equal(job.analysisModel, 'Omni-Analysis'); assert.equal(job.quality.model, 'Omni-Analysis');
    assert.equal(f.store.get(job.id).quality.model, 'Omni-Analysis', 'Review model is frozen before the engine is allowed to run');
    assert.equal(job.recipe.actionRebuild.frames, 71); assert.deepEqual(job.recipe.sourceCuts, [5]);
    assert.equal(job.recipe.story.actions[0].evidenceKind, 'user_reconstruction_goal');
    assert.equal(job.recipe.edits.continuity.actions[job.recipe.story.actions[0].id], 'spread_finish');
    assert.deepEqual(job.segments[1].bindings.map(binding => binding.type), ['first_frame', 'last_frame']);
    const root = path.join(f.directory, 'jobs', job.id);
    assert.equal(await media.fileSHA256(path.join(root, 'base.mp4')), await media.fileSHA256(f.base));
    assert.equal(job.frozenFiles.find(file => file.file === 'anchors/first.png').sha256, await media.fileSHA256(f.first.file));
    const baseHashes = await frameHashes(f.base);
    assert.deepEqual(await frameHashes(path.join(root, 'segments/output-0.mp4')), baseHashes.slice(0, 60));
    assert.deepEqual(await frameHashes(path.join(root, 'segments/output-2.mp4')), baseHashes.slice(131));
    await assert.rejects(() => createReconstruction({ ...f.args, start: 1 }), /已用于其他重建范围/);
  } finally { await f.close(); }
});

test('integer-duration reconstruction retains both endpoint frames, full timeline, outside pixels and exact base audio packets', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const job = await createReconstruction(f.args), root = path.join(f.directory, 'jobs', job.id), segment = job.segments[1];
    const generated = path.join(root, 'segments/generated-1.mp4');
    await media.ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=96x160:rate=30:duration=3', '-an', '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv420p', generated]);
    const rawHashes = await frameHashes(generated);
    const normalized = await media.normalizeResult(root, job, segment);
    const rebuiltHashes = await frameHashes(path.join(root, 'segments/output-1.mp4'));
    assert.equal(rebuiltHashes.length, 71); assert.equal(rebuiltHashes[0], rawHashes[0]); assert.equal(rebuiltHashes.at(-1), rawHashes.at(-1));
    assert.equal(normalized.timeMapping.generatedFrames, 90); assert.equal(normalized.timeMapping.targetFrames, 71);
    for (const part of job.segments) part.state = 'completed';
    const result = await media.assemble(root, job);
    assert.equal(result.frames, 180); assert.equal(result.hasAudio, true);
    const baseHashes = await frameHashes(f.base), finalHashes = await frameHashes(path.join(root, 'result.mp4'));
    assert.deepEqual(finalHashes.slice(0, 60), baseHashes.slice(0, 60)); assert.deepEqual(finalHashes.slice(131), baseHashes.slice(131));
    const audioHash = async file => (await media.ffmpeg(['-i', file, '-map', '0:a:0', '-c:a', 'copy', '-f', 'md5', '-'])).trim();
    assert.equal(await audioHash(path.join(root, 'result.mp4')), await audioHash(f.base));
  } finally { await f.close(); }
});

test('keyframe queue submits only the two anchors and an unknown create cannot be resumed into another request', { timeout: 60000 }, async () => {
  const f = await fixture({ hasAudio: false });
  let engine;
  try {
    const job = await createReconstruction(f.args), calls = [];
    const provider = { upload: async file => { calls.push(['upload', file]); return 'oss://' + path.basename(file); },
      create: async body => { calls.push(['create', body]); throw new Error('unknown reply'); } };
    engine = new QueueEngine({ fundingGate: { ensure: async () => ({ state: 'approved' }) }, store: f.store, vault: f.vault, directory: f.directory, providerFactory: () => provider, mediaTools: media });
    await engine.pump();
    assert.deepEqual(calls.filter(call => call[0] === 'upload').map(call => path.basename(call[1])), ['first.png', 'last.png']);
    const body = calls.find(call => call[0] === 'create')[1];
    assert.equal(body.prompt_extend, false); assert.deepEqual(body.metadata.input.media.map(item => item.type), ['first_frame', 'last_frame']);
    assert.equal(f.store.get(job.id).segments[1].state, 'unknown');
    assert.throws(() => engine.resume(job.id), /结果未知/);
    await engine.pump(); assert.equal(calls.filter(call => call[0] === 'create').length, 1);
    assert.equal(f.store.get(job.id).segments[0].state, 'completed');
  } finally { engine?.stop(); await f.close(); }
});

test('successful keyframe recovery uses the saved remote ID and discards generated audio for a silent base', { timeout: 60000 }, async () => {
  const f = await fixture({ hasAudio: false }); let engine;
  try {
    const job = await createReconstruction(f.args), generated = path.join(f.directory, 'returned.mp4');
    await media.ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=96x160:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=999:sample_rate=48000:duration=3',
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '3', generated]);
    f.store.update(job.id, current => { current.state = 'queued'; current.prepared = true; Object.assign(current.segments[1], { state: 'submitted', taskId: 'existing-rebuild-task', attempts: 1 }); });
    const calls = [];
    const provider = { upload: async () => { throw new Error('A known remote ID must not upload again'); },
      create: async () => { throw new Error('A known remote ID must not create again'); },
      status: async id => { calls.push(['status', id]); return { status: 'completed' }; },
      download: async (id, file) => { calls.push(['download', id]); await copyFile(generated, file); } };
    engine = new QueueEngine({ fundingGate: { ensure: async () => ({ state: 'approved' }) }, store: f.store, vault: f.vault, directory: f.directory, providerFactory: () => provider, mediaTools: media });
    await engine.pump();
    const completed = f.store.get(job.id);
    assert.equal(completed.state, 'completed'); assert.equal(completed.result.frames, 180); assert.equal(completed.result.hasAudio, false);
    assert.equal(completed.segments[1].timeMapping.generatedFrames, 90);
    assert.deepEqual(calls, [['status', 'existing-rebuild-task'], ['download', 'existing-rebuild-task']]);
    await engine.pump(); assert.equal(calls.length, 2);
    assert.equal(f.store.get(f.parent.id).state, 'completed');
  } finally { engine?.stop(); await f.close(); }
});

test('a changed frozen anchor is rejected before any upload or paid create', { timeout: 60000 }, async () => {
  const f = await fixture({ hasAudio: false }); let engine;
  try {
    const job = await createReconstruction(f.args), root = path.join(f.directory, 'jobs', job.id);
    await writeFile(path.join(root, 'anchors/last.png'), 'tampered');
    let calls = 0;
    const provider = { upload: async () => { calls++; }, create: async () => { calls++; } };
    engine = new QueueEngine({ fundingGate: { ensure: async () => ({ state: 'approved' }) }, store: f.store, vault: f.vault, directory: f.directory, providerFactory: () => provider, mediaTools: media });
    await engine.pump();
    assert.equal(calls, 0); assert.equal(f.store.get(job.id).state, 'needs_attention');
    assert.match(f.store.get(job.id).error, /冻结首尾帧校验失败/);
  } finally { engine?.stop(); await f.close(); }
});

test('three contact stages partition five seconds into fifty frames each and bill six integer seconds', () => {
  const anchors = { first: { file: 'first.png' }, intermediates: [{ file: 'cheek.png' }, { file: 'forehead.png' }], last: { file: 'last.png' } };
  const stages = reconstructionStages(reconstructionRange(960, 13, 18), anchors);
  assert.deepEqual(stages.map(stage => [stage.region, stage.startFrame, stage.frames, stage.requestDuration]),
    [['cheek', 390, 50, 2], ['forehead', 440, 50, 2], ['chin', 490, 50, 2]]);
  assert.equal(stages.reduce((sum, stage) => sum + stage.requestDuration, 0), 6);
  const remainder = reconstructionStages(reconstructionRange(960, 13, 542 / 30), anchors);
  assert.deepEqual(remainder.map(stage => stage.frames), [51, 51, 50]);
  assert.throws(() => reconstructionStages(reconstructionRange(180, 0, 4), anchors), /4.5/);
  const cheek = reconstructionStagePrompt({ characterId: 'C001' }, stages[0], '同一人物');
  assert.match(cheek, /额头和下巴本阶段尚未触及/); assert.match(cheek, /手指仍贴着脸颊/);
  assert.match(cheek, /不要先收手再让膏体消失/); assert.match(cheek, /淡出、溶解、变形过渡/);
  assert.match(reconstructionStagePrompt({ characterId: 'C001' }, stages[2]), /脸颊和额头已经薄匀/);
});

async function stagedFixture() {
  const f = await fixture();
  const cheek = path.join(f.directory, 'cheek.png'), forehead = path.join(f.directory, 'forehead.png');
  await media.ffmpeg(['-f', 'lavfi', '-i', 'color=green:size=96x160', '-frames:v', '1', '-update', '1', cheek]);
  await media.ffmpeg(['-f', 'lavfi', '-i', 'color=magenta:size=96x160', '-frames:v', '1', '-update', '1', forehead]);
  const args = { ...f.args, start: 0.5, end: 5.5, intermediates: [{ file: cheek }, { file: forehead }] };
  return { ...f, args, cheek, forehead };
}

test('staged job freezes all four targets, makes one continuous shot and keeps region goals separate', { timeout: 60000 }, async () => {
  const f = await stagedFixture();
  try {
    const job = await createReconstruction(f.args), spec = job.recipe.actionRebuild;
    assert.equal(job.billableSeconds, 6); assert.equal(spec.version, 2); assert.equal(spec.intermediates.length, 2);
    assert.deepEqual(job.segments.map(part => [part.frames, part.requestDuration]), [[15, 0], [50, 2], [50, 2], [50, 2], [15, 0]]);
    assert.deepEqual(job.segments.slice(1, 4).map(part => part.bridgeFromIndex), [undefined, 1, 2]);
    assert.deepEqual(job.recipe.story.actions.map(action => action.region), ['脸颊', '额头', '下巴']);
    assert.equal(job.recipe.story.shots.filter(shot => shot.authorisedReconstruction).length, 1, 'Stages are not inserted cuts');
    assert.deepEqual(job.recipe.sourceCuts, []);
    assert.ok(job.frozenFiles.some(file => file.file === 'anchors/mid-cheek.png'));
    assert.ok(job.frozenFiles.some(file => file.file === 'anchors/mid-forehead.png'));
    await assert.rejects(() => createReconstruction({ ...f.args, intermediates: [] }), /不同的涂抹阶段/);
  } finally { await f.close(); }
});

test('stage coupling uses previous actual last frames and unknown phase recovery never submits any phase twice', { timeout: 60000 }, async () => {
  const f = await stagedFixture(); let engine;
  try {
    const job = await createReconstruction(f.args), root = path.join(f.directory, 'jobs', job.id);
    const urls = new Map(), remote = new Map(), calls = []; let unknownPhase = true;
    const actualTail = path.join(f.directory, 'actual-tail.png');
    await media.ffmpeg(['-f', 'lavfi', '-i', 'color=yellow:size=96x160', '-frames:v', '1', '-update', '1', actualTail]);
    const provider = {
      upload: async file => { const url = 'oss://mock/' + randomUUID(); urls.set(url, file); calls.push(['upload', file]); return url; },
      create: async (body, segment) => {
        calls.push(['create', segment.index]); assert.equal(body.prompt_extend, false);
        const first = urls.get(body.metadata.input.media[0].url), result = path.join(f.directory, `returned-${segment.index}.mp4`);
        if (segment.bridgeFromIndex !== undefined) {
          const saved = f.store.get(job.id), previous = saved.segments[segment.bridgeFromIndex];
          assert.equal(previous.state, 'completed'); assert.ok(previous.outputSHA256);
          assert.equal(saved.segments[segment.index].bridge.sha256, await media.fileSHA256(first));
          assert.notEqual(await media.fileSHA256(first), saved.recipe.actionRebuild.stages[segment.reconstructionStageIndex].first.sha256,
            'Actual yellow returned state must replace the desired green/magenta pose as the next input');
        }
        await media.ffmpeg(['-loop', '1', '-framerate', '30', '-i', first, '-loop', '1', '-framerate', '30', '-i', actualTail,
          '-filter_complex', '[0:v]trim=end_frame=59,setpts=PTS-STARTPTS[a];[1:v]trim=end_frame=1,setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1:a=0[out]',
          '-map', '[out]', '-an', '-frames:v', '60', '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv420p', result]);
        const taskId = 'phase-' + segment.index; remote.set(taskId, result);
        if (segment.index === 2 && unknownPhase) { unknownPhase = false; throw new Error('Receipt lost after one real create'); }
        return taskId;
      },
      status: async id => { calls.push(['status', id]); return { status: 'completed', model: job.model }; },
      download: async (id, file) => { calls.push(['download', id]); await copyFile(remote.get(id), file); },
    };
    engine = new QueueEngine({ fundingGate: { ensure: async () => ({ state: 'approved' }) }, store: f.store, vault: f.vault, directory: f.directory, providerFactory: () => provider, mediaTools: media });
    await engine.pump();
    const interrupted = f.store.get(job.id);
    assert.equal(interrupted.segments[1].state, 'completed'); assert.equal(interrupted.segments[2].state, 'unknown');
    assert.equal(interrupted.segments[3].state, 'pending');
    assert.deepEqual(calls.filter(call => call[0] === 'create').map(call => call[1]), [1, 2]);
    assert.throws(() => engine.resume(job.id), /结果未知/);
    await engine.pump(); assert.equal(calls.filter(call => call[0] === 'create').length, 2);
    const bridge = interrupted.segments[2].bridge;
    assert.equal(bridge.fromTaskId, 'phase-1'); assert.equal(bridge.sourceFrameIndex, 49);
    assert.equal(interrupted.frozenFiles.find(file => file.file === bridge.file).sha256, bridge.sha256);
    await engine.bindTask(job.id, 2, 'phase-2'); engine.resume(job.id);
    for (let count = 0; engine.active && count < 1000; count++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(engine.active, null);
    const completed = f.store.get(job.id);
    assert.equal(completed.state, 'completed'); assert.equal(completed.result.frames, 180);
    assert.deepEqual(calls.filter(call => call[0] === 'create').map(call => call[1]), [1, 2, 3]);
    assert.ok(completed.segments[3].bridge.sha256);
    assert.equal((await frameHashes(path.join(root, 'result.mp4'))).length, 180);
    const baseHashes = await frameHashes(f.base), finalHashes = await frameHashes(path.join(root, 'result.mp4'));
    assert.deepEqual(finalHashes.slice(0, 15), baseHashes.slice(0, 15)); assert.deepEqual(finalHashes.slice(165), baseHashes.slice(165));
    const audioHash = async file => (await media.ffmpeg(['-i', file, '-map', '0:a:0', '-c:a', 'copy', '-f', 'md5', '-'])).trim();
    assert.equal(await audioHash(path.join(root, 'result.mp4')), await audioHash(f.base));
  } finally { engine?.stop(); await f.close(); }
});
