import test from 'node:test';
import assert from 'node:assert/strict';
import { propRole, propRoleEvidence, isPhysicalProp, referenceRoleIssue, materialReferenceMode } from '../public/prop-role.js';
import { normalizePropEditPolicy, propReferencePolicy, propReferenceFile, assertPropReferencePolicies, propReferenceLocks, propReferenceWarnings, selectMaterialAssetIds, materialScopeForAsset, materialReviewTargets, materialFinishReferenceIssue } from '../src/prop-reference.js';
import { normalizeProductScope, selectProductAssetIds, productScopeForAsset, productScopeReviewTargets, productScopeLocks } from '../src/product-scope.js';
import { actionContracts, actionLocks } from '../src/continuity.js';
import { planStudio, studioPrompt, validateEdits } from '../src/story.js';

const prop = (id, name, description = '') => ({ id, type: 'prop', name, description });
function customerFixture() {
  return { source: { duration: 32.167 }, story: {
    assets: [{ id: 'C001', type: 'character', name: '涂脸人物' },
      prop('P001', 'JOVISSE面霜罐', '浅蓝色圆罐，里面是乳霜；从罐中取出涂在脸上'),
      prop('P002', '面霜膏体', '粉色膏状物，从罐中取出后涂抹在脸上'),
      prop('P003', '产品包装盒'), prop('P004', '透明手提袋'), prop('P005', '优惠字幕贴纸')],
    shots: [{ id: 'SH1', start: 0, end: 13, characterIds: ['C001'], propIds: ['P001', 'P003'] },
      { id: 'SH2', start: 13, end: 18, characterIds: ['C001'], propIds: ['P002'] },
      { id: 'SH3', start: 18, end: 32.167, characterIds: ['C001'], propIds: ['P004'] }],
    actions: [{ id: 'A1', start: 13, end: 18, type: 'spread', characterId: 'C001', propId: 'P002', region: '画面右侧脸颊',
      before: '脸颊已有厚膏体块', after: '指腹向外推开形成薄层', contact: '指腹持续接触已有膏体', motion: '向外推开',
      evidence: '手指接触膏体向外推开，膏体面积扩大、厚度减小', confidence: 'high' }],
  }, edits: { assets: {
    P001: { main: { file: 'jar.png' }, uploadedImageRole: 'jar' },
    P002: { main: { file: 'crop.png' }, uploadedImageRole: 'material', materialReferenceMode: 'image' },
    P003: { main: { file: 'box.png' }, uploadedImageRole: 'packaging' },
  }, continuity: { actions: { A1: 'spread_finish' } } } };
}
const materialSegment = () => ({ start: 13, duration: 5, bindings: [
  { assetId: 'P001', slot: 'main', type: 'reference_image', file: 'jar.png' },
  { assetId: 'P002', slot: 'main', type: 'reference_image', file: 'crop.png' },
  { assetId: 'C001', slot: 'voice', type: 'reference_audio', file: 'voice.wav' },
  { assetId: 'P003', slot: 'main', type: 'reference_image', file: 'box.png' },
] });

test('legacy customer cream is a material while a jar mentioning its contents stays a jar', () => {
  const project = customerFixture(), [person, jar, cream, box, bag, caption] = project.story.assets;
  assert.equal(propRole(person), null);
  assert.equal(propRole(jar), 'jar');
  assert.equal(propRole(cream), 'material');
  assert.equal(propRole(box), 'packaging');
  assert.equal(propRole(bag), 'object');
  assert.equal(propRole(caption), 'graphic');
  assert.equal(propRole(prop('P6', '护肤原料', '粉色膏状物，取出后被涂在皮肤上')), 'material');
  assert.equal(propRole(prop('P7', '面霜', '品牌推广产品，适合日常使用')), 'object', 'brand/product copy alone does not identify the material');
  assert.equal(isPhysicalProp(cream), false);
  assert.equal(isPhysicalProp(caption), false);
  assert.ok(propRoleEvidence(jar).inferred);
});

