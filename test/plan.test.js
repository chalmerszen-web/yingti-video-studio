import test from 'node:test';
import assert from 'node:assert/strict';
import { planSegments, editPrompt, requestBody } from '../src/plan.js';
import { parseKey, KeyVault } from '../src/keys.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('duration boundaries, contiguous coverage and API duration limits', () => {
  for (const duration of [0.001, 0.5, 1, 1.99, 2, 14.99, 15, 15.001, 15.01, 15.1, 16, 29.99, 30, 30.04, 599.99, 600]) {
    const parts = planSegments(duration);
    assert.equal(parts.reduce((n, p) => n + p.frames, 0), Math.max(1, Math.round(duration * 30)));
    assert.ok(parts.length <= 40);
    let frame = 0;
    for (const part of parts) {
      assert.equal(part.startFrame, frame); frame += part.frames;
      assert.ok(part.frames > 0 && part.frames <= 450);
      assert.ok(part.requestDuration >= 2 && part.requestDuration <= 15);
      assert.ok(part.requestDuration + part.requestDuration <= 30);
      assert.ok(part.requestDuration * 30 >= part.frames);
    }
  }
  assert.equal(planSegments(15).length, 1);
  assert.equal(planSegments(15.001).length, 2);
  assert.equal(planSegments(15.1).length, 2);
  assert.deepEqual(planSegments(15.1).map(p => p.frames), [393, 60]);
  assert.equal(planSegments(600).length, 40);
  for (const invalid of [0, -1, 600.001, NaN, Infinity, '15', null]) assert.throws(() => planSegments(invalid));
});

test('random fractional timelines never lose or overlap frames', () => {
  for (let i = 1; i <= 1000; i++) {
    const duration = i * 0.5999;
    const parts = planSegments(duration);
    assert.equal(parts.at(-1).startFrame + parts.at(-1).frames, Math.round(duration * 30));
    assert.ok(parts.every(part => part.duration <= 15 && Number.isInteger(part.requestDuration)));
  }
});

test('face and product requests pin the editing input, image and timeline', () => {
  const segment = planSegments(15.1)[0];
  for (const mode of ['face', 'product']) {
    const job = { mode, model: 'wan3.0-720p', target: '画面左侧的目标' };
    const body = requestBody(job, segment, [{ type: 'reference_video', url: 'oss://video' }, { type: 'reference_image', url: 'oss://image' }]);
    assert.equal(body.duration, 14);
    assert.equal(body.prompt_extend, true);
    assert.equal(requestBody({ ...job, generationOptions: { promptExtend: false } }, segment, []).prompt_extend, true, 'A stale setting must not disable expansion in any new request');
    assert.equal(body.metadata.parameters.ratio, 'adaptive');
    assert.match(body.prompt, /图片1/);
    assert.match(body.prompt, /画面左侧的目标/);
    assert.match(body.prompt, /禁止角色分身/);
    assert.match(editPrompt(mode, '', segment), mode === 'face' ? /面部身份/ : /品牌标识/);
  }
});

test('KEY imports accept common formats and reject malformed input', () => {
  const key = 'test-credential-only';
  assert.equal(parseKey('\ufeff Bearer ' + key + '\n'), key);
  for (const field of ['api_key', 'apikey', 'key', 'token']) assert.equal(parseKey(JSON.stringify({ [field]: key })), key);
  for (const invalid of ['', '{}', '{', 'aaa bbbbb', '太短且非法字符', JSON.stringify({ key: 123 })]) assert.throws(() => parseKey(invalid));
});

test('Windows persisted KEY is encrypted and can be restored', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wan-key-test-'));
  try {
    const vault = new KeyVault(directory);
    await vault.set('test-credential-only-dpapi', true);
    const raw = await readFile(path.join(directory, 'credential.dpapi'), 'utf8');
    assert.ok(!raw.includes('test-credential-only-dpapi'));
    const restored = new KeyVault(directory); await restored.load();
    assert.equal(restored.require(), 'test-credential-only-dpapi');
    assert.equal(restored.status().remembered, true);
    await restored.clear(); assert.equal(restored.status().configured, false);
    const empty = new KeyVault(directory); await empty.load(); assert.equal(empty.status().configured, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
