import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAnalysisJSON } from '../src/analysis-json.js';
import { mergeStory, emptyStory } from '../src/story.js';

function story() {
  return { summary:'完整内容，不删改。', characters:[], scenes:[], props:[
    {id:'P001',name:'产品',description:'紫色罐'}, {id:'P002',name:'包装',description:'包装盒'},
    {id:'P003',name:'粉扑',description:'白色圆形'},
    {id:'P004',name:'木制小圆台',description:'浅色原木材质圆形小台座，用于陈列产品罐。',firstSeen:1,confidence:'high'}
  ], shots:[{start:0,end:5,summary:'展示',camera:'特写',characterIds:[],sceneId:null,propIds:['P004']}], dialogues:[{start:1,end:2,characterId:null,text:'你好。',uncertain:false}], warnings:[] };
}
test('strict, fenced and prefixed JSON preserve text, Unicode, literal braces and escapes', () => {
  const value=story(); value.props[0].description='他说："hello"，保留 { , } 和 😊\n第二行';
  const raw=JSON.stringify(value);
  for(const input of [raw,'\uFEFF'+raw,'```json\n'+raw+'\n```','结果如下：\n'+raw+'\n分析结束。']){
    const parsed=parseAnalysisJSON(input); assert.deepEqual(parsed.value,value); assert.deepEqual(parsed.corrections,[]);
  }
});
test('the real missing-opening-quote pattern is recovered without changing any value', () => {
  const expected=story(), raw=JSON.stringify(expected,null,2).replace('"description": "浅色','"description": 浅色');
  const parsed=parseAnalysisJSON(raw);
  assert.deepEqual(parsed.value,expected); assert.equal(parsed.corrections.length,1);
  assert.equal(parsed.corrections[0].kind,'missing_opening_quote'); assert.equal(parsed.corrections[0].path,'/props/3/description');
  assert.equal(parsed.corrections[0].offset,raw.indexOf('浅色')); assert.ok(parsed.corrections[0].line>1);
  assert.ok(raw.includes('"description": 浅色')); // original response stays untouched
  assert.deepEqual(parseAnalysisJSON(raw),parsed);
});
test('trailing commas and literal control whitespace are normalized only outside or within known text fields', () => {
  const raw='{"summary":"第一行\n第二行\t保留 ,} 和 ,]","characters":[],"scenes":[],"props":[],"shots":[{"start":0,"end":5,"summary":"原文",},],"dialogues":[],"warnings":[],}';
  const parsed=parseAnalysisJSON(raw);
  assert.equal(parsed.value.summary,'第一行\n第二行\t保留 ,} 和 ,]');
  assert.equal(parsed.value.shots[0].summary,'原文'); assert.equal(parsed.corrections.length,5);
});
test('incomplete containers, ambiguous strings, missing fields and malformed IDs or numbers are never guessed', () => {
  const bad=[
    '{"summary":"partial', '{"summary":"done","props":[{"name":"a"}]',
    '{"description": missing, "name": "another"}', '{"description":"missing end}',
    '{description:"unquoted key"}', '{"start":12seconds"}', '{"characterId":C001"}',
    '{"characters":[C001"]}', '{"summary":new value" "props":[]}',
    '{"summary":"a","summary":missing"}', '{"summary":true and false"',
  ];
  for(const raw of bad) assert.throws(()=>parseAnalysisJSON(raw),{code:'analysis_json'},raw);
  const parsed=parseAnalysisJSON('{"summary":合法正文"}');
  assert.throws(()=>mergeStory(emptyStory(),parsed.value,{index:0,start:0,duration:5}),/缺少/);
});
test('repair budget, depth limit, and domain validation still reject unsafe or inconsistent output', () => {
  const many='['+Array.from({length:9},()=>'{"description":文本"}').join(',')+']';
  assert.throws(()=>parseAnalysisJSON('{"props":'+many+'}'),{code:'analysis_json'});
  assert.throws(()=>parseAnalysisJSON('{"props":'+ '['.repeat(70)+'{"description":文本"}'+']'.repeat(70)+'}'),{code:'analysis_json'});
  const value=story(); value.shots[0].end=50;
  const raw=JSON.stringify(value).replace('"description":"浅色','"description":浅色');
  assert.throws(()=>mergeStory(emptyStory(),parseAnalysisJSON(raw).value,{index:0,start:0,duration:5}),/超出/);
  value.shots[0].end=5; value.shots[0].propIds=['UNKNOWN'];
  assert.throws(()=>mergeStory(emptyStory(),parseAnalysisJSON(JSON.stringify(value).replace('"description":"浅色','"description":浅色')).value,{index:0,start:0,duration:5}),/无法对应/);
});
test('recovered natural-language content is data, including code-like text', () => {
  const parsed=parseAnalysisJSON('{"description":process.exit(42); 只是原文"}');
  assert.equal(parsed.value.description,'process.exit(42); 只是原文');
});
