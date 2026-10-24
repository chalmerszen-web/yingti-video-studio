import test from 'node:test';
import assert from 'node:assert/strict';
import { actionEvidence, effectiveAction } from '../public/action-evidence.js';
import { actionContracts, actionLocks, enabledActions, normalizeActions, validateContinuityEdits } from '../src/continuity.js';
import { normalizeAnalysisInterval } from '../src/story.js';
import { continuityEditor as userEditor } from '../public/user-continuity.js';
import { continuityEditor as developerEditor } from '../public/continuity-ui.js';

// These observations are copied from the saved analysis of the customer's
// original 32.167-second JOVISSE clip. The test concerns the contradictory
// record, not an assertion that model observations are frame-level truth.
const originalObservations = [
  { start: 6, end: 9, type: 'apply', characterId: 'C001', propId: 'P001', region: '脸颊、额头、下巴',
    before: '皮肤上有数个白色膏体点', after: '膏体被手指初步推开',
    evidence: '画面清晰显示手指将脸上的白色膏体向四周涂抹', confidence: 'high' },
  { start: 9, end: 13, type: 'spread', characterId: 'C001', propId: 'P001', region: '全脸',
    before: '膏体呈不均匀的条纹状', after: '膏体完全融入皮肤，肤色提亮',
    evidence: '手部持续在脸上做打圈和抚平动作，直至膏体不可见', confidence: 'high' },
];
const event = (fields = {}) => ({ id: 'A0', start: 2, end: 8, type: 'spread', characterId: 'C001', propId: 'P001',
  region: '画面左侧脸颊', before: '脸颊上有白色膏体块', after: '接触区域变为均匀薄层',
  evidence: '指腹持续接触白色膏体，向外推开后覆盖面积增加、厚度下降', confidence: 'high', ...fields });
function fixture(actions = [event()]) {
  return { id: 'customer-source', source: { duration: 32.167 }, story: { assets: [
    { id: 'C001', type: 'character', name: '白衣女人' }, { id: 'C002', type: 'character', name: '蕾丝衫女人' },
    { id: 'P001', type: 'prop', name: 'JOVISSE面霜瓶' },
  ], shots: [], actions, actionWindows: [0] }, edits: { assets: { P001: { main: { file: 'target-closed-jar.jpg' }, notes: '' } }, continuity: { actions: {}, autoReview: true } } };
}

test('saved source apply/spread contradiction is not emitted as a no-spreading hard lock', () => {
  const actions = normalizeActions(originalObservations, { index: 0, start: 0, duration: 32.167 }, id => id, normalizeAnalysisInterval);
  const project = fixture(actions), before = JSON.stringify(project);
  assert.equal(actions[0].type, 'apply');
  assert.equal(actionEvidence(actions[0]).conflict, true);
  assert.deepEqual(enabledActions(project).map(action => action.id), ['A0_1']);
  assert.equal(actionContracts(project, { start: 6, duration: 3 }).length, 0);
  assert.throws(() => validateContinuityEdits(project, { actions: { A0_0: 'on' } }), /分类与推开证据冲突/u);
  assert.equal(JSON.stringify(project), before);
  project.edits.continuity = validateContinuityEdits(project, { actions: { A0_0: 'spread' } });
  const contract = actionContracts(project, { start: 6, duration: 3 })[0];
  assert.equal(contract.type, 'spread');
  assert.equal(contract.sourceType, 'apply');
  assert.equal(contract.reviewed, true);
  assert.equal(contract.target, 'source');
  assert.equal(contract.exit.state, originalObservations[0].after);
  assert.ok(!actionLocks(project, { start: 6, duration: 3 }).join('').includes('不提前推匀'));
});

test('full-spread target requires an observed contact event and explicit review, not product copy', () => {
  const project = fixture();
  assert.equal(actionContracts(project, { start: 0, duration: 10 })[0].exit.kind, 'observed');
  project.edits.continuity = validateContinuityEdits(project, { actions: { A0: 'spread_finish' }, autoReview: false });
  assert.equal(project.edits.continuity.autoReview, false);
  assert.equal(actionContracts(project, { start: 0, duration: 10 })[0].exit.kind, 'spread_finish');
  for (const action of [event({ type: 'uncertain' }), event({ evidence: '字幕说这款面霜好抹开' }),
    event({ evidence: '手部被遮挡，无法确认是否接触或推开膏体' }), event({ region: '' }), event({ type: 'residue' })]) {
    const other = fixture([action]);
    assert.throws(() => validateContinuityEdits(other, { actions: { A0: 'spread_finish' } }), /缺少画面依据/u);
  }
  assert.equal(enabledActions(fixture([event({ evidence: '字幕说这款面霜好抹开' })])).length, 0);
  assert.throws(() => validateContinuityEdits(fixture([event({ evidence: '字幕说这款面霜好抹开' })]), { actions: { A0: 'on' } }), /缺少画面依据/u);
  const low = fixture([event({ confidence: 'low' })]);
  assert.equal(enabledActions(low).length, 0);
  low.edits.continuity = validateContinuityEdits(low, { actions: { A0: 'spread' } });
  assert.equal(enabledActions(low).length, 1);
});