test('explicit source evidence and human overrides beat compatibility inference without touching old data', () => {
  const asset = { ...prop('P1', '面霜膏体'), sourceRole: 'jar' }, before = JSON.stringify(asset);
  assert.equal(propRole(asset), 'jar');
  assert.equal(propRoleEvidence(asset).inferred, false);
  assert.equal(propRole(asset, { propRole: 'material' }), 'material');
  assert.equal(JSON.stringify(asset), before);
  const project = customerFixture();
  const selected = normalizePropEditPolicy(project, project.story.assets[1], { propRole: 'packaging', uploadedImageRole: 'packaging', main: { file: '../unsafe.png' } });
  assert.deepEqual(selected, { propRole: 'packaging', uploadedImageRole: 'packaging' }, 'JSON edits never introduce or replace server-owned files');
});

test('partial role edits preserve earlier confirmations while explicit empty controls clear them', () => {
  const project = customerFixture(), asset = project.story.assets[1], previous = { propRole: 'jar', uploadedImageRole: 'jar' };
  assert.deepEqual(normalizePropEditPolicy(project, asset, {}, previous), previous);
  assert.deepEqual(normalizePropEditPolicy(project, asset, { propRole: '' }, previous), { uploadedImageRole: 'jar' });
  assert.deepEqual(normalizePropEditPolicy(project, asset, { propRole: '', uploadedImageRole: '' }, previous), {});
  for (const value of ['unknown', 'auto', null, [], {}, false, 'Material']) assert.throws(() => normalizePropEditPolicy(project, asset, { propRole: value }), /素材分类/);
  assert.throws(() => normalizePropEditPolicy(project, project.story.assets[0], { propRole: 'graphic' }), /人物和场景/);
});

test('explicit jar-box mismatch blocks generation but names and upload filenames never classify the picture', () => {
  const project = customerFixture(), jar = project.story.assets[1];
  const unconfirmed = { main: { file: 'purple-packaging-box.png', names: ['jar.jpg'] } };
  const warning = referenceRoleIssue(jar, unconfirmed);
  assert.equal(warning.blocking, false);
  assert.equal(warning.imageRole, null);
  assert.match(warning.message, /不会根据文件名猜测/);
  project.edits.assets.P001.uploadedImageRole = 'packaging';
  const mismatch = referenceRoleIssue(jar, project.edits.assets.P001);
  assert.equal(mismatch.blocking, true);
  assert.throws(() => assertPropReferencePolicies(project), error => error.code === 'prop_reference_role_mismatch'
    && error.details.assetId === 'P001' && error.details.imageRole === 'packaging');
  project.edits.assets.P001.uploadedImageRole = 'jar';
  assert.doesNotThrow(() => assertPropReferencePolicies(project));
  project.edits.assets.P003.uploadedImageRole = 'jar';
  assert.throws(() => assertPropReferencePolicies(project));
  project.edits.assets.P003.uploadedImageRole = 'packaging';
  project.edits.assets.P001.propRole = 'unknown';
  assert.throws(() => assertPropReferencePolicies(project), /素材分类/);
});

test('an open jar reference for cream is constrained to material appearance, never the whole object', () => {
  const project = customerFixture(), cream = project.story.assets[2];
  project.edits.assets.P002.uploadedImageRole = 'jar';
  const policy = propReferencePolicy(cream, project.edits.assets.P002);
  assert.equal(policy.role, 'material');
  assert.equal(policy.referenceRole, 'jar');
  assert.equal(policy.usage, 'material_appearance');
  assert.equal(policy.issue.blocking, false);
  assert.match(policy.issue.message, /只参考图片中实际可见膏体/);
  const prompt = propReferenceLocks(project, materialSegment()).join('\n');
  assert.match(prompt, /不得.*容器.*固定膏块形状贴到皮肤/);
  assert.match(prompt, /不能像贴片随脸滑动/);
  assert.match(prompt, /图片2.*本段0\.000–5\.000秒.*人物C001.*画面右侧脸颊/s);
  assert.ok(!prompt.includes('完整换成'));
  project.edits.assets.P002.uploadedImageRole = 'graphic';
  assert.throws(() => assertPropReferencePolicies(project));
});

