import test from 'node:test';
import assert from 'node:assert/strict';
import { demoProject } from '../public/studio-demo.js';
import { planStudio, studioPrompt } from '../src/story.js';
import { compileFullDialogue, speechWeight, validateFullDialogue } from '../src/full-dialogue.js';
import { generationOptions, REFERENCE_SPEECH_RATE } from '../public/generation-policy.js';
import { requestBody } from '../src/plan.js';

test('a standalone character montage and scene use distinct references in every applicable segment', () => {
  const p=demoProject(); p.edits.assets={C001:{views:{file:'four-panels.png'}},S001:{main:{file:'street.png'}}};
  const plan=planStudio(p), frozen=JSON.stringify(p);
  for(const segment of plan.segments){
    assert.deepEqual(segment.bindings.map(b=>[b.assetId,b.slot]),[['C001','views'],['S001','main']]);
    const prompt=studioPrompt({recipe:{...p,characterModes:plan.characterModes}},segment);
    assert.match(prompt,/C001.*完整替换为图片1/);
    assert.match(prompt,/S001.*图片2/);
    assert.match(prompt,/全片将图片2作为该场景唯一/);
    assert.match(prompt,/同一取景区域、同一机位方向、同一人物站位/);
    assert.match(prompt,/近景、特写或分段开始时不重新选择场景位置/);
    assert.match(prompt,/人物参考图中的背景、白底、分格和排版不进入视频/);
    assert.deepEqual([...prompt.matchAll(/【([^】]+)】/g)].map(m=>m[1]),['总体描述','全局锁定','固定台词','分镜','禁止项']);
    assert.ok(!prompt.includes(p.story.shots[0].summary),'No invented/replayed drama or source action script');
    const body=requestBody({workflow:'studio',model:p.edits.model,generationOptions:generationOptions()},{...segment,prompt},[]);
    assert.equal(body.prompt_extend,true);assert.equal(body.prompt,prompt);
  }
  assert.equal(JSON.stringify(p),frozen);
});

test('complete sentences stay inside one original shot and generation segment', () => {
  const p=demoProject();p.edits.fullDialogue={enabled:true,text:'今天给你介绍产品。请看这边的效果。用起来很方便。喜欢可以试试。',speakerId:'C001',pronunciation:'VC 按英文字母 V、C 朗读。'};
  const full=compileFullDialogue(p),plan=planStudio(p);
  assert.equal(full.blockers.length,0);assert.equal(full.lines.length,4);
  assert.equal(full.lines.map(l=>l.text).join(''),p.edits.fullDialogue.text);
  for(const line of full.lines){
    const shot=p.story.shots.find(s=>s.id===line.shotId);
    assert.ok(line.start>=shot.start && line.end<=shot.end);
    assert.ok(speechWeight(line.text)/(line.end-line.start)<=REFERENCE_SPEECH_RATE+0.01);
    assert.equal(plan.segments.filter(s=>s.start<=line.start+0.001 && s.start+s.duration>=line.end-0.001).length,1);
  }
  const prompt=studioPrompt({recipe:p},plan.segments[0]);
  assert.match(prompt,/说：“今天给你介绍产品。/);
  assert.match(prompt,/不改写固定台词、不增加对白/);
  assert.match(prompt,/发音说明.*VC 按英文字母/);
  assert.ok(prompt.includes('其余人物不跟读'));
});

test('numbers and short uppercase abbreviations are included in speech estimates', () => {
  assert.equal(speechWeight('VC'),2);assert.equal(speechWeight('12345'),5);
  const p=demoProject();assert.throws(()=>validateFullDialogue(p,{enabled:true,text:'你好。',pronunciation:'a'.repeat(1201)}),/发音说明/);
});

test('long sentences and tight source shots use advisory duration fitting without losing text', () => {
  const p=demoProject();p.source.duration=100;p.story.shots=[{id:'SH001',start:0,end:100,characterIds:['C001'],propIds:[],sceneId:null}];p.story.dialogues=[];
  p.edits.fullDialogue={enabled:true,text:'完整词语'.repeat(22),speakerId:'C001'};
  let result=compileFullDialogue(p);assert.equal(result.blockers.length,0);assert.match(result.warnings.join(''),/长句/);assert.equal(result.spokenText,p.edits.fullDialogue.text);
  assert.equal(result.lines.map(l=>l.text).join(''),p.edits.fullDialogue.text);
  p.source.duration=4;p.story.shots=[{id:'A',start:0,end:2,characterIds:['C001'],propIds:[],sceneId:null},{id:'B',start:2,end:4,characterIds:['C001'],propIds:[],sceneId:null}];p.edits.fullDialogue.text='这一整句话需要更长镜头才能清楚说完。';
  result=compileFullDialogue(p);assert.equal(result.blockers.length,0);assert.ok(result.lines.length);assert.equal(result.lines.map(l=>l.text).join(''),p.edits.fullDialogue.text);
  const plan=planStudio(p);assert.equal(plan.canGenerate,true);
  const prompt=studioPrompt({recipe:p},plan.segments[0]);
  assert.equal(prompt.split(`说：“${p.edits.fullDialogue.text}”`).length-1,1);
  assert.match(prompt,/续接 FULL001 尚未说完的部分，不从句首重复/);
});
