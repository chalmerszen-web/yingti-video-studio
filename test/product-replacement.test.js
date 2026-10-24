import test from 'node:test';
import assert from 'node:assert/strict';
import { planStudio, studioPrompt } from '../src/story.js';
import { requestBody } from '../src/plan.js';

function productProject() {
  return {
    source: { duration: 30 },
    story: {
      assets: [
        { id: 'C001', type: 'character', name: '讲解人', description: '坐在左侧' },
        { id: 'P001', type: 'prop', name: '婴儿袜子', description: '人物手里的白色袜子' },
        { id: 'P002', type: 'prop', name: '袜子包装袋', description: '另一只手里的透明袋' },
        { id: 'P003', type: 'prop', name: '图形贴纸', description: '画面中的不要买贴纸' },
      ],
      shots: [
        { id: 'SH001', start: 0, end: 5, summary: '揉搓袜子成球。', camera: '近景', characterIds: ['C001'], propIds: ['P001', 'P002'], sceneId: null },
        { id: 'SH002', start: 5, end: 10, summary: '拉伸袜口展示巨大弹力。', camera: '特写', characterIds: ['C001'], propIds: ['P001'], sceneId: null },
        { id: 'SH003', start: 10, end: 15, summary: '在袜子上叠加不要买贴纸。', camera: '特写', characterIds: [], propIds: ['P001', 'P003'], sceneId: null },
        { id: 'SH004', start: 15, end: 30, summary: '打开包装展示袜子。', camera: '中景', characterIds: ['C001'], propIds: ['P001', 'P002'], sceneId: null },
      ],
      dialogues: [{ id: 'L001', start: 0, end: 3, characterId: 'C001', text: '这是新买的袜子。' }], warnings: [],
    },
    edits: { model: 'wan3.0-480p', dialogues: [], assets: {
      C001: { main: { file: 'person.png' }, views: { file: 'views.png' } },
      P001: { main: { file: 'cream.png' } },
      P002: { main: { file: 'box.png' } },
    } },
  };
}

test('product editing binds each target to its actual image number and removes conflicting source actions', () => {
  const project = productProject(), original = JSON.stringify(project);
  const segment = planStudio(project).segments[0], prompt = studioPrompt({ recipe: project }, segment);
  assert.deepEqual(segment.bindings.map(b => b.file), ['person.png', 'views.png', 'cream.png', 'box.png']);
  assert.match(prompt, /婴儿袜子.*P001.*完整替换为图片3中的物品/);
  assert.match(prompt, /袜子包装袋.*P002.*完整替换为图片4中的物品/);
  for (const shot of project.story.shots) assert.ok(!prompt.includes(shot.summary));
  assert.deepEqual(segment.shotIds, ['SH001', 'SH002', 'SH003'], 'Shot metadata is retained for planning, not repeated in the editing prompt');
  assert.match(prompt, /外形、颜色、材质、包装和标识以图片3为准/);
  assert.match(prompt, /握持、接触和展示动作与新物品的形状相适应/);
  assert.match(prompt, /不能只给旧物体换色或贴标/);
  assert.match(prompt, /除上述指定的编辑外.*物品.*保持不变/); assert.ok(!segment.bindings.some(b => b.assetId === 'P003'));
  const media = [{ type:'reference_video', url:'mock:original' }, ...segment.bindings.map(b => ({type:b.type,url:'mock:'+b.file}))];
  const request = requestBody({ workflow:'studio',model:project.edits.model }, { ...segment,prompt }, media);
  assert.equal(request.prompt,prompt); assert.deepEqual(request.metadata.input.media,media);
  assert.equal(JSON.stringify(project), original, 'planning must not alter user story, references or dialogue');
});

test('replacement scope uses the actual shot ranges and warns about graphical overlays', () => {
  const project=productProject(); project.edits.assets.P003={main:{file:'open-cream.png'}};
  const plan=planStudio(project);
  assert.deepEqual(plan.visualPlan.find(a=>a.assetId==='P001').ranges,[{start:0,end:30}]);
  assert.deepEqual(plan.visualPlan.find(a=>a.assetId==='P003').ranges,[{start:10,end:15}]);
  assert.ok(plan.segments[0].bindings.some(b=>b.assetId==='P003'));
  assert.ok(!plan.segments[1].bindings.some(b=>b.assetId==='P003'));
  assert.match(plan.warnings.join('\n'),/图形贴纸.*此处的替换图只对应这项图文/);
});

test('voice and character-only edits keep unedited product actions and never activate unbound props', () => {
  const project=productProject(); delete project.edits.assets.P001.main; delete project.edits.assets.P002.main;
  project.edits.assets.P001.notes='把物品变成霜罐';
  const plan=planStudio(project), prompt=studioPrompt({recipe:project},plan.segments[0]);
  assert.deepEqual(plan.visualPlan.map(a=>a.assetId),['C001']);
  assert.ok(!prompt.includes(project.story.shots[0].summary));
  assert.ok(!prompt.includes('把物品变成霜罐')); assert.ok(!prompt.includes('【本段必须完成的产品替换】'));
  assert.match(prompt,/除上述指定的编辑外.*物品.*动作.*保持不变/);
  assert.ok(!plan.segments[0].bindings.some(b => b.assetId.startsWith('P')));
});

test('copying original dialogue prompts a product review without rewriting or blocking the user text', () => {
  const project=productProject(); project.edits.fullDialogue={enabled:true,text:'[C001] 这是新买的袜子！',speakerId:'auto'};
  const copy=planStudio(project); assert.match(copy.warnings.join('\n'),/正文仍与原稿相同/);
  assert.equal(copy.dialoguePlan.lines.map(l=>l.text).join(''),'这是新买的袜子！');
  project.edits.fullDialogue.text='[C001] 这是紫色包装的新产品。';
  assert.ok(!planStudio(project).warnings.some(w=>w.includes('正文仍与原稿相同')));
});
