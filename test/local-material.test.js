import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.js';
import * as media from '../src/media.js';
import { normalizeLocalRanges, normalizeLocalCalibration, normalizeSourceSkinReference, normalizeLocalOcclusionReconstruction, normalizeLocalAppearanceReconstruction, localCalibrationReady, validateLocalWorkerResult } from '../src/local-material-contract.js';
import { createLocalMaterialDraft, updateLocalCalibration, LocalMaterialEngine, localPath, runLocalWorker } from '../src/local-material.js';

const ranges = { source: { startFrame: 30, frames: 60 }, target: { startFrame: 30, frames: 60 } };
const region = [{ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.7 }, { x: 0.1, y: 0.7 }];
const calibration = () => ({ sourceRegion: region, targetRegion: region, sourceSkinPoints: [{ x: 0.7, y: 0.2 }, { x: 0.8, y: 0.3 }, { x: 0.8, y: 0.6 }, { x: 0.6, y: 0.7 }], targetSkinPoints: [],
  reviewed: true, donorReviewed: true, framePairAnchors: [{ sourceFrame: 30, targetFrame: 30 }, { sourceFrame: 89, targetFrame: 89 }],
  shots: [{ sourceStartFrame: 30, sourceFrames: 60, targetStartFrame: 30, targetFrames: 60 }],
  handKeyframes: ['source', 'target'].map(side => ({ side, frameIndex: 30, strokes: [{ mode: 'protect', radius: 0.025, points: [{ x: 0.2, y: 0.4 }] }] })), postCutCleanup: [] });

test('cleanup border inference requires an enabled reviewed own-frame cleanup and cannot change protected pixels', () => {
  const c = calibration(); c.shots[0].mode = 'preserve';
  c.postCutCleanup = [{ targetStartFrame: 30, targetFrames: 60, donorFrameIndex: 30, region, reviewed: true }];
  const request = { action: 'render', revision: 1, requestHash: 'border', frameRanges: ranges, calibration: normalizeLocalCalibration(c, ranges),
    processing: { appearanceReconstruction: normalizeLocalAppearanceReconstruction({ enabled: true }) } };
  const evidence = { radiusPixels: 2, protectedPixelsChanged: 0, changedOutsideBand: 0 };
  const result = change => ({ schemaVersion: 1, action: 'render', revision: 1, requestHash: 'border', status: 'preview_ready', riskFrames: [],
    checks: { calibrated: true, lowSupportCount: 0, changedOutsideEditablePixels: 0 },
    artifacts: { frames: [{ targetFrame: 37, cleanupBoundaryReconstruction: { ...evidence, ...change } }] } });
  assert.equal(validateLocalWorkerResult(result(), request).status, 'preview_ready');
  for (const change of [{ protectedPixelsChanged: 1 }, { changedOutsideBand: 1 }, { radiusPixels: 3 }])
    assert.equal(validateLocalWorkerResult(result(change), request).status, 'needs_calibration');
  assert.throws(() => validateLocalWorkerResult(result(), { ...request, processing: { appearanceReconstruction: { enabled: false } } }), /未经开启/);
  request.calibration.postCutCleanup = [];
  assert.equal(validateLocalWorkerResult(result(), request).status, 'needs_calibration');
});

test('isolated CPU runner keeps split UTF-8 progress paths intact and explicitly enables Python UTF-8 mode', async () => {
  const progress = [], spawnCalls = [];
  const spawnProcess = (file, args, options) => {
    spawnCalls.push({ file, args, options });
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    queueMicrotask(() => {
      const bytes = Buffer.from(JSON.stringify({ phase: 'render', path: '中文路径/涂抹.png' }) + '\n');
      for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
      child.stdout.end(); child.stderr.end(); child.emit('close', 0);
    }); return child;
  };
  await runLocalWorker({ runtime: { executable: 'owned-python.exe', workerFile: 'owned-worker.py' }, requestFile: 'request.json', resultFile: 'result.json', outputDirectory: 'owned-cache', cancelFile: 'cancel.flag', spawnProcess, onProgress: p => progress.push(p) });
  assert.equal(progress[0].path, '中文路径/涂抹.png'); assert.deepEqual(spawnCalls[0].args.slice(0,4), ['-X','utf8','-I','-B']); assert.equal(spawnCalls[0].options.windowsHide, true);
});

test('local calibration uses normalized source skin, independent ranges, monotonic frames and explicit source-only reference', () => {
  assert.deepEqual(normalizeLocalOcclusionReconstruction({ enabled: true }), { enabled: true, method: 'two-sided-observed-residual-and-bounded-spatial-v1', isGroundTruth: false });
  assert.equal(normalizeLocalOcclusionReconstruction().enabled, false);
  assert.throws(() => normalizeLocalOcclusionReconstruction({ enabled: true, radius: 100 }), /未知字段/);
  assert.throws(() => normalizeLocalOcclusionReconstruction({ enabled: 'true' }), /开启或关闭/);
  assert.deepEqual(normalizeLocalRanges(ranges, { frames: 120 }, { frames: 120 }), ranges);
  const ready = normalizeLocalCalibration(calibration(), ranges);
  assert.equal(localCalibrationReady({ donor: { file: 'donor.png' }, calibration: ready }), true);
  assert.equal(localCalibrationReady({ donor: { file: 'donor.png' }, calibration: { ...ready, sourceSkinPoints: [] } }), false);
  assert.throws(() => normalizeLocalCalibration({ ...calibration(), skinPoints: region }, ranges), /未知字段/);
  assert.throws(() => normalizeLocalCalibration({ ...calibration(), sourceRegion: [{ x: 2, y: 0 }] }, ranges), /归一化/);
  assert.throws(() => normalizeLocalCalibration({ ...calibration(), framePairs: [{ sourceFrame: 89, targetFrame: 30 }, { sourceFrame: 30, targetFrame: 89 }] }, ranges), /单调/);
  assert.throws(() => normalizeSourceSkinReference({ file: 'C:/private.png', frameIndex: 40, reviewed: true }, { frames: 120 }), /未知字段/);
  assert.equal(localCalibrationReady({ donor: { file: 'donor.png' }, calibration: ready, sourceSkinReference: { frameIndex: 119, reviewed: true } }), false);
});

