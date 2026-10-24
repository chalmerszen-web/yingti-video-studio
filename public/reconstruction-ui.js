import {propRole} from './prop-role.js';
import {reconstructionRequestSeconds} from './reconstruction-policy.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const actors=job=>(job.recipe?.story?.assets||[]).filter(asset=>asset.type==='character');
const materials=job=>(job.recipe?.story?.assets||[]).filter(asset=>propRole(asset,job.recipe?.edits?.assets?.[asset.id])==='material');
export const canReconstruct=job=>job?.state==='completed'&&job.workflow==='studio'&&job.source?.duration>=2&&actors(job).length>0&&materials(job).length>0;
export const reconstructionButton=job=>canReconstruct(job)?`<button class="secondary" data-action="reconstruct-job" data-id="${esc(job.id)}">修正涂抹动作</button>`:'';
export function reconstructionDefaults(job){
  const material=materials(job)[0];
  const action=(job.recipe?.story?.actions||[]).find(item=>item.propId===material?.id&&item.type==='spread');
  const start=Math.max(0,Math.min(action?.start??0,job.source.duration-2));
  return{start:Number(start.toFixed(3)),end:Number(Math.min(job.source.duration,start+5).toFixed(3)),characterId:action?.characterId||actors(job)[0]?.id,materialAssetId:material?.id};
}
export function reconstructionForm(job){
  const d=reconstructionDefaults(job);
  const options=(items,selected)=>items.map(item=>`<option value="${esc(item.id)}" ${item.id===selected?'selected':''}>${esc(item.name)} · ${esc(item.id)}</option>`).join('');
  const labels={first:'厚膏起始画面',midCheek:'脸颊已匀，手仍贴脸',midForehead:'额头已匀，手仍贴额',last:'薄匀结束画面'};
  const upload=slot=>`<label class="reconstruction-frame ${slot.startsWith('mid')?'hidden':''}" data-rebuild-frame="${slot}"><span>${labels[slot]}</span><button type="button" data-rebuild-choose="${slot}" aria-label="导入${labels[slot]}">＋<span>点击或拖入完整图片</span><small>同一人物、衣服、场景及画幅</small></button><input class="file-input" type="file" tabindex="-1" data-rebuild-file="${slot}" accept=".png,.jpg,.jpeg,.webp,.bmp"><small data-rebuild-name="${slot}">尚未导入</small></label>`;
  return `<form method="dialog"><div class="reconstruction-title"><h2>修正涂抹动作</h2><button type="button" data-rebuild-cancel aria-label="关闭动作重建">关闭</button></div><p>用厚膏首帧和薄匀尾帧重建连续揉匀过程。所选范围的手部节奏和剪辑会改变，其他画面与当前成片声音沿用。</p><video controls preload="metadata" src="/api/jobs/${esc(job.id)}/media/result"></video><div class="reconstruction-fields"><label>开始秒数<input type="number" name="start" min="0" max="${Math.ceil(job.source.duration*1000)/1000}" step="any" value="${d.start}" required></label><label>结束秒数<input type="number" name="end" min="2" max="${Math.ceil(job.source.duration*1000)/1000}" step="any" value="${d.end}" required></label><label>涂抹人物<select name="characterId">${options(actors(job),d.characterId)}</select></label><label>膏体材质<select name="materialAssetId">${options(materials(job),d.materialAssetId)}</select></label></div><div class="reconstruction-frames">${upload('first')}${upload('midCheek')}${upload('midForehead')}${upload('last')}</div><label class="reconstruction-notes">局部动作要求<textarea name="notes" maxlength="1200" rows="2" placeholder="例如：脸颊、额头和下巴依次揉匀，最后收手展示自然肤纹"></textarea></label><label class="reconstruction-review">画面复核模型<input type="hidden" name="reviewModel" value="Omni-Analysis"><strong>Omni-Analysis</strong><small>自动结论仍需核对实际动作，复核另计分析用量。</small></label><p data-rebuild-budget></p><label class="reconstruction-confirm"><input type="checkbox" name="confirmNewCharge" required>确认生成新版本并使用新的生成、分析用量</label><p role="status" data-rebuild-status></p><button type="submit" class="primary accent">生成动作重建版本</button></form>`;
}

