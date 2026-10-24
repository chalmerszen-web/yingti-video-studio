import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisWindows, parseStoryJSON, mergeStory, emptyStory, validateEdits, planStudio, studioPrompt } from '../src/story.js';
import { demoProject } from '../public/studio-demo.js';

test('analysis windows retain exact global offsets up to ten minutes', () => {
  const windows = analysisWindows(600); assert.equal(windows.length, 10); assert.equal(windows.at(-1).start, 540); assert.equal(windows.at(-1).duration, 60);
  assert.equal(analysisWindows(61.2).at(-1).duration, 1.2000000000000028);
  assert.throws(() => analysisWindows(601));
});

test('structured analysis maps stable assets and local times back to original video', () => {
  const raw = { summary: '第一段', characters: [{ id: 'woman', name: '女人', description: '白衣，左侧', firstSeen: 0 }], scenes: [{ id: 'room', name: '客厅', firstSeen: 0 }], props: [], shots: [{ start: 0, end: 10, summary: '交谈', characterIds: ['woman'], sceneId: 'room', propIds: [] }], dialogues: [{ start: '00:01.5', end: '00:03.5', characterId: 'woman', text: '你好', uncertain: false }] };
  const first = mergeStory(emptyStory(), parseStoryJSON('```json\n' + JSON.stringify(raw) + '\n```'), { start: 0, duration: 10 });
  assert.equal(first.assets[0].id, 'C001'); assert.equal(first.dialogues[0].start, 1.5);
  const second = { ...raw, characters: [{ id: 'C001', name: '女人', description: '白衣' }, { id: 'new-person', name: '男人', description: '绿衣' }], scenes: [{ id: 'S001', name: '客厅' }], shots: [{ start: 0, end: 10, summary: '回应', characterIds: ['C001', 'new-person'], sceneId: 'S001', propIds: [] }], dialogues: [{ start: 1, end: 2, characterId: 'new-person', text: '欢迎' }] };
  const result = mergeStory(first, second, { start: 60, duration: 10 });
  assert.equal(result.assets.filter(a => a.type === 'character').length, 2); assert.equal(result.dialogues[1].start, 61); assert.equal(result.dialogues[1].characterId, 'C002');
  assert.throws(() => mergeStory(emptyStory(), { ...raw, shots: [{ start: 0, end: 600, characterIds: [], propIds: [] }] }, { start: 0, duration: 10 }));
  assert.throws(() => mergeStory(emptyStory(), { ...raw, shots: [] }, { start: 0, duration: 10 }));
});

test('edits cannot inject file bindings or unknown speakers', () => {
  const project = demoProject(); project.edits.assets.C001 = { main: { file: 'assets/owned/main.png' }, notes: '旧说明' };
  const edits = validateEdits(project, { model: 'wan3.0-720p', assets: { C001: { main: { file: '../../secret' }, notes: '新说明' } }, dialogues: [] });
  assert.equal(edits.assets.C001.main.file, 'assets/owned/main.png'); assert.equal(edits.assets.C001.notes, '新说明');
  assert.throws(() => validateEdits(project, { model: 'wan3.0-720p', assets: {}, dialogues: [{ id: 'L001', enabled: true, text: '新句子', start: 1, end: 2, characterId: 'C999' }] }));
});

test('new local IDs cannot collide with canonical IDs allocated earlier in the same response', () => {
  const raw = { summary: '', characters: [{ id: 'woman', name: '女人' }, { id: 'C001', name: '男人' }], scenes: [], props: [], shots: [{ start: 0, end: 3, characterIds: ['woman', 'C001'], propIds: [] }], dialogues: [] };
  const story = mergeStory(emptyStory(), raw, { start: 0, duration: 3 });
  assert.equal(story.assets.length, 2); assert.deepEqual(story.shots[0].characterIds, ['C001', 'C002']);
});

test('dialogue-only and voice-only edits work without character images', () => {
  const project = demoProject();
  project.edits.dialogues = [{ id: 'L003', start: 13.1, end: 16.7, characterId: 'C001', text: '这是新的台词。', enabled: true }];
  const plan = planStudio(project); assert.equal(plan.audioMode, 'mixed'); assert.equal(plan.hasChanges, true);
  assert.ok(plan.segments.every(s => s.frames <= 450));
  const changed = plan.segments.filter(s => s.audioChanged); assert.equal(changed.length, 1);
  const prompt = studioPrompt({ recipe: project }, changed[0]); assert.match(prompt, /这是新的台词/); assert.match(prompt, /只说这一句/); assert.equal(changed[0].bindings.length, 0);
  project.edits.dialogues = []; project.edits.assets.C001 = { voice: { file: 'assets/voice.wav', shortFile: 'assets/short.wav', duration: 4 } };
  const voiced = planStudio(project); assert.ok(voiced.segments[0].bindings.some(b => b.type === 'reference_audio'));
  assert.match(studioPrompt({ recipe: project }, voiced.segments[0]), /林夏.*音色替换为音频1/);
});

test('visual bindings remain explicit and standalone views enable appearance replacement', () => {
  const project = demoProject();
  project.edits.assets.C001 = { views: { file: 'views.png' } };
  const combined = planStudio(project); assert.equal(combined.hasChanges, true); assert.equal(combined.segments[0].bindings.length, 1); assert.equal(combined.characterModes.C001, 'appearance');
  project.edits.assets.C001.main = { file: 'main.png' };
  project.edits.assets.P001 = { main: { file: 'product.png' } };
  const plan = planStudio(project); assert.equal(plan.audioMode, 'original');
  const prompt = studioPrompt({ recipe: project }, plan.segments[0]);
  assert.match(prompt, /C001.*图片1/); assert.match(prompt, /图片2.*三视图/); assert.match(prompt, /P001.*图片3/);
});

test('media budgets and overlapping dialogue are enforced before billing', () => {
  const project = demoProject();
  project.edits.dialogues = [{ id: 'L001', enabled: true, start: 0, end: 12, text: 'a', characterId: 'C001' }, { id: 'L002', enabled: true, start: 10, end: 22, text: 'b', characterId: 'C002' }];
  assert.throws(() => planStudio(project), /重叠台词/);
  project.edits.dialogues = [{ id: 'L001', enabled: true, start: 0, end: 20, text: 'a', characterId: 'C001' }]; assert.throws(() => planStudio(project), /超过 15 秒/);
  project.edits.dialogues = [];
  for (let i = 3; i <= 4; i++) project.story.assets.push({ id: `C00${i}`, type: 'character', name: `人物${i}`, description: '测试人物', firstSeen: 0 });
  for (const a of project.story.assets.filter(a => a.type === 'character')) { project.edits.assets[a.id] = { voice: { file: `${a.id}.wav`, shortFile: `${a.id}-short.wav`, duration: 5 } }; for (const s of project.story.shots) if (!s.characterIds.includes(a.id)) s.characterIds.push(a.id); }
  const plan = planStudio(project); assert.ok(plan.warnings.length); assert.equal(plan.segments[0].bindings.reduce((n, b) => n + (b.duration || 0), 0), 12); assert.ok(plan.segments[0].bindings.every(b => b.file.endsWith('-short.wav')));
});