test('hand calibration accepts 120 independent source/target keyframes and rejects the next one', () => {
  const input = calibration();
  input.handKeyframes = ['source', 'target'].flatMap(side => Array.from({ length: 60 }, (_, offset) => ({
    side, frameIndex: 30 + offset, strokes: [{ mode: 'protect', radius: .025, points: [{ x: .2, y: .4 }] }]
  })));
  const c = normalizeLocalCalibration(input, ranges);
  assert.equal(c.handKeyframes.length, 120);
  assert.equal(localCalibrationReady({ donor: { file: 'target.png' }, calibration: c }), true);
  assert.throws(() => normalizeLocalCalibration({ ...input, handKeyframes: [...input.handKeyframes, input.handKeyframes[0]] }, ranges), /手部校准关键帧数量/);
});

test('only cleanup with a same-shot donor avoids global donor review; mixed or material work retains it', () => {
  const base = calibration();
  const cleanup = { targetStartFrame: 45, targetFrames: 15, region, reviewed: true, donorFrameIndex: 30 };
  const c = normalizeLocalCalibration({ ...base, donorReviewed: false, sourceRegion: [], targetRegion: [], sourceSkinPoints: [],
    shots: base.shots.map(shot => ({ ...shot, mode: 'preserve' })), postCutCleanup: [cleanup] }, ranges);
  assert.equal(localCalibrationReady({ calibration: c }), true, 'own same-shot donor supplies all pure-preserve cleanups');
  assert.equal(localCalibrationReady({ donor: { file: 'unused-unreviewed-global.png' }, calibration: c }), true,
    'an unused global portrait cannot override the chosen same-shot donor');
  assert.equal(localCalibrationReady({ calibration: { ...c, reviewed: false } }), false, 'the cleanup itself still requires review');
  assert.equal(localCalibrationReady({ calibration: { ...c, postCutCleanup: [{ ...cleanup, reviewed: false }] } }), false);
  const { donorFrameIndex, ...usesGlobal } = cleanup;
  const mixed = { ...c, postCutCleanup: [cleanup, { ...usesGlobal, targetStartFrame: 60, targetFrames: 15 }] };
  assert.equal(localCalibrationReady({ calibration: mixed }), false, 'one cleanup without its own frame requires a global donor');
  assert.equal(localCalibrationReady({ donor: { file: 'target.png' }, calibration: mixed }), false, 'global donor must be reviewed');
  assert.equal(localCalibrationReady({ donor: { file: 'target.png' }, calibration: { ...mixed, donorReviewed: true } }), true);
  const material = normalizeLocalCalibration({ ...base, donorReviewed: false }, ranges);
  assert.equal(localCalibrationReady({ donor: { file: 'target.png' }, calibration: material }), false, 'material transfer always requires global donor review');
});

test('artistic appearance consent uses exact target windows and remains independent of source occlusion', () => {
  const config = normalizeLocalAppearanceReconstruction({ enabled: true });
  assert.deepEqual(config, { enabled: true, method: 'bounded-material-appearance-v1', isGroundTruth: false });
  assert.equal(normalizeLocalAppearanceReconstruction().enabled, false);
  for (const value of [null, {}, { enabled: 1 }, { enabled: true, radius: 9 }, { enabled: true, isGroundTruth: true }, { enabled: true, method: 'other' }]) {
    assert.throws(() => normalizeLocalAppearanceReconstruction(value));
  }
  const first = { frameIndex: 37, region, reviewed: true }, second = { frameIndex: 37, region: region.map(p => ({ x: p.x + .1, y: p.y })), reviewed: true };
  const c = normalizeLocalCalibration({ ...calibration(), appearanceKeyframes: [first, second] }, ranges);
  const spec = { donor: { file: 'target.png' }, calibration: c, processing: { appearanceReconstruction: config } };
  assert.deepEqual(c.appearanceKeyframes, [first, second], 'same-frame windows are not merged, deduplicated or expanded to other frames');
  assert.equal(localCalibrationReady(spec), true);
  assert.deepEqual(normalizeLocalCalibration(calibration(), ranges).appearanceKeyframes, []);
  for (const frame of [{ ...first, reviewed: false }, { ...first, region: region.slice(0, 2) }]) {
    const incomplete = { ...c, appearanceKeyframes: [frame] };
    assert.equal(localCalibrationReady({ ...spec, calibration: incomplete }), false);
    assert.equal(localCalibrationReady({ ...spec, calibration: incomplete, processing: { appearanceReconstruction: { enabled: false } } }), true,
      'disabled annotations remain editable and do not affect the strict branch');
    assert.equal(localCalibrationReady({ ...spec, calibration: incomplete, processing: { sourceOcclusionReconstruction: { enabled: true } } }), true,
      'source occlusion consent never opts into artistic appearance');
  }
  const cutRanges = { source: { startFrame: 30, frames: 60 }, target: { startFrame: 30, frames: 60 } };
  const cut = normalizeLocalCalibration({ ...calibration(), framePairAnchors: [], appearanceKeyframes: [{ ...first, frameIndex: 70 }], shots: [
    { sourceStartFrame: 30, sourceFrames: 30, targetStartFrame: 30, targetFrames: 30, mode: 'material' },
    { sourceStartFrame: 60, sourceFrames: 30, targetStartFrame: 60, targetFrames: 30, mode: 'preserve' }
  ] }, cutRanges);
  assert.equal(localCalibrationReady({ ...spec, calibration: cut }), false, 'preserved shots cannot authorize appearance changes');
  for (const appearanceKeyframes of [null, {}, Array(121).fill(first), [{ ...first, frameIndex: 29 }], [{ ...first, frameIndex: 90 }],
    [{ ...first, frameIndex: 37.5 }], [{ ...first, frameIndex: '37' }], [{ ...first, region: [{ x: -1, y: 0 }] }], [{ ...first, file: 'C:/private.png' }], [{ ...first, reviewed: 'true' }]]) {
    assert.throws(() => normalizeLocalCalibration({ ...calibration(), appearanceKeyframes }, ranges));
  }
});

