import test from 'node:test';
import {reconstructionRequestSeconds} from '../public/reconstruction-policy.js';
import {reconstructionRange,reconstructionStages} from '../src/reconstruction.js';
import assert from 'node:assert/strict';
import { canReconstruct, reconstructionButton, reconstructionDefaults, reconstructionForm } from '../public/reconstruction-ui.js';

function fixture() {
  return { id: 'completed-job', state: 'completed', workflow: 'studio', source: { duration: 20 }, analysisModel: 'Omni-Analysis', recipe: {
    story: { assets: [{ id: 'C001', type: 'character', name: '目标人物' }, { id: 'P001', type: 'prop', name: '面霜膏体' },
      { id: 'P002', type: 'prop', name: '面霜罐', description: '罐里的乳霜可被涂在脸上' }],
      actions: [{ id: 'A1', type: 'spread', start: 13, end: 18, characterId: 'C001', propId: 'P001' }] }, edits: { assets: {} } } };
}

test('only completed studio movies with both an actor and material expose reconstruction', () => {
  const job = fixture(); assert.equal(canReconstruct(job), true); assert.match(reconstructionButton(job), /修正涂抹动作/);
  for (const candidate of [undefined, { ...job, state: 'running' }, { ...job, workflow: 'face' }, { ...job, source: { duration: 1.9 } }]) {
    assert.equal(canReconstruct(candidate), false); assert.equal(reconstructionButton(candidate), '');
  }
  job.recipe.story.assets = job.recipe.story.assets.filter(asset => asset.type !== 'character');
  assert.equal(canReconstruct(job), false); assert.equal(reconstructionButton(job), '');
  const noMaterial = fixture(); noMaterial.recipe.story.assets = noMaterial.recipe.story.assets.filter(asset => asset.id !== 'P001');
  assert.equal(canReconstruct(noMaterial), false, 'A cream jar is not sufficient evidence of a deformable material');
});

test('defaults use an actual material action and rendered form includes all four full-frame inputs', () => {
  const job = fixture();
  assert.deepEqual(reconstructionDefaults(job), { start: 13, end: 18, characterId: 'C001', materialAssetId: 'P001' });
  const html = reconstructionForm(job);
  for (const slot of ['first', 'midCheek', 'midForehead', 'last']) {
    assert.match(html, new RegExp(`data-rebuild-frame="${slot}"`)); assert.match(html, new RegExp(`data-rebuild-file="${slot}"`));
  }
  assert.match(html, /脸颊已匀，手仍贴脸/); assert.match(html, /额头已匀，手仍贴额/);
  assert.match(html, /点击或拖入完整图片/);
  assert.match(html, /name="notes" maxlength="1200"/);
  assert.match(html, /name="reviewModel" value="Omni-Analysis"/);
  assert.doesNotMatch(html, /<select name="reviewModel">|Omni-Plus/);
  assert.match(html, /name="confirmNewCharge" required/);
});

test('fractional frame ranges use step any and do not impose an impossible exact one-thirtieth-second HTML step', () => {
  const job = fixture(); job.recipe.story.actions[0].start = 131 / 30;
  const html = reconstructionForm(job), numberInputs = [...html.matchAll(/<input type="number"[^>]*>/gu)].map(match => match[0]);
  assert.equal(numberInputs.length, 2); assert.ok(numberInputs.every(input => input.includes('step="any"')));
  assert.ok(!html.includes('step="0.03333333333333333"'));
  assert.equal(reconstructionDefaults(job).start, 4.367);
  assert.match(html, /value="4.367"/);
});

test('rendered actor/material labels and job attributes are escaped rather than executed as markup', () => {
  const job = fixture(); job.id = '" onmouseover="alert(1)';
  job.recipe.story.assets[0].name = '<img src=x onerror="alert(1)">';
  job.recipe.story.assets[1].name = '<script>面霜膏体</script>';
  const form = reconstructionForm(job), button = reconstructionButton(job);
  assert.ok(!form.includes('<script>')); assert.ok(!form.includes('<img src=x'));
  assert.match(form, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(form, /&lt;script&gt;面霜膏体&lt;\/script&gt;/);
  assert.ok(!button.includes('data-id="" onmouseover="'));
  assert.match(button, /data-id="&quot; onmouseover=&quot;alert\(1\)"/);
});

test('source role overrides are reflected in available reconstruction materials', () => {
  const job = fixture(); job.recipe.edits.assets.P001 = { propRole: 'object' };
  assert.equal(canReconstruct(job), false);
  job.recipe.edits.assets.P002 = { propRole: 'material' };
  assert.equal(canReconstruct(job), true); assert.equal(reconstructionDefaults(job).materialAssetId, 'P002');
});

test('shown usage matches actual three-stage requests at fractional frame boundaries',()=>{
  for(const frames of [135,150,182,269,450]){
    const range=reconstructionRange(900,13,13+frames/30),stages=reconstructionStages(range,{first:{file:'first'},intermediates:[{file:'cheek'},{file:'forehead'}],last:{file:'last'}});
    assert.equal(reconstructionRequestSeconds(range.start,range.start+range.duration,true),stages.reduce((sum,stage)=>sum+stage.requestDuration,0));
  }
  assert.equal(reconstructionRequestSeconds(0,182/30,true),8);
  assert.equal(reconstructionRequestSeconds(0,269/30,true),9);
  assert.equal(reconstructionRequestSeconds(0,4,true),null);
});
