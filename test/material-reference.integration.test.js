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
import { createApp } from '../src/server.js';
import { ffmpeg, probe } from '../src/media.js';

test('HTTP material roles block jar/box mismatch, preserve server-owned files and freeze material-only references', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yingti-material-http-'));
  const store = new Store(directory), vault = new KeyVault(directory);
  await vault.set('test-material-role-only');
  const projectId = randomUUID(), root = path.join(directory, 'projects', projectId);
  await mkdir(root, { recursive: true });
  let pumps = 0;
  const engine = { active: null, pump: () => { pumps++; }, providerFactory: () => { throw new Error('HTTP contract test must not call a provider'); } };
  const analysis = { active: null, pump: () => {} };
  let app;
  const server = createServer((request, response) => app(request, response));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  app = createApp({ store, vault, engine, analysis, directory, port, toolsStatus: { ffmpeg: true, ffprobe: true } });
  const csrf = (await (await fetch(origin + '/api/bootstrap')).json()).csrf;
  const request = async (route, method = 'GET', body) => {
    const response = await fetch(origin + route, { method, headers: { 'X-CSRF-Token': csrf, ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
  try {
    await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(root, 'source.mp4')]);
    const fixtures = path.join(directory, 'fixtures'); await mkdir(fixtures);
    const image = path.join(fixtures, 'reference.png');
    await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0xe8b9a1:size=360x300', '-frames:v', '1', '-update', '1', image]);
    const now = new Date().toISOString();
    let project = store.createProject({
      id: projectId, created: now, updated: now, title: '素材用途 HTTP 验证', revision: 0, state: 'ready', phase: 'ready', keyHash: vault.hash(),
      sourceFile: 'source.mp4', sourceName: 'source.mp4', source: await probe(path.join(root, 'source.mp4')), analysis: { windows: [] },
      story: { summary: 'Synthetic fixtures validate contracts, not actual cream motion.', assets: [
        { id: 'C001', type: 'character', name: '测试人物', description: '用于合同验证的合成人物标签', firstSeen: 0 },
        { id: 'P001', type: 'prop', name: '面霜罐', description: '闭盖圆罐', firstSeen: 0 },
        { id: 'P002', type: 'prop', name: '面霜膏体', description: '涂抹在脸上的乳霜膏体', firstSeen: 0 },
        { id: 'P003', type: 'prop', name: '产品包装盒', description: '产品纸盒', firstSeen: 0 },
      ], shots: [{ id: 'SH1', start: 0, end: 2, characterIds: ['C001'], propIds: ['P001', 'P002', 'P003'], sceneId: null }], dialogues: [], actions: [
        { id: 'A1', start: 0.2, end: 1.8, type: 'spread', characterId: 'C001', propId: 'P002', region: '脸颊', before: '脸颊上有白色厚膏块', after: '膏体已推开成连续薄层',
          contact: '指腹持续接触脸颊的膏体', motion: '沿脸颊由内向外推开', evidence: '指腹接触并推开已有膏体，覆盖面积扩大、厚度下降',
          materialAppearance: '原片乳白色膏体', materialEvidence: '脸颊膏体在指腹接触的画面中铺展并变薄', confidence: 'high' },
      ], warnings: [] },
      edits: { model: 'wan3.0-480p', assets: {}, dialogues: [], continuity: { actions: {}, autoReview: false } },
    });
    const upload = async assetId => {
      const form = new FormData(); form.append('file', await openAsBlob(image), 'reference.png');
      const response = await request(`/api/projects/${projectId}/assets/${assetId}/main`, 'POST', form);
      assert.equal(response.status, 200, JSON.stringify(response.body)); project = response.body;
    };
    for (const asset of ['P001', 'P002', 'P003']) await upload(asset);
    const originalMain = structuredClone(project.edits.assets.P002.main);
    const save = async edits => {
      const response = await request(`/api/projects/${projectId}/edits`, 'PUT', { revision: project.revision, edits });
      if (response.status === 200) project = response.body;
      return response;
    };
    let edits = structuredClone(project.edits);
    Object.assign(edits.assets.P001, { propRole: 'jar', uploadedImageRole: 'packaging' });
    Object.assign(edits.assets.P002, { propRole: 'material', uploadedImageRole: 'material', materialReferenceMode: 'image', materialDescription: '杏桃色乳霜质地，仅约束颜色与质地' });
    Object.assign(edits.assets.P003, { propRole: 'packaging', uploadedImageRole: 'packaging' });
    let saved = await save(edits); assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const badId = randomUUID();
    const blocked = await request(`/api/projects/${projectId}/generate`, 'POST', { revision: project.revision, requestId: badId });
    assert.ok([400, 422].includes(blocked.status), JSON.stringify(blocked.body));
    assert.match(blocked.body.error, /瓶罐.*包装盒.*不匹配/u);
    assert.equal(store.list().length, 0); assert.equal(pumps, 0, 'Mismatched upload must not start a WAN job');

    edits = structuredClone(project.edits);
    edits.assets.P001.uploadedImageRole = 'jar';
    edits.assets.P002.main = { file: '../spoofed-material.png', width: 1, height: 1 };
    saved = await save(edits); assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(project.edits.assets.P002.main, originalMain, 'Client JSON cannot replace an uploaded material image binding');
    assert.equal(project.edits.assets.P001.uploadedImageRole, 'jar');
    assert.equal(project.edits.assets.P002.propRole, 'material');

    await upload('C001');
    const actorReference = project.edits.assets.C001.main.file;
    const finishUpload = async (assetId, characterId) => {
      const form = new FormData(); form.append('file', await openAsBlob(image), 'completed-face.png'); form.append('characterId', characterId);
      const response = await request(`/api/projects/${projectId}/assets/${assetId}/finish`, 'POST', form);
      if (response.status === 200) project = response.body;
      return response;
    };
    assert.equal((await finishUpload('P001', 'C001')).status, 400, 'Jar references cannot own a material completion image');
    assert.equal((await finishUpload('C001', 'C001')).status, 400, 'Completion images belong to a material, not a character asset slot');
    assert.equal((await finishUpload('P002', 'P001')).status, 422, 'Completion target must identify a character');
    const finished = await finishUpload('P002', 'C001');
    assert.equal(finished.status, 200, JSON.stringify(finished.body));
    const finishBinding = structuredClone(project.edits.assets.P002.materialFinish);
    assert.equal(finishBinding.characterId, 'C001');
    assert.equal(finishBinding.actorReference.main, actorReference);

    const cropRoute = `/api/projects/${projectId}/assets/P002/material/crop`;
    let cropRect = { x: 40, y: 35, width: 180, height: 130 };
    assert.equal((await request(cropRoute, 'POST', { revision: project.revision - 1, ...cropRect })).status, 409);
    for (const rectangle of [{ x: -1, y: 0, width: 100, height: 100 }, { x: 300, y: 200, width: 100, height: 100 }, { x: 0, y: 0, width: 23, height: 30 }]) {
      assert.equal((await request(cropRoute, 'POST', { revision: project.revision, ...rectangle })).status, 422, JSON.stringify(rectangle));
    }
    assert.equal((await request(`/api/projects/${projectId}/assets/P001/material/crop`, 'POST', { revision: project.revision, ...cropRect })).status, 422);
    const alternateCrop = { x: 70, y: 60, width: 160, height: 100 };
    const cropAttempts = await Promise.all([cropRect, alternateCrop].map(rectangle => request(cropRoute, 'POST', { revision: project.revision, ...rectangle })));
    assert.deepEqual(cropAttempts.map(result => result.status).sort(), [200, 409], 'Two concurrent crops of the same revision must not both update the asset');
    const croppedIndex = cropAttempts.findIndex(result => result.status === 200), cropped = cropAttempts[croppedIndex];
    cropRect = [cropRect, alternateCrop][croppedIndex]; project = cropped.body;
    const croppedMain = structuredClone(project.edits.assets.P002.main);
    assert.equal(croppedMain.file, originalMain.file, 'The original image is retained for audit');
    assert.deepEqual(croppedMain.cropRect, cropRect);
    assert.ok(croppedMain.materialFile.startsWith('assets/'));
    const croppedInfo = await probe(path.join(root, croppedMain.materialFile));
    assert.ok(croppedInfo.width >= 240 && croppedInfo.height >= 240, 'Derived crop is compatible with the image reference size policy');
    const cropPreview = await fetch(origin + `/api/projects/${projectId}/assets/P002/material/media`);
    assert.equal(cropPreview.status, 200); assert.equal(cropPreview.headers.get('content-type'), 'image/png'); await cropPreview.arrayBuffer();

    edits = structuredClone(project.edits);
    edits.assets.P002.main = { file: '../spoofed-main.png', materialFile: '../spoofed-crop.png', cropRect: { x: 0, y: 0, width: 1, height: 1 } };
    edits.assets.P002.materialFinish = { file: '../spoofed-finish.png', characterId: 'P001' };
    saved = await save(edits); assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(project.edits.assets.P002.main, croppedMain, 'JSON cannot replace server-derived material files or crop rectangles');
    assert.deepEqual(project.edits.assets.P002.materialFinish, finishBinding, 'JSON cannot invent a finish-state image or change its character');

    const plan = await request(`/api/projects/${projectId}/plan`);
    assert.equal(plan.status, 200, JSON.stringify(plan.body));
    assert.deepEqual(plan.body.blockers, []);
    const jobId = randomUUID();
    const generated = await request(`/api/projects/${projectId}/generate`, 'POST', { revision: project.revision, requestId: jobId });
    assert.equal(generated.status, 201, JSON.stringify(generated.body));
    const frozen = store.get(jobId);
    assert.equal(pumps, 1); assert.equal(frozen.recipe.edits.assets.P002.propRole, 'material');
    assert.equal(frozen.recipe.edits.assets.P002.uploadedImageRole, 'material');
    const materialFile = croppedMain.materialFile, frozenPath = path.join(directory, 'jobs', jobId, materialFile);
    assert.equal(await hash(frozenPath), await hash(path.join(root, materialFile)));
    assert.equal(frozen.frozenFiles.find(file => file.file === materialFile)?.sha256, await hash(frozenPath));
    const materialBinding = frozen.segments[0].bindings.find(binding => binding.assetId === 'P002' && binding.slot === 'main');
    assert.equal(materialBinding.role, 'material');
    assert.equal(materialBinding.referenceRole, 'material');
    assert.equal(materialBinding.usage, 'material_appearance');
    assert.equal(materialBinding.file, croppedMain.materialFile);
    assert.ok(!frozen.segments[0].bindings.some(binding => binding.assetId === 'P002' && binding.file === originalMain.file), 'Full product photograph is audit-only, never a material model reference after cropping');
    assert.equal(await hash(path.join(directory, 'jobs', jobId, originalMain.file)), await hash(path.join(root, originalMain.file)), 'The uncropped source remains available for audit');
    const finalState = frozen.segments[0].bindings.find(binding => binding.slot === 'materialFinish');
    assert.equal(finalState.assetId, 'P002'); assert.equal(finalState.characterId, 'C001');
    assert.equal(finalState.usage, 'material_finish_state');
    assert.equal(await hash(path.join(directory, 'jobs', jobId, finalState.file)), await hash(path.join(root, finishBinding.file)));
    assert.match(frozen.segments[0].prompt, /颜色.{0,12}质地|质地.{0,12}颜色/u);
    assert.doesNotMatch(frozen.segments[0].prompt, /把.{0,20}面霜膏体.{0,20}完整替换/u);
    assert.match(frozen.segments[0].prompt, /薄匀完成状态参考/u);

    // A later reference edit is applied to future jobs; the submitted recipe
    // and material bytes remain reviewable exactly as frozen.
    edits = structuredClone(project.edits); edits.assets.P002.notes = 'later edit';
    saved = await save(edits); assert.equal(saved.status, 200);
    assert.notEqual(project.revision, frozen.projectRevision);
    assert.notEqual(project.edits.assets.P002.notes, store.get(jobId).recipe.edits.assets.P002.notes);
    assert.equal(await hash(frozenPath), frozen.frozenFiles.find(file => file.file === materialFile).sha256);

    // Clearing the optional mode chooses the safer default: preserve motion,
    // freeze the explicit appearance description and keep thick-cream images
    // out of the model's geometry references.
    edits = structuredClone(project.edits);
    edits.assets.P002.materialReferenceMode = '';
    const description = '杏粉色、细腻的乳霜，仅调整材料外观，沿原片指腹接触持续推开变薄';
    edits.assets.P002.materialDescription = description;
    saved = await save(edits); assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(project.edits.assets.P002.materialReferenceMode, 'motion');
    const motionId = randomUUID();
    const motionResponse = await request(`/api/projects/${projectId}/generate`, 'POST', { revision: project.revision, requestId: motionId });
    assert.equal(motionResponse.status, 201, JSON.stringify(motionResponse.body));
    const motionJob = store.get(motionId);
    assert.equal(motionJob.recipe.edits.assets.P002.materialDescription, description);
    assert.ok(!motionJob.segments.flatMap(segment => segment.bindings).some(binding => binding.assetId === 'P002' && binding.slot === 'main'));
    const motionTarget = motionJob.segments.flatMap(segment => segment.materialTargets.targets).find(target => target.assetId === 'P002');
    assert.equal(motionTarget.reference, null); assert.equal(motionTarget.referenceMode, 'motion');
    assert.equal(motionTarget.materialDescription, description); assert.equal(motionTarget.usage, 'material_motion');
    assert.match(motionJob.segments[0].prompt, /采用运动主导/u);
    assert.ok(motionJob.segments[0].prompt.includes(description));
    assert.doesNotMatch(motionJob.segments[0].prompt, /已绑定材料图|目标颜色与质地采用材料参考图/u, 'Motion mode cannot refer to a nonexistent material image or confuse it with the finish reference');
    assert.ok(motionJob.frozenFiles.some(file => file.file === croppedMain.materialFile), 'Motion mode retains the crop as audit evidence while excluding it from model references');

    // A completion image belongs to the confirmed actor/action, not every
    // person using the same cream. Disabled actions cannot bring it back.
    project = store.updateProject(projectId, value => {
      value.story.assets.push({ id: 'C002', type: 'character', name: '第二位测试人物', firstSeen: 0 });
      value.story.shots[0].characterIds.push('C002');
      value.story.actions.push({ ...value.story.actions[0], id: 'A2', characterId: 'C002' });
      value.edits.continuity.actions.A1 = 'off'; value.revision++;
    });
    const scopedId = randomUUID();
    const scopedResponse = await request(`/api/projects/${projectId}/generate`, 'POST', { revision: project.revision, requestId: scopedId });
    assert.equal(scopedResponse.status, 201, JSON.stringify(scopedResponse.body));
    const scoped = store.get(scopedId);
    assert.ok(!scoped.segments.flatMap(segment => segment.bindings).some(binding => binding.slot === 'materialFinish'));
    const scopedTarget = scoped.segments.flatMap(segment => segment.materialTargets.targets).find(target => target.assetId === 'P002');
    assert.equal(scopedTarget.finishReference, null);
    assert.deepEqual(scopedTarget.actions.map(action => action.characterId), ['C002']);
    assert.equal(pumps, 3);

    await upload('P002');
    assert.equal(project.edits.assets.P002.propRole, 'material');
    assert.equal(project.edits.assets.P002.uploadedImageRole, undefined, 'A new image requires fresh content classification');
    assert.equal(project.edits.assets.P002.main.materialFile, undefined, 'A new image cannot retain a stale crop from the previous upload');
    assert.equal(await hash(frozenPath), frozen.frozenFiles.find(file => file.file === materialFile).sha256, 'Replacing an image must not change an old job crop');

    const invalid = structuredClone(project.edits); invalid.assets.P002.propRole = 'unrecognized-role';
    const invalidResult = await save(invalid);
    assert.equal(invalidResult.status, 400, JSON.stringify(invalidResult.body));
    const badMode = structuredClone(project.edits); badMode.assets.P002.materialReferenceMode = 'invented-mode';
    assert.equal((await save(badMode)).status, 400);
    const nonMaterialMode = structuredClone(project.edits); nonMaterialMode.assets.P001.materialReferenceMode = 'image';
    assert.equal((await save(nonMaterialMode)).status, 400);
    assert.equal(pumps, 3, 'Invalid classification must not submit an extra job');
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