test('worker readiness cannot bypass appearance review, unresolved risks or measured-support gates', () => {
  const c = normalizeLocalCalibration({ ...calibration(), appearanceKeyframes: [{ frameIndex: 37, region, reviewed: false }] }, ranges);
  const request = { action: 'render', revision: 1, requestHash: 'frozen', frameRanges: ranges, targetSkin: { file: 'target.png' }, calibration: c,
    processing: { appearanceReconstruction: normalizeLocalAppearanceReconstruction({ enabled: true }) } };
  const raw = { schemaVersion: 1, action: 'render', revision: 1, requestHash: 'frozen', status: 'preview_ready', riskFrames: [],
    checks: { calibrated: true, lowSupportCount: 0, changedOutsideEditablePixels: 0 } };
  assert.equal(validateLocalWorkerResult(raw, request).status, 'needs_calibration');
  request.calibration.appearanceKeyframes[0].reviewed = true;
  assert.equal(validateLocalWorkerResult(raw, request).status, 'preview_ready');
  assert.equal(validateLocalWorkerResult({ ...raw, checks: { ...raw.checks, lowSupportCount: 1 } }, request).status, 'needs_calibration');
  assert.equal(validateLocalWorkerResult({ ...raw, riskFrames: [{ id: 'appearance-remaining', reason: 'bounded reconstruction leaves unknown pixels', targetFrame: 37 }] }, request).status, 'needs_calibration');
  const withAppearance = { ...raw, artifacts: { frames: [{ targetFrame: 37, appearanceReconstruction: { featureChangedPixels: 0, protectedOldHandChangedPixels: 0 } }] } };
  assert.equal(validateLocalWorkerResult(withAppearance, request).status, 'preview_ready');
  for (const field of ['featureChangedPixels', 'protectedOldHandChangedPixels']) {
    assert.equal(validateLocalWorkerResult({ ...withAppearance, artifacts: { frames: [{ targetFrame: 37, appearanceReconstruction: { [field]: 1 } }] } }, request).status, 'needs_calibration');
  }
  assert.throws(() => validateLocalWorkerResult(withAppearance, { ...request, processing: { appearanceReconstruction: { enabled: false } } }), /未经开启/);
});

test('sparse reviewed frame anchors cover every real target frame, retain repeated source frames and stay inside each cut', () => {
  const ranges = { source: { startFrame: 10, frames: 14 }, target: { startFrame: 20, frames: 18 } };
  const shots = [
    { sourceStartFrame: 10, sourceFrames: 3, targetStartFrame: 20, targetFrames: 4, mode: 'preserve' },
    { sourceStartFrame: 13, sourceFrames: 8, targetStartFrame: 24, targetFrames: 10, mode: 'material' },
    { sourceStartFrame: 21, sourceFrames: 3, targetStartFrame: 34, targetFrames: 4, mode: 'preserve' }
  ];
  const anchors = [{ sourceFrame: 16, targetFrame: 28 }, { sourceFrame: 16, targetFrame: 29 }];
  const result = normalizeLocalCalibration({ shots, framePairAnchors: anchors }, ranges);
  assert.deepEqual(result.framePairAnchors, anchors);
  assert.equal(result.framePairs.length, 18);
  assert.deepEqual(result.framePairs.map(pair => pair.targetFrame), Array.from({ length: 18 }, (_, i) => 20 + i));
  for (const [targetFrame, sourceFrame] of [[20,10],[23,12],[24,13],[28,16],[29,16],[33,20],[34,21],[37,23]]) {
    assert.equal(result.framePairs.find(pair => pair.targetFrame === targetFrame).sourceFrame, sourceFrame);
  }
  assert.ok(result.framePairs.every(pair => Number.isInteger(pair.sourceFrame) && shots.some(shot =>
    pair.targetFrame >= shot.targetStartFrame && pair.targetFrame < shot.targetStartFrame + shot.targetFrames
    && pair.sourceFrame >= shot.sourceStartFrame && pair.sourceFrame < shot.sourceStartFrame + shot.sourceFrames)));
  assert.deepEqual(normalizeLocalCalibration(result, ranges), result, 're-saving a frozen expanded map is idempotent');
  const explicit = result.framePairs.map(pair => ({ ...pair }));
  assert.deepEqual(normalizeLocalCalibration({ shots, framePairs: explicit }, ranges).framePairs, explicit, 'existing complete maps are not retimed');
  assert.throws(() => normalizeLocalCalibration({ shots, framePairAnchors: [{ sourceFrame: 12, targetFrame: 25 }] }, ranges), /同一组已标注镜头/);
  assert.throws(() => normalizeLocalCalibration({ shots, framePairAnchors: [{ sourceFrame: 15, targetFrame: 24 }] }, ranges), /实际镜头端点/);
  assert.throws(() => normalizeLocalCalibration({ shots, framePairAnchors: [{ sourceFrame: 16, targetFrame: 28 }, { sourceFrame: 17, targetFrame: 28 }] }, ranges), /重复目标帧/);
  assert.throws(() => normalizeLocalCalibration({ shots, framePairAnchors: [{ sourceFrame: 17, targetFrame: 28 }, { sourceFrame: 16, targetFrame: 29 }] }, ranges), /单调/);
  assert.throws(() => normalizeLocalCalibration({ shots, framePairAnchors: [{ sourceFrame: 16.5, targetFrame: 28 }] }, ranges), /有效帧范围/);
  assert.throws(() => normalizeLocalCalibration({ shots, framePairAnchors: [{ sourceFrame: 16, targetFrame: 28, file: 'private.png' }] }, ranges), /未知字段/);
  const single = normalizeLocalCalibration({ shots: [{ sourceStartFrame: 10, sourceFrames: 1, targetStartFrame: 20, targetFrames: 1 }],
    framePairAnchors: [{ sourceFrame: 10, targetFrame: 20 }] }, { source: { startFrame: 10, frames: 1 }, target: { startFrame: 20, frames: 1 } });
  assert.deepEqual(single.framePairs, [{ targetFrame: 20, sourceFrame: 10 }]);
  const ready = normalizeLocalCalibration({ ...calibration(), framePairAnchors: [], framePairs: [{ sourceFrame: 30, targetFrame: 30 }] },
    { source: { startFrame: 30, frames: 60 }, target: { startFrame: 30, frames: 60 } });
  assert.equal(localCalibrationReady({ donor: { file: 'target.png' }, calibration: ready }), false, 'old incomplete explicit maps fail before worker launch');
});

