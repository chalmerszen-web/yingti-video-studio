import test from 'node:test';
import assert from 'node:assert/strict';
import { demoProject } from '../public/studio-demo.js';
import { planStudio, studioPrompt, validateEdits } from '../src/story.js';
import { compileFullDialogue } from '../src/full-dialogue.js';
import { qualityPrompt, qualityWindows } from '../src/quality.js';
import { captionASS, captionEvents } from '../src/captions.js';
import { updateNarrationField, narrationEditor } from '../public/narration-ui.js';

const script='平时你不买我不管，但是你千万不能错过维希缇双十一福利大促！这次让你一次性腾个够！拍一到手三大件这么多只要99！还是女明星伪素颜的好搭子！特调的杏粉色高铁做到一份修黄稳稳拿捏秋冬换季皮肤蜡黄等， 丝滑细腻的乳霜质地，从脸上非常好抹开，非常适合懒人小白，三两下就能搞定一个澡吧。清透底妆，而且持久度高，过年出门走亲戚也能牢牢汗妆不脱妆，到了晚上脸上依旧透亮有光泽，送给辛苦的自己再合适不过了，快去直播间抢购吧！。';
test('customer draft remains exact and receives per-phrase risk warnings without a false global hard limit',()=>{
  const p=demoProject();p.source.duration=32.167;p.story.dialogues=[{id:'L001',start:0,end:32.167,characterId:null,text:'原品牌原价格'}];p.story.shots=[{id:'S1',start:0,end:32.167,propIds:[],characterIds:[],sceneId:null}];
  p.edits.fullDialogue={enabled:true,text:script,speakerId:'narrator'};
  const ranges=[{startFrame:0,frames:390},{startFrame:390,frames:270},{startFrame:660,frames:305}];
  const plan=compileFullDialogue(p,ranges);
  assert.equal(plan.lines.map(l=>l.text).join('').replace(/\s/g,''),script.replace(/\s/g,''));assert.deepEqual(plan.blockers,[]);
  for(const phrase of plan.phraseBudget.filter(p=>p.rate>6.05))assert.ok(plan.warnings.some(w=>w.includes(phrase.id)&&w.includes('局部语速')));
  for(const line of plan.lines)assert.ok(ranges.some(r=>line.start>=r.startFrame/30-.001&&line.end<=(r.startFrame+r.frames)/30+.001));
});
test('exact narrator ignores old voice samples and emits no contradictory speaking or voice-change instruction',()=>{
  const p=demoProject();p.edits.fullDialogue={enabled:true,text:'维希缇，只要99。',speakerId:'narrator',delivery:'voiceover',voiceId:'voice_ready',subtitles:'replace'};
  for(const a of p.story.assets.filter(a=>a.type==='character'))p.edits.assets[a.id]={voice:{file:'old.wav',duration:4}};
  const plan=planStudio(p);assert.equal(plan.audioMode,'narration');assert.equal(plan.narrationCalls,1);
  for(const s of plan.segments){assert.ok(s.bindings.every(b=>b.type!=='reference_audio'));const prompt=studioPrompt({recipe:{...p,dialoguePlan:plan.dialoguePlan}},s);assert.doesNotMatch(prompt,/将视频1中.*音色替换|人声按固定台词与指定音色执行|嘴型与新台词同步/);assert.match(prompt,/此生成只处理画面/);}
});
test('exact narrator rejects character labels before paid work and uploaded audio cannot be client forged',()=>{
  const p=demoProject();p.edits.fullDialogue={enabled:true,text:'[C001] 这是人物对白。',speakerId:'narrator',delivery:'voiceover',voiceId:'voice_ready'};
  assert.ok(planStudio(p).blockers.some(b=>b.includes('人物对话标签')));
  const edits=validateEdits(p,{model:p.edits.model,assets:{},dialogues:[],narration:{file:'forged.wav'},fullDialogue:{enabled:false,text:'',speakerId:'auto'}});assert.equal(edits.narration,undefined);
});
test('review request withholds the expected body rather than offering it as hearing evidence',()=>{
  const p=demoProject();p.edits.fullDialogue={enabled:true,text:'独立测试正文XYZ，价格3199。',speakerId:'narrator',delivery:'voiceover'};
  const job={recipe:p,segments:[{index:0,start:0,duration:10,frames:300}]};
  const prompt=qualityPrompt(job,qualityWindows(job)[0]);assert.doesNotMatch(prompt,/独立测试正文XYZ|3199/);assert.match(prompt,/不提供预期正文/);
});
test('caption minutes roll over and all caption words come from the frozen body',()=>{
  const ass=captionASS([{start:59.999,end:60.1,text:'99元'}],720,1280);assert.match(ass,/0:01:00\.00,0:01:00\.10/);assert.doesNotMatch(ass,/0:00:60/);
  const job={audioMode:'narration',narration:{duration:32},recipe:{edits:{fullDialogue:{enabled:true,subtitles:'replace'}},dialoguePlan:{spokenText:script}}};
  const events=captionEvents(job);assert.equal(events.map(e=>e.text).join(''),script.replace(/\s/g,''));assert.equal(events[0].start,0);assert.equal(events.at(-1).end,32);assert.ok(events.every(e=>e.end>e.start));
});
test('voiceover UI transition selects a narrator while preserving exact text and explicit user brand',()=>{
  const full={enabled:true,text:script,speakerId:'C001'};assert.equal(updateNarrationField(full,{id:'full-dialogue-delivery',value:'voiceover'}),true);assert.equal(full.speakerId,'narrator');assert.equal(full.text,script);
  const html=narrationEditor(demoProject(),{...full,voiceId:'voice_user',criticalTerms:'<维希缇>'});assert.ok(html.includes('&lt;维希缇&gt;'));assert.match(html,/不创建或克隆新音色/);
});