test('material selection is local to grounded matched actions, never all appearances or unknown product actions', () => {
  const project = customerFixture();
  assert.deepEqual([...selectMaterialAssetIds(project, { start: 13, duration: 5 })], ['P002']);
  assert.deepEqual([...selectMaterialAssetIds(project, { start: 0, duration: 13 })], []);
  assert.deepEqual([...selectMaterialAssetIds(project, { start: 18, duration: 5 })], []);
  assert.deepEqual(materialScopeForAsset(project, 'P002'), { mode: 'material_appearance', ranges: [{ start: 13, end: 18 }] });
  assert.equal(productScopeForAsset(project, 'P002'), null);
  assert.deepEqual([...selectProductAssetIds(project, ['C001', 'P002'])], ['C001', 'P001', 'P003']);
  project.story.actions[0].propId = null;
  assert.deepEqual([...selectMaterialAssetIds(project, { start: 13, duration: 5 })], []);
  assert.match(propReferenceWarnings(project).join('\n'), /P002.*没有对应.*时段/);
  project.story.actions[0].propId = 'P002'; project.edits.continuity.actions.A1 = 'off';
  assert.deepEqual([...selectMaterialAssetIds(project, { start: 13, duration: 5 })], []);
});

test('frozen material review carries actual actor, region, local range and reference order', () => {
  const project = customerFixture(), before = JSON.stringify(project), segment = materialSegment();
  const review = materialReviewTargets(project, segment);
  assert.equal(review.targets.length, 1);
  const target = review.targets[0];
  assert.equal(target.assetId, 'P002');
  assert.deepEqual(target.reference, { imageIndex: 2, file: 'crop.png' });
  assert.equal(target.actions[0].target, 'spread_finish');
  assert.equal(target.actions[0].characterId, 'C001');
  assert.equal(target.actions[0].region, '画面右侧脸颊');
  assert.equal(target.actions[0].start, 0); assert.equal(target.actions[0].end, 5);
  assert.ok(target.forbiddenReferenceFeatures.includes('rigid_shape'));
  assert.equal(JSON.stringify(project), before);
  const physical = productScopeReviewTargets(project, segment);
  assert.deepEqual(physical.targets.map(item => [item.assetId, item.reference.imageIndex]), [['P001', 1], ['P003', 3]]);
  assert.ok(!productScopeLocks(project, segment).join('\n').includes('面霜膏体'));
});

test('material and graphics cannot enter physical product groups or bag contains relationships', () => {
  const project = customerFixture();
  assert.throws(() => normalizeProductScope(project, { groups: [{ id: 'G1', name: '面霜', assetIds: ['P001', 'P002'] }] }), /膏体材质/);
  assert.throws(() => normalizeProductScope(project, { groups: [{ id: 'G1', name: '面霜', assetIds: ['P001'], containers: [{ assetId: 'P002', contains: ['P001'] }] }] }), /膏体/);
  assert.throws(() => normalizeProductScope(project, { groups: [{ id: 'G1', name: '面霜', assetIds: ['P005'] }] }), /字幕/);
  assert.doesNotThrow(() => normalizeProductScope(project, { groups: [{ id: 'G1', name: '面霜', assetIds: ['P001', 'P003'], containers: [{ assetId: 'P004', contains: ['P003'] }] }] }));
  project.edits.assets.P001.propRole = 'material';
  assert.throws(() => normalizeProductScope(project, { groups: [{ id: 'G1', name: '面霜', assetIds: ['P001'] }] }), /膏体材质/);
});

test('server-owned material crop takes precedence without applying crop geometry to jars or accepting client paths', () => {
  const project = customerFixture(), cream = project.story.assets[2], jar = project.story.assets[1];
  project.edits.assets.P002.main.materialFile = 'refs/P002/cream-only.png';
  project.edits.assets.P002.main.cropRect = { x: 0.2, y: 0.3, width: 0.4, height: 0.4 };
  assert.equal(propReferenceFile(cream, project.edits.assets.P002), 'refs/P002/cream-only.png');
  assert.equal(propReferenceFile(jar, { main: { file: 'jar.png', materialFile: 'cream-only.png' } }), 'jar.png');
  assert.deepEqual(normalizePropEditPolicy(project, cream, { materialFile: '../bad.png', cropRect: { x: 0 }, main: { materialFile: '../bad.png' } }), { uploadedImageRole: 'material', materialReferenceMode: 'image' });
  const segment = materialSegment(); segment.bindings[1].file = propReferenceFile(cream, project.edits.assets.P002);
  const reference = materialReviewTargets(project, segment).targets[0].reference;
  assert.equal(reference.file, 'refs/P002/cream-only.png');
  assert.equal(reference.sourceFile, 'crop.png');
  assert.equal(reference.cropped, true);
  reference.cropRect.x = 99;
  assert.equal(project.edits.assets.P002.main.cropRect.x, 0.2, 'review cannot mutate server-owned crop evidence');
});