test('material transfer stays in its reviewed shot, while surrounding preserve shots and independent cleanup stay distinct', () => {
  const threeRanges = { source: { startFrame: 0, frames: 151 }, target: { startFrame: 0, frames: 150 } };
  const input = { ...calibration(), anchorPair: { sourceFrame: 20, targetFrame: 20 }, framePairAnchors: [], framePairs: [], shots: [
    { sourceStartFrame: 0, sourceFrames: 15, targetStartFrame: 0, targetFrames: 15, mode: 'preserve' },
    { sourceStartFrame: 15, sourceFrames: 71, targetStartFrame: 15, targetFrames: 70, mode: 'material' },
    { sourceStartFrame: 86, sourceFrames: 65, targetStartFrame: 85, targetFrames: 65, mode: 'preserve' }
  ], handKeyframes: ['source', 'target'].map(side => ({ side, frameIndex: 15,
    strokes: [{ mode: 'protect', radius: 0.025, points: [{ x: 0.2, y: 0.4 }] }] })),
    postCutCleanup: [{ targetStartFrame: 85, targetFrames: 65, region, reviewed: true }] };
  const normalized = normalizeLocalCalibration(input, threeRanges);
  const spec = { donor: { file: 'target-own-skin.png' }, calibration: normalized, sourceSkinReference: { frameIndex: 50, reviewed: true } };
  assert.equal(localCalibrationReady(spec), true, 'unequal material spans use the reviewed-shot mapping without invented frame pairs');
  const materialKeyframes = normalizeLocalCalibration({ ...input, targetMaterialKeyframes: [{ frameIndex: 37, region, reviewed: true }] }, threeRanges);
  assert.equal(localCalibrationReady({ ...spec, calibration: materialKeyframes }), true);
  assert.equal(localCalibrationReady({ ...spec, calibration: { ...materialKeyframes, targetMaterialKeyframes: [{ frameIndex: 5, region, reviewed: true }] } }), false,
    'a preserved actor cannot provide the material target region');
  assert.equal(localCalibrationReady({ ...spec, calibration: { ...materialKeyframes, targetMaterialKeyframes: [{ frameIndex: 37, region, reviewed: false }] } }), false,
    'unreviewed manual material selection never becomes a rendered acceptance');
  assert.throws(() => normalizeLocalCalibration({ ...input, targetMaterialKeyframes: [{ frameIndex: 37, region, reviewed: true, file: 'private.png' }] }, threeRanges), /未知字段/);
  const fullPairs = Array.from({ length: 150 }, (_, targetFrame) => ({ targetFrame, sourceFrame: targetFrame < 15 ? targetFrame : targetFrame < 85
    ? 15 + Math.round((targetFrame - 15) * 70 / 69) : 86 + Math.round((targetFrame - 85) * 64 / 64) }));
  assert.equal(normalizeLocalCalibration({ ...input, framePairs: fullPairs }, threeRanges).framePairs.length, 150, 'the contract accepts one explicit real mapping per output frame');
  assert.equal(localCalibrationReady({ ...spec, calibration: { ...normalized, framePairs: [{ sourceFrame: 0, targetFrame: 15 }] } }), false,
    'explicit correspondence cannot route a preserved source actor into a material target shot');
  assert.deepEqual(normalized.shots.map(shot => shot.mode), ['preserve', 'material', 'preserve']);
  assert.equal(localCalibrationReady({ ...spec, sourceSkinReference: { frameIndex: 5, reviewed: true } }), false, 'another actor/preserved first shot cannot supply the material reference');
  assert.equal(localCalibrationReady({ ...spec, sourceSkinReference: { frameIndex: 90, reviewed: true } }), false, 'finished display shot cannot cross the material boundary');
  assert.equal(localCalibrationReady({ ...spec, calibration: { ...normalized, anchorPair: { sourceFrame: 5, targetFrame: 20 } } }), false,
    'ROI drawn on the first preserved actor cannot be applied to the material actor');
  assert.equal(localCalibrationReady({ ...spec, calibration: { ...normalized, anchorPair: { sourceFrame: 20, targetFrame: 90 } } }), false,
    'source and target ROI anchors must belong to the same material shot');
  assert.throws(() => normalizeLocalCalibration({ ...input, anchorPair: { sourceFrame: 20, targetFrame: 150 } }, threeRanges), /目标区域绘制帧/);
  assert.throws(() => normalizeLocalCalibration({ ...input, anchorPair: { sourceFrame: 20, targetFrame: 20, file: 'private.png' } }, threeRanges), /未知字段/);
  assert.equal(localCalibrationReady({ ...spec, calibration: { ...normalized, handKeyframes: normalized.handKeyframes.map(frame => ({ ...frame, frameIndex: 0 })) } }), false,
    'mask controls from the preserved actor cannot satisfy a material-shot calibration');
  assert.throws(() => normalizeLocalCalibration({ ...input, shots: input.shots.map((shot, index) => index === 1 ? { ...shot, mode: 'auto' } : shot) }, threeRanges), /镜头处理方式/);
  assert.equal(normalizeLocalCalibration(calibration(), ranges).shots[0].mode, 'material', 'legacy shot entries retain material behavior');
  const cleanupOnly = { ...normalized, anchorPair: undefined, shots: normalized.shots.map(shot => ({ ...shot, mode: 'preserve' })), sourceRegion: [], targetRegion: [], sourceSkinPoints: [],
    handKeyframes: normalized.handKeyframes.filter(frame => frame.side === 'target') };
  assert.equal(localCalibrationReady({ donor: spec.donor, calibration: cleanupOnly }), true, 'reviewed cleanup of own target needs no source transfer');
  assert.equal(localCalibrationReady({ donor: spec.donor, calibration: { ...cleanupOnly, postCutCleanup: [] } }), false, 'preserve alone is not a completed material repair');
  const localDonor = normalizeLocalCalibration({ ...cleanupOnly, donorReviewed: false,
    postCutCleanup: [{ targetStartFrame: 108, targetFrames: 42, region, reviewed: true, donorFrameIndex: 85 }] }, threeRanges);
  assert.equal(localCalibrationReady({ calibration: localDonor }), true, 'a cleanup-only task can use its own same-shot target donor without a global portrait');
  assert.equal(localCalibrationReady({ calibration: { ...localDonor, postCutCleanup: [{ ...localDonor.postCutCleanup[0], donorFrameIndex: 14 }] } }), false,
    'a target donor from another preserved shot is not interchangeable');
  assert.equal(localCalibrationReady({ calibration: { ...localDonor, postCutCleanup: [{ ...localDonor.postCutCleanup[0], donorFrameIndex: 50 }] } }), false,
    'cleanup donors must not be taken from the active material shot');
  assert.throws(() => normalizeLocalCalibration({ ...cleanupOnly, postCutCleanup: [{ targetStartFrame: 108, targetFrames: 42, region, reviewed: true, donorFrameIndex: 150 }] }, threeRanges), /自身清肤帧/);
});

