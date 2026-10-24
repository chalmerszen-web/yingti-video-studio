import test from 'node:test';
import assert from 'node:assert/strict';
import { propRoleEditor, applyPropRoleControl } from '../public/prop-role-ui.js';
import { productScopeEditor, applyProductScopeAction, readProductScopeEditor } from '../public/product-scope-ui.js';

const jar = { id: 'P001', type: 'prop', name: '面霜罐', sourceRole: 'jar' };
const cream = { id: 'P002', type: 'prop', name: '面霜膏体', sourceRole: 'material' };
const project = { story: { assets: [jar, cream, { id: 'C001', type: 'character', name: '人物' }] } };

test('jar with packaging image shows its wrong-purpose issue in always-visible controls', () => {
  const html = propRoleEditor(jar, { main: { file: 'customer.jpg' }, uploadedImageRole: 'packaging' });
  assert.match(html, /原片素材类型/); assert.match(html, /上传图片内容/); assert.match(html, /asset-role-error/);
  assert.match(html, /value="packaging" selected/); assert.doesNotMatch(html, /<details/);
});

test('whole open-jar reference for cream shows texture-only semantics rather than whole-object replacement', () => {
  const html = propRoleEditor(cream, { main: { file: 'open-jar.jpg' }, uploadedImageRole: 'jar', materialReferenceMode: 'image' });
  assert.match(html, /只参考颜色和质地/); assert.match(html, /不把整只罐、盒子的外形贴到脸上/); assert.match(html, /asset-role-warning/);
  assert.doesNotMatch(html, /asset-role-error/);
});

test('role confirmation survives shared editor save state and clearing returns to inferred source', () => {
  const edits = { assets: { P001: { notes: '保留握持', main: { file: 'jar.jpg' } } } };
  assert.equal(applyPropRoleControl(project, edits, { dataset: { propRole: 'propRole', assetId: 'P001' }, value: 'jar' }), true);
  assert.equal(applyPropRoleControl(project, edits, { dataset: { propRole: 'uploadedImageRole', assetId: 'P001' }, value: 'jar' }), true);
  assert.equal(edits.assets.P001.propRole, 'jar'); assert.equal(edits.assets.P001.uploadedImageRole, 'jar');
  assert.equal(edits.assets.P001.notes, '保留握持'); assert.equal(edits.assets.P001.main.file, 'jar.jpg');
  applyPropRoleControl(project, edits, { dataset: { propRole: 'propRole', assetId: 'P001' }, value: '' });
  assert.equal(edits.assets.P001.propRole, undefined); assert.equal(edits.assets.P001.uploadedImageRole, 'jar');
});

test('role helper rejects unrelated controls, invented roles and non-prop asset mutations', () => {
  const edits = { assets: {} };
  for (const target of [
    { dataset: { propRole: 'notes', assetId: 'P001' }, value: 'jar' },
    { dataset: { propRole: 'propRole', assetId: 'C001' }, value: 'jar' },
    { dataset: { propRole: 'propRole', assetId: 'P001' }, value: 'invented' },
    { dataset: { propRole: 'propRole', assetId: 'MISSING' }, value: 'material' },
  ]) assert.equal(applyPropRoleControl(project, edits, target), false);
  assert.deepEqual(edits, { assets: {} });
});

test('material references cannot be selected as detachable products or bag contents', () => {
  const edits = { assets: { P002: { main: { file: 'cream-in-jar.jpg' } } }, productScope: { groups: [{ id: 'G1', name: '面霜罐与包装', assetIds: ['P001'], containers: [] }] } };
  const html = productScopeEditor(project, edits);
  assert.match(html, /data-asset-id="P001"/); assert.doesNotMatch(html, /data-asset-id="P002"/);
  const added = { assets: edits.assets };
  applyProductScopeAction(project, added, { action: 'product-scope-add' });
  assert.deepEqual(added.productScope.groups[0].assetIds, ['P001']);
});

test('unsaved source role overrides filter grouping and reader through current editor edits', () => {
  const editable = { story: { assets: [{ id: 'PX', type: 'prop', name: '其他道具' }, jar] }, edits: { assets: {} } };
  const edits = { assets: { PX: { propRole: 'material' } }, productScope: { groups: [{ id: 'G1', name: '瓶罐', assetIds: ['P001'], containers: [] }] } };
  assert.doesNotMatch(productScopeEditor(editable, edits), /data-asset-id="PX"/);
  const fields = [{ dataset: { productScope: 'name' }, value: '瓶罐' }, { dataset: { productScope: 'member', assetId: 'PX' }, checked: true }, { dataset: { productScope: 'member', assetId: 'P001' }, checked: true }];
  const card = { dataset: { productGroup: 'G1' }, querySelectorAll: () => fields };
  const container = { matches: () => true, querySelectorAll: () => [card] };
  assert.deepEqual(readProductScopeEditor(container, editable, edits).groups[0].assetIds, ['P001']);
});

test('material defaults to motion preservation and distinguishes audit image from a direct reference', () => {
  const html = propRoleEditor(cream, { main: { file: 'cream.jpg' }, uploadedImageRole: 'material' });
  assert.match(html, /value="motion" selected/); assert.match(html, /不直接传入视频模型/);
  assert.match(html, /maxlength="600"/); assert.match(html, /data-prop-role="materialDescription"/);
  assert.doesNotMatch(propRoleEditor(jar, {}), /data-prop-role="materialDescription"/);
  const direct = propRoleEditor(cream, { materialReferenceMode: 'image', materialDescription: '<b>淡杏粉</b>' });
  assert.match(direct, /value="image" selected/); assert.match(direct, /需短片验证/); assert.match(direct, /&lt;b&gt;淡杏粉&lt;\/b&gt;/);
});

test('motion mode and material description save independently and only for a material source', () => {
  const edits = { assets: { P002: { main: { file: 'cream.jpg' } } } };
  for (const [field, value] of [['materialReferenceMode', 'motion'], ['materialDescription', '淡杏粉色乳霜，薄涂后自然肤质']]) {
    assert.equal(applyPropRoleControl(project, edits, { dataset: { propRole: field, assetId: 'P002' }, value }), true);
    assert.equal(edits.assets.P002[field], value);
  }
  assert.equal(edits.assets.P002.main.file, 'cream.jpg');
  assert.equal(applyPropRoleControl(project, edits, { dataset: { propRole: 'materialDescription', assetId: 'P002' }, value: '' }), true);
  assert.equal(edits.assets.P002.materialDescription, '');
  assert.equal(applyPropRoleControl(project, edits, { dataset: { propRole: 'materialDescription', assetId: 'P002' }, value: 'x'.repeat(601) }), false);
  assert.equal(applyPropRoleControl(project, edits, { dataset: { propRole: 'materialReferenceMode', assetId: 'P002' }, value: 'invented' }), false);
  assert.equal(applyPropRoleControl(project, edits, { dataset: { propRole: 'materialDescription', assetId: 'P001' }, value: '淡杏粉' }), false);
});

test('reclassifying a material as a physical object clears material-only options', () => {
  const edits = { assets: { P002: { materialReferenceMode: 'image', materialDescription: '淡杏粉', main: { file: 'open-jar.jpg' } } } };
  applyPropRoleControl(project, edits, { dataset: { propRole: 'propRole', assetId: 'P002' }, value: 'jar' });
  assert.equal(edits.assets.P002.materialReferenceMode, undefined); assert.equal(edits.assets.P002.materialDescription, undefined);
  assert.equal(edits.assets.P002.main.file, 'open-jar.jpg');
});
