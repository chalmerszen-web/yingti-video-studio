import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAnalysisInterval, mergeStory, emptyStory } from '../src/story.js';

const duration = 32.166667;
const finalWindow = { index: 0, start: 0, duration, sourceDuration: duration };
const raw = () => ({
  summary: '模型片尾时间偏差',
  characters: [{ id: 'C001', name: '讲解者', firstSeen: 0 }], scenes: [], props: [],
  shots: [{ start: 0, end: duration, summary: '讲解镜头', characterIds: ['C001'], propIds: [], sceneId: null }],
  dialogues: [{ start: 31.36, end: 32.96, text: '这是保留的片尾台词。\n“不能改写”', characterId: 'C001', uncertain: false }],
  warnings: [],
});
const rejectsTiming = (item, window = finalWindow, kind = 'dialogue') => assert.throws(
  () => normalizeAnalysisInterval(item, window, kind, 0),
  error => { assert.equal(error.code, 'analysis_timing'); return true; },
);

test('the reported 0.793-second tail drift is clamped and audited without rewriting the model result', () => {
  const input = raw();
  input.dialogues.unshift({ start: 0.1, end: 2.9, text: '正常台词。', characterId: 'C001', uncertain: false });
  const before = structuredClone(input), previous = emptyStory();
  const story = mergeStory(previous, input, finalWindow), tail = story.dialogues.at(-1);
  assert.equal(tail.start, 31.36); assert.equal(tail.end, duration);
  assert.equal(tail.text, before.dialogues.at(-1).text); assert.equal(tail.uncertain, true);
  assert.equal(tail.timingAdjustment.reason, 'tail_boundary_clamp');
  assert.equal(tail.timingAdjustment.originalStart, 31.36); assert.equal(tail.timingAdjustment.originalEnd, 32.96);
  assert.equal(tail.timingAdjustment.correctedEnd, duration);
  assert.deepEqual(story.dialogues[0], { id: 'L001', start: 0.1, end: 2.9, characterId: 'C001', text: '正常台词。', emotion: '', uncertain: false });
  assert.equal(story.shots[0].end, duration, 'Other intervals are not rescaled');
  assert.equal(story.warnings.length, 1); assert.match(story.warnings[0], /32\.960.*32\.167/);
  assert.deepEqual(input, before); assert.deepEqual(previous, emptyStory());
});

test('the extended one-second tail bound is inclusive and 1.001 seconds is rejected', () => {
  const window = { start: 0, duration: 32, sourceDuration: 32 };
  for (const kind of ['dialogue', 'shot']) {
    const result = normalizeAnalysisInterval({ start: 30, end: 33 }, window, kind, 0);
    assert.equal(result.end, 32); assert.equal(result.timingAdjustment.reason, 'tail_boundary_clamp');
    rejectsTiming({ start: 30, end: 33.001 }, window, kind);
  }
});

test('short final clips retain the ten-percent bound rather than receiving a full second', () => {
  const window = { start: 0, duration: 8, sourceDuration: 8 };
  const result = normalizeAnalysisInterval({ start: 6, end: 8.8 }, window, 'dialogue', 0);
  assert.equal(result.end, 8); assert.equal(result.timingAdjustment.reason, 'tail_boundary_clamp');
  rejectsTiming({ start: 6, end: 8.801 }, window);
  rejectsTiming({ start: 1, end: 5.501 }, { start: 0, duration: 5, sourceDuration: 5 });
  rejectsTiming({ start: 0.1, end: 0.5 }, { start: 0, duration: 0.4, sourceDuration: 0.4 });
});

test('intermediate boundaries and unknown or mismatched source durations cannot use the extra allowance', () => {
  for (const window of [
    { start: 0, duration: 32, sourceDuration: 64 },
    { start: 60, duration: 32, sourceDuration: 120 },
    { start: 0, duration: 32 },
    { start: 0, duration: 32, sourceDuration: Infinity },
    { start: 0, duration: 32, sourceDuration: '32' },
    { start: 0, duration: 32, sourceDuration: 32.000002 },
  ]) rejectsTiming({ start: 30, end: 32.8 }, window);
  assert.doesNotThrow(() => normalizeAnalysisInterval({ start: 30, end: 32.8 }, { start: 0, duration: 32, sourceDuration: 32.0000005 }, 'dialogue', 0));
});

