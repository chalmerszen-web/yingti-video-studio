import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { openAsBlob } from 'node:fs';
import { mkdtemp, mkdir, rm, readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { KeyVault } from '../src/keys.js';
import { createApp } from '../src/server.js';
import { ffmpeg, probe, fileSHA256 } from '../src/media.js';

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yingti-reconstruction-api-'));
  const store = new Store(directory), vault = new KeyVault(directory); await vault.set('test-reconstruction-api-only');
  const parentId = randomUUID(), parentRoot = path.join(directory, 'jobs', parentId); await mkdir(parentRoot, { recursive: true });
  const base = path.join(parentRoot, 'result.mp4');
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=96x160:rate=30:duration=6', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', base]);
  const images = [];
  for (const [index, color] of ['red', 'green', 'yellow', 'blue'].entries()) {
    const file = path.join(directory, `state-${index}.png`);
    await ffmpeg(['-f', 'lavfi', '-i', `color=${color}:size=96x160`, '-frames:v', '1', '-update', '1', file]); images.push(file);
  }
  const parent = { id: parentId, created: new Date().toISOString(), updated: new Date().toISOString(), state: 'completed', workflow: 'studio',
    title: '已编辑基底', projectId: randomUUID(), keyHash: vault.hash(), model: 'wan3.0-720p', analysisModel: 'Omni-Analysis', source: await probe(base),
    sourceName: '素材.mp4', sourceFile: 'source.mp4', output: { width: 96, height: 160 }, segments: [], events: [],
    quality: { state: 'completed', model: 'Omni-Analysis', windows: [{ index: 0, responseFile: 'old-response.json', state: 'completed' }] },
    recipe: { sourceCuts: [3], story: { assets: [{ id: 'C001', type: 'character', name: '测试人物' }, { id: 'P001', type: 'prop', name: '面霜膏体' }],
      shots: [{ id: 'SH1', start: 0, end: 6, characterIds: ['C001'], propIds: ['P001'], sceneId: null }], actions: [], dialogues: [] },
      edits: { assets: {}, dialogues: [], continuity: { actions: {} } } } };
  store.create(parent);
  const initialParent = JSON.stringify(store.get(parentId)), baseSHA = await fileSHA256(base);
  let pumps = 0; const observed = [];
  const engine = { active: null, providerFactory: () => { throw new Error('Integration test must not call a paid provider'); },
    pump: () => { pumps++; observed.push(structuredClone(store.list().filter(job => job.recipe?.actionRebuild).at(-1))); } };
  let app; const server = createServer((request, response) => app(request, response)); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  app = createApp({ store, vault, engine, directory, port, toolsStatus: { ffmpeg: true, ffprobe: true } });
  const csrf = (await (await fetch(origin + '/api/bootstrap')).json()).csrf;
  const metadata = { start: 0.5, end: 5.5, characterId: 'C001', materialAssetId: 'P001', stageMode: 'single', notes: '', confirmNewCharge: true };
  const send = async ({ id = randomUUID(), data = metadata, count = 2, rawMetadata, extraField, fieldName = 'file', headers = {} } = {}) => {
    const body = new FormData(); body.append('metadata', rawMetadata ?? JSON.stringify(data));
    if (extraField) body.append(extraField, 'invalid');
    const selected = count === 2 ? [images[0], images[3]] : images.slice(0, count);
    for (const [index, file] of selected.entries()) body.append(fieldName, await openAsBlob(file), `状态图${index}.png`);
    const response = await fetch(`${origin}/api/jobs/${parentId}/reconstruction`, { method: 'POST',
      headers: { 'X-CSRF-Token': csrf, 'X-Job-Request-ID': id, ...headers }, body });
    return { status: response.status, body: await response.json(), id };
  };
  return { directory, store, parent, parentId, base, initialParent, baseSHA, send, metadata, observed, pumps: () => pumps,
    close: async () => { await new Promise(resolve => server.close(resolve)); store.close();
      assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(directory, { recursive: true, force: true }); } };
}

