import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { KeyVault } from '../src/keys.js';
import { ReviewEngine, normalizeQuality, qualityPrompt, qualityWindows } from '../src/quality.js';
import { QUALITY_VERSION, QUALITY_KINDS, contentReviewState } from '../src/content-review.js';
import { demoProject } from '../public/studio-demo.js';

const checks = () => ({ checks: [{ kind: 'framing', status: 'pass', time: null, detail: '景别一致' }, { kind: 'boundary', status: 'fail', time: 1, detail: '原片连续，新片在接头变全身' }, { kind: 'material', status: 'uncertain', time: null, detail: '手遮挡，无法判断' }, ...['dialogue', 'subtitles', 'products'].map(kind => ({ kind, status: 'uncertain', time: null, detail: '尚待独立核验' }))] });
async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yingti-review-')), store = new Store(directory), vault = new KeyVault(directory); await vault.set('test-review-only');
  const id = randomUUID(), p = demoProject(); Object.assign(p, { id, created: new Date().toISOString(), keyHash: vault.hash(), sourceFile: 'source.mp4', revision: 2 }); store.createProject(p);
  let calls = 0;
  const provider = { upload: async () => 'oss://fixture', analyzeVideo: async (_url, _prompt, delta) => { calls++; const text = JSON.stringify({ actions: [] }); await delta(text); return { complete: true, usage: { total_tokens: 10 }, text }; } };
  const engine = new ReviewEngine({ store, vault, directory, providerFactory: () => provider, mediaTools: { prepareAnalysisVideo: async () => 'test.mp4', prepareComparisonVideo: async () => 'compare.mp4', detectSourceMotion: async () => ({ cuts: [12], quietPoints: [10] }) } });
  const idle = async () => { while (engine.active) await new Promise(r => setTimeout(r, 5)); };
  return { directory, store, vault, id, provider, engine, calls: () => calls, idle, close: async () => { engine.stop(); await idle(); store.close(); await rm(directory, { recursive: true, force: true }); } };
}
test('action enrichment preserves assets, edits and raw source analysis; duplicate start does not charge twice', async () => {
  const s = await setup();
  try {
    const before = s.store.project(s.id); s.engine.enqueue('actions', s.id); await s.idle(); s.engine.enqueue('actions', s.id); await s.idle();
    const after = s.store.project(s.id); assert.equal(s.calls(), 1); assert.equal(after.actionReview.state, 'completed');
    assert.deepEqual(after.story.assets, before.story.assets); assert.deepEqual(after.edits.assets, before.edits.assets); assert.deepEqual(after.story.dialogues, before.story.dialogues); assert.deepEqual(after.analysis, before.analysis);
    assert.deepEqual(after.story.actions, []); assert.deepEqual(after.sourceCuts, [12]); assert.equal(after.revision, 3);
  } finally { await s.close(); }
});
test('unknown review never submits again on resume/restart', async () => {
  const s = await setup();
  try {
    let calls = 0; s.provider.analyzeVideo = async () => { calls++; throw new Error('stream interrupted'); };
    s.engine.enqueue('actions', s.id); await s.idle(); assert.equal(s.store.project(s.id).actionReview.windows[0].state, 'unknown');
    assert.throws(() => s.engine.resume('actions', s.id), /未知请求/); await s.engine.start(); await s.idle(); assert.equal(calls, 1);
  } finally { await s.close(); }
});
test('complete review response recovers locally without KEY, upload or new billing', async () => {
  const s = await setup();
  try {
    const root = path.join(s.directory, 'projects', s.id); await mkdir(path.join(root, 'actions'), { recursive: true });
    const responseFile = 'actions/response-0-1.json', bytes = JSON.stringify({ complete: true, usage: { total_tokens: 1 }, text: '{"actions":[],}' }); await writeFile(path.join(root, responseFile), bytes);
    s.store.updateProject(s.id, p => { p.actionReview = { state: 'attention', windows: [{ index: 0, start: 0, duration: 24, attempts: 1, state: 'parse_error', responseFile }] }; });
    await s.vault.clear(); const result = await s.engine.reparse('actions', s.id);
    assert.equal(result.actionReview.state, 'completed'); assert.equal(s.calls(), 0); assert.equal(await readFile(path.join(root, responseFile), 'utf8'), bytes);
  } finally { await s.close(); }
});
test('quality reports retain failures and uncertainty with global times; no implicit retry or user approval', async () => {
  const s = await setup();
  try {
    s.store.create({ id: s.id, created: new Date().toISOString(), keyHash: s.vault.hash(), state: 'completed', segments: [{ index: 0, start: 0, duration: 10, frames: 300 }, { index: 1, start: 10, duration: 10, frames: 300 }], recipe: s.store.project(s.id) });
    let calls = 0; s.provider.analyzeVideo = async () => { calls++; return { complete: true, usage: { total_tokens: 8 }, text: JSON.stringify(checks()) }; };
    s.engine.enqueue('quality', s.id); await s.idle(); const job = s.store.get(s.id);
    assert.equal(calls, 2); assert.equal(job.state, 'completed'); assert.equal(job.quality.verdict, 'issues');
    assert.equal(job.quality.version, QUALITY_VERSION); assert.equal(contentReviewState(job).state, 'issues');
    assert.equal(job.quality.windows[1].result[1].time, 10.4); assert.equal(job.quality.userApproved, undefined);
    await s.engine.pump(); assert.equal(calls, 2);
  } finally { await s.close(); }
});
test('quality parser rejects incomplete, duplicate and out-of-range evidence', () => {
  const window = { start: 10, duration: 5 };
  assert.throws(() => normalizeQuality({ checks: [] }, window));
  const bad = checks(); bad.checks[2].kind = 'boundary'; assert.throws(() => normalizeQuality(bad, window));
  const outside = checks(); outside.checks[1].time = 6; assert.throws(() => normalizeQuality(outside, window));
  const missing = checks(); missing.checks[1].time = null; assert.throws(() => normalizeQuality(missing, window));
});
test('review compares both sides and includes neighboring boundary context without imposing false continuity', () => {
  const job = { recipe: demoProject(), segments: [{ index: 0, start: 0, duration: 12, frames: 360 }, { index: 1, start: 12, duration: 12, frames: 360 }] };
  const windows = qualityWindows(job); assert.equal(windows[0].duration, 12.6); assert.equal(windows[1].start, 11.4);
  const prompt = qualityPrompt(job, windows[1]); assert.match(prompt, /左半为原片/); assert.match(prompt, /原片自身切镜为正常/); assert.match(prompt, /不要求维持生成错误/);
  assert.match(prompt, /实际听取声音/); assert.match(prompt, /袋内每个盒子/); assert.equal(windows[1].coreStart, 12); assert.equal(windows[1].coreDuration, 12);
  assert.match(prompt, /不能只写“自然推开”/); assert.match(prompt, /localEnd 附近终点/); assert.match(prompt, /白色面积减小/); assert.match(prompt, /actionCoverage/);
});

