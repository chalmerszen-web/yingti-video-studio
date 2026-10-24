import test from 'node:test';
import assert from 'node:assert/strict';
import { characterEditMode, characterModes, CHARACTER_EDIT_POLICY } from '../public/character-edit.js';
import { planStudio, studioPrompt, validateEdits } from '../src/story.js';
import { requestBody } from '../src/plan.js';
import { demoProject } from '../public/studio-demo.js';

function freeze(project) {
  const plan = planStudio(project);
  const recipe = { ...structuredClone(project), characterEditPolicy: CHARACTER_EDIT_POLICY, characterModes: structuredClone(plan.characterModes) };
  for (const segment of plan.segments) segment.prompt = studioPrompt({ recipe }, segment);
  return { workflow: 'studio', model: project.edits.model, recipe, segments: plan.segments };
}

test('uploaded main/views determine each character mode; notes and audio never enable visual changes', () => {
  assert.equal(characterEditMode(), 'preserve');
  assert.equal(characterEditMode({ voice: { file: 'voice.wav' }, notes: '换衣服' }), 'preserve');
  assert.equal(characterEditMode({ views: { file: 'views.png' } }), 'appearance');
  assert.equal(characterEditMode({ main: { file: 'face.png' }, notes: '换衣服' }), 'face');
  assert.equal(characterEditMode({ main: { file: 'face.png' }, views: { file: 'views.png' } }), 'appearance');
  const project = demoProject(); project.edits.assets.C001 = { main: { file: 'face.png' } };
  const edits = validateEdits(project, { model: project.edits.model, dialogues: [], assets: { C001: { mode: 'appearance', views: { file: 'injected.png' }, notes: '' } } });
  assert.equal(characterEditMode(edits.assets.C001), 'face');
});

test('main-only generation uses face editing throughout and does not replay analyzed scripts', () => {
  const project = demoProject(); project.edits.assets.C001 = { main: { file: 'face.png' } };
  const before = JSON.stringify(project), job = freeze(project);
  assert.equal(job.recipe.characterModes.C001, 'face');
  for (const segment of job.segments) {
    assert.equal(segment.characterModes.C001, 'face');
    assert.deepEqual(segment.bindings.map(b => b.file), ['face.png']);
    const prompt = requestBody(job, segment, [{ type: 'reference_video', url: 'mock:video' }, { type: 'reference_image', url: 'mock:face' }]).prompt;
    assert.match(prompt, /人脸替换为图片1中人物的人脸/);
    assert.match(prompt, /保留原人物的发型、服装、配饰和身形/);
    assert.doesNotMatch(prompt, /完整替换.*目标人物|目标替换主视图|三视图|编辑后分镜/);
    for (const shot of project.story.shots) assert.ok(!prompt.includes(shot.summary));
    for (const line of project.story.dialogues) assert.ok(!prompt.includes(line.text));
    assert.equal(segment.audioChanged, false);
  }
  assert.equal(JSON.stringify(project), before);
});

test('mixed characters and products use actual reference order with separate face and appearance scopes', () => {
  const project = demoProject();
  project.edits.assets = { C001: { main: { file: 'actor.png' }, views: { file: 'outfit.png' } }, C002: { main: { file: 'face.png' } }, P001: { main: { file: 'product.png' } } };
  const job = freeze(project), segment = job.segments[0];
  assert.deepEqual(segment.bindings.map(b => b.file), ['actor.png', 'outfit.png', 'face.png', 'product.png']);
  assert.deepEqual(job.recipe.characterModes, { C001: 'appearance', C002: 'face' });
  assert.match(segment.prompt, /C001.*图片1.*图片2中的三视图/);
  assert.match(segment.prompt, /C002.*人脸替换为图片3/);
  assert.match(segment.prompt, /P001.*完整替换为图片4中的物品/);
  assert.match(segment.prompt, /从本段开始到结束均保持这套造型/);
});

test('removing views restores face mode for new jobs without changing frozen jobs', () => {
  const project = demoProject(); project.edits.assets.C001 = { main: { file: 'main.png' }, views: { file: 'views.png' } };
  const old = freeze(project), proof = JSON.stringify(old);
  delete project.edits.assets.C001.views;
  assert.equal(freeze(project).recipe.characterModes.C001, 'face');
  assert.equal(JSON.stringify(old), proof);
  const media = old.segments[0].bindings.map(b => ({ type: b.type, url: 'mock:' + b.file }));
  assert.match(requestBody(old, old.segments[0], media).prompt, /图片2中的三视图/);
  delete project.edits.assets.C001.main;
  assert.equal(planStudio(project).hasChanges, false);
  project.edits.assets.C001.views = { file: 'views.png' };
  assert.equal(planStudio(project).hasChanges, true);
  assert.equal(characterModes(project.story, project.edits).C001, 'appearance');
  const combined = freeze(project);
  assert.deepEqual(combined.segments[0].bindings.map(b => b.file), ['views.png']);
  assert.match(combined.segments[0].prompt, /图片1是同一人物的三视图或主视图与三视图合成图/);
});

test('missing view media or mismatched frozen scopes stop before submission', () => {
  const project = demoProject(); project.edits.assets.C001 = { main: { file: 'main.png' }, views: { file: 'views.png' } };
  const segment = planStudio(project).segments[0];
  const broken = structuredClone(segment); broken.bindings = broken.bindings.filter(b => b.slot !== 'views');
  assert.throws(() => studioPrompt({ recipe: project }, broken), /缺少本段实际绑定的三视图/);
  const wrong = structuredClone(segment); wrong.characterModes.C001 = 'face';
  assert.throws(() => studioPrompt({ recipe: project }, wrong), /替换范围.*不一致/);
});

test('dialogue instructions contain only requested changes and keep sound-only edits from changing appearance', () => {
  const project = demoProject();
  project.edits.assets.C001 = { voice: { file: 'voice.wav', shortFile: 'short.wav', duration: 4 } };
  project.edits.dialogues = [{ ...project.story.dialogues[0], enabled: true, text: '这是明确指定的新台词。' }];
  const prompt = freeze(project).segments[0].prompt;
  assert.match(prompt, /音色替换为音频1/); assert.match(prompt, /不改变人物外观/);
  assert.match(prompt, /说：“这是明确指定的新台词。/);
  assert.doesNotMatch(prompt, /人脸替换|中的三视图/);
  for (const line of project.story.dialogues) assert.ok(!prompt.includes(line.text));
});

test('legacy task prompts stay frozen when the request is resumed', () => {
  const segment = { requestDuration: 10, prompt: '旧版已经提交的完整人物外观指令' };
  assert.equal(requestBody({ workflow: 'studio', model: 'wan3.0-480p' }, segment, []).prompt, segment.prompt);
});
