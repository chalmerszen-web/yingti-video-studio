import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { LocalMaterialEngine } from '../src/local-material.js';
import { installLocalMaterialAPI } from '../src/local-material-api.js';
import { ffmpeg, probe, fileSHA256 } from '../src/media.js';

test('keyless HTTP drafts, normalized calibration and source-only reference reject client paths and stale revisions without any provider', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yingti-local-api-')), store = new Store(directory), parentId = randomUUID();
  const root = path.join(directory, 'jobs', parentId); await mkdir(root, { recursive: true });
  const source = path.join(root, 'original.mp4'), base = path.join(root, 'result.mp4');
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=64x96:rate=30:duration=3', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=blue:size=64x96:rate=30:duration=3', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', base]);
  const parent = { id: parentId, title: '待局部修复成片', created: new Date().toISOString(), state: 'completed', workflow: 'studio', sourceFile: 'original.mp4',
    sourceSHA256: await fileSHA256(source), source: await probe(base), recipe: { story: { assets: [{ id: 'C001', type: 'character', name: '目标人物' }, { id: 'P001', type: 'prop', name: '膏体' }] }, edits: { assets: {} } }, segments: [] };
  store.create(parent); const before = JSON.stringify(store.get(parentId)), baseSHA = await fileSHA256(base);
  let calls = 0;
  const engine = new LocalMaterialEngine({ store, directory, runner: async () => { calls++; throw new Error('Runtime not installed for this HTTP contract test'); } });
  const app = express(); app.use(express.json()); app.use((req, res, next) => { if (req.method !== 'GET' && req.get('x-csrf-token') !== 'fixture-csrf') return res.status(403).json({ error: 'CSRF' }); next(); });
  installLocalMaterialAPI(app, { store, directory, engine });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, method = 'GET', body) => { const response = await fetch(origin + url, { method, headers: { 'X-CSRF-Token': 'fixture-csrf', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: response.status, body: await response.json() }; };
  const draft = { requestId: randomUUID(), sourceActorId: 'C001', targetActorId: 'C001', materialAssetId: 'P001' };
  try {
    const created = await request(`/api/jobs/${parentId}/local-material`, 'POST', draft);
    assert.equal(created.status, 201, JSON.stringify(created.body)); const id = created.body.id;
    assert.equal(created.body.state, 'needs_calibration'); assert.equal(created.body.billableSeconds, 0); assert.equal(created.body.keyHash, undefined);
    assert.equal(created.body.recipe.localMaterialRepair.donor, null, 'A draft never invents a clean target frame');
    assert.deepEqual(created.body.recipe.localMaterialRepair.processing.appearanceReconstruction,
      { enabled: false, method: 'bounded-material-appearance-v1', isGroundTruth: false });
    assert.deepEqual(created.body.recipe.localMaterialRepair.calibration.appearanceKeyframes, []);
    assert.equal(created.body.recipe.localMaterialRepair.sourceNative.sha256, parent.sourceSHA256);
    assert.notEqual(created.body.recipe.localMaterialRepair.base.sha256, parent.sourceSHA256);
    assert.equal((await request(`/api/jobs/${parentId}/local-material`, 'POST', draft)).status, 200); assert.equal(calls, 0);
    const detail = await request(`/api/local-material/${id}`); assert.equal(detail.body.local.revision, 0); assert.ok(detail.body.local.media.source);
    assert.equal((await request(`/api/local-material/${id}/render`, 'POST', { revision: 0 })).status, 422);
    assert.equal((await request(`/api/local-material/${id}/confirm`, 'POST', { revision: 0, confirmPreview: true })).status, 409);
    assert.equal((await request(`/api/jobs/${parentId}/local-material`, 'POST', { ...draft, requestId: randomUUID(), sourceFile: 'C:/private/video.mp4' })).status, 400);
    assert.equal((await request(`/api/jobs/${parentId}/local-material`, 'POST', { ...draft, requestId: randomUUID(), appearanceReconstruction: { enabled: true, radius: 9 } })).status, 400);
    assert.equal((await request(`/api/jobs/${parentId}/local-material`, 'POST', { ...draft, requestId: randomUUID(), processing: { appearanceReconstruction: { enabled: true } } })).status, 400);
    const optedIn = await request(`/api/jobs/${parentId}/local-material`, 'POST', { ...draft, requestId: randomUUID(), appearanceReconstruction: { enabled: true } });
    assert.equal(optedIn.status, 201, JSON.stringify(optedIn.body));
    assert.deepEqual(optedIn.body.recipe.localMaterialRepair.processing.appearanceReconstruction,
      { enabled: true, method: 'bounded-material-appearance-v1', isGroundTruth: false });
    assert.equal((await request(`/api/local-material/${id}/calibration`, 'PUT', { revision: 0, calibration: { sourceRegion: [{ x: 2, y: 0 }] } })).status, 400);
    assert.equal((await request(`/api/local-material/${id}/calibration`, 'PUT', { revision: 0, sourceSkinReference: { file: 'C:/private.png', frameIndex: 2, reviewed: true } })).status, 400);
    const saved = await request(`/api/local-material/${id}/calibration`, 'PUT', { revision: 0, donor: { frameIndex: 0 }, calibration: {}, sourceSkinReference: { frameIndex: 20, reviewed: false } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.equal(saved.body.local.revision, 1);
    assert.equal(saved.body.recipe.localMaterialRepair.donor.origin, 'target-own-base-frame'); assert.equal(saved.body.recipe.localMaterialRepair.sourceSkinReference.frameIndex, 20);
    assert.equal((await request(`/api/local-material/${id}/calibration`, 'PUT', { revision: 0, calibration: {} })).status, 409);
    const maskFile = path.join(directory, 'mask.png');
    await ffmpeg(['-i', base, '-frames:v', '1', '-update', '1', maskFile]);
    const multipart = new FormData(); multipart.append('file', new Blob([await readFile(maskFile)], { type: 'image/png' }), 'mask.png');
    const uploadResponse = await fetch(`${origin}/api/local-material/uploads?kind=mask`, { method: 'POST', headers: { 'X-CSRF-Token': 'fixture-csrf' }, body: multipart });
    assert.equal(uploadResponse.status, 201); const mask = await uploadResponse.json();
    const masked = await request(`/api/local-material/${id}/calibration`, 'PUT', { revision: 1, calibration: { handKeyframes: [{ side: 'target', frameIndex: 0, strokes: [], uploadId: mask.id }] } });
    assert.equal(masked.status, 200, JSON.stringify(masked.body)); const frame = masked.body.recipe.localMaterialRepair.calibration.handKeyframes[0];
    assert.equal(frame.mask, undefined); assert.ok(frame.maskUrl.endsWith('/hand-mask/0?revision=2'));
    const servedMask = await fetch(origin + frame.maskUrl); assert.equal(servedMask.status, 200); assert.equal(servedMask.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await servedMask.arrayBuffer()), await readFile(maskFile));
    assert.equal((await fetch(`${origin}/api/local-material/${id}/hand-mask/0?revision=1`)).status, 409);
    assert.equal((await fetch(`${origin}/api/local-material/${id}/hand-mask/99?revision=2`)).status, 404);
    assert.equal((await fetch(`${origin}/api/local-material/${id}/hand-mask/0?file=C:/private.png`)).status, 409);
    assert.equal((await request(`/api/local-material/${id}/calibration`, 'PUT', { revision: 2, calibration: {}, sourceOcclusionReconstruction: { enabled: true, radius: 100 } })).status, 400);
    const enabled = await request(`/api/local-material/${id}/calibration`, 'PUT', { revision: 2, calibration: {}, sourceOcclusionReconstruction: { enabled: true } });
    assert.equal(enabled.status, 200); assert.deepEqual(enabled.body.recipe.localMaterialRepair.processing.sourceOcclusionReconstruction,
      { enabled: true, method: 'two-sided-observed-residual-and-bounded-spatial-v1', isGroundTruth: false });
    assert.equal(enabled.body.recipe.localMaterialRepair.processing.appearanceReconstruction.enabled, false, 'old occlusion consent does not opt into appearance reconstruction');
    const pairCalibration = { framePairAnchors: [{ sourceFrame: 30, targetFrame: 29 }, { sourceFrame: 30, targetFrame: 30 }],
      shots: [{ sourceStartFrame: 0, sourceFrames: 90, targetStartFrame: 0, targetFrames: 90, mode: 'material' }] };
    const paired = await request(`/api/local-material/${id}/calibration`, 'PUT', { revision: 3, calibration: pairCalibration });
    assert.equal(paired.status, 200, JSON.stringify(paired.body));
    const storedPairs = paired.body.recipe.localMaterialRepair.calibration;
    assert.deepEqual(storedPairs.framePairAnchors, pairCalibration.framePairAnchors);
    assert.equal(storedPairs.framePairs.length, 90);
    assert.equal(storedPairs.framePairs[29].sourceFrame, 30); assert.equal(storedPairs.framePairs[30].sourceFrame, 30);
    assert.deepEqual(storedPairs.framePairs[0], { sourceFrame: 0, targetFrame: 0 });
    assert.deepEqual(storedPairs.framePairs[89], { sourceFrame: 89, targetFrame: 89 });
    const recalled = (await request(`/api/local-material/${id}`)).body;
    assert.deepEqual(recalled.recipe.localMaterialRepair.calibration.framePairs, storedPairs.framePairs);
    assert.equal((await request(`/api/local-material/${id}/calibration`, 'PUT', { revision: 4,
      calibration: { ...pairCalibration, framePairAnchors: [{ sourceFrame: 30, targetFrame: 30, file: 'C:/private.png' }] } })).status, 400);
    assert.equal((await request(`/api/local-material/${id}/calibration`, 'PUT', { revision: 4,
      calibration: { ...pairCalibration, framePairAnchors: [{ sourceFrame: 30, targetFrame: 30 }, { sourceFrame: 31, targetFrame: 30 }] } })).status, 400);
    assert.equal((await request(`/api/local-material/${id}`)).body.local.revision, 4, 'rejected anchors cannot change the frozen revision');
    const appearanceKeyframes = [
      { frameIndex: 37, region: [{ x: .1, y: .2 }, { x: .2, y: .2 }, { x: .2, y: .3 }], reviewed: true },
      { frameIndex: 37, region: [{ x: .3, y: .2 }, { x: .4, y: .2 }, { x: .4, y: .3 }], reviewed: true }
    ];
    for (const appearanceReconstruction of [{ enabled: 'true' }, { enabled: true, method: 'custom' }, { enabled: true, isGroundTruth: true }, { enabled: true, threshold: 1 }]) {
      assert.equal((await request(`/api/local-material/${id}/calibration`, 'PUT', { revision: 4, calibration: pairCalibration, appearanceReconstruction })).status, 400);
    }
    for (const invalid of [[{ ...appearanceKeyframes[0], frameIndex: 90 }], [{ ...appearanceKeyframes[0], frameIndex: 37.5 }], [{ ...appearanceKeyframes[0], file: 'C:/private.png' }], Array(121).fill(appearanceKeyframes[0])]) {
      assert.equal((await request(`/api/local-material/${id}/calibration`, 'PUT', { revision: 4, calibration: { ...pairCalibration, appearanceKeyframes: invalid } })).status, 400);
    }
    const appearanceSaved = await request(`/api/local-material/${id}/calibration`, 'PUT', { revision: 4,
      calibration: { ...pairCalibration, appearanceKeyframes }, appearanceReconstruction: { enabled: true } });
    assert.equal(appearanceSaved.status, 200, JSON.stringify(appearanceSaved.body));
    assert.equal(appearanceSaved.body.local.revision, 5);
    assert.deepEqual(appearanceSaved.body.recipe.localMaterialRepair.calibration.appearanceKeyframes, appearanceKeyframes);
    assert.equal(appearanceSaved.body.recipe.localMaterialRepair.processing.appearanceReconstruction.enabled, true);
    const disabled = await request(`/api/local-material/${id}/calibration`, 'PUT', { revision: 5,
      calibration: { ...pairCalibration, appearanceKeyframes }, appearanceReconstruction: { enabled: false } });
    assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
    assert.equal(disabled.body.recipe.localMaterialRepair.processing.appearanceReconstruction.enabled, false);
    assert.deepEqual(disabled.body.recipe.localMaterialRepair.calibration.appearanceKeyframes, appearanceKeyframes, 'disabling preserves separately editable exact-frame windows');
    store.update(id, current => { delete current.recipe.localMaterialRepair.processing.appearanceReconstruction; delete current.recipe.localMaterialRepair.calibration.appearanceKeyframes; });
    const legacy = (await request(`/api/local-material/${id}`)).body.recipe.localMaterialRepair;
    assert.deepEqual(legacy.processing.appearanceReconstruction, { enabled: false, method: 'bounded-material-appearance-v1', isGroundTruth: false });
    assert.deepEqual(legacy.calibration.appearanceKeyframes, []);
    assert.equal(JSON.stringify(store.get(parentId)), before); assert.equal(await fileSHA256(base), baseSHA); assert.equal(calls, 0);
  } finally { await engine.stop(); await new Promise(resolve => server.close(resolve)); store.close(); assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(directory, { recursive: true, force: true }); }
});
