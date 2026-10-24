import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { KeyVault } from '../src/keys.js';
import { planSegments } from '../src/plan.js';
import { QueueEngine } from '../src/engine.js';

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wan-engine-test-'));
  const store = new Store(directory), vault = new KeyVault(directory); await vault.set('test-engine-credential');
  const id = randomUUID(); await mkdir(path.join(directory, 'jobs', id), { recursive: true });
  const job = { id, created: new Date().toISOString(), updated: new Date().toISOString(), title: '测试任务', keyHash: vault.hash(), mode: 'face', target: '', model: 'wan3.0-720p', state: 'queued', source: {}, output: {}, sourceFile: 'source.mp4', prepared: false, pauseRequested: false, segments: planSegments(30.1), events: [] };
  store.create(job);
  const calls = [];
  const provider = {
    upload: async (file, model, affinity) => { calls.push(['upload', file, affinity]); return 'oss://test'; },
    create: async () => { const taskId = 'task-' + calls.filter(c => c[0] === 'create').length; calls.push(['create', taskId]); return taskId; },
    status: async id => { calls.push(['status', id]); return { status: 'completed' }; },
    download: async id => { calls.push(['download', id]); },
  };
  const mediaTools = { prepareSegments: async () => {}, normalizeResult: async () => {}, assemble: async () => ({ duration: 30.1 }) };
  const engine = new QueueEngine({ store, vault, directory, providerFactory: () => provider, mediaTools, pollInterval: 1 });
  return { directory, store, vault, id, provider, calls, engine, close: async () => { engine.stop(); while (engine.active) await new Promise(r => setTimeout(r, 5)); store.close(); await rm(directory, { recursive: true, force: true }); } };
}
const waitIdle = async engine => { for (let i = 0; i < 200 && engine.active; i++) await new Promise(r => setTimeout(r, 5)); assert.equal(engine.active, null); };
const fakeExport=async(_directory,job)=>({state:job.segments.some(s=>s.state==='completed')?'ready':'empty',clips:job.segments.filter(s=>s.state==='completed').map(s=>({index:s.index,duration:s.duration}))});

test('normal generation completes without rates or any balance API while funding is deferred',async()=>{
  const s=await setup();try{
    let balanceCalls=0;s.provider.balance=async()=>{balanceCalls++;throw new Error('platform balance API unavailable');};
    assert.equal(s.engine.funding,null);await s.engine.pump();
    const job=s.store.get(s.id);assert.equal(job.state,'completed');assert.deepEqual(job.fundingStatus,{state:'deferred'});
    assert.equal(balanceCalls,0);assert.equal(s.calls.filter(c=>c[0]==='create').length,3);
  }finally{await s.close();}
});

test('previous funding-blocked jobs require explicit resume and then use the deferred default',async()=>{
  const s=await setup();try{
    s.store.update(s.id,j=>{j.state='funds_required';j.error='旧额度接口不可用';j.fundingStatus={state:'unavailable'};});
    s.engine.start();await waitIdle(s.engine);
    assert.equal(s.store.get(s.id).state,'funds_required');assert.equal(s.calls.length,0);
    assert.match(s.store.get(s.id).error,/可点击继续生成/);
    s.engine.resume(s.id);await waitIdle(s.engine);
    assert.equal(s.store.get(s.id).state,'completed');assert.equal(s.calls.filter(c=>c[0]==='create').length,3);
  }finally{await s.close();}
});

test('a blocked receipt file cannot crash or undo a successful stopped export',async()=>{
  const s=await setup();try{
    await mkdir(path.join(s.directory,'jobs',s.id,'receipt.json'));
    s.store.update(s.id,j=>{j.segments[0].state='completed';});s.engine.partialExporter=fakeExport;
    s.engine.abort(s.id);await waitIdle(s.engine);
    const saved=s.store.get(s.id);assert.equal(saved.state,'stopped');assert.equal(saved.partialExport.clips.length,1);assert.equal(s.calls.length,0);
    assert.ok(saved.events.some(e=>e.message.includes('回执暂未写入')));
  }finally{await s.close();}
});