test('large start drift or combined start-and-end drift remains invalid at the real source tail', () => {
  rejectsTiming({ start: -0.6, end: 2 });
  rejectsTiming({ start: -0.1, end: duration + 0.8 });
  const small = normalizeAnalysisInterval({ start: -0.2, end: duration + 0.3 }, finalWindow, 'shot', 0);
  assert.equal(small.start, 0); assert.equal(small.timingAdjustment.reason, 'boundary_clamp');
});

test('reversed, non-finite and wholly outside intervals remain errors with extended tail metadata', () => {
  for (const item of [
    { start: duration, end: duration + 0.8 }, { start: duration + 0.1, end: duration + 0.8 },
    { start: -1, end: -0.1 }, { start: 4, end: 3 }, { start: 1, end: Infinity },
    { start: NaN, end: 2 }, { start: 'bad', end: 2 },
  ]) rejectsTiming(item);
});

test('tail correction keeps at least half the interval and cannot create a tiny fragment', () => {
  const window = { start: 0, duration: 32, sourceDuration: 32 };
  const exactHalf = normalizeAnalysisInterval({ start: 31.4, end: 32.6 }, window, 'dialogue', 0);
  assert.equal(exactHalf.start, 31.4); assert.equal(exactHalf.end, 32);
  rejectsTiming({ start: 31.401, end: 32.6 }, window);
  rejectsTiming({ start: 31.801, end: 32.6 }, window, 'shot');
});

test('actions never receive the extended dialogue and shot tail tolerance', () => {
  rejectsTiming({ start: 31.36, end: 32.96 }, finalWindow, 'action');
  const input = raw();
  input.actions = [{ start: 31.36, end: 32.96, type: 'spread', characterId: 'C001', propId: null, evidence: '可见手部运动' }];
  assert.throws(() => mergeStory(emptyStory(), input, finalWindow), error => {
    assert.equal(error.code, 'analysis_timing'); assert.equal(error.details.kind, 'action'); return true;
  });
});

test('tail audit records original global timestamps in the final analysis window', () => {
  const window = { index: 1, start: 60, duration, sourceDuration: 60 + duration };
  const result = normalizeAnalysisInterval({ start: '00:31.36', end: '00:32.96' }, window, 'shot', 0);
  assert.equal(result.start, 91.36); assert.equal(result.end, 60 + duration);
  assert.equal(result.timingAdjustment.originalStart, 91.36); assert.ok(Math.abs(result.timingAdjustment.originalEnd - 92.96) < 1e-9);
  assert.equal(result.timingAdjustment.windowIndex, 1); assert.equal(result.timingAdjustment.reason, 'tail_boundary_clamp');
});

test('multiple extended clamps of the same kind fail without partially changing previous story or raw data', () => {
  for (const kind of ['dialogue', 'shot']) {
    const input = raw(), list = kind === 'dialogue' ? input.dialogues : input.shots;
    if (kind === 'shot') Object.assign(list[0], { start: 30, end: 32.96 });
    list.push({ ...list[0], start: 30.5, end: 32.9 });
    const original = structuredClone(input), previous = emptyStory();
    assert.throws(() => mergeStory(previous, input, finalWindow), error => { assert.equal(error.code, 'analysis_timing'); return true; });
    assert.deepEqual(previous, emptyStory()); assert.deepEqual(input, original);
  }
});

test('one extended shot and one extended dialogue can coexist with ordinary boundary corrections', () => {
  const input = raw();
  input.shots[0].end = 32.96;
  input.dialogues.unshift({ start: 30, end: duration + 0.2, text: '原有小误差。', characterId: 'C001', uncertain: false });
  const story = mergeStory(emptyStory(), input, finalWindow);
  assert.equal(story.shots[0].timingAdjustment.reason, 'tail_boundary_clamp');
  assert.equal(story.dialogues[0].timingAdjustment.reason, 'boundary_clamp');
  assert.equal(story.dialogues[1].timingAdjustment.reason, 'tail_boundary_clamp');
  assert.equal(story.warnings.length, 3);
});