// No KEY or CSRF is retained here. An unresolved local submission must survive
// closing/reopening its dialog and can only be recovered with a GET request.
const attempts = new Map();
const metadataSignature = value => JSON.stringify(Object.keys(value).sort().map(key => [key, value[key]]));
export function reconstructionAttemptFor(parentId, newId = () => crypto.randomUUID()) {
  const current = () => {
    const record = attempts.get(parentId);
    return record ? { ...record, metadata: structuredClone(record.metadata), files: [...record.files] } : null;
  };
  const update = (id, fields) => {
    const record = attempts.get(parentId);
    if (!record || record.requestId !== id) throw new Error('动作重建请求记录不一致，请查看生成记录。');
    Object.assign(record, fields); return current();
  };
  return {
    current,
    begin(metadata, files) {
      const previous = attempts.get(parentId);
      if (previous && ['submitting', 'unknown', 'created'].includes(previous.state)) throw new Error('上次请求尚待取回，只能查询原版本，不能再次提交。');
      const signature = metadataSignature(metadata);
      const unchanged = previous && previous.signature === signature && previous.files.length === files.length && previous.files.every((file, index) => file === files[index]);
      const record = { requestId: unchanged ? previous.requestId : newId(), state: 'submitting', signature,
        metadata: structuredClone(metadata), files: [...files], error: '', job: null };
      attempts.set(parentId, record); return current();
    },
    response(id, statusCode, data) {
      // A 409 can mean another save of this same nonce is still running.
      if (statusCode >= 400 && statusCode < 500 && statusCode !== 409 && typeof data?.error === 'string') return update(id, { state: 'rejected', error: data.error });
      if (statusCode >= 200 && statusCode < 300 && data?.id === id && data.recipe?.actionRebuild?.parentJobId === parentId) return update(id, { state: 'created', job: data, error: '' });
      return update(id, { state: 'unknown', error: data?.error || '请求结果尚未确认，只查询原任务，不会重复提交。' });
    },
    unknown(id, message) { return update(id, { state: 'unknown', error: message || '请求结果尚未确认。' }); },
    acknowledged(id) {
      const record = attempts.get(parentId);
      if (record?.requestId === id && record.state === 'created') attempts.delete(parentId);
    },
  };
}

