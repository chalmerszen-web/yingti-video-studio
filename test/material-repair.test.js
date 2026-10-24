import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { regenerateSegment } from '../src/regenerate.js';

function parentFixture() {
  return { id: randomUUID(), state:'completed',workflow:'studio',title:'材料历史版本',sourceFile:'source.mp4',source:{hasAudio:false},
    recipe:{story:{assets:[{id:'P002',type:'prop',name:'面霜膏体'}],shots:[],dialogues:[],actions:[]},edits:{assets:{P002:{main:{file:'assets/audit.png'}}},fullDialogue:{enabled:false}}},
    segments:[{index:0,start:0,duration:5,requestDuration:5,frames:150,state:'completed',prompt:'冻结的原片编辑指令',bindings:[]}],events:[] };
}
test('historical whole-cream bindings are stopped before KEY access, billing or version mutation', async () => {
  const parent=parentFixture();parent.segments[0].bindings=[{assetId:'P002',slot:'main',type:'reference_image',file:'assets/audit.png'}];
  const original=JSON.stringify(parent);let keyReads=0,pumps=0,creates=0;
  await assert.rejects(regenerateSegment({parent,index:0,id:randomUUID(),directory:'unused',vault:{require(){keyReads++;}},engine:{pump(){pumps++;}},store:{create(){creates++;}}}),error=>error.code==='material_reference_legacy'&&error.status===409&&/生成新版本/.test(error.message));
  assert.deepEqual([keyReads,pumps,creates],[0,0,0]);assert.equal(JSON.stringify(parent),original);
});
test('material audit-only frozen files are copied and verified without becoming WAN bindings', async () => {
  const directory=await mkdtemp(path.join(os.tmpdir(),'yingti-material-repair-'));
  const parent=parentFixture(),root=path.join(directory,'jobs',parent.id),id=randomUUID();let saved,pumps=0;
  try{
    const contents='immutable cream audit';
    parent.frozenFiles=[{file:'assets/audit.png',sha256:createHash('sha256').update(contents).digest('hex')}];
    for(const file of ['source.mp4','canonical.mp4','reference.png','segments/input-0.mp4','assets/audit.png']){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),file==='assets/audit.png'?contents:file);}
    await regenerateSegment({parent,index:0,id,directory,vault:{require(){}},engine:{pump(){pumps++;}},store:{create(job){saved=job;}}});
    assert.equal(await readFile(path.join(directory,'jobs',id,'assets/audit.png'),'utf8'),contents);
    assert.deepEqual(saved.segments[0].bindings,[]);assert.deepEqual(saved.frozenFiles,parent.frozenFiles);assert.equal(pumps,1);
    parent.frozenFiles[0].sha256='0'.repeat(64);let creates=0;
    await assert.rejects(regenerateSegment({parent,index:0,id:randomUUID(),directory,vault:{require(){}},engine:{pump(){pumps++;}},store:{create(){creates++;}}}),/参考素材校验失败/);
    assert.equal(creates,0);assert.equal(pumps,1);
  }finally{await rm(directory,{recursive:true,force:true});}
});