export async function localFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yingti-local-contract-')), store = new Store(directory);
  const initialId = randomUUID(), parentId = randomUUID();
  const initialRoot = path.join(directory, 'jobs', initialId), parentRoot = path.join(directory, 'jobs', parentId); await mkdir(initialRoot, { recursive: true }); await mkdir(parentRoot);
  const source = path.join(initialRoot, 'original.mp4'), base = path.join(parentRoot, 'result.mp4');
  await media.ffmpeg(['-f', 'lavfi', '-i', 'color=red:size=64x96:rate=30:duration=4', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
  await media.ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=64x96:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '4', base]);
  const story = { assets: [{ id: 'C001', type: 'character', name: '测试人物' }, { id: 'P001', type: 'prop', name: '膏体材质' }], actions: [], dialogues: [], shots: [] };
  const initial = { id: initialId, created: new Date().toISOString(), state: 'completed', workflow: 'studio', sourceFile: 'original.mp4', sourceSHA256: await media.fileSHA256(source), recipe: { story, edits: { assets: {} } }, segments: [] };
  store.create(initial);
  const parent = { id: parentId, parentJobId: initialId, created: new Date().toISOString(), state: 'completed', workflow: 'studio', sourceFile: 'base.mp4', source: await media.probe(base),
    title: '已编辑成片', keyHash: 'unavailable-old-key', recipe: { story, edits: { assets: {} }, actionRebuild: { parentJobId: initialId } }, segments: [] };
  store.create(parent);
  const runtimeRoot = path.join(directory, 'fake-runtime'); await mkdir(runtimeRoot);
  const paths = {};
  for (const name of ['python.exe', 'worker.py', 'manifest.json', 'face.task', 'hand.task']) { paths[name] = path.join(runtimeRoot, name); await writeFile(paths[name], name); }
  const runtime = { executable: paths['python.exe'], workerFile: paths['worker.py'], manifestFile: paths['manifest.json'], version: 'test-injected-runner', models: { face: { file: paths['face.task'] }, hand: { file: paths['hand.task'] } } };
  const options = { store, directory, parent, id: randomUUID(), sourceActorId: 'C001', targetActorId: 'C001', materialAssetId: 'P001', ranges, runtime, donor: { frameIndex: 0 } };
  return { directory, store, parent, source, base, runtime, options, close: async () => { store.close(); assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(directory, { recursive: true, force: true }); } };
}
const idle = async engine => { for (let count = 0; engine.active && count < 2000; count++) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(engine.active, null); };
const fakeResult = request => ({ schemaVersion: 1, action: request.action, revision: request.revision, requestHash: request.requestHash, status: 'preview_ready', riskFrames: [], checks: { calibrated: true, lowSupportCount: 0, changedOutsideEditablePixels: 0 } });

