import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAssetFiles, assetUploadForm, bindAssetDrop, preventFileNavigation } from '../public/user-asset-drop.js';
import { finishReferenceCharacter } from '../public/material-reference-ui.js';
import { generationStatus, generationProgress, jobProgressMarkup, jobRecoveryActions } from '../public/user-job-view.js';
import { fullDialogueEditor } from '../public/user-dialogue.js';
import { fullDialogueEditor as developerDialogue } from '../public/full-dialogue-ui.js';
import { demoProject } from '../public/studio-demo.js';

const file = (name, size = 20) => ({ name, size });
test('dragged references reject wrong counts, unsupported files, empty data and oversized media', () => {
  for (const slot of ['main','voice','views','finish']) assert.throws(() => validateAssetFiles([],slot));
  assert.throws(() => validateAssetFiles([file('a.png'),file('b.png')],'main'), /1 张/);
  assert.throws(() => validateAssetFiles([file('a.png'),file('b.png')],'views'), /3 张/);
  assert.throws(() => validateAssetFiles([file('a.mp3'),file('b.wav')],'voice'), /1 个/);
  assert.throws(() => validateAssetFiles([file('a.mp3')],'main'), /图片/);
  assert.throws(() => validateAssetFiles([file('a.png')],'voice'), /音频/);
  assert.throws(() => validateAssetFiles([file('a.exe')],'main'), /图片/);
  assert.throws(() => validateAssetFiles([file('a.png',0)],'main'), /为空/);
  assert.throws(() => validateAssetFiles([file('a.png',20*1024**2+1)],'main'), /20 MB/);
  assert.throws(() => validateAssetFiles([file('a.png')],'other'), /对应/);
  assert.throws(() => validateAssetFiles([file('a.png'),file('b.png')],'finish'), /终态.*1 张/);
  assert.throws(() => validateAssetFiles([file('a.mp3')],'finish'), /图片/);
  assert.throws(() => validateAssetFiles([file('a.png',0)],'finish'), /为空/);
});
test('valid main, montage, views and voice retain file identity and ordering', () => {
  const views = ['front.PNG','side.jpg','back.WebP'].map(name=>file(name));
  assert.deepEqual(validateAssetFiles(views,'views'),views);
  assert.equal(validateAssetFiles([views[0]],'views')[0],views[0]);
  assert.equal(validateAssetFiles([views[1]],'main')[0],views[1]);
  assert.equal(validateAssetFiles([views[1]],'finish')[0],views[1]);
  for(const name of ['a.WAV','a.mp3','a.m4a','a.aac','a.ogg','a.flac']) assert.equal(validateAssetFiles([file(name)],'voice')[0].name,name);
});

function dropHarness() {
  const handlers = {}, active = new Set();
  const zone = { dataset:{asset:'C002',slot:'views'}, classList:{add:v=>active.add(v),remove:v=>active.delete(v)}, contains:node=>node===child };
  const child = { closest:()=>zone };
  const root = { addEventListener:(type,fn)=>handlers[type]=fn,removeEventListener:type=>delete handlers[type],contains:node=>node===zone,querySelectorAll:()=>active.has('dragover')?[zone]:[] };
  const event = files => ({target:child,relatedTarget:null,dataTransfer:{types:['Files'],files},preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;}});
  return {root,zone,child,active,handlers,event};
}
test('dropping onto a nested image dispatches to that card and slot once, then clears highlight', async () => {
  const h=dropHarness(), received=[];
  const dispose=bindAssetDrop(h.root,async(...args)=>received.push(args),()=>assert.fail('Unexpected upload error'));
  const files=['front.png','side.png','back.png'].map(n=>file(n)), event=h.event(files);
  h.handlers.dragover(event); assert.equal(event.prevented,true); assert.equal(event.dataTransfer.dropEffect,'copy'); assert.ok(h.active.has('dragover'));
  h.handlers.dragleave({...event,relatedTarget:h.child}); assert.ok(h.active.has('dragover'));
  await h.handlers.drop(event); assert.equal(event.stopped,true);assert.deepEqual(received,[['C002','views',files]]); assert.equal(h.active.size,0);
  dispose(); assert.equal(Object.keys(h.handlers).length,0);
});
test('drop failures remain visible and leaving or canceling removes hover state', async () => {
  const h=dropHarness(), errors=[];
  bindAssetDrop(h.root,async()=>{throw new Error('当前素材正在保存');},message=>errors.push(message));
  h.handlers.dragenter(h.event([file('a.png')]));h.handlers.dragleave(h.event([]));assert.equal(h.active.size,0);
  h.handlers.dragover(h.event([file('a.png')]));h.handlers.dragend();assert.equal(h.active.size,0);
  await h.handlers.drop(h.event([file('a.png')]));assert.deepEqual(errors,['当前素材正在保存']);
});

test('finish drops dispatch one image to the material slot without borrowing a character views slot', async () => {
  const h = dropHarness(), received = [];
  h.zone.dataset = { asset: 'P002', slot: 'finish' };
  bindAssetDrop(h.root, async (...args) => received.push(args), () => assert.fail('Unexpected error'));
  const files = [file('same-actor-finish.png')];
  await h.handlers.drop(h.event(files));
  assert.deepEqual(received, [['P002', 'finish', files]]);
});

