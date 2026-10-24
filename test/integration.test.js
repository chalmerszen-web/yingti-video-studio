import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { openAsBlob } from 'node:fs';
import { mkdtemp, mkdir, copyFile, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { KeyVault } from '../src/keys.js';
import { QueueEngine } from '../src/engine.js';
import { createApp } from '../src/server.js';
import { ffmpeg, probe, normalizeResult } from '../src/media.js';

test('HTTP + real FFmpeg: upload, both modes, segmentation, original audio, recovery-safe queue, download', { timeout: 180000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), '.wan-e2e-test-'));
  const fixtures = path.join(directory, 'fixtures'); await mkdir(fixtures);
  const video = path.join(fixtures, 'test-with-audio.mp4');
  const silent = path.join(fixtures, 'short-silent.mp4');
  const delayed = path.join(fixtures, 'delayed-audio.mov');
  const image = path.join(fixtures, 'test-product.png');
  const long = path.join(fixtures, 'over-10-minutes.mp4');
  const exact = path.join(fixtures, 'exact-10-minutes.mp4');
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30000/1001', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '16.2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video]);
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=180x320:rate=30', '-t', '1.034', '-c:v', 'libx264', '-preset', 'ultrafast', '-an', silent]);
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-itsoffset', '0.4', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'pcm_s16le', delayed]);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=orange:size=120x180', '-frames:v', '1', '-update', '1', image]);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:size=32x32:rate=1', '-t', '601', '-c:v', 'libx264', '-preset', 'ultrafast', '-an', long]);
  await ffmpeg(['-i', long, '-t', '600', '-c', 'copy', exact]);
  const store = new Store(directory), vault = new KeyVault(directory);
  const uploads = new Map(), tasks = new Map(), calls = [], ordered = [];
  const provider = {
    check: async () => ({ models: ['wan3.0-720p', 'wan3.0-480p'] }),
    upload: async (file, model, affinity) => {
      const url = 'oss://test/' + randomUUID(); uploads.set(url, { file, affinity }); return url;
    },
    create: async (body, segment) => {
      assert.equal([...tasks.values()].filter(task => !task.downloaded).length, 0, 'Only one active cloud segment at a time');
      assert.ok(body.duration <= 15 && body.duration >= 2);
      assert.equal(body.metadata.input.media.length, 2);
      const ref = uploads.get(body.metadata.input.media[0].url);
      assert.equal(ref.affinity, segment.affinity);
      assert.equal(uploads.get(body.metadata.input.media[1].url).affinity, segment.affinity);
      const info = await probe(ref.file);
      assert.equal(info.frames, body.duration * 30);
      assert.ok(info.duration <= 15);
      const id = 'fake-task-' + tasks.size;
      calls.push(body); tasks.set(id, { file: ref.file, polled: false, downloaded: false });
      return id;
    },
    status: async id => { const task = tasks.get(id); const status = task.polled ? 'completed' : 'in_progress'; task.polled = true; return { status }; },
    download: async (id, destination) => {
      const task = tasks.get(id); await copyFile(task.file, destination); task.downloaded = true; ordered.push(id);
    },
  };
  const engine = new QueueEngine({ fundingGate: { ensure: async () => ({ state: 'approved' }) }, store, vault, directory, providerFactory: () => provider, pollInterval: 2 });
  const processJob = engine.process.bind(engine);
  engine.process = async id => { try { await processJob(id); } catch (error) { t.diagnostic(error.stack); throw error; } };
  let app;
  const server = createServer((req, res) => app(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, origin = 'http://127.0.0.1:' + port;
  app = createApp({ store, vault, engine, directory, port, toolsStatus: { ffmpeg: true, ffprobe: true } });
  let csrf;
  async function request(url, { method = 'GET', body, headers = {} } = {}) {
    return fetch(origin + url, { method, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined, headers: { ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), 'X-CSRF-Token': csrf || '', ...headers } });
  }
  async function formFor(file, mode = 'face') {
    const form = new FormData(); form.append('mode', mode); form.append('model', 'wan3.0-480p'); form.append('target', '画面中的主体'); form.append('title', '完整表单验证');
    form.append('video', await openAsBlob(file), path.basename(file)); form.append('image', await openAsBlob(image), 'test-product.png');
    return form;
  }
  async function waitFor(id) {
    for (let i = 0; i < 600; i++) {
      const job = store.get(id);
      if (['completed', 'needs_attention'].includes(job.state)) return job;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for local test pipeline');
  }
  try {
    const bootstrap = await (await request('/api/bootstrap')).json(); csrf = bootstrap.csrf;
    assert.equal(bootstrap.key.configured, false);
    assert.equal((await request('/api/key', { method: 'POST', body: { key: 'test-only-api-key', remember: false }, headers: { 'X-CSRF-Token': 'wrong' } })).status, 403);
    assert.equal((await request('/api/bootstrap', { headers: { Origin: 'https://evil.example' } })).status, 403);
    const rebindingStatus = await new Promise((resolve, reject) => {
      const req = httpRequest(origin + '/api/bootstrap', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(rebindingStatus, 403);
    assert.equal((await request('/api/key', { method: 'POST', body: { key: 'test-only-api-key', remember: false } })).status, 200);
    assert.equal((await request('/api/key/check', { method: 'POST' })).status, 200);
    for (const [file, mode] of [[video, 'face'], [silent, 'product'], [delayed, 'face']]) {
      const requestId = randomUUID();
      const response = await request('/api/jobs', { method: 'POST', body: await formFor(file, mode), headers: { 'X-Job-Request-Id': requestId } });
      const created = await response.json(); assert.equal(response.status, 201, JSON.stringify(created));
      const duplicate = await request('/api/jobs', { method: 'POST', body: await formFor(file, mode), headers: { 'X-Job-Request-Id': requestId } });
      assert.equal((await duplicate.json()).id, created.id);
      const job = await waitFor(created.id);
      assert.equal(job.state, 'completed', job.error);
      assert.equal(job.segments.length, file === video ? 2 : 1);
      const output = path.join(directory, 'jobs', job.id, 'result.mp4');
      const info = await probe(output);
      assert.equal(info.frames, Math.round(job.source.duration * 30));
      assert.equal(info.hasAudio, mode === 'face');
      assert.ok(Math.abs(info.duration - job.source.duration) <= 1 / 30 + 0.001);
      if (file === video) {
        const originalPCM = path.join(fixtures, 'original.f32'), resultPCM = path.join(fixtures, 'result.f32');
        await ffmpeg(['-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', originalPCM]);
        await ffmpeg(['-i', output, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', resultPCM]);
        const a = await readFile(originalPCM), b = await readFile(resultPCM);
        let xy = 0, xx = 0, yy = 0;
        for (let i = 4000; i < Math.min(a.length, b.length) - 4000; i += 4) { const x = a.readFloatLE(i), y = b.readFloatLE(i); xy += x * y; xx += x * x; yy += y * y; }
        assert.ok(xy / Math.sqrt(xx * yy) > 0.98, 'Original audio remains aligned');
      }
      if (file === delayed) {
        assert.ok(Math.abs(job.source.audioOffset - 0.4) < 0.001);
        const resultPCM = path.join(fixtures, 'delayed-result.f32');
        await ffmpeg(['-i', output, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', resultPCM]);
        const pcm = await readFile(resultPCM);
        const rms = (start, end) => { let squares = 0, count = 0; for (let i = Math.round(start * 48000) * 4; i < Math.round(end * 48000) * 4; i += 4) { squares += pcm.readFloatLE(i) ** 2; count++; } return Math.sqrt(squares / count); };
        assert.ok(rms(0.05, 0.3) < 0.0001, 'Opening audio delay remains silent');
        assert.ok(rms(0.5, 0.8) > 0.07, 'Original sound starts at its source position');
      }
      const downloaded = await request(`/api/jobs/${job.id}/media/result?download=1`);
      assert.equal(downloaded.status, 200); assert.match(downloaded.headers.get('content-disposition'), /attachment/);
      assert.equal((await downloaded.arrayBuffer()).byteLength, (await stat(output)).size);
      const ranged = await request(`/api/jobs/${job.id}/media/result`, { headers: { Range: 'bytes=0-99' } });
      assert.equal(ranged.status, 206); assert.equal((await ranged.arrayBuffer()).byteLength, 100);
      assert.equal((await request(`/api/jobs/${job.id}/media/__proto__`)).status, 404);
    }
    assert.equal(calls.length, 4);
    assert.deepEqual(ordered, ['fake-task-0', 'fake-task-1', 'fake-task-2', 'fake-task-3']);
    assert.match(calls[0].prompt, /人脸/); assert.match(calls[2].prompt, /产品/);
    engine.stop();
    const accepted = await request('/api/jobs', { method: 'POST', body: await formFor(exact) });
    const tenMinute = await accepted.json(); assert.equal(accepted.status, 201, JSON.stringify(tenMinute)); assert.equal(tenMinute.segments.length, 40);
    const rejected = await request('/api/jobs', { method: 'POST', body: await formFor(long) });
    assert.equal(rejected.status, 400); assert.match((await rejected.json()).error, /10 分钟/);
    const jobs = await (await request('/api/jobs')).text(); assert.ok(!jobs.includes('test-only-api-key')); assert.ok(!jobs.includes('keyHash')); assert.ok(!jobs.includes('idempotencyKey'));
    assert.equal(store.list().length, 4);
    const badDir = path.join(directory, 'bad-result'); await mkdir(path.join(badDir, 'segments'), { recursive: true });
    await copyFile(silent, path.join(badDir, 'segments', 'generated-0.mp4'));
    await assert.rejects(normalizeResult(badDir, { output: { width: 320, height: 180 } }, { index: 0, requestDuration: 15, frames: 450 }), /预期 15 秒/);
    assert.equal((await request('/api/key', { method: 'DELETE' })).status, 200);
    assert.equal(vault.status().configured, false);
  } finally {
    engine.stop(); while (engine.active) await new Promise(resolve => setTimeout(resolve, 100));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
