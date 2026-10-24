import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [installation,directory]=process.argv.slice(2);
const {Store}=await import(pathToFileURL(path.join(installation,'src/store.js')));
const id='11111111-2222-4333-8444-555555555555', now=new Date().toISOString();
await mkdir(path.join(directory,'projects',id),{recursive:true});
const store=new Store(directory);
try {
  store.createProject({id,title:'桌面升级验证（测试）',created:now,updated:now,revision:0,state:'ready',sourceName:'desktop-test.mp4',sourceFile:'source.mp4',sourceBytes:0,source:{duration:2,width:160,height:90,hasAudio:false},keyHash:createHash('sha256').update('installer-smoke-test-not-a-real-key').digest('hex'),analysis:{windows:[{index:0,start:0,duration:2,state:'completed',attempts:1}]},story:{summary:'此项目仅用于验证窗口、托盘和覆盖更新。',assets:[],shots:[{id:'SH001',start:0,end:2,summary:'测试镜头',camera:'固定',characterIds:[],sceneId:null,propIds:[]}],dialogues:[],warnings:[]},edits:{model:'wan3.0-480p',assets:{},dialogues:[]},error:null});
} finally {store.close();}
await writeFile(path.join(directory,'project-proof.txt'),'Keep this data when overwriting the application.\n');
console.log(id);
