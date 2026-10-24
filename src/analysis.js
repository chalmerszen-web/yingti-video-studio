import path from 'node:path';
import { mkdir, writeFile, appendFile, readFile, rename } from 'node:fs/promises';
import { AppError, invariant, safeError } from './errors.js';
import { VocalignProvider } from './provider.js';
import { analysisPrompt, mergeStory } from './story.js';
import { prepareAnalysisVideo, detectSourceMotion } from './media.js';
import { parseAnalysisJSON } from './analysis-json.js';
import { createHash } from 'node:crypto';

export class AnalysisEngine {
  constructor({ store, vault, directory, providerFactory = key => new VocalignProvider(key), prepareVideo = prepareAnalysisVideo }) {
    Object.assign(this, { store, vault, directory, providerFactory, prepareVideo });
    this.active = null; this.stopping = false;
  }
  async start() {
    for (const project of this.store.projects()) {
      if (project.state === 'ready') continue;
      for (const part of project.analysis.windows) {
        if (part.state !== 'submitting') continue;
        let recovered = false;
        if (part.responseFile) {
          try { const response = JSON.parse(await readFile(path.join(this.directory, 'projects', project.id, part.responseFile), 'utf8')); recovered = response.complete === true; } catch {}
        }
        this.store.updateProject(project.id, current => { current.analysis.windows[part.index].state = recovered ? 'response_saved' : 'unknown'; });
      }
      this.store.updateProject(project.id, current => {
        if (current.analysis.windows.some(w => w.state === 'unknown')) { current.state = 'analysis_attention'; current.error = '上次分析在完成前中断，部分结果已保留；不会自动重复调用。'; }
        else if (current.state === 'analyzing') current.state = 'analysis_queued';
      });
    }
    this.timer = setInterval(() => this.pump(), 1500); this.timer.unref(); this.pump();
  }
  async pump() {
    if (this.active || this.stopping) return;
    const project = this.store.projects().reverse().find(p => p.state === 'analysis_queued' && p.keyHash === this.vault.hash());
    if (!project) return;
    this.active = project.id;
    try { await this.process(project.id); }
    catch (error) { this.store.updateProject(project.id, p => { p.state = 'analysis_attention'; p.error = safeError(error); for (const w of p.analysis.windows) if (w.state === 'submitting') w.state = 'unknown'; }); }
    finally { this.active = null; if (!this.stopping) setImmediate(() => this.pump()); }
  }
  async process(id, { localOnly = false } = {}) {
    const directory = path.join(this.directory, 'projects', id); await mkdir(path.join(directory, 'analysis'), { recursive: true });
    let project = this.store.project(id);
    let provider;
    for (let index = 0; index < project.analysis.windows.length; index++) {
      if (this.stopping) return;
      project = this.store.project(id); let part = project.analysis.windows[index];
      if (part.state === 'completed') continue;
      const saved = ['response_saved', 'parse_error'].includes(part.state);
      if (localOnly && !saved) {
        this.store.updateProject(id, p => { p.state = 'analysis_attention'; p.phase = '已整理本地结果，仍有未完成部分'; p.error = '已保存的完整结果已整理。剩余部分没有可用的完整结果，本次未调用模型。'; });
        return;
      }
      invariant(!['unknown', 'submitting'].includes(part.state), '请核对上次分析记录后决定是否重新分析此段。', 409);
      const update = change => this.store.updateProject(id, p => Object.assign(p.analysis.windows[index], change));
      this.store.updateProject(id, p => { p.state = 'analyzing'; p.phase = saved ? `整理第 ${index + 1} / ${p.analysis.windows.length} 部分已保存结果` : `分析第 ${index + 1} / ${p.analysis.windows.length} 部分`; p.error = null; });
      if (!saved) {
        provider ||= this.providerFactory(this.vault.require(project.keyHash));
        this.vault.require(project.keyHash);
        update({ state: 'preparing' });
        const file = await this.prepareVideo(directory, project, part);
        if (this.stopping) return;
        update({ state: 'uploading' });
        this.store.updateProject(id,p=>{const old=p.analysis.model;if(old&&old!=='Omni-Analysis')for(const prior of p.analysis.windows)if(prior.attempts&&!prior.model)prior.model=old;p.analysis.model='Omni-Analysis';});
        const url = await provider.upload(file, 'Omni-Analysis');
        if (this.stopping) return;
        this.vault.require(project.keyHash);
        const attempt = (part.attempts || 0) + 1;
        const responseFile = `analysis/response-${index}-${attempt}.json`, partialFile = path.join(directory, `analysis/partial-${index}-${attempt}.txt`);
        await writeFile(partialFile, '', 'utf8');
        update({ state: 'submitting', model:'Omni-Analysis', attempts: attempt, responseFile, charactersReceived: 0, startedAt: new Date().toISOString() });
        let received = 0, checkpoint = 0;
        let response;
        try {
          response = await provider.analyzeVideo(url, analysisPrompt(project, part), async delta => {
            await appendFile(partialFile, delta, 'utf8'); received += delta.length;
            if (Date.now() - checkpoint > 500) { update({ charactersReceived: received }); checkpoint = Date.now(); }
          });
        } catch (error) { update({ state: 'unknown', error: safeError(error), charactersReceived: received }); throw error; }
        invariant(response.complete === true, 'Omni-Analysis 没有完成，禁止把部分结果当作完整分析。', 502);
        const responsePath = path.join(directory, responseFile);
        await writeFile(responsePath + '.tmp', JSON.stringify(response), 'utf8'); await rename(responsePath + '.tmp', responsePath);
        update({ state: 'response_saved', charactersReceived: response.text.length, usage: response.usage, responseId: response.responseId, receivedAt: new Date().toISOString() });
      }
      part = this.store.project(id).analysis.windows[index];
      try {
        const response = JSON.parse(await readFile(path.join(directory, part.responseFile), 'utf8'));
        invariant(response.complete === true, '保存的响应没有完整结束标记，不能把部分结果当成完整分析。', 422);
        const previous = this.store.project(id).story;
        const parsed = parseAnalysisJSON(response.text);
        const story = mergeStory(previous, parsed.value, { ...part, sourceDuration: project.source.duration });
        if (parsed.corrections.length) story.warnings.push(`第 ${index + 1} 部分的分析 JSON 有 ${parsed.corrections.length} 处格式错误，已在本地修复。仅修正引号、转义或尾随逗号，未补写资产、台词或时间；原始结果仍保留。`);
        const countAdjusted = value => [...value.shots, ...value.dialogues].filter(item => item.timingAdjustment).length;
        this.store.updateProject(id, p => {
          p.story = story;
          Object.assign(p.analysis.windows[index], { state: 'completed', error: null, errorCode: null, errorDetails: null, timingCorrections: countAdjusted(story) - countAdjusted(previous), formatCorrections: parsed.corrections, formatCorrectionSourceHash: parsed.corrections.length ? createHash('sha256').update(response.text).digest('hex') : null, completedAt: new Date().toISOString() });
        });
      } catch (error) {
        update({ state: 'parse_error', error: safeError(error), errorCode: error.code || 'local_processing', errorDetails: error.details || null });
        this.store.updateProject(id, p => { p.phase = '分析已返回，本地结果整理需处理'; });
        throw error;
      }
    }
    if (project.sourceFile && !project.sourceCuts) {
      try { const motion = await detectSourceMotion(path.join(directory, project.sourceFile)); this.store.updateProject(id, p => { p.sourceCuts = motion.cuts; p.sourceQuietPoints = motion.quietPoints; }); }
      catch { this.store.updateProject(id, p => { p.story.warnings.push('本地切镜候选检测未完成，暂按分析镜头规划。'); }); }
    }
    this.store.updateProject(id, p => { p.state = 'ready'; p.phase = '分镜与资产已就绪'; p.error = null; p.revision++; p.analysis.completedAt = new Date().toISOString(); });
  }
  async reparse(id) {
    const project = this.store.project(id);
    if (project.state === 'ready') return project;
    invariant(!this.active, '请等待当前分析处理完成后再整理本地结果。', 409);
    invariant(project.analysis.windows.some(w => ['parse_error', 'response_saved'].includes(w.state)), '没有待整理的完整分析结果；结果未知的请求仍需先核对。', 409);
    invariant(!this.stopping, '服务正在退出，请启动后重试。', 409);
    this.active = id;
    try {
      // A separate local-only path: no KEY, upload, provider instance, or model POST is needed.
      await this.process(id, { localOnly: true });
      return this.store.updateProject(id, p => {
        p.analysis.lastLocalReparse = { at: new Date().toISOString(), complete: p.state === 'ready', timingCorrections: p.analysis.windows.reduce((n, w) => n + (w.timingCorrections || 0), 0), formatCorrections: p.analysis.windows.reduce((n, w) => n + (w.formatCorrections?.length || 0), 0) };
      });
    } catch (error) {
      this.store.updateProject(id, p => { p.state = 'analysis_attention'; p.phase = '本地结果整理仍需处理'; p.error = safeError(error); });
      throw error;
    } finally { this.active = null; }
  }
  resume(id) {
    const project = this.store.project(id); this.vault.require(project.keyHash);
    invariant(project.state !== 'ready' && this.active !== id, '当前项目不需要恢复分析。', 409);
    invariant(!project.analysis.windows.some(w => ['unknown', 'submitting'].includes(w.state)), '请先核对结果未知的分析请求。', 409);
    this.store.updateProject(id, p => { p.state = 'analysis_queued'; p.error = null; }); this.pump();
  }
  retry(id, index, confirmed) {
    const project = this.store.project(id); this.vault.require(project.keyHash);
    invariant(this.active !== id && project.state !== 'ready', '请等待当前分析结束。', 409);
    const part = project.analysis.windows[index];
    invariant(part && ['unknown', 'parse_error'].includes(part.state) && confirmed === true, '需先核对平台记录，并明确确认重新调用 Omni-Analysis。', 409);
    this.store.updateProject(id, p => {
      const w = p.analysis.windows[index]; w.history = [...(w.history || []), { state: w.state, responseFile: w.responseFile, attempts: w.attempts }];
      Object.assign(w, { state: 'pending', error: null }); p.state = 'analysis_queued'; p.error = null;
    }); this.pump();
  }
  stop() { this.stopping = true; clearInterval(this.timer); }
}
