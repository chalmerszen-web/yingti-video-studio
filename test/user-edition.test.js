import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {availablePage,viewURL,friendly,connectionSummary,workflowPages} from '../public/user-flow.js';

test('four workflow pages guard only existing project readiness and keep libraries independent',()=>{
  assert.deepEqual(workflowPages,['import','analysis','edit','generate']);
  for(const page of ['analysis','edit','generate'])assert.equal(availablePage(page,null),'import');
  assert.equal(availablePage('generate',{state:'analyzing'}),'analysis');
  assert.equal(availablePage('generate',{state:'ready'}),'generate');
  for(const page of ['projects','records','record'])assert.equal(availablePage(page,null),page);
});
test('page routes retain the selected project/job without any model request or mutable payload',()=>{
  const url=viewURL('record',{projectId:'a',jobId:'b'}); assert.equal(url,'/?view=record&project=a&job=b');
  assert.equal(viewURL('edit',{projectId:'a',demo:true}),'/?view=edit&demo=1');
});
test('customer system copy translates provider names while service capability checks keep model IDs',()=>{
  assert.equal(friendly('Omni-Analysis 分析，WAN 3.0 生成，导入 API KEY'),'视频分析 分析，视频生成 生成，导入 访问密钥');
  assert.ok(!/Omni|WAN|KEY|JSON|FFmpeg/.test(friendly('Omni-Analysis WAN3.0 KEY JSON FFmpeg / FFprobe')));
  const capabilities=connectionSummary(['Omni-Analysis','wan3.0-480p']); assert.equal(capabilities.analysis,true);assert.equal(capabilities.generation,true);assert.match(capabilities.text,/连接正常/);
});
test('customer document gives every functional control one owner and separate page containers',async()=>{
  const html=await readFile('public/user.html','utf8');
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]); assert.equal(ids.length,new Set(ids).size,'Duplicate IDs break existing handlers');
  for(const page of [...workflowPages,'projects','records','record'])assert.ok(html.includes(`data-screen="${page}"`));
  for(const id of ['source-file','analyze-button','analysis-state','asset-content','studio-model','auto-quality','generate-button','project-list','studio-job-list','studio-job-detail','key-save','result-video'])assert.equal(ids.filter(value=>value===id).length,1);
  assert.ok(html.indexOf('data-screen="import"')<html.indexOf('id="import-section"'));
  assert.ok(!/Omni-Analysis|WAN 3\.0|API KEY/.test(html));
});
test('desktop customer route restoration allows page state but excludes local actions and external URLs',async()=>{
  const source=await readFile('packaging/user-route.cjs.txt','utf8'); const context=vm.createContext({URL,URLSearchParams}); vm.runInContext(source,context);
  const route='/?project=327c1117-33b7-47f0-b3cf-596f9c6b05a9&view=generate'; assert.equal(context.savedRoute(route),route);
  for(const route of ['//evil.test','/api/key','/api/shutdown','https://evil.test','/?job=../../secret'])assert.equal(context.savedRoute(route),null);
});