export function openReconstruction(job,{csrf,onCreated}){
  if(!canReconstruct(job))throw new Error('请选择已完成且有涂抹人物和膏体材质的成片。');
  const dialog=document.createElement('dialog');dialog.className='reconstruction-dialog';dialog.innerHTML=reconstructionForm(job);document.body.append(dialog);
  const form=dialog.querySelector('form'),status=dialog.querySelector('[data-rebuild-status]'),files={},urls={},attemptsForJob=reconstructionAttemptFor(job.id);let busy=false;
  const cleanup=()=>{for(const url of Object.values(urls))URL.revokeObjectURL(url);dialog.remove();};
  dialog.addEventListener('close',cleanup);
  const stageChoice=document.createElement('label');stageChoice.className='reconstruction-confirm';stageChoice.innerHTML='<input type="checkbox" name="threeRegions">按脸颊、额头、下巴依次推匀';form.querySelector('.reconstruction-frames').before(stageChoice);
  const budget=()=>{const start=Number(form.elements.start.value),end=Number(form.elements.end.value),seconds=end-start,staged=form.elements.threeRegions.checked;for(const slot of ['midCheek','midForehead'])dialog.querySelector(`[data-rebuild-frame="${slot}"]`).classList.toggle('hidden',!staged);const cost=reconstructionRequestSeconds(start,end,staged);dialog.querySelector('[data-rebuild-budget]').textContent=cost!==null?`重建 ${seconds.toFixed(2)} 秒画面，${staged?'三个部位依序生成，':'WAN '}请求用量合计 ${cost} 秒；生成后核对连续涂抹与两端接头。`:`请选择当前成片中 ${staged?'4.5':'2'}–15 秒的范围。`;};
  form.elements.threeRegions.addEventListener('change',budget);
  form.elements.start.addEventListener('input',budget);form.elements.end.addEventListener('input',budget);budget();
  const recoveryButton=document.createElement('button');recoveryButton.type='button';recoveryButton.className='secondary';recoveryButton.textContent='查询原请求（不重新生成）';recoveryButton.hidden=true;status.after(recoveryButton);
  const pending=()=>['submitting','unknown','created'].includes(attemptsForJob.current()?.state);
  const setLocked=locked=>{
    for(const control of form.querySelectorAll('input,select,textarea,[data-rebuild-choose],button[type="submit"]'))control.disabled=locked;
    recoveryButton.hidden=!locked;recoveryButton.disabled=busy;
  };
  const frozenMessage=()=>{const record=attemptsForJob.current();return `请求 ${record?.requestId||''} 的结果尚待取回，图片和参数已冻结。可查询原请求或关闭窗口查看生成记录，不会再次提交。`;};
  const displayFile=(slot,file)=>{
    if(urls[slot])URL.revokeObjectURL(urls[slot]);files[slot]=file;urls[slot]=URL.createObjectURL(file);
    const button=dialog.querySelector(`[data-rebuild-choose="${slot}"]`);button.innerHTML=`<img alt="状态参考画面" src="${urls[slot]}"><span>点击或拖入图片更换</span>`;dialog.querySelector(`[data-rebuild-name="${slot}"]`).textContent=file.name;
  };
  const choose=(slot,list)=>{
    if(busy||pending())throw new Error(frozenMessage());
    if(list.length!==1)throw new Error('每个状态画面请导入一张图片。');
    const file=list[0];if(!/\.(png|jpe?g|webp|bmp)$/i.test(file.name)||file.size>20*1024**2)throw new Error('图片请使用 JPG、PNG、WebP 或 BMP，单张不超过20 MB。');
    displayFile(slot,file);status.textContent='';
  };
  for(const slot of ['first','midCheek','midForehead','last']){
    const input=dialog.querySelector(`[data-rebuild-file="${slot}"]`),button=dialog.querySelector(`[data-rebuild-choose="${slot}"]`);
    button.addEventListener('click',()=>input.click());input.addEventListener('change',()=>{try{choose(slot,input.files);}catch(error){status.textContent=error.message;}finally{input.value='';}});
    button.addEventListener('dragover',event=>{event.preventDefault();});button.addEventListener('drop',event=>{event.preventDefault();try{choose(slot,event.dataTransfer.files);}catch(error){status.textContent=error.message;}});
  }
  dialog.querySelector('[data-rebuild-cancel]').addEventListener('click',()=>dialog.close());
  const showCreated=async record=>{
    await onCreated(record.job);attemptsForJob.acknowledged(record.requestId);if(dialog.isConnected)dialog.close();
  };
  const recover=async()=>{
    const record=attemptsForJob.current();if(!record||busy)return;
    busy=true;setLocked(true);status.textContent='正在查询原请求，不提交新的生成…';
    try{
      const response=await fetch(`/api/jobs/${encodeURIComponent(record.requestId)}`,{method:'GET'});
      const data=await response.json();
      if(!response.ok){status.textContent='暂未取回原版本，请稍后查询或查看生成记录；当前不会重复提交。';return;}
      const recovered=attemptsForJob.response(record.requestId,response.status,data);
      if(recovered.state==='created')await showCreated(recovered);else status.textContent=frozenMessage();
    }catch(error){status.textContent=`原请求查询未完成：${error.message}。可稍后查询，不会重新生成。`;}
    finally{busy=false;if(dialog.isConnected)setLocked(pending());}
  };
  recoveryButton.addEventListener('click',recover);
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy)return;if(pending()){await recover();return;}
    const staged=form.elements.threeRegions.checked,slots=staged?['first','midCheek','midForehead','last']:['first','last'];
    if(slots.some(slot=>!files[slot])){status.textContent=staged?'请导入起点、脸颊完成、额头完成和最终完成四张状态图。':'请先导入厚膏首帧和薄匀尾帧。';return;}
    const metadata={start:Number(form.elements.start.value),end:Number(form.elements.end.value),characterId:form.elements.characterId.value,materialAssetId:form.elements.materialAssetId.value,stageMode:staged?'three_regions':'single',notes:form.elements.notes.value,reviewModel:form.elements.reviewModel.value,confirmNewCharge:form.elements.confirmNewCharge.checked};
    const attempt=attemptsForJob.begin(metadata,slots.map(slot=>files[slot]));
    const payload=new FormData();payload.append('metadata',JSON.stringify(attempt.metadata));for(const file of attempt.files)payload.append('file',file);
    busy=true;setLocked(true);status.textContent='正在保存首尾帧与重建范围…';
    try{
      const response=await fetch(`/api/jobs/${encodeURIComponent(job.id)}/reconstruction`,{method:'POST',headers:{'X-CSRF-Token':csrf,'X-Job-Request-ID':attempt.requestId},body:payload,signal:AbortSignal.timeout(120000)});
      const result=await response.json();if(attemptsForJob.current()?.requestId!==attempt.requestId)return;
      const record=attemptsForJob.response(attempt.requestId,response.status,result);
      if(record.state==='created'){if(dialog.isConnected)await showCreated(record);}else if(record.state==='rejected')status.textContent=record.error;else status.textContent=frozenMessage();
    }catch(error){
      const current=attemptsForJob.current();
      if(current?.requestId!==attempt.requestId)return;
      if(current?.state!=='created')attemptsForJob.unknown(attempt.requestId,error.message);
      status.textContent=current?.state==='created'?'版本已保存，但界面刷新未完成。请查询原请求或查看生成记录，不要重复生成。':frozenMessage();
    }finally{busy=false;if(dialog.isConnected)setLocked(pending());}
  });
  const unresolved=attemptsForJob.current();
  if(unresolved&&['submitting','unknown','created'].includes(unresolved.state)){
    for(const name of ['start','end','characterId','materialAssetId','notes','reviewModel','confirmNewCharge'])form.elements[name].value=unresolved.metadata[name];
    form.elements.confirmNewCharge.checked=unresolved.metadata.confirmNewCharge===true;form.elements.threeRegions.checked=unresolved.metadata.stageMode==='three_regions';
    const slots=unresolved.metadata.stageMode==='three_regions'?['first','midCheek','midForehead','last']:['first','last'];
    slots.forEach((slot,index)=>displayFile(slot,unresolved.files[index]));budget();setLocked(true);status.textContent=frozenMessage();
  }
  dialog.showModal();return dialog;
}