test('finish upload actor remains frozen across save/render and only finish FormData carries it', async () => {
  const asset = { id: 'P002', type: 'prop', sourceRole: 'material', name: '膏体' };
  const project = { story: { assets: [asset, { id: 'C002', type: 'character', name: '已选涂抹人物' }, { id: 'C001', type: 'character', name: '其他人物' }], actions: [{ propId: 'P002', characterId: 'C002', type: 'spread' }] } };
  let selectorValue = 'C002';
  const captured = finishReferenceCharacter(project, asset, {}, selectorValue);
  await Promise.resolve().then(() => { selectorValue = 'C001'; }); // Saving replaced the rendered selector.
  assert.equal(captured, 'C002'); assert.equal(selectorValue, 'C001');
  const image = new File([new Uint8Array([1, 2, 3])], 'finish.png', { type: 'image/png' });
  const finish = assetUploadForm([image], 'finish', captured);
  assert.deepEqual([...finish.keys()], ['file', 'characterId']); assert.equal(finish.get('characterId'), 'C002');
  assert.equal(finish.get('file').name, 'finish.png');
  for (const slot of ['main', 'views']) assert.deepEqual([...assetUploadForm([image], slot, captured).keys()], ['file']);
  const audio = new File([new Uint8Array([1])], 'voice.wav');
  assert.deepEqual([...assetUploadForm([audio], 'voice', captured).keys()], ['file']);
  assert.throws(() => assetUploadForm([image], 'finish'), /选择.*人物/);
});
test('text dragging is ignored and file drops outside a target cannot navigate the page', async () => {
  const h=dropHarness(); bindAssetDrop(h.root,()=>assert.fail('Text was imported'),()=>{});
  const textEvent=h.event([]);textEvent.dataTransfer.types=['text/plain'];await h.handlers.drop(textEvent);assert.equal(textEvent.prevented,undefined);
  const events={},root={addEventListener:(t,fn)=>events[t]=fn,removeEventListener:t=>delete events[t]};
  const dispose=preventFileNavigation(root), outside=h.event([file('a.png')]); events.drop(outside); assert.equal(outside.prevented,true);
  events.drop(textEvent);assert.equal(textEvent.prevented,undefined);dispose();assert.equal(Object.keys(events).length,0);
});
test('overall progress uses completed work, never raw phase IDs or fabricated completion', () => {
  const job={state:'processing',phase:'生成第 1 / 4 段',progress:24,segments:[{state:'completed'},{state:'running',taskId:'private-task-id'},{state:'pending'},{state:'pending'}]};
  assert.equal(generationStatus(job),'正在生成视频'); assert.equal(generationProgress(job),24);
  assert.equal(generationProgress({...job,progress:undefined}),24);
  assert.equal(generationProgress({...job,progress:100}),97);
  assert.equal(generationProgress({...job,progress:-3}),0);
  assert.equal(generationProgress({...job,state:'completed',progress:0}),100);
  const html=jobProgressMarkup(job);assert.match(html,/value="24"/);assert.doesNotMatch(html,/分段|第 1|private-task-id|details|segment-card/);
  assert.equal(generationStatus({...job,phase:'拼接成片并恢复原音轨'}),'正在合成成片');
  assert.equal(generationStatus({...job,state:'paused'}),'已暂停');
});
test('simplified progress still exposes safe recovery without automatically resubmitting unknown tasks', () => {
  const job={id:'abc',state:'needs_attention',segments:[{index:0,state:'completed'},{index:1,state:'unknown',taskId:'private-id'}]};
  const unknown=jobRecoveryActions(job);assert.match(unknown,/data-action="bind-job"/);assert.match(unknown,/data-index="1"/);assert.doesNotMatch(unknown,/retry-job|resume-job|private-id/);
  const failed=jobRecoveryActions({...job,segments:[{index:2,state:'failed'}]});assert.match(failed,/retry-job/);assert.match(failed,/data-index="2"/);
  assert.match(jobRecoveryActions({...job,segments:[{state:'completed'}]}),/resume-job/);
  assert.equal(jobRecoveryActions({...job,segments:[{state:'submitting'}]}),'');
  assert.equal(jobRecoveryActions({...job,state:'processing',segments:[{state:'running'}]}),'');
  // A pause can arrive after the provider failure, before the UI's next refresh.
  assert.match(jobRecoveryActions({...job,state:'paused'}),/bind-job/);
  assert.doesNotMatch(jobRecoveryActions({...job,state:'paused'}),/resume-job/);
  assert.match(jobRecoveryActions({...job,state:'paused',segments:[{index:0,state:'failed'}]}),/retry-job/);
  assert.match(jobRecoveryActions(job,{bind:'bind',retry:'retry',resume:'resume'}),/data-action="bind"/);
});
test('customer dialogue exposes complete source and allocation while developer UI is unchanged', () => {
  const project=demoProject();
  const customer=fullDialogueEditor(project,project.edits,{demo:true});
  assert.doesNotMatch(customer,/<details|<summary/);assert.match(customer,/原片完整台词/);assert.match(customer,/id="full-script-allocation"/);
  assert.match(developerDialogue(project,project.edits,{demo:true}),/<details/);
});
