import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openAsBlob } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Store } from '../src/store.js';
import { KeyVault } from '../src/keys.js';
import { QueueEngine } from '../src/engine.js';
import { AnalysisEngine } from '../src/analysis.js';
import { createApp } from '../src/server.js';
import { ffmpeg, probe } from '../src/media.js';

test('studio HTTP: analyze, dynamic assets, 3 views, voice, dialogue, frozen generation and correct audio mixing', { timeout: 180000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), '.wan-studio-e2e-')), fixtures = path.join(directory, 'fixtures'); await mkdir(fixtures);
  const source = path.join(fixtures, 'original.mp4'), main = path.join(fixtures, 'main.png'), side = path.join(fixtures, 'side.png'), back = path.join(fixtures, 'back.png'), voice = path.join(fixtures, 'voice.wav'), short = path.join(fixtures, 'invalid-short.wav');
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '16.2', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', source]);
  for (const [file, color] of [[main, 'orange'], [side, 'green'], [back, 'blue']]) await ffmpeg(['-f', 'lavfi', '-i', `color=c=${color}:size=240x300`, '-frames:v', '1', '-update', '1', file]);
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000', '-t', '4', '-c:a', 'pcm_s16le', voice]);
  await ffmpeg(['-i', voice, '-t', '2', '-c:a', 'pcm_s16le', short]);
  const story = { summary: '人工测试数据，不是真实素材分析', characters: [{ id: 'C001', name: '白衣女人', description: '左侧白衣', firstSeen: 0, confidence: 'high' }, { id: 'C002', name: '绿衣男人', description: '右侧绿衣', firstSeen: 12, confidence: 'high' }], scenes: [{ id: 'S001', name: '客厅', description: '浅色背景', firstSeen: 0 }], props: [{ id: 'P001', name: '精华瓶', description: '白色瓶子', firstSeen: 0 }], shots: [{ start: 0, end: 12, summary: '女人展示产品', camera: '中景', characterIds: ['C001'], sceneId: 'S001', propIds: ['P001'] }, { start: 12, end: 16.2, summary: '男人回应', camera: '近景', characterIds: ['C002'], sceneId: 'S001', propIds: [] }], dialogues: [{ start: 1, end: 3, characterId: 'C001', text: '原来的句子', uncertain: false }, { start: 13, end: 15, characterId: 'C002', text: '原声保持', uncertain: false }], warnings: [] };
  const store = new Store(directory), vault = new KeyVault(directory); await vault.set('test-studio-only-key');
  const uploads = new Map(), tasks = new Map(), submitted = []; let analyses = 0;
  const provider = {
    check: async () => ({ models: ['Omni-Analysis', 'wan3.0-480p'] }),
    upload: async (file, model, affinity) => { const url = 'oss://fixture/' + randomUUID(); uploads.set(url, { file, model, affinity }); return url; },
    analyzeVideo: async (url, prompt, onText) => {
      analyses++; assert.equal(uploads.get(url).model, 'Omni-Analysis'); assert.match(prompt, /只返回一个.*JSON 对象/); assert.equal((await probe(uploads.get(url).file)).hasAudio, true);
      const text = JSON.stringify(story); await onText(text.slice(0, 30)); await onText(text.slice(30)); return { text, complete: true, usage: { total_tokens: 99 }, responseId: 'analysis-fixture' };
    },
    create: async (body, part) => {
      assert.equal(body.prompt_extend, true, 'Every new WAN request enables prompt expansion');
      const id = 'studio-task-' + tasks.size, ref = uploads.get(body.metadata.input.media[0].url); assert.equal(ref.affinity, part.affinity);
      submitted.push(body); tasks.set(id, { file: ref.file, duration: body.duration }); return id;
    },
    status: async () => ({ status: 'completed' }),
    download: async (id, output) => {
      const task = tasks.get(id);
      // Deliberately different audio: the final file must use this only in edited-audio segments.
      await ffmpeg(['-i', task.file, '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-map', '0:v:0', '-map', '1:a:0', '-t', String(task.duration), '-c:v', 'copy', '-c:a', 'aac', output]);
    },
  };
  const engine = new QueueEngine({ fundingGate: { ensure: async () => ({ state: 'approved' }) }, store, vault, directory, providerFactory: () => provider, pollInterval: 1 });
  const analysis = new AnalysisEngine({ store, vault, directory, providerFactory: () => provider });
  for (const processor of [engine, analysis]) { const run = processor.process.bind(processor); processor.process = async id => { try { return await run(id); } catch (error) { t.diagnostic(error.stack); throw error; } }; }
  let app; const server = createServer((req, res) => app(req, res)); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  app = createApp({ store, vault, engine, analysis, directory, port, toolsStatus: { ffmpeg: true, ffprobe: true } });
  const bootstrap = await (await fetch(origin + '/api/bootstrap')).json();
  assert.equal(bootstrap.features.characterEditModes, true);
  const request = async (url, method = 'GET', body, headers = {}) => {
    const response = await fetch(origin + url, { method, headers: { 'X-CSRF-Token': bootstrap.csrf, ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const form = async (files, title) => { const value = new FormData(); if (title !== undefined) value.append('title', title); for (const file of files) value.append('file', await openAsBlob(file), path.basename(file)); return value; };
  const wait = async (read, terminal) => { for (let i = 0; i < 900; i++) { const value = read(); if (terminal.includes(value.state)) return value; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Pipeline timed out'); };
  try {
    const nonce = randomUUID();
    const imported = await request('/api/projects', 'POST', await form([source], '编辑工作台测试'), { 'X-Project-Request-Id': nonce }); assert.equal(imported.status, 201, JSON.stringify(imported.body));
    const duplicate = await request('/api/projects', 'POST', await form([source], '编辑工作台测试'), { 'X-Project-Request-Id': nonce }); assert.equal(duplicate.body.id, nonce);
    let project = await wait(() => store.project(nonce), ['ready', 'analysis_attention']); assert.equal(project.state, 'ready', project.error); assert.equal(analyses, 1); assert.equal(project.story.assets.length, 4);
    const uploadAsset = async (asset, slot, files) => { const response = await request(`/api/projects/${nonce}/assets/${asset}/${slot}`, 'POST', await form(files)); assert.equal(response.status, 200, JSON.stringify(response.body)); project = response.body; };
    await uploadAsset('C001', 'main', [main]);
    let scopePlan = (await request(`/api/projects/${nonce}/plan`)).body;
    assert.equal(scopePlan.characterModes.C001, 'face');
    assert.equal(scopePlan.visualPlan.find(a => a.assetId === 'C001').editMode, 'face');
    await uploadAsset('C001', 'views', [main]);
    scopePlan = (await request(`/api/projects/${nonce}/plan`)).body;
    assert.equal(scopePlan.characterModes.C001, 'appearance', 'A single uploaded views montage also selects appearance');
    const removedViews = await request(`/api/projects/${nonce}/assets/C001/views`, 'DELETE'); assert.equal(removedViews.status, 200); project = removedViews.body;
    assert.equal((await request(`/api/projects/${nonce}/plan`)).body.characterModes.C001, 'face');
    await uploadAsset('C001', 'views', [main, side, back]); await uploadAsset('C001', 'voice', [voice]);
    await uploadAsset('S001', 'main', [side]); await uploadAsset('P001', 'main', [back]);
    assert.equal(project.edits.assets.C001.views.width, 1800); assert.equal(project.edits.assets.C001.voice.duration, 4);
    const badVoice = await request(`/api/projects/${nonce}/assets/C001/voice`, 'POST', await form([short])); assert.equal(badVoice.status, 400); assert.match(badVoice.body.error, /3–5 秒/);
    const badViews = await request(`/api/projects/${nonce}/assets/C001/views`, 'POST', await form([main, side])); assert.equal(badViews.status, 400);
    project.edits.model = 'wan3.0-480p'; project.edits.dialogues = [{ id: 'L001', enabled: true, start: 1, end: 3, characterId: 'C001', text: '这是替换后的台词。' }];
    const saved = await request(`/api/projects/${nonce}/edits`, 'PUT', { revision: project.revision, edits: project.edits }); assert.equal(saved.status, 200); project = saved.body;
    const plan = await request(`/api/projects/${nonce}/plan`); assert.equal(plan.status, 200); assert.equal(plan.body.segments.length, 2); assert.equal(plan.body.audioMode, 'mixed'); assert.deepEqual(plan.body.segments.map(s => s.audioChanged), [true, false]);
    const requestId = randomUUID(), generation = { revision: project.revision, requestId };
    const started = await request(`/api/projects/${nonce}/generate`, 'POST', generation); assert.equal(started.status, 201, JSON.stringify(started.body));
    const frozenMain = store.get(requestId).recipe.edits.assets.C001.main.file;
    assert.equal(store.get(requestId).recipe.characterModes.C001, 'appearance');
    await uploadAsset('C001', 'main', [back]); assert.notEqual(project.edits.assets.C001.main.file, frozenMain);
    project = (await request(`/api/projects/${nonce}/assets/C001/views`, 'DELETE')).body;
    assert.equal((await request(`/api/projects/${nonce}/plan`)).body.characterModes.C001, 'face');
    const again = await request(`/api/projects/${nonce}/generate`, 'POST', generation); assert.equal(again.body.id, requestId);
    const job = await wait(() => store.get(requestId), ['completed', 'needs_attention']); assert.equal(job.state, 'completed', job.error);
    assert.equal(job.recipe.edits.assets.C001.main.file, frozenMain); assert.equal(submitted.length, 2); assert.equal(submitted[0].metadata.input.media.filter(m => m.type === 'reference_audio').length, 1); assert.equal(submitted[1].metadata.input.media.filter(m => m.type === 'reference_audio').length, 0);
    assert.match(submitted[0].prompt, /这是替换后的台词/); assert.match(submitted[0].prompt, /白衣女人.*音色替换为音频1/);
    assert.match(submitted[0].prompt, /图片2中的三视图/);
    assert.equal(job.recipe.characterModes.C001, 'appearance');
    assert.equal(job.segments[0].characterModes.C001, 'appearance');
    assert.equal(job.generationOptions.promptExtend, true);
    assert.ok(job.segments.every(segment => segment.requestSettings.promptExtend === true));
    const originalAsset = await readFile(path.join(directory, 'projects', nonce, frozenMain)), snapshotAsset = await readFile(path.join(directory, 'jobs', requestId, frozenMain));
    const hash = bytes => createHash('sha256').update(bytes).digest('hex'); assert.equal(hash(originalAsset), hash(snapshotAsset));
    const resultFile = path.join(directory, 'jobs', requestId, 'result.mp4'), info = await probe(resultFile); assert.equal(info.frames, 486); assert.equal(info.hasAudio, true); assert.ok(Math.abs(info.duration - 16.2) < 0.06);
    const pcmFile = path.join(fixtures, 'final.f32'); await ffmpeg(['-i', resultFile, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', pcmFile]); const pcm = await readFile(pcmFile);
    const energy = (frequency, start) => { let sine = 0, cosine = 0; const begin = Math.round(start * 48000); for (let n = 0; n < 24000; n++) { const sample = pcm.readFloatLE((begin + n) * 4), phase = 2 * Math.PI * frequency * n / 48000; sine += sample * Math.sin(phase); cosine += sample * Math.cos(phase); } return Math.hypot(sine, cosine); };
    assert.ok(energy(880, 1) > energy(440, 1) * 20, 'Edited segment must retain generated speech track');
    assert.ok(energy(440, 13) > energy(880, 13) * 20, 'Unedited segment must retain original audio');
    const publicData = await request(`/api/projects/${nonce}`); assert.ok(!JSON.stringify(publicData.body).includes('test-studio-only-key')); assert.ok(!Object.hasOwn(publicData.body, 'keyHash'));
    const result = await fetch(origin + `/api/jobs/${requestId}/media/result`, { headers: { Range: 'bytes=0-99' } }); assert.equal(result.status, 206); await result.arrayBuffer();
    assert.equal(store.list().length, 1);
    // A newly submitted version after removing views must actually send face-only
    // instructions, while the already submitted version keeps its outfit recipe.
    const faceId = randomUUID(), faceStartCalls = submitted.length;
    const faceStarted = await request(`/api/projects/${nonce}/generate`, 'POST', { revision: project.revision, requestId: faceId });
    assert.equal(faceStarted.status, 201, JSON.stringify(faceStarted.body));
    const faceCompleted = await wait(() => store.get(faceId), ['completed', 'needs_attention']); assert.equal(faceCompleted.state, 'completed', faceCompleted.error);
    assert.equal(faceCompleted.recipe.characterModes.C001, 'face');
    assert.match(submitted[faceStartCalls].prompt, /人脸替换为图片1中人物的人脸/);
    assert.doesNotMatch(submitted[faceStartCalls].prompt, /中的三视图/);
    assert.equal(store.get(requestId).recipe.characterModes.C001, 'appearance');
    // Whole-script mode replaces all old dialogue; assets without images are explicitly preserved.
    for (const [asset, slot] of [['C001','main'],['C001','views'],['C001','voice'],['S001','main'],['P001','main']]) {
      const removed = await request(`/api/projects/${nonce}/assets/${asset}/${slot}`, 'DELETE'); assert.equal(removed.status, 200); project = removed.body;
    }
    const fullText = '这是新的完整口播。所有原对白都已经替换。';
    project.edits.fullDialogue = { enabled: true, text: fullText, speakerId: 'C001' };
    project.edits.assets.C001.notes = '不该执行的无图外观改动';
    const wholeSaved = await request(`/api/projects/${nonce}/edits`, 'PUT', { revision: project.revision, edits: project.edits }); assert.equal(wholeSaved.status, 200); project = wholeSaved.body;
    const fullPlan = await request(`/api/projects/${nonce}/plan`); assert.equal(fullPlan.status, 200); assert.ok(fullPlan.body.segments.every(s => s.audioChanged));
    assert.equal(fullPlan.body.dialoguePlan.lines.map(l => l.text).join('').replace(/\s/g,''), fullText.replace(/\s/g,''));
    assert.equal(fullPlan.body.segments[0].images, 0); assert.equal(fullPlan.body.segments[0].voices, 0);
    const wholeId = randomUUID(), startCalls = submitted.length;
    const newJob = await request(`/api/projects/${nonce}/generate`, 'POST', { revision: project.revision, requestId: wholeId }); assert.equal(newJob.status, 201, JSON.stringify(newJob.body));
    const completedWhole = await wait(() => store.get(wholeId), ['completed','needs_attention']); assert.equal(completedWhole.state, 'completed', completedWhole.error);
    assert.ok(submitted.slice(startCalls).every(b => b.metadata.input.media.length === 1));
    assert.ok(submitted.slice(startCalls).every(b => !b.prompt.includes('不该执行的无图外观改动')));
    assert.ok(submitted.slice(startCalls).every(b => b.prompt.includes('原视频的所有旧人声对白都要移除')));
    const wholePCM = path.join(fixtures, 'whole-script.f32');
    await ffmpeg(['-i', path.join(directory,'jobs',wholeId,'result.mp4'), '-map','0:a:0','-ac','1','-ar','48000','-f','f32le',wholePCM]);
    const wholeBytes = await readFile(wholePCM);
    const wholeEnergy = frequency => { let a=0,b=0; for(let n=0;n<24000;n++){const sample=wholeBytes.readFloatLE((13*48000+n)*4), phase=2*Math.PI*frequency*n/48000;a+=sample*Math.sin(phase);b+=sample*Math.cos(phase);} return Math.hypot(a,b); };
    assert.ok(wholeEnergy(880) > wholeEnergy(440)*20, 'Whole replacement must never restore the old voice in later segments');
    assert.equal(store.list().length, 3);
    await uploadAsset('C001', 'views', [main, side, back]);
    assert.ok(!project.edits.assets.C001.main);
    const combinedPlan = (await request(`/api/projects/${nonce}/plan`)).body;
    assert.equal(combinedPlan.characterModes.C001, 'appearance');
    const combinedId = randomUUID(), beforeCombined = submitted.length;
    const combinedStart = await request(`/api/projects/${nonce}/generate`, 'POST', { revision: project.revision, requestId: combinedId });
    assert.equal(combinedStart.status, 201, JSON.stringify(combinedStart.body));
    const combinedJob = await wait(() => store.get(combinedId), ['completed', 'needs_attention']); assert.equal(combinedJob.state, 'completed', combinedJob.error);
    const combinedRef = combinedJob.segments[0].bindings.find(binding => binding.assetId === 'C001');
    assert.equal(combinedRef.slot, 'views');
    assert.deepEqual(await readFile(path.join(directory, 'jobs', combinedId, combinedRef.file)), await readFile(path.join(directory, 'projects', nonce, project.edits.assets.C001.views.file)));
    assert.match(submitted[beforeCombined].prompt, /三视图或主视图与三视图合成图/);
    const uploadedImages = submitted[beforeCombined].metadata.input.media.filter(media => media.type === 'reference_image');
    assert.equal(uploadedImages.length, 1, 'The standalone montage must reach the actual provider request');
    assert.equal(uploads.get(uploadedImages[0].url).file, path.join(directory, 'jobs', combinedId, combinedRef.file));
    // Speech estimates must not silently discard text or block the user's choice.
    project.edits.fullDialogue.text = '这是一句完整的新台词。'.repeat(80);
    const overloaded = await request(`/api/projects/${nonce}/edits`, 'PUT', { revision: project.revision, edits: project.edits }); assert.equal(overloaded.status, 200); project = overloaded.body;
    const warningPlan = (await request(`/api/projects/${nonce}/plan`)).body;
    assert.equal(warningPlan.canGenerate, true); assert.equal(warningPlan.blockers.length, 0); assert.match(warningPlan.warnings.join(''), /仅提醒，可继续生成/);
    assert.equal(warningPlan.dialoguePlan.lines.map(line=>line.text).join('').replace(/\s/gu,''),project.edits.fullDialogue.text.replace(/\s/gu,''));
    const callCount = submitted.length, jobCount = store.list().length, fastId = randomUUID();
    const accepted = await request(`/api/projects/${nonce}/generate`, 'POST', { revision: project.revision, requestId: fastId });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    const fastJob = await wait(() => store.get(fastId), ['completed','needs_attention']);assert.equal(fastJob.state,'completed',fastJob.error);
    assert.ok(submitted.length > callCount);assert.equal(store.list().length,jobCount+1);
    const newRequests = submitted.slice(callCount);
    assert.ok(newRequests.every(body=>body.prompt_extend));
    const actualText = newRequests.flatMap(body=>[...body.prompt.matchAll(/说：“([\s\S]*?)”。只说这一句/g)].map(match=>match[1])).join('');
    assert.equal(actualText.replace(/\s/gu,''),project.edits.fullDialogue.text.replace(/\s/gu,''), 'Every word must reach the actual provider request exactly once; silent tails have no new speech');
    for (const [index, segment] of fastJob.segments.entries()) if (!segment.dialogueIds.length) assert.match(newRequests[index].prompt, /保持人声静默/);
    assert.equal(store.project(nonce).edits.fullDialogue.text, project.edits.fullDialogue.text);
  } finally {
    engine.stop(); analysis.stop(); while (engine.active || analysis.active) await new Promise(resolve => setTimeout(resolve, 50)); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); await rm(directory, { recursive: true, force: true });
  }
});