test('split spreading event keeps intermediate state without finishing early or resetting the next segment', () => {
  const project = fixture([event({ start: 6, end: 18 })]);
  project.edits.continuity.actions.A0 = 'spread_finish';
  const first = actionContracts(project, { start: 0, duration: 15 })[0];
  const next = actionContracts(project, { start: 15, duration: 15 })[0];
  assert.equal(first.entry.kind, 'observed'); assert.equal(first.exit.kind, 'continuation');
  assert.equal(next.entry.kind, 'continuation'); assert.equal(next.exit.kind, 'spread_finish');
  assert.equal(first.stateKey, next.stateKey); assert.equal(next.localStart, 0); assert.equal(next.localEnd, 3);
  assert.equal(next.entry.state, null);
  assert.match(actionLocks(project, { start: 15, duration: 15 }).join(''), /不重置为厚膏/u);
});

test('completed target carries through adjacent residue but cannot bleed across person, side, product or new deposits', () => {
  const project = fixture([
    event(), event({ id: 'R1', start: 8, end: 10, type: 'residue' }),
    event({ id: 'R2', start: 10, end: 12, type: 'residue' }),
    event({ id: 'other-person', start: 8, end: 10, type: 'residue', characterId: 'C002' }),
    event({ id: 'other-side', start: 8, end: 10, type: 'residue', region: '画面右侧脸颊' }),
    event({ id: 'other-product', start: 8, end: 10, type: 'residue', propId: null }),
    event({ id: 'new-deposit', start: 12, end: 13, type: 'apply', before: '左侧脸颊已是薄层', after: '新点上白色膏体', evidence: '指尖在脸颊新点上一小粒膏体' }),
    event({ id: 'new-residue', start: 13, end: 14, type: 'residue' }),
  ]);
  project.edits.continuity.actions.A0 = 'spread_finish';
  const contracts = actionContracts(project, { start: 0, duration: 15 });
  for (const id of ['R1', 'R2']) assert.equal(contracts.find(action => action.id === id).exit.kind, 'spread_finish');
  for (const id of ['other-person', 'other-side', 'other-product', 'new-deposit', 'new-residue']) {
    assert.equal(contracts.find(action => action.id === id).exit.kind, 'observed');
  }
});

test('replacement identity follows action propId without deriving cream colour from a closed jar', () => {
  const project = fixture();
  const material = actionContracts(project, { start: 0, duration: 15 })[0].material;
  assert.equal(material.replacement.id, 'P001'); assert.equal(material.observed, null);
  assert.equal(material.noContainerInference, true);
  project.story.actions[0].propId = null;
  assert.equal(actionContracts(project, { start: 0, duration: 15 })[0].material.replacement, null);
  project.story.actions[0].propId = 'P001';
  project.story.actions[0].materialAppearance = '杏粉色乳霜';
  project.story.actions[0].materialEvidence = '从紫色瓶盖推测膏体为杏粉色';
  assert.equal(actionContracts(project, { start: 0, duration: 15 })[0].material.observed, null);
  project.story.actions[0].materialEvidence = '脸颊及指腹上可见杏粉色膏体';
  assert.equal(actionContracts(project, { start: 0, duration: 15 })[0].material.observed.appearance, '杏粉色乳霜');
});

test('both editions expose conflict review and the scoped completion target', () => {
  const project = fixture(normalizeActions(originalObservations, { index: 0, start: 0, duration: 32.167 }, id => id, normalizeAnalysisInterval));
  for (const render of [userEditor, developerEditor]) {
    const html = render(project, project.edits, { segments: [] });
    assert.match(html, /记录标为点涂/u);
    assert.match(html, /value="spread"/u); assert.match(html, /value="spread_finish"/u);
    const firstControl = html.match(/data-action-mode="A0_0"[\s\S]+?<\/select>/u)[0];
    assert.ok(!firstControl.includes('value="on"'));
  }
});

test('negative or ambiguous spreading evidence cannot override point-application instructions', () => {
  for (const evidence of ['手指接触膏体但未见明显推开', '手指遮住脸，看不清是否抹开', '没有接触皮肤或揉匀的画面']) {
    const action = event({ type: 'apply', evidence });
    assert.equal(actionEvidence(action).canSpread, false);
    assert.equal(effectiveAction(action, 'spread'), null);
    assert.equal(effectiveAction(action, 'auto'), null);
  }
});