test('a keyless draft traces the original studio source rather than treating its edited base as original', { timeout: 60000 }, async () => {
  const f = await localFixture();
  try {
    const before = JSON.stringify(f.store.get(f.parent.id)), job = await createLocalMaterialDraft(f.options), spec = job.recipe.localMaterialRepair;
    assert.equal(job.state, 'needs_calibration'); assert.equal(job.billableSeconds, 0); assert.equal(spec.cost.providerCalls, 0);
    assert.equal(spec.sourceNative.sha256, await media.fileSHA256(f.source)); assert.equal(spec.base.sha256, await media.fileSHA256(f.base));
    assert.notEqual(spec.sourceNative.sha256, spec.base.sha256); assert.equal(spec.sourceNative.provenance.kind, 'initial_studio');
    assert.equal(spec.sourceNative.knownHashVerified, true); assert.equal((await createLocalMaterialDraft(f.options)).id, job.id);
    assert.equal(JSON.stringify(f.store.get(f.parent.id)), before); assert.equal(f.store.list().length, 3);
  } finally { await f.close(); }
});

test('incomplete calibration never runs render, and low support never becomes preview or completed', { timeout: 60000 }, async () => {
  const f = await localFixture(); let engine;
  try {
    const job = await createLocalMaterialDraft(f.options); let calls = 0;
    engine = new LocalMaterialEngine({ store: f.store, directory: f.directory, runtime: f.runtime, runner: async ({ request, resultFile }) => { calls++; await writeFile(resultFile, JSON.stringify({ ...fakeResult(request), checks: { calibrated: true, lowSupportCount: 1, changedOutsideEditablePixels: 0 }, riskFrames: [{ id: 'unsupported', targetFrame: 45, reason: '原片裸肤不足', resolved: false }] })); } });
    assert.throws(() => engine.enqueue(job.id, 0, 'render'), /至少四个源裸肤点/); assert.equal(calls, 0);
    await updateLocalCalibration({ store: f.store, directory: f.directory, id: job.id, revision: 0, input: { revision: 0, calibration: calibration() } });
    engine.enqueue(job.id, 1, 'render'); await idle(engine);
    assert.equal(f.store.get(job.id).local.state, 'needs_calibration'); assert.equal(f.store.get(job.id).local.preview, undefined); assert.equal(calls, 1);
    await assert.rejects(() => engine.confirm(job.id, 1, true), /完整预览/);
  } finally { await engine?.stop(); await f.close(); }
});

test('CPU preview retains total frames and audio, requires manual confirmation, and a revision invalidates old acceptance/cache', { timeout: 60000 }, async () => {
  const f = await localFixture(); let engine;
  try {
    const parentBefore = JSON.stringify(f.store.get(f.parent.id)), job = await createLocalMaterialDraft(f.options); let calls = 0;
    engine = new LocalMaterialEngine({ store: f.store, directory: f.directory, runtime: f.runtime, runner: async ({ request, resultFile, outputDirectory }) => {
      assert.equal(request.processing.targetMaterialCandidateMethod, 'reviewed-region-or-own-donor-relative-residual-v1');
      assert.equal(request.processing.targetMaterialCandidateIsGroundTruth, false);
      calls++; const file = path.join(outputDirectory, 'visual.mp4'), r = request.frameRanges.target;
      await media.ffmpeg(['-i', request.baseVideo.file, '-vf', `trim=start_frame=${r.startFrame}:end_frame=${r.startFrame + r.frames},setpts=N/(30*TB)`, '-an', '-frames:v', String(r.frames), '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv420p', file]);
      await writeFile(resultFile, JSON.stringify({ ...fakeResult(request), localClip: { file } }));
    } });
    await updateLocalCalibration({ store: f.store, directory: f.directory, id: job.id, revision: 0, input: { revision: 0, calibration: calibration(), sourceSkinReference: { frameIndex: 40, reviewed: true } } });
    engine.enqueue(job.id, 1, 'render'); await idle(engine);
    const ready = f.store.get(job.id); assert.equal(ready.state, 'preview_ready'); assert.equal(ready.local.preview.frames, 120); assert.equal(calls, 1);
    assert.equal(ready.local.preview.hasAudio, true); assert.notEqual(ready.state, 'completed');
    await assert.rejects(() => engine.confirm(job.id, 1, false));
    const previewFile = localPath(path.join(f.directory, 'jobs', job.id), ready.local.preview.file);
    const audioHash = async file => (await media.ffmpeg(['-i', file, '-map', '0:a', '-c:a', 'copy', '-f', 'md5', '-'])).trim();
    assert.equal(await audioHash(previewFile), await audioHash(f.base));
    const changed = await updateLocalCalibration({ store: f.store, directory: f.directory, id: job.id, revision: 1, input: { revision: 1, calibration: { ...calibration(), reviewed: false } } });
    assert.equal(changed.local.revision, 2); assert.equal(changed.local.preview, undefined); assert.equal(changed.state, 'needs_calibration');
    await assert.rejects(() => engine.confirm(job.id, 1, true)); assert.ok(await readFile(previewFile));
    await updateLocalCalibration({ store: f.store, directory: f.directory, id: job.id, revision: 2, input: { revision: 2, calibration: calibration() } });
    engine.enqueue(job.id, 3, 'render'); await idle(engine); assert.equal(calls, 2);
    const confirmed = await engine.confirm(job.id, 3, true); assert.equal(confirmed.state, 'completed'); assert.equal(confirmed.local.state, 'confirmed');
    assert.equal(confirmed.quality.contentState, 'unverified', 'Local user approval is not a fabricated whole-film AI audit');
    assert.equal(JSON.stringify(f.store.get(f.parent.id)), parentBefore);
  } finally { await engine?.stop(); await f.close(); }
});

