import test from 'node:test';
import assert from 'node:assert/strict';
import { compileFullDialogue, parseFullDialogue, validateFullDialogue } from '../src/full-dialogue.js';
import { planStudio, studioPrompt, effectiveDialogue, validateEdits } from '../src/story.js';
import { demoProject } from '../public/studio-demo.js';
import { initializeFullDialogue, completeScript } from '../public/full-dialogue-ui.js';

const noWhitespace = value => value.replace(/\s+/gu, '');
const withFull = (text, speakerId = 'auto') => { const p = demoProject(); p.edits.fullDialogue = { enabled: true, text, speakerId }; return p; };

test('a complete monologue remains complete, with bounded timing and no old lines appended', () => {
  const text = '这是第一句话，先把产品展示清楚。接着介绍使用方式。最后说再见。';
  const p = withFull(text, 'C001'), full = compileFullDialogue(p);
  assert.equal(noWhitespace(full.lines.map(l => l.text).join('')), noWhitespace(text));
  assert.ok(full.lines.every(l => l.characterId === 'C001' && l.end > l.start && l.end - l.start <= 12.01 && l.end <= p.source.duration));
  const plan = planStudio(p); assert.equal(plan.hasChanges, true); assert.equal(plan.audioMode, 'mixed'); assert.ok(plan.segments.every(s => s.audioChanged));
  assert.ok(plan.segments.every(s => s.duration <= 15 && s.requestDuration <= 15));
  const prompt = studioPrompt({ recipe: p }, plan.segments[0]);
  assert.match(prompt, /整篇台词替换/); assert.match(prompt, /原视频的所有旧人声对白都要移除/);
  assert.doesNotMatch(prompt, /原对白「这是我最近新换的精华/);
  assert.doesNotMatch(prompt, /保留其他人物对白/);
});

test('short full scripts keep a sentence together and leave old dialogue silent afterwards', () => {
  const p = withFull('你好，欢迎回来。', 'C001');
  const result = compileFullDialogue(p); assert.equal(result.lines.length, 1); assert.equal(result.lines[0].text, p.edits.fullDialogue.text);
  assert.ok(result.lines[0].end < p.source.duration / 2); assert.match(result.warnings.join(''), /不再保留原对白/);
  const plan = planStudio(p), silentTail = plan.segments.find(s => !s.dialogueIds.length);
  assert.ok(silentTail); assert.equal(silentTail.audioChanged, true);
  assert.match(studioPrompt({ recipe: p }, silentTail), /没有安排新台词的时间保持人声静默/);
});

test('speaker labels retain dialogue order and text without creating new people', () => {
  const p = withFull('林夏：这是新的完整台词，请自然地说出来。\n陈言：好的，我明白了。');
  const result = compileFullDialogue(p);
  assert.deepEqual(result.lines.map(l => l.characterId), ['C001', 'C002']);
  assert.deepEqual(result.lines.map(l => l.text), ['这是新的完整台词，请自然地说出来。', '好的，我明白了。']);
  assert.throws(() => parseFullDialogue('[C999] 不应出现的新角色。', p.story.assets), /未识别说话人/);
  assert.throws(() => parseFullDialogue('林夏：你好。\n陌生角色：不应猜测。', p.story.assets), /未识别说话人/);
  assert.equal(parseFullDialogue('注意：这是一段普通口播，不是人物标签。', p.story.assets).spokenText, '注意：这是一段普通口播，不是人物标签。');
});

test('overlong drafts warn about speed but remain complete and can submit', () => {
  const p = withFull('这段文稿会完整保留，不能为了时长删掉任何文字。'.repeat(45), 'C001');
  const result = compileFullDialogue(p);
  assert.equal(result.spokenText, p.edits.fullDialogue.text);
  assert.match(result.warnings.join(''), /仅提醒，可继续生成/);
  assert.equal(noWhitespace(result.lines.map(l => l.text).join('')), noWhitespace(p.edits.fullDialogue.text));
  assert.ok(result.lines.length > 0);
  const plan = planStudio(p); assert.equal(plan.canGenerate, true); assert.equal(plan.blockers.length, 0);
  assert.ok(plan.segments.every(s => s.frames > 0 && s.frames <= 450));
});