test('complete legacy quality response reparses offline as unverified without new model charge', async () => {
  const s = await setup();
  try {
    const root = path.join(s.directory, 'jobs', s.id); await mkdir(path.join(root, 'quality'), { recursive: true });
    const responseFile = 'quality/response-0-1.json';
    const response = JSON.stringify({ complete: true, usage: { total_tokens: 1 }, text: JSON.stringify({ checks: QUALITY_KINDS.slice(0, 3).map(kind => ({ kind, status: 'pass', time: null, detail: '历史画面检查' })) }) });
    await writeFile(path.join(root, responseFile), response);
    s.store.create({ id: s.id, created: new Date().toISOString(), keyHash: s.vault.hash(), state: 'completed', recipe: s.store.project(s.id), segments: [{ index: 0, start: 0, duration: 24, frames: 720 }], quality: { version: 1, state: 'attention', windows: [{ index: 0, start: 0, duration: 24, attempts: 1, state: 'parse_error', responseFile }] } });
    await s.vault.clear(); const result = await s.engine.reparse('quality', s.id);
    assert.equal(result.quality.state, 'completed'); assert.equal(result.quality.verdict, 'unverified'); assert.equal(result.quality.windows[0].result.length, 6);
    assert.equal(contentReviewState(result).state, 'unverified'); assert.equal(s.calls(), 0); assert.equal(await readFile(path.join(root, responseFile), 'utf8'), response);
  } finally { await s.close(); }
});