test('cancellation preserves draft and resume invokes only the local runner, with no cloud or KEY calls', { timeout: 60000 }, async () => {
  const f = await localFixture(); let engine;
  try {
    const job = await createLocalMaterialDraft({ ...f.options, donor: undefined }); let calls = 0;
    engine = new LocalMaterialEngine({ store: f.store, directory: f.directory, runtime: f.runtime, runner: async ({ request, resultFile, signal }) => {
      calls++; if (calls === 1) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      else await writeFile(resultFile, JSON.stringify({ ...fakeResult(request), status: 'needs_calibration', checks: {}, riskFrames: [{ id: 'needs-donor', targetFrame: 30, reason: '请导入目标自身清肤参考' }] }));
    } });
    engine.enqueue(job.id, 0, 'analyse');
    for (let count = 0; calls === 0 && count < 1000; count++) await new Promise(resolve => setTimeout(resolve, 5));
    await engine.cancel(job.id); await idle(engine); assert.equal(f.store.get(job.id).state, 'local_paused');
    engine.resume(job.id, 0); await idle(engine); assert.equal(calls, 2); assert.equal(f.store.get(job.id).state, 'needs_calibration');
    assert.equal(f.store.get(job.id).billableSeconds, 0);
  } finally { await engine?.stop(); await f.close(); }
});

test('CPU delivery keeps accepted AAC tail packets instead of stopping audio mux at the last video frame', { timeout: 60000 }, async () => {
  const f = await localFixture(); let engine;
  try {
    const extended = path.join(f.directory, 'base-with-aac-tail.mp4');
    await media.ffmpeg(['-i', f.base, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=4.03', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-ar', '44100', extended]);
    await copyFile(extended, f.base);
    const job = await createLocalMaterialDraft(f.options);
    engine = new LocalMaterialEngine({ store: f.store, directory: f.directory, runtime: f.runtime, runner: async ({ request, resultFile, outputDirectory }) => {
      const file = path.join(outputDirectory, 'visual.mp4'), r = request.frameRanges.target;
      await media.ffmpeg(['-i', request.baseVideo.file, '-vf', `trim=start_frame=${r.startFrame}:end_frame=${r.startFrame+r.frames},setpts=N/(30*TB)`, '-an', '-frames:v', String(r.frames), '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv420p', file]);
      await writeFile(resultFile, JSON.stringify({ ...fakeResult(request), localClip: { file } }));
    } });
    await updateLocalCalibration({ store: f.store, directory: f.directory, id: job.id, revision: 0, input: { revision: 0, calibration: calibration() } });
    engine.enqueue(job.id, 1, 'render'); await idle(engine);
    const ready = f.store.get(job.id); assert.equal(ready.local.state, 'preview_ready'); assert.equal(ready.local.preview.frames, 120);
    const file = localPath(path.join(f.directory, 'jobs', job.id), ready.local.preview.file);
    const packets = async f => (await media.ffmpeg(['-i', f, '-map', '0:a:0', '-c:a', 'copy', '-f', 'framemd5', '-'])).split('\n').filter(line => line && !line.startsWith('#'));
    assert.deepEqual(await packets(file), await packets(f.base), 'all accepted AAC packets and their tail metadata survive');
  } finally { await engine?.stop(); await f.close(); }
});

test('processing-module changes invalidate CPU cache even when entrypoint is unchanged, while pycache is ignored', { timeout: 60000 }, async () => {
  const f = await localFixture(); let engine;
  try {
    const workerDirectory = path.join(f.directory, 'worker-package'); await mkdir(workerDirectory); await writeFile(path.join(workerDirectory, 'geometry.py'), 'v1');
    f.runtime.workerDirectory = workerDirectory;
    const job = await createLocalMaterialDraft(f.options); let calls = 0;
    engine = new LocalMaterialEngine({ store: f.store, directory: f.directory, runtime: f.runtime, runner: async ({ request, resultFile }) => {
      calls++; const mask = path.join(path.dirname(resultFile), 'diagnostic-mask.png'); await writeFile(mask, 'diagnostic test pixels');
      const savedRuntime = f.store.get(job.id).recipe.localMaterialRepair.runtime; assert.equal(savedRuntime.workerSHA256, request.runtime.workerSHA256, 'the exact executing runtime is frozen before the worker runs');
      await writeFile(resultFile, JSON.stringify({ ...fakeResult(request), status: 'needs_calibration', checks: {}, riskFrames: [{ id: 'global-calibration', targetFrame: null, reason: '请核对遮挡mask' }],
        artifacts: { frames: [], diagnostics: [{ kind: 'target_material_candidate', side: 'target', frameIndex: 37, file: mask, isGroundTruth: false },
          { kind: 'target_editable', side: 'target', frameIndex: 37, file: mask, isGroundTruth: false }, { kind: 'source_hand_exclusion', side: 'source', frameIndex: 37, file: mask, isGroundTruth: false }] } }));
    } });
    engine.enqueue(job.id, 0, 'analyse'); await idle(engine); const first = f.store.get(job.id).local.requestHash; assert.equal(calls, 1);
    const diagnostics = f.store.get(job.id).local.artifacts; assert.equal(diagnostics.length, 3); assert.equal(new Set(diagnostics.map(item => item.id)).size, 3);
    assert.ok(diagnostics.every(item => /^[a-z0-9_-]+$/i.test(item.id) && !path.isAbsolute(item.file) && item.isGroundTruth === false));
    await writeFile(path.join(workerDirectory, 'geometry.py'), 'v2');
    engine.enqueue(job.id, 0, 'analyse'); await idle(engine); const second = f.store.get(job.id).local.requestHash; assert.notEqual(second, first); assert.equal(calls, 2);
    await mkdir(path.join(workerDirectory, '__pycache__')); await writeFile(path.join(workerDirectory, '__pycache__', 'ignored.py'), 'not executed');
    engine.enqueue(job.id, 0, 'analyse'); await idle(engine); assert.equal(f.store.get(job.id).local.requestHash, second); assert.equal(calls, 2);
  } finally { await engine?.stop(); await f.close(); }
});

