import {localMaterialButton} from './local-material-ui.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stamp=frame=>(Math.max(0,Number(frame)||0)/30).toFixed(3)+'秒';
export const isLocalMaterialJob=job=>!!job?.recipe?.localMaterialRepair;
export const localMaterialThumbnail=job=>isLocalMaterialJob(job)?job.recipe.localMaterialRepair.donor?`/api/local-material/${encodeURIComponent(job.id)}/media/donor`:'/mark.svg':`/api/jobs/${encodeURIComponent(job.id)}/media/reference`;
export const localMaterialInstallHint='本地涂抹处理组件尚未安装，请安装组件后重新打开软件。本地处理不需要连接视频服务。';
const localState=job=>job.local?.state||({local_processing:'processing',local_paused:'paused'}[job.state]||job.state);

export function localMaterialStatus(job){
  const state=localState(job);
  if(state==='confirmed'||job.state==='completed')return '局部修复版本已保存 · 整片未自动核验';
  if(state==='processing')return job.local?.action==='analyse'?'正在本地检查':'正在生成本地预览';
  return({draft:'本地校准草稿',needs_calibration:'本地草稿 · 需要补充校准',local_queued:'等待本地处理',queued:'等待本地处理',preview_ready:'本地预览就绪 · 待人工查看',paused:'本地处理已暂停',cancelled:'本地处理已暂停',failed:'本地处理未完成'})[state]||'本地校准草稿';
}

export function localMaterialProgress(job){
  if(['preview_ready','confirmed'].includes(localState(job))||job.state==='completed')return 100;
  const value=job.local?.progress;
  const percent=Number.isFinite(value)?value:Number.isFinite(value?.processedFrames)&&Number.isFinite(value?.totalFrames)&&value.totalFrames>0?value.processedFrames/value.totalFrames*100:0;
  return Math.max(0,Math.min(99,Math.round(percent)));
}

export function localMaterialProgressMarkup(job){
  const value=localMaterialProgress(job),status=localMaterialStatus(job),count=job.local?.progress;
  const work=Number.isFinite(count?.processedFrames)&&Number.isFinite(count?.totalFrames)&&count.totalFrames>0?`已处理 ${Math.max(0,Math.min(count.totalFrames,count.processedFrames))}/${count.totalFrames} 帧。 `:'';
  return `<section class="user-job-progress" aria-label="本地修复进度"><div class="user-progress-heading"><span>本地处理进度</span><strong>${value}<small>%</small></strong></div><progress max="100" value="${value}" aria-label="本地修复进度" aria-valuetext="${esc(status)}，${value}%">${value}%</progress><div class="user-progress-status" role="status"><span>${esc(status)}</span><span>${work}平台用量 0；预览就绪只表示局部文件已生成，须人工核对。</span></div></section>`;
}

export function localMaterialJobActions(job,{enabled=true}={}){
  if(!isLocalMaterialJob(job))return '';
  if(localState(job)==='confirmed'||job.state==='completed')return `${localMaterialButton(job,{enabled})}<button class="secondary" data-action="preview-result" data-id="${esc(job.id)}">预览局部修复版本</button><a class="download-button" href="/api/jobs/${encodeURIComponent(job.id)}/media/result?download=1">下载待核对视频 ↓</a>`;
  return `<button class="secondary" data-action="local-material-resume" data-id="${esc(job.id)}" ${enabled?'':`disabled title="${esc(localMaterialInstallHint)}"`}>继续校准</button>${localState(job)==='preview_ready'?`<button class="secondary" data-action="preview-local-result" data-id="${esc(job.id)}">查看待确认预览</button>`:''}${enabled?'':`<span class="asset-target-scope">${localMaterialInstallHint}</span>`}`;
}

export function localMaterialLegacyActions(job){
  const saved=localState(job)==='confirmed'||job.state==='completed';
  return `<a class="secondary" href="/user.html?view=record&amp;job=${encodeURIComponent(job.id)}">${saved?'查看局部修复记录':'在创作页面继续本地校准'}</a>${saved?`<a class="download-button" href="/api/jobs/${encodeURIComponent(job.id)}/media/result?download=1">下载待核对视频 ↓</a>`:''}`;
}

export function localMaterialRecordDetails(job,{enabled=true,actions=null}={}){
  const spec=job.recipe.localMaterialRepair,r=spec.ranges||{},names=job.recipe.story?.assets||[];
  const actor=id=>names.find(a=>a.id===id)?.name||id||'待核对';
  const range=side=>r[side]?`${stamp(r[side].startFrame)}–${stamp(r[side].startFrame+r[side].frames)}`:'待选择';
  return `<section class="quality-panel"><h3>本地涂抹修复记录</h3><p>原片人物：${esc(actor(spec.actors?.sourceActorId))}；目标人物：${esc(actor(spec.actors?.targetActorId))}。原片范围 ${range('source')}；目标范围 ${range('target')}。</p><p>沿用当前成片声音，包含此版本已经编辑的台词、音乐与环境声。只处理校准的局部区域；其他人物、台词、字幕和商品没有自动判定通过。</p>${localMaterialProgressMarkup(job)}<div class="studio-job-actions">${actions??localMaterialJobActions(job,{enabled})}</div>${job.error?`<div class="notice error">${esc(job.error)}</div>`:''}</section>`;
}

export function localMaterialQualityPanel(job){
  return `<section class="quality-panel"><h3>局部修复核对</h3><p>${job.state==='completed'?'已保存人工确认的局部预览。':'当前仍是本地草稿。'}整片人物、台词、声音、字幕和其他商品仍需预览核对，未自动判定通过。</p></section>`;
}

// Resolve only by explicit lineage. Opening an existing draft must never guess
// another completed job or use the draft's edited base as its original parent.
export async function localMaterialOpenContext(selected,findJob,getJob){
  if(!isLocalMaterialJob(selected)||selected.state==='completed')return{parent:selected,existingDraftId:null};
  if(!selected.parentJobId)throw new Error('本地草稿没有完整父版本记录，请先找回修复前的视频版本。');
  const parent=findJob(selected.parentJobId)||await getJob(selected.parentJobId);
  if(!parent||parent.id!==selected.parentJobId||parent.state!=='completed'||parent.workflow!=='studio')throw new Error('修复前版本尚未完整取回，不能替换为其他人物或视频。');
  return{parent,existingDraftId:selected.id};
}
