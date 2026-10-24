import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { VocalignProvider, API_ORIGIN } from '../src/provider.js';
const response = (object, status = 200) => new Response(JSON.stringify(object), { status });

test('paid create never retries, GETs back off and recover', async () => {
  let calls = 0;
  const provider = new VocalignProvider('test-key', { fetchImpl: async () => { calls++; return response({}, 503); }, sleep: async () => {} });
  await assert.rejects(provider.create({}, { idempotencyKey: 'stable-id', affinity: 'stable-affinity' }));
  assert.equal(calls, 1);
  calls = 0;
  provider.fetch = async () => { calls++; return calls < 3 ? response({}, 429) : response({ status: 'completed' }); };
  assert.equal((await provider.status('task-1')).status, 'completed');
  assert.equal(calls, 3);
  calls = 0;
  provider.fetch = async () => { calls++; throw new Error('network with potentially sensitive details'); };
  await assert.rejects(provider.create({}, { idempotencyKey: 'stable-id', affinity: 'stable-affinity' }), /结果未知/);
  assert.equal(calls, 1);
});

test('uploads stream blobs, bind affinity and keep platform KEY out of storage requests', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wan-upload-test-'));
  try {
    const file = path.join(directory, 'image.png'); await writeFile(file, Buffer.from('not-a-real-image-transport-only'));
    const calls = [];
    const provider = new VocalignProvider('test-secret', { fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).startsWith(API_ORIGIN + '/v1/uploads')) return response({ policy: 'test-policy', signature: 'test-signature', upload_dir: 'test/media', upload_host: 'https://storage.example.test', oss_access_key_id: 'temporary-test', x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true', max_file_size_mb: 100, capacity_limit_mb: 100 });
      if (String(url) === 'https://storage.example.test/') return new Response('', { status: 200 });
      return response({ id: 'task-1', status: 'queued' });
    } });
    const url = await provider.upload(file, 'wan3.0-720p', 'affinity-one');
    assert.match(url, /^oss:\/\/test\/media\//);
    assert.equal(calls[0].options.headers.Authorization, 'Bearer test-secret');
    assert.equal(calls[0].options.headers['X-Vocalign-Task-Affinity'], 'affinity-one');
    assert.equal(calls[1].options.headers, undefined);
    assert.ok(calls[1].options.body instanceof FormData);
    assert.equal(calls[1].options.body.get('file').size, 31);
    await provider.create({ metadata: { input: { media: [{ type: 'reference_image', url }] } } }, { affinity: 'affinity-one', idempotencyKey: 'id-one' });
    assert.equal(calls[2].options.headers['X-Vocalign-Task-Affinity'], 'affinity-one');
    assert.equal(calls[2].options.headers['Idempotency-Key'], 'id-one');
    assert.ok(!calls[2].options.body.includes('base64'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('download strips KEY on redirect and writes atomically', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wan-download-test-'));
  try {
    const calls = [];
    const provider = new VocalignProvider('test-secret', { fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (calls.length === 1) return new Response(null, { status: 302, headers: { location: 'https://cdn.example.test/result.mp4' } });
      return new Response(Buffer.from('test-mp4-transport'));
    } });
    const file = path.join(directory, 'result.mp4'); await provider.download('task-1', file);
    assert.equal(calls[0].options.headers.Authorization, 'Bearer test-secret');
    assert.equal(calls[1].options.headers.Authorization, undefined);
    assert.equal(await readFile(file, 'utf8'), 'test-mp4-transport');
    provider.fetch = async () => new Response(null, { status: 302, headers: { location: 'http://unsafe.example.test/file' } });
    await assert.rejects(provider.download('task-1', file), /不支持/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
