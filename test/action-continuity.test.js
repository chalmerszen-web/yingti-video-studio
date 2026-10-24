import test from 'node:test';
import assert from 'node:assert/strict';
import { demoProject } from '../public/studio-demo.js';
import { planStudio, studioPrompt, mergeStory, emptyStory, validateEdits } from '../src/story.js';
import { enabledActions, actionLocks, visualRanges } from '../src/continuity.js';

const action = fields => ({ id: 'A0_0', start: 2, end: 10, type: 'spread', characterId: 'C001', propId: null, region: '画面左侧脸颊', before: '有两点白膏', after: '推开后变薄', evidence: '手指接触白膏并向外推开', confidence: 'high', ...fields });
function fixture() {
  const p = demoProject(); p.source.duration = 30;
  p.story.shots = [{ id: 'SH001', start: 0, end: 30, characterIds: ['C001'], propIds: [], sceneId: null }]; p.story.dialogues = [];
  p.edits = { model: 'wan3.0-480p', assets: { C001: { main: { file: 'face.png' } } }, dialogues: [] };
  return p;
}
test('no action is inferred from dialogue or product names; uncertain observations do not activate', () => {
  const p = fixture(); p.story.dialogues = [{ id: 'L1', start: 1, end: 3, characterId: 'C001', text: '这款面霜涂抹很方便' }];
  assert.deepEqual(enabledActions(p), []);
  p.story.actions = [action({ type: 'uncertain' }), action({ id: 'A1', confidence: 'low' }), action({ id: 'A2', before: '' })];
  assert.deepEqual(enabledActions(p), []);
  assert.deepEqual(actionLocks(p, { start: 0, duration: 15 }), []);
});
test('smear, residue and no-action segments get different, time-limited instructions', () => {
  const p = fixture(); p.story.actions = [action(), action({ id: 'A1', start: 10, end: 14, type: 'residue', before: '薄层', after: '薄层仍可见' })];
  assert.match(actionLocks(p, { start: 0, duration: 10 }).join(''), /2.00–10.00秒.*涂抹过程/);
  assert.match(actionLocks(p, { start: 10, duration: 4 }).join(''), /只保留对应时刻的残留.*不增加涂抹动作/);
  assert.deepEqual(actionLocks(p, { start: 15, duration: 15 }), []);
  const middle = actionLocks(p, { start: 4, duration: 2 }).join('');
  assert.match(middle, /动作中途.*不重新点涂/); assert.match(middle, /动作仍未完成/); assert.ok(!middle.includes('推开后变薄'));
  p.story.actions = [action({ type: 'apply' })]; assert.ok(!actionLocks(p, { start: 0, duration: 15 }).join('').includes('随手指摊开'));
});
test('manual controls can disable high confidence or approve evidenced low confidence, never unknown actions', () => {
  const p = fixture(); p.story.actions = [action({ confidence: 'low' })];
  p.edits = validateEdits(p, { ...p.edits, continuity: { actions: { A0_0: 'on' } } }); assert.equal(enabledActions(p).length, 1);
  p.edits.continuity.actions.A0_0 = 'off'; assert.equal(enabledActions(p).length, 0);
  p.story.actions[0].type = 'uncertain'; assert.throws(() => validateEdits(p, { ...p.edits, continuity: { actions: { A0_0: 'on' } } }), /缺少画面依据/);
});
test('source cuts and complete continuous application take precedence over new dialogue boundaries', () => {
  const p = fixture(); p.source.duration = 41.833333; p.story.shots[0].end = p.source.duration;
  p.sourceCuts = [3.766667, 8.6, 12.6, 29.866667];
  p.story.actions = [action({ start: 4, end: 8, type: 'apply' }), action({ id: 'A1', start: 8, end: 12.6 })];
  p.edits.fullDialogue = { enabled: true, text: '这是一段完整的中文台词。'.repeat(28), speakerId: 'C001' };
  const before = JSON.stringify(p), plan = planStudio(p), spoken = [];
  assert.equal(plan.canGenerate, true);
  assert.ok(plan.segments.some(s => Math.abs(s.start + s.duration - 12.6) < 0.001));
  assert.ok(!plan.segments.some(s => s.start === 7.766667 || s.start === 8));
  for (const s of plan.segments) {
    assert.ok(s.frames <= 450);
    for (const line of s.dialogueLines) assert.ok(line.start >= s.start - 0.001 && line.end <= s.start + s.duration + 0.001);
    const prompt = studioPrompt({ recipe: p }, s);
    spoken.push(...[...prompt.matchAll(/说：“([\s\S]*?)”。只说这一句/g)].map(m => m[1]));
  }
  assert.equal(spoken.join('').replace(/\s/gu, ''), p.edits.fullDialogue.text);
  assert.equal(plan.segments.reduce((sum, s) => sum + s.frames, 0), 1255);
  assert.equal(JSON.stringify(p), before);
});
test('long actions remain within 15 seconds, with visible risk and quiet-point candidates', () => {
  const p = fixture(); p.story.actions = [action({ start: 0, end: 30 })]; p.sourceQuietPoints = [14.2];
  const ranges = visualRanges(p); assert.ok(ranges.every(s => s.frames <= 450)); assert.ok(ranges.some(s => s.boundaryRisk));
  assert.equal(ranges.reduce((n, s) => n + s.frames, 0), 900);
});
test('analysis maps action asset IDs and offsets; old responses do not mean no action', () => {
  const raw = { summary: '', characters: [{ id: 'old', name: '人物' }], scenes: [], props: [], shots: [{ start: 0, end: 10, characterIds: ['old'], propIds: [] }], dialogues: [], actions: [action({ start: 1, end: 3, characterId: 'old' })] };
  const story = mergeStory(emptyStory(), raw, { index: 1, start: 60, duration: 10 });
  assert.equal(story.actions[0].characterId, 'C001'); assert.equal(story.actions[0].start, 61); assert.deepEqual(story.actionWindows, [1]);
  delete raw.actions; assert.equal(mergeStory(emptyStory(), raw, { index: 0, start: 0, duration: 10 }).actionVersion, undefined);
});

test('visual planning covers fractional clips through ten minutes without lost or duplicated frames', () => {
  for (const duration of [0.1, 1.967, 14.999, 15.001, 59.933, 60, 121.167, 599.967, 600]) {
    const p = fixture(); p.source.duration = duration; p.story.shots[0].end = duration;
    p.sourceCuts = [2.733, 8.667, 28.1, 60.033, 99.933, 185.267, 245.533, 400.133].filter(t => t < duration);
    const ranges = visualRanges(p); let frame = 0;
    for (const segment of ranges) { assert.equal(segment.startFrame, frame); assert.ok(segment.frames > 0 && segment.frames <= 450); frame += segment.frames; }
    assert.equal(frame, Math.round(duration * 30));
  }
});
