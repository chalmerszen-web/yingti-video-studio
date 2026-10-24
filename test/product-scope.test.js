import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProductScope, productScopeFromEdits, selectProductAssetIds, productScopeForAsset, productScopeLocks, productScopeReviewTargets, productScopeWarnings, assertProductReferenceBudget } from '../src/product-scope.js';
import { productScopeEditor, readProductScopeEditor, applyProductScopeAction } from '../public/product-scope-ui.js';

function fixture() {
  return {
    source: { duration: 30 },
    story: {
      assets: [
        { id: 'C001', type: 'character', name: '讲解人' },
        { id: 'P001', type: 'prop', name: 'JOVISSE面霜瓶' },
        { id: 'P002', type: 'prop', name: '产品包装盒' },
        { id: 'P003', type: 'prop', name: '透明手提袋' },
        { id: 'P004', type: 'prop', name: '金属小勺' },
        { id: 'P005', type: 'prop', name: '优惠字幕贴纸' },
      ],
      shots: [
        { start: 0, end: 15, propIds: ['P001'] },
        { start: 15, end: 30, propIds: ['P003', 'P004'] },
      ],
    },
    edits: {
      assets: { P001: { main: { file: 'new-jar.png' } }, P002: { main: { file: 'new-box.png' } }, P005: { main: { file: 'offer.png' } } },
      productScope: { groups: [{ id: 'G001', name: '面霜商品', assetIds: ['P001', 'P002'], containers: [{ assetId: 'P003', contains: ['P002'] }], targetBrand: '维希缇' }] },
    },
  };
}
const segment = () => ({ index: 1, start: 15, duration: 15, assetIds: ['C001', 'P001', 'P002'], bindings: [
  { assetId: 'C001', slot: 'main', type: 'reference_image', file: 'face.png' },
  { assetId: 'C001', slot: 'views', type: 'reference_image', file: 'views.png' },
  { assetId: 'P001', slot: 'main', type: 'reference_image', file: 'new-jar.png' },
  { assetId: 'P002', slot: 'main', type: 'reference_image', file: 'new-box.png' },
] });

test('a bag-only shot retains both product references without replacing bag exterior or unrelated spoon', () => {
  const project = fixture(), before = JSON.stringify(project);
  const ids = selectProductAssetIds(project, ['P003', 'P004']);
  assert.deepEqual([...ids], ['P003', 'P004', 'P001', 'P002']);
  assert.ok(!ids.has('P005'), 'a graphical overlay remains time-scoped');
  const review = productScopeReviewTargets(project, segment());
  assert.deepEqual(review.targets.map(target => [target.assetId, target.reference.imageIndex]), [['P001', 3], ['P002', 4]]);
  assert.deepEqual(review.containers, [{ assetId: 'P003', sourceName: '透明手提袋', groupId: 'G001', exterior: 'preserve', containedAssetIds: ['P002'] }]);
  assert.deepEqual(review.targets.find(target => target.assetId === 'P002').containedBy, [{ assetId: 'P003', sourceName: '透明手提袋', replaceExterior: false }]);
  const prompt = productScopeLocks(project, segment()).join('\n');
  assert.match(prompt, /P002（图片4）.*每一件可见商品仍必须分别替换/);
  assert.match(prompt, /外壳、透明材质、提手.*保持原样/);
  assert.match(prompt, /原片资产名称、旧品牌.*仅用于定位/);
  assert.match(prompt, /本段没有出现某个参考对象时不把它补入画面/);
  assert.ok(!prompt.includes('金属小勺'));
  assert.equal(JSON.stringify(project), before, 'planning and prompt construction never mutate a customer project');
});

test('all-appearance scope covers undetected physical props while preserving detected ranges for review', () => {
  const project = fixture();
  assert.deepEqual(productScopeForAsset(project, 'P001'), { mode: 'all_appearances', ranges: [{ start: 0, end: 30 }], detectedRanges: [{ start: 0, end: 15 }] });
  assert.deepEqual(productScopeForAsset(project, 'P002').detectedRanges, []);
  assert.equal(productScopeForAsset(project, 'P005'), null);
  assert.equal(productScopeForAsset(project, 'P004'), null);
  assert.ok(productScopeWarnings(project).some(warning => warning.includes('全片所有可见实例')));
});

