import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ffmpeg,probe} from '../src/media.js';
import {preparePartialExport} from '../src/partial-export.js';
import {outputActions,partialOutputPanel} from '../public/output-recovery.js';

test('actual partial export contains only the available clips, with playable picture and audio',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'yingti-partial-'));
 try{
  await mkdir(path.join(directory,'segments'));
  for(const [index,color] of [[0,'red'],[2,'blue']])await ffmpeg(['-f','lavfi','-i',`color=c=${color}:s=160x90:r=30`,'-t','1','-c:v','libx264','-pix_fmt','yuv420p',path.join(directory,`segments/output-${index}.mp4`)]);
  await ffmpeg(['-f','lavfi','-i','sine=frequency=600:sample_rate=48000','-t','4','-c:a','pcm_s16le',path.join(directory,'original-audio.wav')]);
  const job={output:{width:160,height:90},source:{hasAudio:true},audioMode:'original',segments:[0,1,2].map(i=>({index:i,start:i,frames:30,duration:1,state:i===1?'running':'completed'}))};
  const result=await preparePartialExport(directory,job);assert.equal(result.state,'ready');assert.equal(result.frames,60);assert.equal(result.hasAudio,true);assert.deepEqual(result.clips.map(c=>c.index),[0,2]);
  await ffmpeg(['-xerror','-i',path.join(directory,result.file),'-f','null','-']);
  assert.ok(Math.abs(result.duration-2)<.04);for(const clip of result.clips)assert.equal((await probe(path.join(directory,clip.file))).frames,30);
  const noFiles=await preparePartialExport(directory,{...job,segments:[{index:1,state:'pending'}]});assert.equal(noFiles.state,'empty');
  await writeFile(path.join(directory,'segments/generated-1.mp4'),'corrupt-media');
  const partlyBad=await preparePartialExport(directory,{...job,segments:job.segments.map(p=>p.index===1?{...p,state:'downloaded',downloaded:true}:p)});
  assert.equal(partlyBad.state,'ready');assert.deepEqual(partlyBad.clips.map(c=>c.index),[0,2]);assert.equal(partlyBad.issues[0].index,1);
  const missingNarration=await preparePartialExport(directory,{...job,audioMode:'narration',narration:{},segments:[job.segments[0]]});
  assert.equal(missingNarration.state,'ready');assert.equal(missingNarration.clips[0].audioMissing,true);
  const pcm=path.join(directory,'exported-audio.pcm');await ffmpeg(['-i',path.join(directory,missingNarration.file),'-map','0:a:0','-c:a','pcm_s16le','-f','s16le',pcm]);
  const samples=await readFile(pcm);let peak=0;for(let i=0;i+1<samples.length;i+=2)peak=Math.max(peak,Math.abs(samples.readInt16LE(i)));
  assert.ok(peak<=1,'Missing replacement narration must never restore the original speech');
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('stopped and timed out UI exposes partial downloads and never offers a new paid retry',()=>{
 for(const state of ['stopped','timed_out']){
  const job={id:'safe-id',state,segments:[{index:0,state:'completed'},{index:1,state:'running',taskId:'original'}],partialExport:{state:'ready',clips:[{index:0,duration:3}]}};
  const html=outputActions(job)+partialOutputPanel(job);assert.match(html,/导出已完成视频/);assert.match(html,/收取已完成结果/);assert.match(html,/\/exports\/0\?download=1/);assert.doesNotMatch(html,/data-action="retry|中止生成/);
 }
 assert.match(outputActions({id:'safe-id',state:'processing',segments:[]}),/中止生成/);
 assert.equal(outputActions({id:'local',state:'processing',local:{}}),'');
});
