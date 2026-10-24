import test from 'node:test';
import assert from 'node:assert/strict';
import {demoProject} from '../public/studio-demo.js';
import {compileFullDialogue} from '../src/full-dialogue.js';
import {planStudio,studioPrompt} from '../src/story.js';
import {allocationPreview} from '../public/full-dialogue-ui.js';

test('advisory fast dialogue includes every word exactly once in actual segment prompts',()=>{
  const p=demoProject();p.edits.fullDialogue={enabled:true,text:'这是一段完整的中文台词。'.repeat(25),speakerId:'C001'};
  const plan=planStudio(p),full=plan.dialoguePlan;
  assert.equal(plan.canGenerate,true);assert.deepEqual(plan.blockers,[]);
  assert.equal(full.timingMode,'visual-segments');
  const compact=s=>s.replace(/\s/gu,'');
  assert.equal(compact(full.lines.map(l=>l.text).join('')),compact(full.spokenText));
  const assigned=[];
  for(const segment of plan.segments){
    assert.ok(segment.duration<=15);const prompt=studioPrompt({recipe:p},segment);
    const lines=full.lines.filter(line=>line.start>=segment.start-0.001 && line.end<=segment.start+segment.duration+0.001);
    for(const line of lines){assert.ok(prompt.includes(`说：“${line.text}”`));assigned.push(line.id);}
  }
  assert.deepEqual(assigned,full.lines.map(line=>line.id));
  assert.equal(new Set(assigned).size,assigned.length);
  assert.match(allocationPreview(plan),/可以继续生成|可继续生成/);
});

test('fitting retains word boundaries and speaker order for mixed language drafts',()=>{
  const p=demoProject();const text='[C001] Hello everyone! 今天介绍 VC 产品。'.repeat(1)+'\n[C002] This is a complete response. 回应内容也完整保留。'.repeat(7);
  p.edits.fullDialogue={enabled:true,text,speakerId:'auto'};
  const full=compileFullDialogue(p);assert.equal(full.blockers.length,0);
  assert.equal(full.lines.map(l=>l.text).join('').replace(/\s/gu,''),full.spokenText.replace(/\s/gu,''));
  assert.equal(full.lines[0].characterId,'C001');assert.ok(full.lines.slice(1).every(l=>l.characterId==='C002'));
  assert.ok(full.lines.every(line=>line.end>line.start && line.end-line.start<=12.01));
  assert.ok(full.lines.some(line=>line.text.includes('everyone')));
});

test('invalid empty dialogue still fails before generation',()=>{
  const p=demoProject();p.edits.fullDialogue={enabled:true,text:' ',speakerId:'auto'};
  assert.throws(()=>planStudio(p),/请粘贴完整/);
});