test('resume cannot race an active collection using its aborted request controller',async()=>{
  const s=await setup();let release;try{
    s.engine.partialExporter=async()=>{await new Promise(r=>{release=r;});return {state:'empty',clips:[]};};
    s.engine.abort(s.id);for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,5));
    assert.equal(typeof release,'function');assert.throws(()=>s.engine.resume(s.id),/正在收取/);release();await waitIdle(s.engine);
    assert.equal(s.store.get(s.id).state,'stopped');assert.equal(s.calls.length,0);
  }finally{release?.();await s.close();}
});

test('abort collects a just-completed remote task, exports it and never submits the next part or restarts automatically',async()=>{
  const s=await setup();try{
    s.engine.partialExporter=fakeExport;let checks=0;
    s.provider.status=async()=>{if(!checks++){s.engine.abort(s.id);return {status:'running'};}return {status:'completed'};};
    await s.engine.pump();const job=s.store.get(s.id);
    assert.equal(job.state,'stopped');assert.equal(job.segments[0].state,'completed');assert.equal(job.partialExport.clips.length,1);
    assert.equal(s.calls.filter(c=>c[0]==='create').length,1);assert.equal(s.calls.filter(c=>c[0]==='download').length,1);
    s.engine.start();await waitIdle(s.engine);assert.equal(checks,2);assert.equal(s.store.get(s.id).state,'stopped');
  }finally{await s.close();}
});

test('3600-second default is durable and a timeout preserves downloads and the original task ID',async()=>{
  const s=await setup();try{
    assert.equal(s.engine.waitTimeout,3600000);s.engine.partialExporter=fakeExport;let clock=0,checks=0;s.engine.now=()=>clock;
    s.provider.status=async()=>{checks++;clock=3600001;return {status:checks===1?'running':'completed'};};
    await s.engine.pump();const job=s.store.get(s.id);
    assert.equal(job.state,'timed_out');assert.equal(job.generationDeadline,3600000);assert.equal(job.segments[0].taskId,'task-0');assert.equal(job.partialExport.clips.length,1);
    assert.equal(s.calls.filter(c=>c[0]==='create').length,1);
    s.engine.start();await waitIdle(s.engine);assert.equal(checks,2);
  }finally{await s.close();}
});

test('collecting later retrieves only an existing task and performs no paid POST',async()=>{
  const s=await setup();try{
    s.engine.partialExporter=fakeExport;s.store.update(s.id,j=>{j.state='stopped';j.stopRequested=true;j.haltReason='stopped';j.prepared=true;Object.assign(j.segments[0],{state:'running',taskId:'retained-task'});});
    s.engine.collect(s.id);await waitIdle(s.engine);
    const job=s.store.get(s.id);assert.equal(job.state,'stopped');assert.equal(job.partialExport.clips.length,1);assert.equal(s.calls.filter(c=>c[0]==='create').length,0);
    assert.ok(s.calls.some(c=>c[0]==='download'&&c[1]==='retained-task'));
  }finally{await s.close();}
});

test('abort during an uncertain paid POST preserves the unknown marker and cannot resubmit',async()=>{
  const s=await setup();try{
    s.engine.partialExporter=fakeExport;let submitted=0;s.provider.create=async()=>{submitted++;s.engine.abort(s.id);throw new Error('request aborted after write');};
    await s.engine.pump();const job=s.store.get(s.id);assert.equal(job.state,'stopped');assert.equal(job.segments[0].state,'unknown');assert.throws(()=>s.engine.resume(s.id));
    s.engine.collect(s.id);await waitIdle(s.engine);assert.equal(submitted,1);
  }finally{await s.close();}
});

test('queue waits for completion and download before submitting next segment', async () => {
  const s = await setup();
  try {
    let previousDownloaded = true;
    const create = s.provider.create;
    s.provider.create = async () => { assert.equal(previousDownloaded, true); previousDownloaded = false; return create(); };
    const download = s.provider.download;
    s.provider.download = async id => { await download(id); previousDownloaded = true; };
    await s.engine.pump();
    assert.equal(s.store.get(s.id).state, 'completed');
    assert.equal(s.calls.filter(c => c[0] === 'create').length, 3);
    await s.engine.pump();
    assert.equal(s.calls.filter(c => c[0] === 'create').length, 3);
    assert.ok(!JSON.stringify(s.store.list()).includes('test-engine-credential'));
  } finally { await s.close(); }
});