test('new quality result cannot silently accept an old three-check response', () => {
  const window = { start: 0, duration: 5 };
  assert.throws(() => normalizeQuality({ checks: checks().checks.slice(0, 3) }, window), /六类/);
  const legacy = normalizeQuality({ checks: checks().checks.slice(0, 3) }, window, {}, { allowLegacy: true });
  assert.deepEqual(legacy.slice(3).map(c => c.status), ['uncertain', 'uncertain', 'uncertain']);
});

test('review engine merges independently voiced words across estimated dialogue slots once and retains the full audit', async () => {
  const s = await setup();
  try {
    const recipe = s.store.project(s.id);
    recipe.edits.fullDialogue = { enabled: true, delivery: 'voiceover', speakerId: 'narrator', text: '维希缇！拍一到手三大件，这么多只要99！' };
    s.store.create({ id: s.id, created: new Date().toISOString(), keyHash: s.vault.hash(), state: 'completed', recipe, segments: [{ index: 0, start: 0, duration: 10, frames: 300, dialogueLines: [{ id: 'FULL001', start: 1, end: 8, text: '维希缇！' }] }, { index: 1, start: 10, duration: 10, frames: 300, dialogueLines: [{ id: 'FULL002', start: 11, end: 18, text: '拍一到手三大件，这么多只要99！' }] }] });
    let calls = 0;
    s.provider.analyzeVideo = async (_url, prompt) => {
      assert.match(prompt, /实际发声时间不受画面估计的台词句界约束/);
      const index = calls++, text = ['维希缇拍一到', '手三大件这么多只要九十九'][index], start = index ? 0.6 : 0;
      return { complete: true, usage: { total_tokens: 10 }, text: JSON.stringify({ speech: { audioAvailable: true, confidence: 'high', coverage: 'complete', heardText: text, observations: [{ start, end: start + 10, text, confidence: 'high' }] }, subtitles: { visible: false, confidence: 'high', coverage: 'complete', absenceEvidence: '逐镜头核对右侧整个区间没有任何字幕或品牌文字', observations: [] }, products: { visible: false, confidence: 'high', coverage: 'complete', absenceEvidence: '没有指定商品，整个区间为测试图形', observations: [] }, material: { visible: false, confidence: 'high', coverage: 'complete', absenceEvidence: '左右整个区间为测试图形，没有人物、膏体残留或涂抹动作', observations: [] }, checks: QUALITY_KINDS.map(kind => ({ kind, status: ['boundary', 'material', 'products'].includes(kind) ? 'not_applicable' : 'pass', time: null, detail: '合成素材独立检查依据' })) }) };
    };
    s.engine.enqueue('quality', s.id); await s.idle();
    const job = s.store.get(s.id); assert.equal(calls, 2); assert.equal(job.quality.speechAudit.status, 'pass'); assert.equal(job.quality.verdict, 'no_issues_detected');
    assert.equal(job.quality.speechAudit.observedText, '维希缇拍一到手三大件这么多只要九十九');
    assert.deepEqual(job.quality.windows.map(w => w.result.find(c => c.kind === 'dialogue').status), ['pass', 'pass']);
    await s.engine.pump(); assert.equal(calls, 2);
  } finally { await s.close(); }
});