function editableFixture() {
  const project = customerFixture();
  project.story.dialogues = []; project.story.warnings = [];
  project.edits.dialogues = []; project.edits.model = 'wan3.0-720p';
  project.sourceCuts = [];
  return project;
}

test('same-person finish reference controls material surface without restoring the source identity or replacing a whole object', () => {
  const project = editableFixture(), segment = materialSegment();
  segment.assetIds = ['P001', 'P002', 'P003']; segment.requestDuration = 5; segment.dialogueLines = [];
  segment.bindings.push({ assetId: 'P002', slot: 'materialFinish', type: 'reference_image', file: 'state/C001-finish.png',
    characterId: 'C001', role: 'material', referenceRole: 'material', usage: 'material_finish_state' });
  const target = materialReviewTargets(project, segment).targets[0];
  assert.deepEqual(target.finishReference, { imageIndex: 4, file: 'state/C001-finish.png', characterId: 'C001' });
  const prompt = studioPrompt({ recipe: project }, segment);
  assert.match(prompt, /图片4是人物C001的薄匀完成状态参考/);
  assert.match(prompt, /不替换人物身份、服装、背景、手势、构图或机位/);
  assert.match(prompt, /不能从第一帧直接清除膏体，不能用于其他人物/);
  assert.doesNotMatch(prompt, /「面霜膏体」（P002）完整替换/);
  assert.doesNotMatch(prompt, /图片4中的(?:人物|物品)/);
  assert.equal(productScopeReviewTargets(project, segment).targets.some(item => item.assetId === 'P002'), false);
});

test('an unrelated actor finish picture never becomes an executable material state reference', () => {
  const project = editableFixture(), segment = materialSegment();
  segment.bindings.push({ assetId: 'P002', slot: 'materialFinish', type: 'reference_image', file: 'state/C999-finish.png', characterId: 'C999' });
  const target = materialReviewTargets(project, segment).targets[0];
  assert.equal(target.finishReference, null, 'Finish evidence must match a grounded actor action in this segment');
  assert.doesNotMatch(propReferenceLocks(project, segment).join('\n'), /图片4是人物C999/);
});

test('disabled actor actions cannot bind their finish image to another actor sharing the same material ID', () => {
  const project = editableFixture();
  project.story.assets.push({ id: 'C002', type: 'character', name: '另一涂脸人物' });
  project.story.shots[1].characterIds.push('C002');
  project.story.actions.push({ ...project.story.actions[0], id: 'A2', characterId: 'C002' });
  project.edits.continuity.actions.A1 = 'off'; project.edits.continuity.actions.A2 = 'spread_finish';
  project.edits.assets.P002.materialFinish = { file: 'state/C001-finish.png', characterId: 'C001' };
  const plan = planStudio(project);
  const segment = plan.segments.find(item => item.bindings.some(binding => binding.assetId === 'P002'));
  assert.ok(segment);
  assert.equal(segment.bindings.some(binding => binding.slot === 'materialFinish'), false,
    'Only an enabled matching actor action can submit a finish-state picture');
  assert.equal(segment.materialTargets.targets[0].finishReference, null);
  assert.deepEqual(segment.materialTargets.targets[0].actions.map(action => action.characterId), ['C002']);
});

test('a confirmed source cut uses the new shot state rather than carrying a thick block through a jump cut', () => {
  const project = editableFixture(), first = project.story.actions[0];
  first.start = 13; first.end = 14.5; first.after = '脸颊仍有厚膏块';
  project.edits.continuity.actions.A1 = 'on';
  project.story.actions.push({ ...first, id: 'A2', start: 14.5, end: 18, type: 'residue', before: '切镜后脸颊薄匀，没有独立厚膏块',
    after: '切镜后保留自然肤纹和薄层', evidence: '新镜头可见薄层，没有独立膏体点' });
  project.edits.continuity.actions.A2 = 'on'; project.sourceCuts = [14.5];
  const before = JSON.stringify(project.sourceCuts);
  const contracts = actionContracts(project, { start: 13, duration: 5 });
  const afterCut = contracts.find(action => action.id === 'A2');
  assert.equal(afterCut.sourceCutBefore, true); assert.equal(afterCut.previous, null);
  assert.equal(afterCut.entry.state, '切镜后脸颊薄匀，没有独立厚膏块');
  const lines = actionLocks(project, { start: 13, duration: 5 });
  assert.match(lines[1], /原片已确认的切镜/);
  assert.doesNotMatch(lines[1], /上一事件\(A1\).*仍有厚膏块/);
  assert.match(propReferenceLocks(project, materialSegment()).join('\n'), /不能把前镜头的膏体点带入已经薄匀的后镜头/);
  assert.equal(JSON.stringify(project.sourceCuts), before, 'State computation leaves saved source cuts intact');
});

