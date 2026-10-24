import test from 'node:test';
import assert from 'node:assert/strict';
import { materialReferenceTools, normalizedCropRect, finishReferenceCharacter } from '../public/material-reference-ui.js';

const material = { id: 'P002', type: 'prop', name: '面霜膏体', sourceRole: 'material' };
const project = { id: 'project-1', story: { assets: [material, { id: 'C001', type: 'character', name: '其他人物' }, { id: 'C002', type: 'character', name: '涂脸人物' }], actions: [{ id: 'A2', propId: 'P002', characterId: 'C002', type: 'spread' }] } };

test('material tools separate original image crop, audit preview and finish state with the matching actor', () => {
  const html = materialReferenceTools(project, material, { main: { file: 'open-jar.png', materialFile: 'cream.png', materialRevision: 'crop-1', cropRect: { x: 10, y: 10, width: 200, height: 100 } }, materialFinish: { file: 'finish.png', revision: 'finish-1', characterId: 'C002', names: ['薄匀.png'] } });
  assert.match(html, /data-action="material-crop" data-asset="P002"/);
  assert.match(html, /\/P002\/material\/media\?v=crop-1/); assert.match(html, /\/P002\/finish\/media\?v=finish-1/);
  assert.match(html, /id="asset-P002-finish"/); assert.match(html, /data-finish-character="P002"/);
  assert.match(html, /value="C002" selected/); assert.doesNotMatch(html, /value="C001"/);
  assert.match(html, /data-action="remove-asset" data-asset="P002" data-slot="finish"/);
  assert.match(html, /data-asset-drop data-action="choose-asset" data-asset="P002" data-slot="finish"/);
  assert.match(html, /不能一开始删除膏体/);
});

test('text-only material can import a finish reference while a jar never gets these material controls', () => {
  const html = materialReferenceTools(project, material, { materialDescription: '淡杏粉色乳霜' });
  assert.match(html, /data-action="choose-asset" data-asset="P002" data-slot="finish"/);
  assert.doesNotMatch(html, /data-action="material-crop"/); assert.match(html, /value="C002" selected/);
  assert.equal(materialReferenceTools(project, { id: 'P001', type: 'prop', name: '面霜罐', sourceRole: 'jar' }, {}), '');
});

test('crop conversion follows natural image pixels regardless of direction, scale or drag overflow', () => {
  assert.deepEqual(normalizedCropRect({ x: .75, y: .8 }, { x: .25, y: .2 }, 800, 600), { x: 200, y: 120, width: 400, height: 360 });
  assert.deepEqual(normalizedCropRect({ x: -.5, y: -.5 }, { x: 1.5, y: 1.5 }, 800, 600), { x: 0, y: 0, width: 800, height: 600 });
  const fractional = normalizedCropRect({ x: .101, y: .102 }, { x: .899, y: .898 }, 512, 512);
  assert.ok(Object.values(fractional).every(Number.isInteger)); assert.ok(fractional.x + fractional.width <= 512); assert.ok(fractional.y + fractional.height <= 512);
});

test('crop validation rejects invisible, sub24pixel or excessive aspect selections before saving', () => {
  assert.equal(normalizedCropRect({ x: .1, y: .1 }, { x: .11, y: .11 }, 800, 600), null);
  assert.equal(normalizedCropRect({ x: .1, y: .1 }, { x: .9, y: .14 }, 800, 600), null);
  assert.equal(normalizedCropRect({ x: NaN, y: 0 }, { x: 1, y: 1 }, 800, 600), null);
  assert.equal(normalizedCropRect({ x: 0, y: 0 }, { x: 1, y: 1 }, 0, 600), null);
});

test('saved finish actor is retained for inspection rather than silently reassigned to another person', () => {
  const html = materialReferenceTools(project, material, { materialFinish: { file: 'finish.png', characterId: 'C001' } });
  assert.match(html, /value="C001" selected/); assert.match(html, /未关联当前动作/);
  const demo = materialReferenceTools(project, material, { main: { file: 'open.png' } }, true);
  assert.match(demo, /data-action="material-crop" data-asset="P002" disabled/);
});

test('finish upload accepts only the material action actor and never borrows an unrelated saved finish face', () => {
  assert.equal(finishReferenceCharacter(project, material, {}, 'C002'), 'C002');
  assert.throws(() => finishReferenceCharacter(project, material, {}, ''), /先选择.*人物/);
  assert.throws(() => finishReferenceCharacter(project, material, { materialFinish: { characterId: 'C001' } }, 'C001'), /不能借用其他人物/);
  assert.throws(() => finishReferenceCharacter(project, material, {}, 'MISSING'), /不对应/);
  assert.throws(() => finishReferenceCharacter(project, material, { propRole: 'jar' }, 'C002'), /只能用于膏体/);
  assert.throws(() => finishReferenceCharacter({ story: { assets: project.story.assets, actions: [] } }, material, {}, 'C002'), /不对应/);
});
