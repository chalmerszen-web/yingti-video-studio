import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { KeyVault } from '../src/keys.js';
import { AnalysisEngine } from '../src/analysis.js';
import { analysisWindows, emptyStory, emptyEdits } from '../src/story.js';

const raw = { summary: '测试梗概', characters: [], scenes: [], props: [], shots: [{ start: 0, end: 5, summary: '色条', characterIds: [], propIds: [], sceneId: null }], dialogues: [], warnings: [] };
async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), '.wan-analysis-'));
  const store = new Store(directory), vault = new KeyVault(directory); await vault.set('test-only-analysis-key');
  const project = { id: 'analysis-test', created: new Date().toISOString(), revision: 0, source: { duration: 5 }, sourceFile: 'source.mp4', keyHash: vault.hash(), state: 'analysis_queued', story: emptyStory(), edits: emptyEdits(), analysis: { windows: analysisWindows(5) } };
  store.createProject(project); await mkdir(path.join(directory, 'projects', project.id, 'analysis'), { recursive: true });
  let creates = 0;
  const provider = { upload: async () => 'oss://test', analyzeVideo: async (url, prompt, onText) => { creates++; const text = JSON.stringify(raw); await onText(text); return { text, complete: true, usage: { total_tokens: 1 } }; } };
  const engine = new AnalysisEngine({ store, vault, directory, providerFactory: () => provider, prepareVideo: async () => 'source.mp4' });
  return { directory, store, vault, project, provider, engine, get creates() { return creates; }, close: async () => { engine.stop(); while (engine.active) await new Promise(r => setTimeout(r, 5)); store.close(); await rm(directory, { recursive: true, force: true }); } };
}
const idle = async engine => { for (let i = 0; i < 200 && engine.active; i++) await new Promise(r => setTimeout(r, 5)); assert.equal(engine.active, null); };

test('analysis is durable and completed projects do not issue another model call', async () => {
  const s = await setup();
  try { await s.engine.pump(); assert.equal(s.store.project(s.project.id).state, 'ready'); assert.equal(s.creates, 1); await s.engine.pump(); assert.equal(s.creates, 1); }
  finally { await s.close(); }
});
test('analysis restart marks incomplete submit unknown and requires explicit retry', async () => {
  const s = await setup();
  try {
    s.store.updateProject(s.project.id, p => { p.state = 'analyzing'; p.analysis.windows[0].state = 'submitting'; });
    await s.engine.start(); await idle(s.engine); assert.equal(s.store.project(s.project.id).analysis.windows[0].state, 'unknown'); assert.equal(s.creates, 0);
    assert.throws(() => s.engine.resume(s.project.id)); assert.throws(() => s.engine.retry(s.project.id, 0, false));
    s.engine.retry(s.project.id, 0, true); await idle(s.engine); assert.equal(s.creates, 1); assert.equal(s.store.project(s.project.id).state, 'ready');
  } finally { await s.close(); }
});
test('saved complete SSE response is recovered after a crash without another paid request', async () => {
  const s = await setup();
  try {
    const responseFile = 'analysis/response-0-1.json';
    await writeFile(path.join(s.directory, 'projects', s.project.id, responseFile), JSON.stringify({ complete: true, text: JSON.stringify(raw) }));
    s.store.updateProject(s.project.id, p => { p.state = 'analyzing'; Object.assign(p.analysis.windows[0], { state: 'submitting', attempts: 1, responseFile }); });
    await s.engine.start(); await idle(s.engine); assert.equal(s.creates, 0); assert.equal(s.store.project(s.project.id).state, 'ready');
  } finally { await s.close(); }
});

test('local reparse recovers a timing validation error without KEY, provider, or another attempt', async () => {
  const s = await setup();
  try {
    const responseFile = 'analysis/response-0-1.json';
    const result = { ...raw, shots: [{ start: 0, end: 46.833, summary: '镜头', characterIds: [], propIds: [] }], dialogues: [{ start: 43.36, end: 47.2, characterId: null, text: '片尾台词', uncertain: false }] };
    const receipt = JSON.stringify({ complete: true, text: JSON.stringify(result), usage: { total_tokens: 27487 }, responseId: 'original-response' });
    const file = path.join(s.directory, 'projects', s.project.id, responseFile); await writeFile(file, receipt);
    s.store.updateProject(s.project.id, p => {
      p.source.duration = 46.833333; p.state = 'analysis_attention'; p.error = '旧时间边界报错';
      Object.assign(p.analysis.windows[0], { duration: 46.833333, state: 'parse_error', attempts: 1, responseFile, usage: { total_tokens: 27487 }, responseId: 'original-response' });
    });
    await s.vault.clear();
    s.engine.providerFactory = () => { throw new Error('Must never instantiate a provider for local reparse'); };
    s.engine.prepareVideo = () => { throw new Error('Must never re-encode or upload for local reparse'); };
    const project = await s.engine.reparse(s.project.id);
    assert.equal(project.state, 'ready'); assert.equal(project.error, null); assert.equal(project.analysis.windows[0].attempts, 1);
    assert.deepEqual(project.analysis.windows[0].usage, { total_tokens: 27487 }); assert.equal(project.analysis.windows[0].responseId, 'original-response');
    assert.equal(project.story.dialogues[0].end, 46.833); assert.equal(project.analysis.lastLocalReparse.timingCorrections, 1);
    assert.equal(await readFile(file, 'utf8'), receipt); assert.equal(s.creates, 0);
    await s.engine.reparse(s.project.id); assert.equal(s.store.project(s.project.id).story.dialogues.length, 1);
  } finally { await s.close(); }
});