test('a finish target cannot leak recursively through residue events across an earlier source cut', () => {
  const project = editableFixture(), first = project.story.actions[0];
  first.start = 13; first.end = 14.5;
  project.sourceCuts = [14.5];
  project.story.actions.push({ ...first, id: 'A2', type: 'residue', start: 14.5, end: 16,
    before: '跳剪后原片可见少量残留条纹', after: '少量可见残留条纹', evidence: '切镜后可见膏体残留条纹' });
  project.story.actions.push({ ...project.story.actions[1], id: 'A3', start: 16, end: 18 });
  project.edits.continuity.actions.A2 = 'on'; project.edits.continuity.actions.A3 = 'on';
  const contracts = actionContracts(project, { start: 13, duration: 5 });
  assert.equal(contracts.find(action => action.id === 'A2').exit.kind, 'observed');
  const third = contracts.find(action => action.id === 'A3');
  assert.equal(third.exit.kind, 'observed', 'Recursing through A2 must respect its earlier cut from A1');
  assert.equal(third.entry.state, '跳剪后原片可见少量残留条纹');
  assert.equal(third.previous.state, '少量可见残留条纹');
});

test('source-role overrides and product memberships are validated together using the newly submitted role', () => {
  const project = editableFixture(), input = structuredClone(project.edits);
  input.assets.P002.propRole = 'object'; input.assets.P002.uploadedImageRole = 'object';
  input.assets.P002.materialReferenceMode = ''; input.assets.P002.materialDescription = '';
  input.productScope = { groups: [{ id: 'G1', name: '已人工核对实物', assetIds: ['P002'] }] };
  const saved = validateEdits(project, input);
  assert.equal(saved.assets.P002.propRole, 'object');
  assert.deepEqual(saved.productScope.groups[0].assetIds, ['P002']);
  project.edits = saved;
  const materialInput = structuredClone(saved); materialInput.assets.P002.propRole = 'material'; materialInput.assets.P002.uploadedImageRole = 'material';
  assert.throws(() => validateEdits(project, materialInput), /膏体材质/,
    'Changing to material must reject an unchanged physical product membership in the same save');
  const graphicInput = structuredClone(saved); graphicInput.assets.P002.propRole = 'graphic'; graphicInput.assets.P002.uploadedImageRole = 'graphic';
  assert.throws(() => validateEdits(project, graphicInput), /字幕贴纸/,
    'Changing to a graphic must also reject physical product membership in the same save');
  materialInput.productScope = { groups: [] };
  assert.equal(validateEdits(project, materialInput).assets.P002.propRole, 'material');
});

test('motion mode is the default and provides scoped colour and texture without a geometry image', () => {
  const project = editableFixture(), edit = project.edits.assets.P002;
  delete edit.materialReferenceMode;
  edit.materialDescription = '杏粉色，柔滑细腻的乳霜；推开后为薄而均匀的可见层';
  assert.equal(materialReferenceMode(edit), 'motion');
  assert.equal(propReferencePolicy(project.story.assets[2], edit).usage, 'material_motion');
  assert.deepEqual(materialScopeForAsset(project, 'P002'), { mode: 'material_motion', ranges: [{ start: 13, end: 18 }] });
  const segment = { start: 13, duration: 5, assetIds: ['P002'], bindings: [] };
  const target = materialReviewTargets(project, segment).targets[0];
  assert.equal(target.reference, null);
  assert.equal(target.referenceMode, 'motion');
  assert.equal(target.usage, 'material_motion');
  assert.equal(target.materialDescription, edit.materialDescription);
  assert.equal(target.actions[0].characterId, 'C001');
  const prompt = propReferenceLocks(project, segment).join('\n');
  assert.match(prompt, /采用运动主导.*不使用上传局部材料图作为固定形状或几何参考/);
  assert.match(prompt, /杏粉色，柔滑细腻的乳霜/);
  assert.doesNotMatch(prompt, /对应图片\d/);
  assert.doesNotMatch(prompt, /完整替换为/);
  assert.equal(JSON.stringify(edit.main), '{"file":"crop.png"}', 'Audit image remains preserved without entering the motion prompt');
});

