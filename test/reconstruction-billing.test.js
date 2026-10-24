import test from 'node:test';
import assert from 'node:assert/strict';
import { reconstructionAttemptFor } from '../public/reconstruction-ui.js';
import { qualityPanel as userQualityPanel } from '../public/user-continuity.js';
import { qualityPanel as developerQualityPanel } from '../public/continuity-ui.js';

const metadata = () => ({ start: 13, end: 18, characterId: 'C001', materialAssetId: 'P001', stageMode: 'single', notes: '', reviewModel: 'Omni-Analysis', confirmNewCharge: true });
const files = () => [{ name: 'first.png' }, { name: 'last.png' }];
let parentCounter = 0;
const controller = () => {
  let nonce = 0; const parentId = `billing-test-${++parentCounter}`;
  return { parentId, tracker: reconstructionAttemptFor(parentId, () => `nonce-${++nonce}`), nonceCount: () => nonce };
};

test('explicit rejected requests retain identity when unchanged and allocate a new identity after every semantic edit', () => {
  const changes = [value => { value.start = 14; }, value => { value.end = 19; }, value => { value.characterId = 'C002'; },
    value => { value.materialAssetId = 'P002'; }, value => { value.stageMode = 'three_regions'; }, value => { value.notes = '重新推开'; }];
  for (const change of changes) {
    const { tracker } = controller(), images = files(), data = metadata();
    const first = tracker.begin(data, images); tracker.response(first.requestId, 400, { error: '明确参数拒绝，未创建任务' });
    const retry = tracker.begin(data, images); assert.equal(retry.requestId, first.requestId);
    tracker.response(retry.requestId, 422, { error: '明确参数拒绝' });
    change(data); const updated = tracker.begin(data, images); assert.notEqual(updated.requestId, first.requestId);
  }
  const { tracker } = controller(), images = files(), first = tracker.begin(metadata(), images);
  tracker.response(first.requestId, 400, { error: '图片被明确拒绝' });
  assert.notEqual(tracker.begin(metadata(), [{ name: 'new-first.png' }, images[1]]).requestId, first.requestId);
});

test('network, server errors, non-JSON responses and in-progress conflicts freeze the original attempt without another nonce', () => {
  for (const outcome of ['network', 500, 502, 201, 400, 409]) {
    const { tracker, nonceCount } = controller(), images = files(), data = metadata();
    const first = tracker.begin(data, images);
    if (outcome === 'network') tracker.unknown(first.requestId, '网络中断');
    else tracker.response(first.requestId, outcome, [500, 502, 409].includes(outcome) ? { error: '提交结果未确认' } : undefined);
    assert.equal(tracker.current().state, 'unknown');
    data.notes = '换图重试';
    assert.throws(() => tracker.begin(data, files()), /只能查询原版本/);
    assert.equal(nonceCount(), 1); assert.equal(tracker.current().requestId, first.requestId);
    assert.equal(tracker.current().metadata.notes, ''); assert.equal(tracker.current().files[0], images[0]);
  }
});

test('a closed and reopened dialog shares its pending record and accepts only the corresponding saved job', () => {
  const { parentId, tracker } = controller(), first = tracker.begin(metadata(), files());
  tracker.unknown(first.requestId, '未知请求');
  const reopened = reconstructionAttemptFor(parentId, () => { throw new Error('Recovery must not allocate another request ID'); });
  assert.equal(reopened.current().requestId, first.requestId);
  const snapshot = reopened.current(); snapshot.metadata.start = 0;
  assert.equal(reopened.current().metadata.start, 13, 'Frozen metadata is not mutable through a snapshot');
  reopened.response(first.requestId, 200, { id: 'wrong-id', recipe: { actionRebuild: { parentJobId: parentId } } });
  assert.equal(reopened.current().state, 'unknown');
  reopened.response(first.requestId, 200, { id: first.requestId, recipe: { actionRebuild: { parentJobId: parentId } } });
  assert.equal(reopened.current().state, 'created');
  assert.throws(() => reopened.begin(metadata(), files()), /尚待取回/);
  reopened.acknowledged(first.requestId); assert.equal(tracker.current(), null);
});

test('a known saved job remains recoverable when rendering its result fails', () => {
  const { parentId, tracker } = controller(), attempt = tracker.begin(metadata(), files());
  tracker.response(attempt.requestId, 201, { id: attempt.requestId, recipe: { actionRebuild: { parentJobId: parentId } } });
  const reopened = reconstructionAttemptFor(parentId);
  assert.equal(reopened.current().state, 'created'); assert.equal(reopened.current().job.id, attempt.requestId);
  assert.throws(() => reopened.begin({ ...metadata(), notes: '新参数' }, files()), /只能查询原版本/);
  assert.equal(Object.hasOwn(reopened.current(), 'csrf'), false); assert.equal(Object.hasOwn(reopened.current(), 'key'), false);
});

const stagedJob = () => ({ id: 'staged-job', state: 'completed', workflow: 'studio', recipe: { actionRebuild: { stages: [{}, {}, {}] } },
  segments: [{ index: 0, start: 0, duration: 13, generationMode: 'base_copy' },
    { index: 1, start: 13, duration: 5 / 3, generationMode: 'keyframe_rebuild' },
    { index: 2, start: 13 + 5 / 3, duration: 5 / 3, generationMode: 'keyframe_rebuild' },
    { index: 3, start: 13 + 10 / 3, duration: 5 / 3, generationMode: 'keyframe_rebuild' },
    { index: 4, start: 18, duration: 14, generationMode: 'base_copy' }] });

test('both quality renderers offer one full-window rebuild and no paid repair on copied or downstream phases', () => {
  for (const render of [userQualityPanel, developerQualityPanel]) {
    const html = render(stagedJob());
    const buttons = [...html.matchAll(/<button[^>]*data-action="regenerate-segment"[^>]*>[^<]*<\/button>/gu)].map(match => match[0]);
    assert.equal(buttons.length, 1); assert.match(buttons[0], /data-index="1"/);
    assert.match(buttons[0], /重新生成整段涂抹/);
    assert.ok(!html.includes('只重做此段'));
  }
});

test('normal edit versions keep their individual repair controls and copied pieces never offer them', () => {
  for (const render of [userQualityPanel, developerQualityPanel]) {
    const job = { id: 'ordinary', state: 'completed', workflow: 'studio', segments: [{ index: 0, start: 0, duration: 5 }, { index: 1, start: 5, duration: 5 }] };
    assert.equal((render(job).match(/data-action="regenerate-segment"/gu) || []).length, 2);
    job.segments[0].generationMode = 'base_copy';
    assert.equal((render(job).match(/data-action="regenerate-segment"/gu) || []).length, 1);
  }
});

test('filtered review windows are shown on their actual phase rather than on a copied segment', () => {
  for (const render of [userQualityPanel, developerQualityPanel]) {
    const job = stagedJob(); job.quality = { state: 'completed', version: 3, verdict: 'issues', windows: [{ segmentIndex: 2, state: 'completed',
      result: [{ kind: 'material', status: 'fail', time: 15, detail: '额头仍有厚片' }] }] };
    const cards = render(job).split('<article class="quality-part">').slice(1);
    assert.ok(!cards[0].includes('额头仍有厚片')); assert.ok(cards[2].includes('额头仍有厚片'));
  }
});