test('legacy projects gain no guessed group, container relation or brand', () => {
  const project = fixture(); delete project.edits.productScope;
  assert.deepEqual(normalizeProductScope(project), { groups: [] });
  assert.deepEqual([...selectProductAssetIds(project, [])], ['P001', 'P002']);
  const review = productScopeReviewTargets(project, segment());
  assert.equal(review.targets[0].targetBrand, '');
  assert.deepEqual(review.targets[1].containedBy, []);
  assert.deepEqual(review.containers, []);
  const prompt = productScopeLocks(project, segment()).join('\n');
  assert.match(prompt, /不猜测、编造或纠正品牌名称/);
  assert.ok(!prompt.includes('维希缇'));
});

test('unbound group members never borrow another reference or silently promise replacement', () => {
  const project = fixture(); delete project.edits.assets.P002.main;
  const one = segment(); one.bindings.pop(); one.assetIds.pop();
  const scope = productScopeReviewTargets(project, one);
  assert.deepEqual(scope.targets.map(target => target.assetId), ['P001']);
  assert.deepEqual(scope.containers, []);
  const warnings = productScopeWarnings(project).join('\n');
  assert.match(warnings, /P002.*未上传替换图.*保留各自外观/);
  assert.match(warnings, /不会自动用于这些对象/);
  const prompt = productScopeLocks(project, one).join('\n');
  assert.match(prompt, /无图商品组成员保持各自原样/);
  assert.ok(!prompt.includes('P002（图片3）'));
});

test('a separately uploaded bag reference modifies exterior with its own image only', () => {
  const project = fixture(); project.edits.assets.P003 = { main: { file: 'new-bag.png' } };
  const planned = segment(); planned.bindings.push({ assetId: 'P003', slot: 'main', type: 'reference_image', file: 'new-bag.png' });
  const review = productScopeReviewTargets(project, planned);
  assert.equal(review.containers[0].exterior, 'replace');
  assert.equal(review.targets.find(target => target.assetId === 'P003').reference.imageIndex, 5);
  assert.match(productScopeLocks(project, planned).join('\n'), /容器外部仅按它自己的替换图处理/);
});

test('partial edits preserve prior relations and explicit empty groups clears them', () => {
  const project = fixture();
  assert.deepEqual(productScopeFromEdits(project, { assets: {} }), normalizeProductScope(project));
  assert.deepEqual(productScopeFromEdits(project, { productScope: { groups: [] } }), { groups: [] });
  const scope = normalizeProductScope(project); scope.groups[0].assetIds.push('P004');
  assert.deepEqual(project.edits.productScope.groups[0].assetIds, ['P001', 'P002']);
});

test('invalid, duplicated, cross-group or cyclic container relationships are rejected before planning', () => {
  const cases = [
    null, { groups: {} },
    { groups: [{ id: 'G1', name: '商品', assetIds: ['P999'] }] },
    { groups: [{ id: 'G1', name: '商品', assetIds: ['C001'] }] },
    { groups: [{ id: 'G1', name: '商品', assetIds: ['P005'] }] },
    { groups: [{ id: 'G1', name: '商品', assetIds: ['P001', 'P001'] }] },
    { groups: [{ id: 'G1', name: '商品', assetIds: ['P001'], targetBrand: { name: 'guess' } }] },
    { groups: [{ id: 'G1', name: '商品', assetIds: ['P001'], containers: [{ assetId: 'P003', contains: ['P002'] }] }] },
    { groups: [{ id: 'G1', name: '商品', assetIds: ['P001'], containers: [{ assetId: 'P001', contains: ['P001'] }] }] },
    { groups: [{ id: 'G1', name: '商品', assetIds: ['P001', 'P002'], containers: [{ assetId: 'P001', contains: ['P002'] }, { assetId: 'P002', contains: ['P001'] }] }] },
    { groups: [{ id: 'G1', name: '甲', assetIds: ['P001'] }, { id: 'G2', name: '乙', assetIds: ['P001'] }] },
  ];
  for (const input of cases) assert.throws(() => normalizeProductScope(fixture(), input), undefined, JSON.stringify(input));
});