test('text-only material motion edit selects an actual actor action without requiring a material upload', () => {
  const project = editableFixture();
  project.edits.assets.P002 = { propRole: 'material', materialDescription: '浅杏粉色、细腻乳霜' };
  assert.doesNotThrow(() => assertPropReferencePolicies(project));
  assert.deepEqual([...selectMaterialAssetIds(project, { start: 13, duration: 5 })], ['P002']);
  assert.deepEqual([...selectMaterialAssetIds(project, { start: 0, duration: 13 })], []);
  assert.equal(materialScopeForAsset(project, 'P002').mode, 'material_motion');
  const target = materialReviewTargets(project, { start: 13, duration: 5, assetIds: ['P002'], bindings: [] }).targets[0];
  assert.equal(target.reference, null);
  assert.equal(target.actions[0].target, 'spread_finish');
  delete project.edits.assets.P001; delete project.edits.assets.P003;
  const plan = planStudio(project);
  assert.equal(plan.hasChanges, true, 'A text-only material edit is an executable change without an image upload');
  assert.ok(plan.visualPlan.some(item => item.assetId === 'P002' && item.mode === 'material_motion'));
  const actionSegment = plan.segments.find(item => item.start < 18 && item.start + item.duration > 13);
  assert.ok(actionSegment.assetIds.includes('P002'));
  assert.equal(actionSegment.bindings.some(binding => binding.assetId === 'P002' && binding.slot === 'main'), false);
  assert.equal(actionSegment.materialTargets.targets[0].materialDescription, '浅杏粉色、细腻乳霜');
  project.edits.assets.P002.materialReferenceMode = 'image';
  assert.throws(() => assertPropReferencePolicies(project), error => error.code === 'material_reference_missing');
});

test('material mode and description validate bounded text, preserve partial updates and clear after reclassification', () => {
  const project = editableFixture(), cream = project.story.assets[2];
  const previous = { propRole: 'material', materialReferenceMode: 'image', materialDescription: '白色乳霜' };
  assert.deepEqual(normalizePropEditPolicy(project, cream, {}, previous), previous);
  assert.deepEqual(normalizePropEditPolicy(project, cream, { materialReferenceMode: '', materialDescription: '' }, previous), { propRole: 'material', materialReferenceMode: 'motion', materialDescription: '' });
  assert.deepEqual(normalizePropEditPolicy(project, cream, { propRole: 'object' }, previous), { propRole: 'object' });
  assert.throws(() => normalizePropEditPolicy(project, cream, { materialReferenceMode: 'geometry' }), /材质参考方式/);
  assert.throws(() => normalizePropEditPolicy(project, cream, { materialDescription: '字'.repeat(601) }), /600/);
  assert.throws(() => normalizePropEditPolicy(project, cream, { materialDescription: null }), /材质说明/);
  assert.throws(() => normalizePropEditPolicy(project, project.story.assets[1], { materialReferenceMode: 'motion' }), /只有膏体/);
  assert.throws(() => normalizePropEditPolicy(project, project.story.assets[1], { materialDescription: '杏粉色' }), /只有膏体/);
  assert.equal(normalizePropEditPolicy(project, cream, { materialDescription: '  杏粉色  ' }).materialDescription, '杏粉色');
});