test('local reparse does not submit pending windows or accept incomplete responses', async () => {
  const s = await setup();
  try {
    const responseFile = 'analysis/response-0-1.json', file = path.join(s.directory, 'projects', s.project.id, responseFile);
    await writeFile(file, JSON.stringify({ complete: true, text: JSON.stringify(raw) }));
    s.store.updateProject(s.project.id, p => {
      p.state = 'analysis_attention'; Object.assign(p.analysis.windows[0], { state: 'parse_error', responseFile, attempts: 1 });
      p.analysis.windows.push({ index: 1, start: 5, duration: 5, state: 'pending', attempts: 0 });
    });
    await s.vault.clear();
    s.engine.providerFactory = () => { throw new Error('Unexpected network access'); };
    const partial = await s.engine.reparse(s.project.id);
    assert.equal(partial.state, 'analysis_attention'); assert.equal(partial.analysis.windows[0].state, 'completed'); assert.equal(partial.analysis.windows[1].state, 'pending'); assert.equal(s.creates, 0);
    s.store.updateProject(s.project.id, p => { p.story = emptyStory(); p.analysis.windows = [p.analysis.windows[0]]; p.analysis.windows[0].state = 'parse_error'; });
    await writeFile(file, JSON.stringify({ complete: false, text: JSON.stringify(raw) }));
    await assert.rejects(s.engine.reparse(s.project.id), /完整结束标记/);
    assert.equal(s.store.project(s.project.id).state, 'analysis_attention'); assert.equal(s.creates, 0);
  } finally { await s.close(); }
});

test('a saved format error is repaired locally without KEY, provider, changed response bytes or another charge', async () => {
  const s=await setup();
  try {
    const responseFile='analysis/response-0-1.json', file=path.join(s.directory,'projects',s.project.id,responseFile);
    const text=JSON.stringify(raw).replace('"summary":"第一段"','"summary":第一段"').replace('"summary":"测试梗概"','"summary":测试梗概"');
    const saved=JSON.stringify({complete:true,text,responseId:'original-format-response',usage:{total_tokens:123}});
    await writeFile(file,saved);
    s.store.updateProject(s.project.id,p=>{p.state='analysis_attention';Object.assign(p.analysis.windows[0],{state:'parse_error',responseFile,attempts:1,responseId:'original-format-response',usage:{total_tokens:123}});});
    await s.vault.clear(); s.engine.providerFactory=()=>{throw new Error('Unexpected provider creation');};
    const project=await s.engine.reparse(s.project.id);
    assert.equal(project.state,'ready'); assert.equal(project.story.summary,raw.summary);
    assert.equal(project.analysis.windows[0].formatCorrections.length,1);
    assert.equal(project.analysis.windows[0].formatCorrections[0].path,'/summary');
    assert.equal(project.analysis.windows[0].attempts,1); assert.equal(project.analysis.windows[0].responseId,'original-format-response');
    assert.deepEqual(project.analysis.windows[0].usage,{total_tokens:123}); assert.equal(project.analysis.lastLocalReparse.formatCorrections,1);
    assert.equal(await readFile(file,'utf8'),saved); assert.equal(s.creates,0);
    const again=await s.engine.reparse(s.project.id); assert.equal(again.revision,project.revision); assert.equal(again.story.shots.length,1);
  } finally {await s.close();}
});

test('fresh complete analysis with a small format defect reaches ready after only one model request', async () => {
  const s=await setup();
  try {
    let calls=0;
    s.provider.analyzeVideo=async(url,prompt,onText)=>{calls++;const text=JSON.stringify(raw).replace('"summary":"测试梗概"','"summary":测试梗概"');await onText(text);return {complete:true,text};};
    await s.engine.pump(); const project=s.store.project(s.project.id);
    assert.equal(project.state,'ready'); assert.equal(calls,1); assert.equal(project.analysis.windows[0].attempts,1);
    assert.equal(project.analysis.windows[0].formatCorrections.length,1);
  } finally {await s.close();}
});