test('multipart single and four-frame reconstruction freeze model and full Chinese notes before one engine pump', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.send({ data: { ...f.metadata, reviewModel: 'Omni-Analysis' } });
    assert.equal(first.status, 201, JSON.stringify(first.body)); assert.equal(f.pumps(), 1);
    assert.equal(f.observed[0].analysisModel, 'Omni-Analysis'); assert.equal(f.observed[0].quality.model, 'Omni-Analysis');
    assert.equal(f.observed[0].quality.windows, undefined, 'No historical response is copied into the new review');
    assert.equal(first.body.keyHash, undefined);
    const notes = '杏'.repeat(1200), data = { ...f.metadata, stageMode: 'three_regions', reviewModel: 'Omni-Analysis', notes };
    assert.ok(Buffer.byteLength(JSON.stringify(data)) > 2048 && Buffer.byteLength(JSON.stringify(data)) < 8192);
    const four = await f.send({ count: 4, data });
    assert.equal(four.status, 201, JSON.stringify(four.body)); assert.equal(f.pumps(), 2);
    assert.equal(four.body.recipe.actionRebuild.notes, notes); assert.equal(four.body.billableSeconds, 6);
    assert.deepEqual(four.body.recipe.actionRebuild.stages.map(stage => stage.frames), [50, 50, 50]);
    assert.deepEqual(four.body.recipe.actionRebuild.stages.map(stage => stage.region), ['cheek', 'forehead', 'chin']);
    const root = path.join(f.directory, 'jobs', four.id);
    assert.equal(await fileSHA256(path.join(root, 'base.mp4')), f.baseSHA);
    assert.equal(JSON.stringify(f.store.get(f.parentId)), f.initialParent);
    assert.equal(await fileSHA256(f.base), f.baseSHA);
    const copied = await readFile(path.join(root, 'anchors/mid-cheek.png'));
    assert.ok(copied.length > 20); assert.equal(four.body.recipe.actionRebuild.first.file, 'anchors/first.png');
    assert.equal(four.body.recipe.actionRebuild.intermediates.length, 2);
    assert.deepEqual(await readdir(path.join(f.directory, 'incoming')), [], 'Server-owned upload temporaries are cleaned after freeze');
  } finally { await f.close(); }
});

test('same request ID returns the frozen reconstruction without copying files or triggering another engine pump', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const result = await f.send(); assert.equal(result.status, 201, JSON.stringify(result.body));
    const jobRoot = path.join(f.directory, 'jobs', result.id), before = JSON.stringify(f.store.get(result.id));
    const frozenSHA = await fileSHA256(path.join(jobRoot, 'anchors/first.png'));
    const duplicate = await f.send({ id: result.id });
    assert.equal(duplicate.status, 200); assert.equal(duplicate.body.id, result.id); assert.equal(f.pumps(), 1);
    assert.equal(f.store.list().length, 2); assert.equal(JSON.stringify(f.store.get(result.id)), before);
    assert.equal(await fileSHA256(path.join(jobRoot, 'anchors/first.png')), frozenSHA);
    assert.equal(await fileSHA256(f.base), f.baseSHA);
  } finally { await f.close(); }
});

test('unconfirmed, malformed, unknown and client-owned reconstruction metadata cannot queue a new paid task', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const invalid = [
      { data: { ...f.metadata, confirmNewCharge: false } }, { data: { ...f.metadata, confirmNewCharge: 'true' } },
      { rawMetadata: '{bad json' }, { rawMetadata: 'null' }, { rawMetadata: '[]' },
      { data: { ...f.metadata, start: '0.5' } }, { data: { ...f.metadata, notes: 123 } },
      { data: { ...f.metadata, notes: '字'.repeat(1201) } }, { data: { ...f.metadata, reviewModel: 'invented-model' } },
      { data: { ...f.metadata, stageMode: 'automatic' } }, { count: 3 },
      { count: 4, data: { ...f.metadata, stageMode: 'single' } }, { count: 2, data: { ...f.metadata, stageMode: 'three_regions' } },
      { data: { ...f.metadata, characterId: 'unknown' } }, { data: { ...f.metadata, materialAssetId: 'C001' } },
      { data: { ...f.metadata, first: { file: 'C:/private/source.png' } } },
      { data: { ...f.metadata, sourceFile: '../../private.mp4' } }, { data: { ...f.metadata, unexpected: true } },
      { extraField: 'sourceFile' }, { fieldName: 'image' },
    ];
    for (const input of invalid) {
      const response = await f.send(input);
      assert.ok(response.status >= 400 && response.status < 500, JSON.stringify({ input, response }));
      assert.equal(f.pumps(), 0); assert.equal(f.store.list().length, 1);
    }
    assert.equal(JSON.stringify(f.store.get(f.parentId)), f.initialParent); assert.equal(await fileSHA256(f.base), f.baseSHA);
  } finally { await f.close(); }
});

test('missing CSRF and an invalid generation request ID reject before task creation', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    assert.equal((await f.send({ headers: { 'X-CSRF-Token': '' } })).status, 403);
    assert.equal((await f.send({ id: '../unsafe' })).status, 400);
    assert.equal(f.pumps(), 0); assert.equal(f.store.list().length, 1);
  } finally { await f.close(); }
});