test('motion finish evidence remains scoped to enabled actor and is never used as source-face identity', () => {
  const project = editableFixture(); project.edits.assets.P002.materialReferenceMode = 'motion';
  const segment = { start: 13, duration: 5, assetIds: ['P002'], bindings: [
    { assetId: 'P002', slot: 'materialFinish', type: 'reference_image', file: 'state/C001-finish.png', characterId: 'C001' },
  ] };
  const target = materialReviewTargets(project, segment).targets[0];
  assert.equal(target.reference, null);
  assert.deepEqual(target.finishReference, { imageIndex: 1, file: 'state/C001-finish.png', characterId: 'C001' });
  assert.match(propReferenceLocks(project, segment).join('\n'), /图片1是人物C001的薄匀完成状态参考/);
  assert.match(propReferenceLocks(project, segment).join('\n'), /不替换人物身份/);
  segment.bindings[0].characterId = 'C999';
  assert.equal(materialReviewTargets(project, segment).targets[0].finishReference, null);
  project.edits.continuity.actions.A1 = 'off';
  assert.deepEqual(materialReviewTargets(project, segment).targets, []);
});

test('a finish-state image does not require a fresh thick cream patch when a cut enters already thin skin', () => {
  const project = editableFixture(); project.edits.assets.P002.materialReferenceMode = 'motion';
  project.story.actions[0] = { ...project.story.actions[0], type: 'residue', before: '切镜后脸颊已有薄匀层', after: '自然肤纹、没有独立厚块', evidence: '脸颊可见薄层，不再有厚膏块' };
  project.edits.continuity.actions.A1 = 'on';
  const segment = { start: 13, duration: 5, assetIds: ['P002'], bindings: [
    { assetId: 'P002', slot: 'materialFinish', type: 'reference_image', file: 'state/C001-finish.png', characterId: 'C001' },
  ] };
  const prompt = propReferenceLocks(project, segment).join('\n');
  assert.match(prompt, /起始状态按本事件原片实际可见状态/);
  assert.match(prompt, /切镜后的薄匀镜头保留其真实薄匀状态/);
  assert.match(prompt, /不因终态图或前镜头有厚膏就重新点涂/);
  assert.doesNotMatch(prompt, /起始仍保留真实厚膏/);
});

test('the executable motion plan preserves audit metadata and uses no main cream geometry reference', () => {
  const project = editableFixture();
  project.edits.assets.P002.materialReferenceMode = 'motion';
  project.edits.assets.P002.materialDescription = '浅杏粉色，丝滑细腻乳霜';
  project.edits.assets.P002.main.materialFile = 'assets/cream-crop.png';
  project.edits.assets.P002.main.cropRect = { x: 0.2, y: 0.3, width: 0.4, height: 0.4 };
  project.edits.assets.P002.materialFinish = { file: 'state/C001-finish.png', characterId: 'C001' };
  const plan = planStudio(project);
  const segment = plan.segments.find(item => item.assetIds.includes('P002'));
  assert.ok(segment);
  assert.equal(segment.bindings.some(binding => binding.assetId === 'P002' && binding.slot === 'main'), false,
    'Uploading a cream image does not force its static geometry into WAN in motion mode');
  const finishBinding = segment.bindings.find(binding => binding.assetId === 'P002' && binding.slot === 'materialFinish');
  assert.equal(finishBinding.characterId, 'C001');
  assert.equal(segment.materialTargets.targets[0].reference, null);
  assert.equal(segment.materialTargets.targets[0].materialDescription, '浅杏粉色，丝滑细腻乳霜');
  assert.equal(project.edits.assets.P002.main.file, 'crop.png');
  assert.equal(project.edits.assets.P002.main.materialFile, 'assets/cream-crop.png');
  const prompt = studioPrompt({ recipe: project }, segment);
  assert.match(prompt, /运动主导/); assert.match(prompt, /浅杏粉色，丝滑细腻乳霜/);
  assert.doesNotMatch(prompt, /面霜膏体.{0,40}完整替换为/);
});

function actorBoundFinishFixture() {
  const project = editableFixture();
  project.edits.assets.C001 = { main: { file: 'actors/v1/main.png' }, views: { file: 'actors/v1/views.png' } };
  project.edits.assets.P002.materialReferenceMode = 'motion';
  project.edits.assets.P002.materialFinish = { file: 'state/C001-finish.png', characterId: 'C001',
    actorReference: { main: 'actors/v1/main.png', views: 'actors/v1/views.png' } };
  const segment = { start: 13, duration: 5, assetIds: ['P002'], bindings: [
    { assetId: 'P002', slot: 'materialFinish', type: 'reference_image', file: 'state/C001-finish.png', characterId: 'C001' },
  ] };
  return { project, segment };
}

