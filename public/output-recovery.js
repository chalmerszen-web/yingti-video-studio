const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const terminal=new Set(['completed','stopped','timed_out']);
export function outputActions(job){
  if(job.local||job.recipe?.localMaterialRepair)return '';
  const id=esc(job.id),working=job.active||['queued','waiting_key','processing','paused'].includes(job.state);
  const stop=!terminal.has(job.state)&&!job.stopRequested&&working?`<button class="secondary danger" data-output-action="abort" data-id="${id}">中止生成</button>`:'';
  const collect=['stopped','timed_out','needs_attention','paused'].includes(job.state)&&!job.active&&(job.segments.some(s=>s.taskId&&s.state!=='completed')||job.partialExport?.error||job.partialExport?.issues?.length)?`<button class="secondary" data-output-action="collect" data-id="${id}">收取已完成结果</button>`:'';
  return stop+collect;
}
export function partialOutputPanel(job,{includeActions=true}={}){
  if(job.state==='completed')return '';
  const value=job.partialExport,id=esc(job.id);if(!value?.clips?.length)return ['stopped','timed_out'].includes(job.state)?'<p class="partial-output-note">暂时没有已完成的视频。已提交的远端任务可能仍在处理，可稍后收取结果。</p>':'';
  const waiting=job.segments.some(s=>s.taskId&&!['completed','failed'].includes(s.state));
  const hint=waiting?'已提交的远端任务可能仍在执行；稍后收取不会重新提交生成。':'未提交的内容已停止，不会继续生成。';
  const all=value.state==='ready'?`<button class="secondary" data-output-action="preview" data-id="${id}">查看已完成视频</button><a class="download-button" href="/api/jobs/${id}/media/partial?download=1">导出已完成视频</a>`:'';
  return `<section class="partial-output"><h3>已保留 ${value.clips.length} 个视频片段</h3><p>按原视频顺序整理，仅包含已完成内容。未完成的内容没有补入。</p><div class="partial-output-actions">${all}${includeActions?outputActions(job):''}</div><ul>${value.clips.map(c=>`<li><span>片段 ${c.index+1} · ${Number(c.duration).toFixed(1)}秒${c.raw?' · 原始生成结果，待核对':''}${c.audioMissing?' · 配音缺失，仅保留画面':''}</span><button class="text-button" data-output-action="preview" data-id="${id}" data-index="${c.index}">查看</button><a href="/api/jobs/${id}/exports/${c.index}?download=1">导出</a></li>`).join('')}</ul>${value.issues?.length?'<p>部分结果尚未整理成功，可再次收取。已完成的导出文件仍可使用。</p>':''}<small>${hint}</small></section>`;
}
export function installOutputRecovery({csrf,refresh,onError}){
  if(!document.querySelector('#output-recovery-styles')){const link=document.createElement('link');link.id='output-recovery-styles';link.rel='stylesheet';link.href='/output-recovery.css';document.head.append(link);}
  document.addEventListener('click',async event=>{
    const button=event.target.closest('[data-output-action]');if(!button)return;const {outputAction:action,id,index}=button.dataset;
    if(action==='preview'){
      const route=index===undefined?`/api/jobs/${encodeURIComponent(id)}/media/partial`:`/api/jobs/${encodeURIComponent(id)}/exports/${Number(index)}`;
      const dialog=document.createElement('dialog');dialog.className='partial-output-dialog';dialog.innerHTML=`<form method="dialog"><h2>已完成内容预览</h2><button>关闭</button></form><video controls autoplay playsinline src="${route}"></video><p>这是当前已完成内容，不代表整片已经完成。</p><a class="download-button" href="${route}?download=1">导出视频</a>`;document.body.append(dialog);dialog.addEventListener('close',()=>{dialog.querySelector('video').pause();dialog.remove();},{once:true});dialog.showModal();return;
    }
    if(!['abort','collect'].includes(action))return;
    button.disabled=true;
    try{const r=await fetch(`/api/jobs/${encodeURIComponent(id)}/${action}`,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf()},body:'{}'});const data=await r.json();if(!r.ok)throw new Error(data.error||'操作未完成，请刷新任务记录。');await refresh();}
    catch(error){onError(error.message);button.disabled=false;}
  });
}