test('English words and punctuation are retained, including mixed Chinese and emoji', () => {
  const p = withFull('Hello everyone! 今天介绍一款产品😀。Keep every word, including OpenAI and punctuation.', 'C001');
  const result = compileFullDialogue(p);
  assert.equal(noWhitespace(result.lines.map(l => l.text).join('')), noWhitespace(p.edits.fullDialogue.text));
  const joined = result.lines.map(l => l.text).join('|'); assert.ok(joined.includes('OpenAI'));
  assert.ok(result.lines.every(l => !l.text.includes('C001')));
});

test('disabled or absent full-script changes preserve original dialogue and legacy work', () => {
  const p = demoProject(); p.edits.dialogues = [{ ...p.story.dialogues[0], enabled: true, text: '旧版保存的新台词。' }];
  assert.equal(effectiveDialogue(p)[0].text, '旧版保存的新台词。');
  const clone = structuredClone(p.edits); assert.equal(initializeFullDialogue(p, clone), true); assert.match(clone.fullDialogue.text, /旧版保存的新台词/);
  p.edits.fullDialogue = { enabled: false, text: '尚未启用的文字', speakerId: 'auto' };
  assert.equal(effectiveDialogue(p)[0].text, p.story.dialogues[0].text);
  assert.equal(planStudio(p).hasChanges, false);
  assert.ok(completeScript(p).includes(p.story.dialogues[0].text));
});

test('missing visual references never enable edits from notes or voice alone', () => {
  const p = demoProject();
  p.edits.assets.C001 = { notes: '把脸改成机器人，衣服变红。' };
  assert.equal(planStudio(p).hasChanges, false);
  p.edits.assets.C001.voice = { file: 'voice.wav', shortFile: 'short.wav', duration: 4 };
  const plan = planStudio(p); assert.equal(plan.hasChanges, true); assert.ok(plan.segments[0].bindings.every(b => b.type === 'reference_audio'));
  const prompt = studioPrompt({ recipe: p }, plan.segments[0]); assert.doesNotMatch(prompt, /机器人/); assert.match(prompt, /不改变人物外观/);
  assert.doesNotMatch(prompt, /人脸替换|中的三视图/);
  p.edits.assets.P001 = { main: { file: 'product.png' }, notes: '只替换瓶子' };
  const changed = planStudio(p); const body = studioPrompt({ recipe: p }, changed.segments[0]);
  assert.match(body, /补充要求.*只替换瓶子/); assert.doesNotMatch(body, /机器人/);
});

test('full script validation, empty text, overlapping speakers and no-dialogue sources are explicit', () => {
  const p = withFull(''); assert.throws(() => compileFullDialogue(p), /粘贴完整/);
  assert.throws(() => validateFullDialogue(p, { enabled: true, text: '字'.repeat(20001), speakerId: 'auto' }), /20000/);
  assert.throws(() => validateFullDialogue(p, { enabled: true, text: '你好', speakerId: 'C999' }), /不存在/);
  p.edits.fullDialogue.text = '你好。'; p.story.dialogues = [{ start: 0, end: 4, characterId: 'C001', text: '你好' }, { start: 2, end: 6, characterId: 'C002', text: '回应' }];
  assert.throws(() => compileFullDialogue(p), /同时发声/);
  p.edits.fullDialogue.speakerId = 'C001'; assert.doesNotThrow(() => compileFullDialogue(p));
  p.story.dialogues = []; p.edits.fullDialogue.speakerId = 'narrator';
  const result = compileFullDialogue(p); assert.equal(result.lines[0].characterId, null); assert.match(result.warnings.join(''), /未识别出对白时段/);
  const saved = validateEdits(p, { model: 'wan3.0-720p', assets: {}, dialogues: [], fullDialogue: p.edits.fullDialogue }); assert.deepEqual(saved.fullDialogue, { ...p.edits.fullDialogue, delivery:'generated', voiceId:'', speed:1, criticalTerms:'', subtitles:'replace', subtitlesExplicit:false });
});