test('unknown paid submission is durable and cannot be resumed into another POST', async () => {
  const s = await setup();
  try {
    let creates = 0;
    s.provider.create = async () => { creates++; throw new Error('connection broke'); };
    await s.engine.pump();
    assert.equal(s.store.get(s.id).segments[0].state, 'unknown');
    assert.equal(s.store.get(s.id).state, 'needs_attention');
    assert.throws(() => s.engine.resume(s.id));
    await s.engine.pump(); assert.equal(creates, 1);
    s.engine.start(); await waitIdle(s.engine); assert.equal(creates, 1);
  } finally { await s.close(); }
});

test('restart resumes an existing remote ID and never resubmits that segment', async () => {
  const s = await setup();
  try {
    s.store.update(s.id, job => { job.state = 'processing'; job.prepared = true; Object.assign(job.segments[0], { state: 'submitted', taskId: 'original-task', attempts: 1 }); });
    s.engine.start(); await waitIdle(s.engine);
    assert.equal(s.store.get(s.id).state, 'completed');
    assert.equal(s.calls.filter(c => c[0] === 'create').length, 2);
    assert.ok(s.calls.some(c => c[0] === 'download' && c[1] === 'original-task'));
  } finally { await s.close(); }
});

test('restart during submit becomes unknown; binding resumes only the original task', async () => {
  const s = await setup();
  try {
    s.store.update(s.id, job => { job.state = 'processing'; job.prepared = true; job.segments[0].state = 'submitting'; });
    s.engine.start(); await waitIdle(s.engine);
    assert.equal(s.store.get(s.id).state, 'needs_attention');
    assert.equal(s.calls.filter(c => c[0] === 'create').length, 0);
    await s.engine.bindTask(s.id, 0, 'recovered-original');
    s.engine.resume(s.id); await waitIdle(s.engine);
    assert.equal(s.calls.filter(c => c[0] === 'create').length, 2);
    assert.ok(s.calls.some(c => c[0] === 'download' && c[1] === 'recovered-original'));
  } finally { await s.close(); }
});

test('pause drains current task and stops subsequent paid submissions', async () => {
  const s = await setup();
  try {
    const create = s.provider.create;
    s.provider.create = async () => { const id = await create(); s.engine.pause(s.id); return id; };
    await s.engine.pump();
    assert.equal(s.store.get(s.id).state, 'paused');
    assert.equal(s.calls.filter(c => c[0] === 'create').length, 1);
    assert.equal(s.store.get(s.id).segments[0].state, 'completed');
    s.provider.create = create; s.engine.resume(s.id); await waitIdle(s.engine);
    assert.equal(s.store.get(s.id).state, 'completed');
    assert.equal(s.calls.filter(c => c[0] === 'create').length, 3);
  } finally { await s.close(); }
});

test('changing KEY does not resume a job owned by another KEY', async () => {
  const s = await setup();
  try {
    await s.vault.set('another-test-credential');
    await s.engine.pump();
    assert.equal(s.calls.length, 0);
    assert.throws(() => s.engine.resume(s.id), /另一枚 KEY/);
  } finally { await s.close(); }
});

test('explicit retry rechecks failure and preserves already completed segments', async () => {
  const s = await setup();
  try {
    s.store.update(s.id, job => { job.state = 'needs_attention'; job.prepared = true; job.segments[0].state = 'completed'; Object.assign(job.segments[1], { state: 'failed', taskId: 'failed-task' }); });
    const status = s.provider.status;
    s.provider.status = async id => id === 'failed-task' ? { status: 'failed' } : status(id);
    await s.engine.retryFailed(s.id, 1); await waitIdle(s.engine);
    const job = s.store.get(s.id);
    assert.equal(job.state, 'completed');
    assert.equal(job.segments[1].history[0].taskId, 'failed-task');
    assert.equal(s.calls.filter(c => c[0] === 'create').length, 2);
  } finally { await s.close(); }
});