test('appearance diagnostics retain inferred provenance, distinct safe files and statistics without approving content', { timeout: 60000 }, async () => {
  const f = await localFixture(); let engine;
  try {
    const job = await createLocalMaterialDraft({ ...f.options, appearanceReconstruction: { enabled: true } });
    let escape = false;
    engine = new LocalMaterialEngine({ store: f.store, directory: f.directory, runtime: f.runtime, runner: async ({ request, resultFile, outputDirectory }) => {
      assert.deepEqual(request.processing.appearanceReconstruction, { enabled: true, method: 'bounded-material-appearance-v1', isGroundTruth: false });
      const file = path.join(outputDirectory, 'appearance-mask.png'); await writeFile(file, 'diagnostic fixture');
      const fields = ['timeInferredBoundaryFile', 'timeInferredPatchFile', 'harmonicInferredFile', 'remainingUnknownFile', 'oldHandOverrideFile'];
      const appearanceArtifacts = Object.fromEntries(fields.map(field => [field, file]));
      if (escape) appearanceArtifacts.evidenceFile = path.join(outputDirectory, '..', 'foreign-evidence.npz');
      await writeFile(resultFile, JSON.stringify({ ...fakeResult(request), status: 'needs_calibration',
        artifacts: { appearanceReconstruction: { method: 'worker-claim', isGroundTruth: true, windowFrames: 9 },
          frames: [{ file, targetFrame: 37, appearanceArtifacts, appearanceReconstruction: { method: 'worker-claim', isGroundTruth: true,
            acceptedPixels: 12, timeInferredBoundaryPixels: 24, harmonicInferredPixels: 12, oldHandAuthorizedOverridePixels: 5, oldHandChangedPixels: 5,
            featureChangedPixels: 0, protectedOldHandChangedPixels: 0 } }],
          diagnostics: fields.map(field => ({ kind: 'appearance_' + field.slice(0, -4), side: 'target', frameIndex: 37, file, isGroundTruth: true })) } }));
    } });
    engine.enqueue(job.id, 0, 'analyse'); await idle(engine);
    const result = f.store.get(job.id);
    assert.equal(result.state, 'needs_calibration'); assert.equal(result.local.preview, undefined);
    assert.deepEqual(result.local.result.appearanceReconstruction, { enabled: true, method: 'bounded-material-appearance-v1', isGroundTruth: false, windowFrames: 9 });
    const [frame, ...diagnostics] = result.local.artifacts;
    assert.equal(frame.appearanceReconstruction.isGroundTruth, false); assert.equal(frame.appearanceReconstruction.method, 'bounded-material-appearance-v1');
    assert.equal(frame.appearanceReconstruction.harmonicInferredPixels, 12); assert.equal(frame.appearanceReconstruction.oldHandChangedPixels, 5);
    assert.ok(Object.values(frame.appearanceArtifacts).every(file => !path.isAbsolute(file) && file.startsWith('local-cache')));
    assert.ok(diagnostics.every(item => item.isGroundTruth === false && !path.isAbsolute(item.file)));
    assert.equal(new Set(diagnostics.map(item => item.id)).size, 5);
    await assert.rejects(() => engine.confirm(job.id, 0, true), /完整预览/);
    escape = true;
    await updateLocalCalibration({ store: f.store, directory: f.directory, id: job.id, revision: 0, input: { revision: 0, calibration: {} } });
    engine.enqueue(job.id, 1, 'analyse'); await idle(engine);
    assert.match(f.store.get(job.id).error, /当前任务目录/);
    assert.equal(f.store.get(job.id).local.preview, undefined);
  } finally { await engine?.stop(); await f.close(); }
});

test('shutdown waits until the owned local runner exits before allowing SQLite to close', { timeout: 60000 }, async () => {
  const f = await localFixture(); let engine;
  try {
    const job = await createLocalMaterialDraft(f.options); let entered = false, exited = false;
    engine = new LocalMaterialEngine({ store: f.store, directory: f.directory, runtime: f.runtime, runner: async ({ signal }) => {
      entered = true; await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      await new Promise(resolve => setTimeout(resolve, 40)); exited = true;
    } });
    engine.enqueue(job.id, 0, 'analyse'); for (let count = 0; !entered && count < 1000; count++) await new Promise(resolve => setTimeout(resolve, 5));
    await engine.stop(); assert.equal(exited, true); assert.equal(engine.active, null); assert.equal(f.store.get(job.id).local.state, 'paused');
  } finally { await engine?.stop(); await f.close(); }
});
