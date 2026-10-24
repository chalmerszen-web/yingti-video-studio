import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAnalysisInterval, mergeStory, emptyStory, analysisPrompt, validateEdits } from '../src/story.js';

const window = { index: 0, start: 0, duration: 46.833333 };
const raw = () => ({ summary: '尾部时间误差回归用例', characters: [{ id: 'C001', name: '讲解者' }], scenes: [], props: [], shots: [{ start: 0, end: 46.833, summary: '讲解', characterIds: ['C001'], propIds: [], sceneId: null }], dialogues: [{ start: 0.16, end: 2.96, characterId: 'C001', text: '正常台词', uncertain: false }, { start: 43.36, end: 47.2, characterId: 'C001', text: '片尾台词，保持原文', uncertain: false }], warnings: [] });

test('small tail drift is clamped, audited, and marked for review without changing text', () => {
  const input = raw(), before = JSON.stringify(input);
  const story = mergeStory(emptyStory(), input, window);
  assert.equal(story.dialogues[0].start, 0.16); assert.equal(story.dialogues[0].end, 2.96); assert.equal(story.dialogues[0].uncertain, false);
  const tail = story.dialogues.at(-1);
  assert.equal(tail.start, 43.36); assert.equal(tail.end, 46.833); assert.equal(tail.text, input.dialogues[1].text); assert.equal(tail.uncertain, true);
  assert.equal(tail.timingAdjustment.originalEnd, 47.2); assert.equal(tail.timingAdjustment.correctedEnd, tail.end);
  assert.equal(story.warnings.length, 1); assert.match(story.warnings[0], /47\.200.*46\.833/);
  assert.equal(JSON.stringify(input), before, 'The saved model output is never mutated');
  const edits = validateEdits({ source: { duration: window.duration }, story, edits: { assets: {} } }, { model: 'wan3.0-720p', assets: {}, dialogues: [{ ...tail, enabled: true }] });
  assert.equal(edits.dialogues[0].end, 46.833);
});

test('normalization uses local bounds but records global times across analysis windows', () => {
  const result = normalizeAnalysisInterval({ start: -0.2, end: 10.35 }, { index: 1, start: 60, duration: 10 }, 'shot', 2);
  assert.equal(result.start, 60); assert.equal(result.end, 70);
  assert.equal(result.timingAdjustment.originalStart, 59.8); assert.equal(result.timingAdjustment.originalEnd, 70.35);
  assert.match(result.warning, /第 2 部分的第 3 个分镜/);
});

test('large, reversed, non-finite, and wholly out-of-window intervals remain errors', () => {
  for (const item of [{ start: 43, end: 48 }, { start: 48, end: 49 }, { start: -1, end: -0.1 }, { start: 4, end: 3 }, { start: 1, end: Infinity }, { start: 'bad', end: 2 }]) {
    assert.throws(() => normalizeAnalysisInterval(item, window, 'dialogue', 10), error => {
      assert.equal(error.code, 'analysis_timing'); assert.equal(error.details.index, 10); assert.match(error.message, /第 11 句台词/); return true;
    });
  }
  assert.throws(() => normalizeAnalysisInterval({ start: 43.36, end: 47.334 }, window, 'dialogue', 10), /超过可自动校正/);
  assert.doesNotThrow(() => normalizeAnalysisInterval({ start: 43.36, end: 47.333333 }, window, 'dialogue', 10));
});

test('short clips do not get half-second tolerance and rounding never expands the window', () => {
  assert.throws(() => normalizeAnalysisInterval({ start: 0.1, end: 0.6 }, { start: 0, duration: 0.4 }, 'shot', 0));
  const result = normalizeAnalysisInterval({ start: 0.1, end: 0.43 }, { start: 0, duration: 0.4 }, 'shot', 0);
  assert.equal(result.end, 0.4);
  const rounded = normalizeAnalysisInterval({ start: 0, end: 1.0008 }, { start: 0, duration: 1.0008 }, 'shot', 0);
  assert.ok(rounded.end <= 1.0008);
});

test('prompts reinforce real end time and keep examples within short windows', () => {
  const prompt = analysisPrompt({ story: emptyStory() }, { start: 60, duration: 0.8 });
  assert.match(prompt, /end <= 0\.800000/); assert.match(prompt, /不要推算未播放完/);
  const example = JSON.parse(prompt.split('\n').find(line => line.startsWith('{"summary"')));
  assert.ok(example.shots[0].end <= 0.8); assert.ok(example.dialogues[0].end <= 0.8);
});
