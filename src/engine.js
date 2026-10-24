import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { AppError, invariant, safeError } from './errors.js';
import { VocalignProvider } from './provider.js';
import { requestBody } from './plan.js';
import * as media from './media.js';
import { publicJob } from './store.js';
import { prepareNarration } from './narration.js';
import { preparePartialExport } from './partial-export.js';

export const GENERATION_WAIT_MS = 3600 * 1000;

const remoteJob = job => {
  invariant(!job.local && !job.recipe?.localMaterialRepair, '这是本地修复版本，请在本地校准窗口中继续处理。', 409);
  return job;
};

export class QueueEngine {
  constructor({ store, vault, directory, providerFactory = key => new VocalignProvider(key), mediaTools = media, pollInterval = 10000, waitTimeout = GENERATION_WAIT_MS, now = Date.now, partialExporter, fundingGate }) {
    Object.assign(this, { store, vault, directory, providerFactory, media: mediaTools, pollInterval });
    Object.assign(this,{waitTimeout,now,partialExporter:partialExporter || (mediaTools===media?preparePartialExport:mediaTools.preparePartialExport)});
    this.controllers = new Map();
    // Balance integration is deferred until the platform publishes its wallet/pricing contract.
    // Only an explicitly supplied gate enables it; normal installations never query balance.
    this.funding=fundingGate ?? null;
    this.active = null;
    this.stopping = false;
    this.timer = null;
  }
  start() {
    // A crash in the create-request window is uncertain, even when no task ID was saved.
    for (const job of this.store.list()) {
      if (['completed','stopped','timed_out'].includes(job.state) || job.local || job.recipe?.localMaterialRepair) continue;
      this.store.update(job.id, current => {
        let ambiguous = false;
        for (const segment of current.segments) {
          if (segment.state === 'submitting' && !segment.taskId) segment.state = 'unknown';
          if (segment.state === 'unknown') ambiguous = true;
          if (['uploading', 'preparing'].includes(segment.state) && !segment.taskId) segment.state = 'pending';
          if (segment.taskId && !['completed', 'failed'].includes(segment.state)) segment.state = 'submitted';
        }
        const live = current.segments.some(s => s.taskId && !['completed', 'failed'].includes(s.state));
        if (current.stopRequested || current.collectRequested) {
          current.state = 'stopping';
        } else if (ambiguous) {
          current.state = 'needs_attention';
          current.error = '上次提交结果未知。请核对平台使用记录并绑定原任务 ID。';
        } else if (!this.funding && current.state === 'funds_required') {
          current.phase = '等待继续生成';
          current.error = '额度检查已暂缓，可点击继续生成。';
          current.fundingStatus = {state:'deferred'};
        } else if (current.state === 'processing' || current.state === 'queued' || current.state === 'waiting_key' || current.state === 'paused' && live) {
          current.state = 'queued';
        }
      });
    }
    this.timer = setInterval(() => this.pump(), 1500);
    this.timer.unref();
    this.pump();
  }
  async pump() {
    if (this.active || this.stopping) return;
    const job = this.store.list().find(j => !j.local && !j.recipe?.localMaterialRepair && (['stopping','collecting'].includes(j.state) || ['queued', 'waiting_key'].includes(j.state) && this.vault.hash() === j.keyHash));
    if (!job) return;
    this.active = job.id;
    this.controllers.set(job.id,new AbortController());
    try { await this.process(job.id); }
    catch (error) {
      if(this.store.get(job.id).stopRequested || error.code==='generation_timeout') {
        await this.collectAvailable(job.id,error.code==='generation_timeout'?'timed_out':this.store.get(job.id).haltReason||'stopped');
      } else {
      this.store.update(job.id, current => {
        current.state = ['insufficient_funds','funding_unavailable'].includes(error.code)?'funds_required':'needs_attention';
        current.error = safeError(error);
      });
      this.store.event(job.id, safeError(error));
      await this.exportAvailable(job.id);
      }
    } finally {
      this.controllers.delete(job.id);
      this.active = null;
      if (!this.stopping) setImmediate(() => this.pump());
    }
  }
  stopped(id) { const job=this.store.get(id);return this.stopping || job.pauseRequested || job.stopRequested; }
  checkInterrupt(id) { if(this.store.get(id).stopRequested)throw new AppError('生成已中止，正在保留已完成视频。',409,'generation_stopped'); }
  async ensureFunds(id,provider,options={}){
    this.checkInterrupt(id);this.vault.require(this.store.get(id).keyHash);
    if(!this.funding){
      if(this.store.get(id).fundingStatus?.state!=='deferred')this.store.update(id,j=>{j.fundingStatus={state:'deferred'};});
      return;
    }
    this.store.update(id,j=>{j.phase='核对生成额度';j.fundingStatus={state:'checking'};});
    try{const result=await this.funding.ensure(this.store.get(id),provider,options);this.checkInterrupt(id);this.vault.require(this.store.get(id).keyHash);this.store.update(id,j=>{j.fundingStatus=result;});}
    catch(error){this.store.update(id,j=>{j.fundingStatus={state:error.code==='insufficient_funds'?'insufficient':'unavailable',checkedAt:new Date().toISOString()};});throw error;}
  }
  checkDeadline(id) {
    const deadline=this.store.get(id).generationDeadline;
    if(Number.isFinite(deadline)&&this.now()>=deadline){this.store.update(id,j=>{j.stopRequested=true;j.haltReason='timed_out';});throw new AppError('等待生成超过3600秒，正在收取已完成视频。',408,'generation_timeout');}
  }
  abort(id) {
    const job=remoteJob(this.store.get(id));invariant(job.state!=='completed','任务已完成。',409);
    const result=this.store.update(id,current=>{current.stopRequested=true;current.haltReason='stopped';current.haltRequestedAt=new Date().toISOString();current.state='stopping';current.phase='正在中止并收取已完成视频';});
    this.controllers.get(id)?.abort();clearTimeout(this.pollTimer);this.wakePoll?.();this.pump();return result;
  }
  collect(id) {
    const job=remoteJob(this.store.get(id));invariant(this.active!==id,'正在收取或处理，请稍候。',409);
    invariant(['stopped','timed_out','needs_attention','paused'].includes(job.state),'当前状态无需单独收取结果。',409);
    const result=this.store.update(id,current=>{current.collectRequested=true;current.collectionReturnState=job.state;current.state='collecting';current.phase='收取已完成视频';});
    this.pump();return result;
  }
  async exportAvailable(id) {
    if(!this.partialExporter)return;
    try{const job=this.store.get(id),result=await this.partialExporter(path.join(this.directory,'jobs',id),job);this.store.update(id,current=>{current.partialExport=result;});}
    catch(error){this.store.update(id,current=>{current.partialExport={...(current.partialExport||{}),error:safeError(error)};});this.store.event(id,'已完成视频仍已保留，导出整理未完成，可再次收取。');}
  }
  async collectAvailable(id,reason) {
    const initial=this.store.get(id);reason ||= initial.haltReason || initial.collectionReturnState || 'stopped';
    this.store.update(id,current=>{current.state='collecting';current.phase='收取已完成视频';});
    const directory=path.join(this.directory,'jobs',id);let provider;
    if(this.vault.hash()===initial.keyHash)provider=this.providerFactory(this.vault.require(initial.keyHash));
    for(const saved of this.store.get(id).segments){
      if(!saved.taskId||saved.state==='completed'||saved.state==='failed'||!provider)continue;
      try{
        this.vault.require(initial.keyHash);
        const remote=await provider.status(saved.taskId,{timeout:15000,retries:0});const status=String(remote.status||'unknown').toLowerCase();
        this.store.update(id,j=>Object.assign(j.segments[saved.index],{remoteStatus:status,checkedAt:new Date().toISOString()}));
        if(!['completed','succeeded','success'].includes(status))continue;
        const raw=path.join(directory,'segments',`generated-${saved.index}.mp4`);
        if(!saved.downloaded){await provider.download(saved.taskId,raw);this.store.update(id,j=>{j.segments[saved.index].downloaded=true;});}
        try{
          const job=this.store.get(id),part=job.segments[saved.index],normalized=await this.media.normalizeResult(directory,job,part);
          this.store.update(id,j=>Object.assign(j.segments[saved.index],{state:'completed',error:null,completedAt:new Date().toISOString(),...(normalized?.timeMapping?{timeMapping:normalized.timeMapping}:{})}));
          if(part.generationMode==='keyframe_rebuild'){const outputSHA256=await this.media.fileSHA256(path.join(directory,'segments',`output-${saved.index}.mp4`));this.store.update(id,j=>{j.segments[saved.index].outputSHA256=outputSHA256;});}
        }catch(error){this.store.update(id,j=>Object.assign(j.segments[saved.index],{state:'downloaded',error:safeError(error)}));}
      }catch(error){this.store.update(id,j=>{j.segments[saved.index].collectionError=safeError(error);});}
    }
    await this.exportAvailable(id);
    this.store.update(id,current=>{current.state=reason;current.collectRequested=false;current.phase=reason==='timed_out'?'等待已超过3600秒，已完成视频可导出':reason==='stopped'?'已中止，已完成视频可导出':'已收取可用视频';});
    this.store.event(id,'已保留已完成视频及原任务编号。未结束的远端任务可稍后收取，不会再次提交生成。');
    try{await writeFile(path.join(directory,'receipt.json'),JSON.stringify(publicJob(this.store.get(id)),null,2),'utf8');}
    catch(error){this.store.event(id,'视频和任务状态已保留，处理回执暂未写入文件：'+safeError(error));}
  }
  pause(id) {
    const job = remoteJob(this.store.get(id));
    invariant(job.state !== 'completed', '任务已完成。', 409);
    return this.store.update(id, current => {
      current.pauseRequested = true;
      if (this.active !== id) current.state = 'paused';
    });
  }
  resume(id) {
    const job = remoteJob(this.store.get(id));
    invariant(!(this.active===id&&(job.stopRequested||job.collectRequested||['stopping','collecting'].includes(job.state))),'正在收取已完成结果，请等待当前操作结束。',409);
    this.vault.require(job.keyHash);
    invariant(job.state !== 'completed', '任务已完成。', 409);
    invariant(!job.segments.some(s => ['submitting', 'unknown', 'failed'].includes(s.state)), '请先处理结果未知或失败的分段。', 409);
    const result = this.store.update(id, current => {
      current.pauseRequested = false;
      current.stopRequested = false;current.collectRequested=false;current.haltReason=null;
      current.generationDeadline=this.now()+this.waitTimeout;
      for(const part of current.segments)if(part.taskId&&!['completed','failed'].includes(part.state))part.waitDeadline=this.now()+this.waitTimeout;
      current.state = this.active === id ? 'processing' : 'queued';
      current.error = null;
    });
    this.pump();
    return result;
  }
  async bindTask(id, index, taskId) {
    invariant(/^[a-zA-Z0-9_-]{1,200}$/.test(taskId), '请输入原平台任务 ID。');
    const job = remoteJob(this.store.get(id));
    invariant(this.active !== id, '请等待当前操作结束再绑定任务。', 409);
    const segment = job.segments[index];
    invariant(segment && ['unknown', 'submitting'].includes(segment.state) && !segment.taskId, '该分段不需要绑定任务。', 409);
    invariant(!this.store.list().some(j => j.segments.some(s => s.taskId === taskId || s.history?.some(h => h.taskId === taskId))), '此任务 ID 已绑定其他分段，不能重复使用。', 409);
    const provider = this.providerFactory(this.vault.require(job.keyHash));
    const remote = await provider.status(taskId);
    invariant(!remote.model || remote.model === job.model, '原任务使用的模型与此分段不一致，请重新核对。', 409);
    invariant(['queued', 'pending', 'in_progress', 'processing', 'running', 'completed', 'succeeded', 'success', 'failed', 'cancelled', 'canceled'].includes(String(remote.status).toLowerCase()), '平台暂未找到有效任务，请核对 ID 和 KEY。', 409);
    this.store.update(id, current => {
      current.segments[index].taskId = taskId;
      current.segments[index].state = 'submitted';
      current.segments[index].error = null;
      current.state = 'paused';
      current.pauseRequested = true;
      current.error = null;
    });
    this.store.event(id, `第 ${index + 1} 段绑定原任务 ID，恢复后只查询此任务。`);
  }
  async retryFailed(id, index) {
    const job = remoteJob(this.store.get(id));
    invariant(this.active !== id, '请等待当前操作结束。', 409);
    const segment = job.segments[index];
    invariant(segment?.state === 'failed' && segment.taskId, '只有平台明确失败的分段才能重新生成。', 409);
    const provider = this.providerFactory(this.vault.require(job.keyHash));
    const remote = await provider.status(segment.taskId);
    invariant(['failed', 'cancelled', 'canceled'].includes(String(remote.status).toLowerCase()), '平台未确认原任务失败，不能重新生成。', 409);
    this.store.update(id, current => {
      const part = current.segments[index];
      part.history = [...(part.history || []), { taskId: part.taskId, state: part.state, at: new Date().toISOString() }];
      Object.assign(part, { state: 'pending', taskId: null, downloaded:false, outputSHA256:null, timeMapping:null, waitDeadline:null, error: null, affinity: randomUUID(), idempotencyKey: 'wan-editor-' + randomUUID() });
      current.state = 'queued';
      current.pauseRequested = false;
      current.stopRequested=false;current.haltReason=null;current.generationDeadline=this.now()+this.waitTimeout;
      current.error = null;
    });
    this.store.event(id, `用户确认重新生成第 ${index + 1} 段，将产生新的平台调用。`);
    this.pump();
  }
  async process(id) {
    let job = remoteJob(this.store.get(id));
    if(job.stopRequested||job.collectRequested){await this.collectAvailable(id);return;}
    const directory = path.join(this.directory, 'jobs', id);
    const provider = this.providerFactory(this.vault.require(job.keyHash));
    const signal=this.controllers.get(id)?.signal;
    const setSegment = (index, change) => this.store.update(id, current => Object.assign(current.segments[index], change));
    const phase = message => {this.checkInterrupt(id);return this.store.update(id, current => { current.state = 'processing'; current.phase = message; });};
    const paused = () => {this.checkInterrupt(id);return this.store.update(id, current => { current.state = 'paused'; current.phase = '已暂停后续分段'; });};
    const live = job.segments.some(s => s.taskId && !['completed', 'failed'].includes(s.state));
    if (this.stopped(id) && !live) { paused(); return; }
    if (job.audioMode === 'narration') {
      phase('准备整篇配音，核对实际长度');
      if (job.recipe.edits.fullDialogue.delivery === 'uploaded') {
        const recorded = job.recipe.edits.narration;
        invariant(recorded?.file && recorded.duration <= job.segments.reduce((n,s)=>n+s.frames,0)/30 + 0.001, '整篇录音超过原片长度，不能裁掉台词。请调整录音或视频长度。', 422);
        this.store.update(id, current => { current.narration = { ...recorded, sourceFile: recorded.file, state: 'ready' }; });
      } else {
        await prepareNarration(directory,job,provider,fields=>this.store.update(id,current=>{ current.narration={...current.narration,...fields}; }), { signal, cacheDirectory: path.join(directory,'..','..','narration-cache',job.keyHash), beforeSubmit: async () => { this.vault.require(job.keyHash); invariant(!this.stopped(id), '已暂停配音提交，恢复后继续。',409);await this.ensureFunds(id,provider,{includeSpeech:true,signal}); } });
      }
      job = this.store.get(id);
    }
    if(!live&&!this.stopped(id)&&job.segments.some(s=>!s.taskId&&s.state!=='completed'&&s.generationMode!=='base_copy'))await this.ensureFunds(id,provider,{signal});
    phase('准备视频分段');
    if (!job.prepared && !this.stopped(id)) {
      await this.media.prepareSegments(directory, job, async index => {
        this.store.update(id, current => { current.phase = `已准备 ${index + 1} / ${current.segments.length} 段`; });
      }, () => this.stopped(id));
      if (this.stopped(id)) { paused(); return; }
      this.store.update(id, current => { current.prepared = true; });
      this.store.event(id, job.recipe?.actionRebuild ? '已准备本地复用画面与冻结首尾帧，仅指定动作片段提交生成。' : `已完成 ${job.segments.length} 段精确切分，每段不超过 15 秒。`);
    }
    for (let index = 0; index < job.segments.length; index++) {
      job = this.store.get(id);
      let segment = job.segments[index];
      if (segment.state === 'completed') continue;
      invariant(!['unknown', 'submitting', 'failed'].includes(segment.state), '请先核对结果未知或失败的分段。', 409);
      if (this.stopping) return;
      this.checkInterrupt(id);
      this.checkDeadline(id);
      this.vault.require(job.keyHash);
      if (segment.generationMode === 'base_copy') {
        await this.media.prepareBaseCopy(directory, job, segment);
        setSegment(index, { state: 'completed', completedAt: new Date().toISOString(), error: null });
        continue;
      }
      if (!segment.taskId) {
        if (this.stopped(id)) { paused(); return; }
        await this.ensureFunds(id,provider,{signal});
        if (Number.isInteger(segment.bridgeFromIndex)) {
          const bridge = await this.media.prepareReconstructionBridge(directory, job, segment);
          this.store.update(id, current => {
            const part = current.segments[index];
            part.bridge = bridge;
            part.bindings[0] = { ...part.bindings[0], file: bridge.file, origin: 'actual_previous_final_frame' };
            current.frozenFiles ||= [];
            const record = { file: bridge.file, sha256: bridge.sha256, origin: bridge.policy, sourceSegmentIndex: bridge.fromSegmentIndex };
            const existing = current.frozenFiles.findIndex(item => item.file === bridge.file);
            if (existing < 0) current.frozenFiles.push(record); else current.frozenFiles[existing] = record;
          });
          job = this.store.get(id); segment = job.segments[index];
        }
        phase(`上传第 ${index + 1} / ${job.segments.length} 段`);
        setSegment(index, { state: 'uploading', error: null });
        const keyframes = segment.generationMode === 'keyframe_rebuild';
        const references = [];
        if (keyframes) {
          invariant(segment.bindings?.length === 2 && segment.bindings[0].type === 'first_frame' && segment.bindings[1].type === 'last_frame', '动作重建仅支持首尾两帧，已停止提交。');
          for (const binding of segment.bindings) {
            const frozen = job.frozenFiles?.find(item => item.file === binding.file);
            invariant(frozen?.sha256 && await this.media.fileSHA256(path.join(directory, binding.file)) === frozen.sha256, '冻结首尾帧校验失败，尚未提交生成任务。', 409);
          }
        } else {
          const videoURL = await provider.upload(path.join(directory, 'segments', `input-${index}.mp4`), job.model, segment.affinity,{signal});
          references.push({ type: 'reference_video', url: videoURL });
        }
        if (keyframes || job.workflow === 'studio') {
          for (const binding of segment.bindings) {
            if (this.stopped(id)) { setSegment(index, { state: 'pending' }); paused(); return; }
            const url = await provider.upload(path.join(directory, binding.file), job.model, segment.affinity,{signal});
            references.push({ type: binding.type, url });
          }
        } else {
          const imageURL = await provider.upload(path.join(directory, 'reference.png'), job.model, segment.affinity,{signal});
          references.push({ type: 'reference_image', url: imageURL });
        }
        if (this.stopped(id)) { setSegment(index, { state: 'pending' }); paused(); return; }
        this.vault.require(job.keyHash);
        const body = requestBody(job, segment, references);
        const inputSHA256 = keyframes ? createHash('sha256').update(JSON.stringify(segment.bindings.map(binding => job.frozenFiles.find(item => item.file === binding.file).sha256))).digest('hex')
          : this.media.fileSHA256 ? await this.media.fileSHA256(path.join(directory,'segments',`input-${index}.mp4`)) : null;
        this.vault.require(job.keyHash);
        if(this.stopped(id)) { setSegment(index,{state:'pending'});paused();return; }
        await this.ensureFunds(id,provider,{signal});
        this.checkDeadline(id);
        if(!Number.isFinite(this.store.get(id).generationDeadline))this.store.update(id,j=>{j.generationDeadline=this.now()+this.waitTimeout;});
        phase(`提交第 ${index + 1} / ${job.segments.length} 段`);
        // This commit must precede the only paid POST. Never retry this window automatically.
        setSegment(index, { state: 'submitting', attempts: segment.attempts + 1, submittedAt: new Date().toISOString(), requestSettings: { promptExtend: body.prompt_extend, model: body.model, duration: body.duration, inputSHA256, promptSHA256:createHash('sha256').update(body.prompt).digest('hex'), references: references.map(item => item.type), promptPolicy: job.generationOptions?.promptPolicy || 'legacy' } });
        let taskId;
        try { taskId = await provider.create(body, segment,{signal}); }
        catch (error) { setSegment(index, { state: 'unknown', error: safeError(error) }); throw error; }
        setSegment(index, { state: 'submitted', taskId,waitDeadline:this.store.get(id).generationDeadline });
        this.store.event(id, `第 ${index + 1} 段已提交，任务 ID 已保存。`);
        segment = this.store.get(id).segments[index];
      }
      const taskId = segment.taskId;
      if(!Number.isFinite(this.store.get(id).generationDeadline))this.store.update(id,j=>{j.generationDeadline=Number.isFinite(segment.waitDeadline)?segment.waitDeadline:this.now()+this.waitTimeout;});
      const deadline=this.store.get(id).generationDeadline;
      if(!Number.isFinite(segment.waitDeadline))setSegment(index,{waitDeadline:deadline});
      for (;;) {
        if (this.stopping) return;
        this.checkInterrupt(id);
        if(this.now()>=deadline){this.store.update(id,j=>{j.stopRequested=true;j.haltReason='timed_out';});throw new AppError('等待生成超过3600秒，正在收取已完成视频。',408,'generation_timeout');}
        this.vault.require(job.keyHash);
        phase(`生成第 ${index + 1} / ${job.segments.length} 段`);
        let result;
        try{result=await provider.status(taskId,{signal,timeout:Math.max(1,Math.min(60000,deadline-this.now())),retries:0});}
        catch(error){if(this.now()>=deadline){this.store.update(id,j=>{j.stopRequested=true;j.haltReason='timed_out';});throw new AppError('等待生成超过3600秒，正在收取已完成视频。',408,'generation_timeout');}throw error;}
        const status = String(result.status || 'unknown').toLowerCase();
        setSegment(index, { remoteStatus: status, checkedAt: new Date().toISOString(), state: 'running' });
        if (['completed', 'succeeded', 'success'].includes(status)) break;
        if (['failed', 'cancelled', 'canceled'].includes(status)) {
          setSegment(index, { state: 'failed', error: '平台确认该分段生成失败。' });
          throw new AppError(`第 ${index + 1} 段生成失败，已完成的分段会保留。可单独重新生成失败段。`, 502);
        }
        invariant(['queued', 'pending', 'in_progress', 'processing', 'running'].includes(status), '平台任务状态暂不可用，保留原 ID，稍后恢复查询。', 502);
        this.checkInterrupt(id);
        await new Promise(resolve => { this.wakePoll = resolve; this.pollTimer = setTimeout(resolve, Math.max(1,Math.min(this.pollInterval,deadline-this.now()))); });
        this.wakePoll = null;
      }
      phase(`下载第 ${index + 1} / ${job.segments.length} 段`);
      setSegment(index, { state: 'downloading' });
      await provider.download(taskId, path.join(directory, 'segments', `generated-${index}.mp4`));
      setSegment(index,{downloaded:true});
      phase(`校准第 ${index + 1} / ${job.segments.length} 段`);
      const normalization = await this.media.normalizeResult(directory, job, segment);
      if (normalization?.timeMapping) setSegment(index, { timeMapping: normalization.timeMapping });
      if (segment.generationMode === 'keyframe_rebuild') setSegment(index, { outputSHA256: await this.media.fileSHA256(path.join(directory, 'segments', `output-${index}.mp4`)) });
      if (normalization?.silentFullScriptGap) this.store.event(id, `第 ${index + 1} 段没有安排新台词且未返回音轨，已按整篇替换规则留为静音，没有回填原对白。`);
      setSegment(index, { state: 'completed', error: null, completedAt: new Date().toISOString() });
      this.store.event(id, `第 ${index + 1} 段已下载并完成帧数校验。`);
    }
    if (this.stopping) return;
    this.checkInterrupt(id);
    phase(job.audioMode === 'narration' ? '合成精确配音与新字幕' : job.audioMode === 'mixed' ? '拼接成片并合成修改后的声音' : '拼接成片并恢复原音轨');
    job = this.store.get(id);
    const result = await this.media.assemble(directory, job);
    this.checkInterrupt(id);
    this.store.update(id, current => {
      current.state = 'completed'; current.phase = current.quality?.enabled ? '视频已生成，正在核对台词、商品和涂抹' : '视频已生成，内容待核对'; current.error = null;
      current.result = result; current.completedAt = new Date().toISOString(); current.pauseRequested = false;
      if (current.quality?.enabled) current.quality.state = 'queued';
    });
    this.store.event(id, '成片拼接、音轨检查和完整解码校验通过。请预览替换效果与分段衔接。');
    await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(publicJob(this.store.get(id)), null, 2), 'utf8');
  }
  stop() {
    this.stopping = true;
    clearInterval(this.timer);
    clearTimeout(this.pollTimer);
    this.wakePoll?.();
  }
}
