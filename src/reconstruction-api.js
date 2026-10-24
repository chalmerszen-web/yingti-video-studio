import path from 'node:path';
import {mkdir,rm} from 'node:fs/promises';
import {invariant} from './errors.js';
import {studioUpload} from './studio-upload.js';
import {prepareImage} from './media.js';
import {createReconstruction} from './reconstruction.js';
import {ANALYSIS_MODELS} from './provider.js';

export function installReconstructionAPI(app,{store,vault,directory,engine,toolsStatus,toPublicJob}) {
  const saving=new Set();
  app.post('/api/jobs/:id/reconstruction',async(req,res)=>{
    const id=req.get('x-job-request-id');
    invariant(typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id),'动作重建请求编号无效。');
    const parent=store.get(req.params.id);vault.require(parent.keyHash);
    const existing=store.list().find(job=>job.id===id);
    if(existing){invariant(existing.parentJobId===parent.id&&existing.recipe?.actionRebuild,'此请求编号已用于其他版本。',409);req.resume();return res.json(toPublicJob(existing));}
    invariant(toolsStatus.ffmpeg&&toolsStatus.ffprobe,'媒体工具尚未就绪。',503);
    invariant(!saving.has(id),'这份动作重建正在保存，请等待。',409);saving.add(id);
    const temporary=path.join(directory,'incoming','reconstruction-'+id);
    try{
      await mkdir(temporary,{recursive:true});
      const {fields,files}=await studioUpload(req,temporary,{kind:'image',count:4,fields:['metadata'],maxFieldBytes:8192});
      invariant([2,4].includes(files.length),'请依次提供首尾两张，或分部位推匀所需的四张状态画面。');
      let data;try{data=JSON.parse(fields.metadata);}catch{invariant(false,'动作重建参数不完整。');}
      invariant(data&&typeof data==='object'&&!Array.isArray(data)&&data.confirmNewCharge===true,'局部动作重建会提交新的生成请求，请确认用量。');
      invariant(Object.keys(data).every(key=>['start','end','characterId','materialAssetId','stageMode','notes','reviewModel','confirmNewCharge'].includes(key)),'动作重建含未支持的参数，不能传入客户端素材路径。');
      invariant(typeof data.start==='number'&&typeof data.end==='number'&&Number.isFinite(data.start)&&Number.isFinite(data.end),'请填写有效的起止秒数。');
      invariant(typeof data.characterId==='string'&&typeof data.materialAssetId==='string'&&(data.notes===undefined||typeof data.notes==='string'&&data.notes.length<=1200),'人物、材质或动作说明格式无效。');
      invariant(data.reviewModel===undefined||ANALYSIS_MODELS.includes(data.reviewModel),'画面复核模型无效。');
      invariant(data.stageMode===undefined||['single','three_regions'].includes(data.stageMode),'分部位重建方式无效。');
      invariant((data.stageMode==='three_regions')===(files.length===4),'分部位推匀需要起点、脸颊完成、额头完成、最终完成四张图。');
      const prepared=[];
      for(const [index,file] of files.entries()){
        const output=path.join(temporary,`prepared-${index}.png`);
        const metadata=await prepareImage(path.join(temporary,file.file),output);
        prepared.push({file:output,...metadata,name:file.name});
      }
      const job=await createReconstruction({store,vault,directory,engine,parent,id,start:data.start,end:data.end,characterId:data.characterId,materialAssetId:data.materialAssetId,first:prepared[0],last:prepared.at(-1),intermediates:prepared.length===4?prepared.slice(1,-1):undefined,notes:data.notes,analysisModel:data.reviewModel});
      res.status(201).json(toPublicJob(job));
    }finally{
      try{await rm(temporary,{recursive:true,force:true});}finally{saving.delete(id);}
    }
  });
}