test('reference budget rejects oversized plans with complete asset diagnostics and counts no audio', () => {
  const planned = { index: 2, bindings: Array.from({ length: 10 }, (_, index) => ({ assetId: `P${index}`, type: 'reference_image', slot: 'main' })) };
  planned.bindings.push({ assetId: 'C1', type: 'reference_audio' });
  assert.doesNotThrow(() => assertProductReferenceBudget(planned));
  planned.bindings.push({ assetId: 'P10', type: 'reference_image' });
  assert.throws(() => assertProductReferenceBudget(planned), error => {
    assert.equal(error.code, 'product_reference_budget');
    assert.equal(error.details.imageCount, 11); assert.equal(error.details.segmentIndex, 2);
    assert.ok(error.details.assetIds.includes('P10'));
    return true;
  });
  assert.equal(planned.bindings.length, 12, 'budget validation never drops references');
});

test('shared editor creates a valid single selection, never guesses a bottle-box relation, and removes a group', () => {
  const project = fixture(); delete project.edits.productScope;
  assert.equal(applyProductScopeAction(project, project.edits, { action: 'product-scope-add' }), true);
  assert.deepEqual(project.edits.productScope.groups[0].assetIds, ['P001']);
  assert.deepEqual(project.edits.productScope.groups[0].containers, []);
  assert.equal(project.edits.productScope.groups[0].targetBrand, '');
  assert.doesNotThrow(() => normalizeProductScope(project));
  assert.equal(applyProductScopeAction(project, project.edits, { action: 'unknown' }), false);
  const id = project.edits.productScope.groups[0].id;
  applyProductScopeAction(project, project.edits, { action: 'product-scope-remove', groupId: id });
  assert.deepEqual(project.edits.productScope.groups, []);
});

test('shared editor exposes open controls and safely escapes names, brand and group attributes', () => {
  const project = fixture();
  project.story.assets[1].name = '<img src=x onerror="alert(1)">';
  project.edits.productScope.groups[0].name = '" onfocus="alert(1)';
  project.edits.productScope.groups[0].targetBrand = '<script>alert(1)</script>';
  const html = productScopeEditor(project, project.edits);
  assert.ok(!html.includes('<details'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /value="&quot; onfocus=&quot;alert\(1\)"/);
  assert.match(html, /data-product-scope="contains".*data-container-id="P003".*data-asset-id="P002" checked/);
});

test('editor reading preserves explicit bag contents, discards unselected members and unknown assets', () => {
  const field = (kind, extra, value = '') => ({ dataset: { productScope: kind, ...extra }, value, checked: true });
  const fields = [field('name', {}, '面霜'), field('target-brand', {}, '维希缇'), field('member', { assetId: 'P001' }), field('member', { assetId: 'P002' }), field('member', { assetId: 'P999' }), field('contains', { containerId: 'P003', assetId: 'P002' }), field('contains', { containerId: 'P003', assetId: 'P004' }), field('contains', { containerId: 'P999', assetId: 'P001' })];
  const card = { dataset: { productGroup: 'G1' }, querySelectorAll: () => fields };
  const editor = { matches: () => true, querySelectorAll: () => [card] };
  const project = fixture(), result = readProductScopeEditor(editor, project);
  assert.deepEqual(result, { groups: [{ id: 'G1', name: '面霜', targetBrand: '维希缇', assetIds: ['P001', 'P002'], containers: [{ assetId: 'P003', contains: ['P002'] }] }] });
  assert.doesNotThrow(() => normalizeProductScope(project, result));
  const fallback = readProductScopeEditor({ querySelector: () => null }, project);
  fallback.groups.length = 0;
  assert.equal(project.edits.productScope.groups.length, 1);
});
