import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { QueueEngine } from '../src/engine.js';
import { ReviewEngine } from '../src/quality.js';
import { createApp } from '../src/server.js';

test('local repair records never enter old paid routes or queues, even with stale queued states', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yingti-local-isolation-'));
  const store = new Store(directory); let keyCalls = 0, providerCalls = 0;
  const vault = { hash: () => 'same-key', status: () => ({ configured: false }), require: () => { keyCalls++; throw new Error('must not require key'); } };
  const factory = () => { providerCalls++; throw new Error('must not call provider'); };
  const engine = new QueueEngine({ store, vault, directory, providerFactory: factory });
  const review = new ReviewEngine({ store, vault, directory, providerFactory: factory });
  const id = randomUUID(), now = new Date().toISOString();
  store.create({ id, created: now, updated: now, workflow: 'studio', title: '本地校准', state: 'queued', keyHash: 'same-key', segments: [], events: [],
    local: { state: 'needs_calibration', revision: 2 }, recipe: { localMaterialRepair: {} }, quality: { state: 'queued', windows: [] } });
  const before = store.get(id); let app;
  const server = createServer((req, res) => app(req, res));
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port, origin = `http://127.0.0.1:${port}`;
    app = createApp({ store, vault, directory, engine, review, port, toolsStatus: {} });
    const csrf = (await (await fetch(origin + '/api/bootstrap')).json()).csrf;
    for (const route of ['pause', 'resume', 'segments/0/bind', 'segments/0/retry', 'segments/0/regenerate', 'reconstruction', 'quality', 'quality/reparse', 'quality/resume', 'quality/0/retry']) {
      const response = await fetch(`${origin}/api/jobs/${id}/${route}`, { method: 'POST', headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 409, route);
      assert.match((await response.json()).error, /本地/);
    }
    assert.throws(() => engine.pause(id), /本地/);
    assert.throws(() => engine.resume(id), /本地/);
    await assert.rejects(engine.bindTask(id, 0, 'old-task'), /本地/);
    await assert.rejects(engine.retryFailed(id, 0), /本地/);
    await assert.rejects(engine.process(id), /本地/);
    assert.throws(() => review.enqueue('quality', id), /本地/);
    engine.start(); await engine.pump(); await review.start(); await review.pump();
    assert.deepEqual(store.get(id), before);
    assert.equal(keyCalls, 0); assert.equal(providerCalls, 0);
  } finally {
    engine.stop(); review.stop(); await new Promise(resolve => server.close(resolve));
    store.close(); await rm(directory, { recursive: true, force: true });
  }
});