test('current actor-reference paths match frozen finish metadata without mutating either snapshot', () => {
  const { project, segment } = actorBoundFinishFixture(), before = JSON.stringify(project);
  assert.equal(materialFinishReferenceIssue(project, 'P002'), null);
  assert.doesNotThrow(() => assertPropReferencePolicies(project));
  const target = materialReviewTargets(project, segment).targets[0];
  assert.equal(target.finishReferenceVerification.state, 'matched');
  assert.deepEqual(target.finishReferenceVerification.actorReference, { main: 'actors/v1/main.png', views: 'actors/v1/views.png' });
  target.finishReferenceVerification.actorReference.main = 'mutated.png';
  assert.equal(JSON.stringify(project), before);
});

test('changing or removing either actor reference rejects stale finish reuse before planning and prompt construction', () => {
  const changes = [actor => { actor.main.file = 'actors/v2/main.png'; }, actor => { actor.views.file = 'actors/v2/views.png'; },
    actor => { delete actor.main; }, actor => { delete actor.views; }];
  for (const change of changes) {
    const { project, segment } = actorBoundFinishFixture(); change(project.edits.assets.C001);
    const issue = materialFinishReferenceIssue(project, 'P002');
    assert.equal(issue.code, 'material_finish_reference_stale'); assert.equal(issue.blocking, true);
    assert.match(issue.message, /人物参考已更换或移除/);
    assert.match(issue.message, /重新上传终态参考图.*移除旧图后生成/);
    assert.throws(() => assertPropReferencePolicies(project), error => error.code === 'material_finish_reference_stale');
    assert.throws(() => planStudio(project), error => error.code === 'material_finish_reference_stale');
    assert.throws(() => materialReviewTargets(project, segment), error => error.code === 'material_finish_reference_stale');
    assert.throws(() => propReferenceLocks(project, segment), error => error.code === 'material_finish_reference_stale');
  }
});

test('adding a reference after a no-reference finish snapshot also invalidates the old state picture', () => {
  const { project, segment } = actorBoundFinishFixture();
  project.edits.assets.C001 = {};
  project.edits.assets.P002.materialFinish.actorReference = { main: null, views: null };
  assert.equal(materialFinishReferenceIssue(project, 'P002'), null);
  assert.equal(materialReviewTargets(project, segment).targets[0].finishReferenceVerification.state, 'matched');
  project.edits.assets.C001.main = { file: 'actors/v2/main.png' };
  assert.throws(() => assertPropReferencePolicies(project), error => error.code === 'material_finish_reference_stale');
});

test('legacy finish images without actor reference evidence warn and are never labelled verified', () => {
  const { project, segment } = actorBoundFinishFixture();
  delete project.edits.assets.P002.materialFinish.actorReference;
  const issue = materialFinishReferenceIssue(project, 'P002');
  assert.equal(issue.blocking, false); assert.equal(issue.code, 'material_finish_reference_unverified');
  assert.match(propReferenceWarnings(project).join('\n'), /未保存当时的人物参考记录.*不能确认/);
  assert.doesNotThrow(() => assertPropReferencePolicies(project));
  const target = materialReviewTargets(project, segment).targets[0];
  assert.equal(target.finishReferenceVerification.state, 'unverified');
  assert.match(propReferenceLocks(project, segment).join('\n'), /尚未确认与当前人物参考一致，不能当作已验证的身份依据/);
});

test('malformed actor snapshots and finish bindings to a different actor are rejected with repair guidance', () => {
  for (const actorReference of [null, 'face.png', [], { main: 'actors/v1/main.png' }, { main: false, views: null }]) {
    const { project } = actorBoundFinishFixture(); project.edits.assets.P002.materialFinish.actorReference = actorReference;
    assert.throws(() => assertPropReferencePolicies(project), error => error.code === 'material_finish_reference_invalid');
  }
  const { project, segment } = actorBoundFinishFixture();
  project.story.assets.push({ id: 'C002', type: 'character', name: '另一人物' });
  project.story.actions.push({ ...project.story.actions[0], id: 'A2', characterId: 'C002' });
  project.edits.continuity.actions.A2 = 'spread_finish';
  segment.bindings[0].characterId = 'C002';
  assert.throws(() => materialReviewTargets(project, segment), error => error.code === 'material_finish_binding_mismatch');
});
