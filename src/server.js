import express from 'express';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError, invariant, safeError } from './errors.js';
import { publicJob } from './store.js';
import { receiveUpload } from './upload.js';
import { planSegments, editPrompt } from './plan.js';
import { probe, prepareImage, outputDimensions } from './media.js';
import { parseKey } from './keys.js';
import { studioRouter } from './studio-api.js';
import { instanceId } from './instance.js';
import { generationOptions } from '../public/generation-policy.js';
import { regenerateSegment } from './regenerate.js';
import { prepareComparisonVideo } from './media.js';
import { qualityWindows } from './quality.js';
import { installReconstructionAPI } from './reconstruction-api.js';
import { installLocalMaterialAPI } from './local-material-api.js';
import { runtimeEdition } from './edition.js';

export function createApp({ store, vault, engine, analysis, review, localMaterial, localRuntime, directory, port, toolsStatus, shutdown, edition=runtimeEdition }) {
  const app = express();
  let pendingWrites = 0;
  app.locals.pendingWrites = () => pendingWrites;
  app.disable('x-powered-by');
  const csrf = randomBytes(32).toString('hex');
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const uploading = new Set();
  app.use((req, res, next) => {
    if (!hosts.has(req.headers.host)) return res.status(403).json({ error: '此软件仅允许本机访问。' });
    const origin = req.get('origin');
    if (origin && ![...hosts].some(host => origin === 'http://' + host)) return res.status(403).json({ error: '不允许跨站访问本地软件。' });
    res.set({
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const token = Buffer.from(req.get('x-csrf-token') || '');
      if (token.length !== csrf.length || !timingSafeEqual(token, Buffer.from(csrf))) return res.status(403).json({ error: '页面已过期，请刷新后重试。' });
    }
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.use((req,res,next)=>{
    if(!['GET','HEAD','OPTIONS'].includes(req.method)&&req.path!=='/api/shutdown'){
      pendingWrites++;let finished=false;
      const done=()=>{if(!finished){finished=true;pendingWrites--;}};
      res.once('finish',done);res.once('close',done);
    }
    next();
  });
  app.get('/api/health', (req, res) => res.json({ app: 'wan-replace-studio', version: '2.2.9', instanceId: instanceId(directory), ...toolsStatus }));
  app.get('/api/bootstrap', (req, res) => res.json({ csrf, edition, key: vault.status(), tools: toolsStatus, analysisEnabled: !!analysis, generationOptions: generationOptions(), features: { fundingPreflight: !!engine.funding, fullDialogue: !!analysis, imageOnlyReplacement: true, characterEditModes: !!analysis, combinedCharacterReference: !!analysis, dialogueSafety: !!analysis, continuity: !!review, productScope: !!analysis, independentNarration: !!analysis, contentReview: !!review, materialReferenceRoles: !!analysis, localMaterialRepair: !!localMaterial && !!localRuntime }, limits: { maxDuration: 600, maxSegment: 15, maxVideoBytes: 2 * 1024 ** 3, maxImageBytes: 20 * 1024 ** 2 } }));
  app.get('/api/jobs/:id/narration/media',(req,res)=>{
    const job=store.get(req.params.id), relative=job.narration?.sourceFile||job.narration?.file;
    invariant(relative,'此版本尚未保存完整配音。',404);
    const root=path.join(directory,'jobs',job.id), file=path.resolve(root,relative);
    invariant(file.startsWith(path.resolve(root)+path.sep),'配音路径无效。');
    res.sendFile(file,{dotfiles:'allow'});
  });
  app.post('/api/shutdown', (req, res) => {
    invariant(typeof shutdown === 'function', '此运行环境不支持通过界面退出。', 409);
    res.json({ message: '本地服务正在退出，处理进度已保留。' });
    setImmediate(shutdown);
  });
  app.post('/api/key', async (req, res) => {
    invariant(typeof req.body?.key === 'string' && typeof req.body?.remember === 'boolean', 'KEY 参数不正确。');
    await vault.set(req.body.key, req.body.remember);
    engine.pump();
    analysis?.pump();
    res.json(vault.status());
  });
  app.delete('/api/key', async (req, res) => { await vault.clear(); res.json(vault.status()); });
  app.post('/api/key/check', async (req, res) => {
    const provider = engine.providerFactory(req.body?.key ? parseKey(req.body.key) : vault.require());
    res.json(await provider.check());
  });
  app.get('/api/funding',async(req,res)=>{
    invariant(edition==='developer','此版本不提供账户金额明细。',403);
    invariant(engine.funding,'余额检查暂缓，等待平台接口更新。',409);
    const provider=engine.providerFactory(vault.require());const balance=await provider.balance();let profile=null;
    try{const {keyHash,...visible}=await engine.funding.profile(vault.hash());profile=visible;}catch{}
    res.json({balance,profile});
  });
  app.post('/api/funding/profile',async(req,res)=>{
    invariant(edition==='developer','请由开发版维护计费配置。',403);
    invariant(engine.funding,'余额检查暂缓，等待平台接口更新。',409);vault.require();
    const {keyHash,...profile}=await engine.funding.save(req.body,vault.hash());res.json(profile);
  });
  if (analysis) app.use('/api', studioRouter({ store, vault, directory, analysis, engine, toolsStatus, review }));
  const forBrowser = job => ({ ...publicJob(job), keyMatches: job.local ? true : job.keyHash === vault.hash(), active: engine.active === job.id || localMaterial?.active?.id === job.id });
  // Old pages and retained links must never send a local job through WAN/key flows.
  app.use('/api/jobs/:id', (req, res, next) => {
    if (req.method === 'POST' && /^\/(?:pause|resume|abort|collect|quality(?:\/|$)|segments\/|reconstruction(?:\/|$))/.test(req.path)) {
      const job = store.get(req.params.id);
      invariant(!job.local && !job.recipe?.localMaterialRepair, '这是本地修复版本，请打开本地校准继续处理。', 409);
    }
    next();
  });
  installReconstructionAPI(app,{store,vault,directory,engine,toolsStatus,toPublicJob:forBrowser});
  const localAPI = localMaterial ? installLocalMaterialAPI(app,{store,directory,engine:localMaterial,runtime:localRuntime}) : null;
  app.locals.localMaterialPendingWrites = () => localAPI?.pendingWrites() || 0;
  app.get('/api/jobs', (req, res) => res.json(store.list().reverse().map(forBrowser)));
  app.get('/api/jobs/:id', (req, res) => res.json(forBrowser(store.get(req.params.id))));
  app.post('/api/jobs/:id/abort',(req,res)=>res.status(202).json(forBrowser(engine.abort(req.params.id))));
  app.post('/api/jobs/:id/collect',(req,res)=>res.status(202).json(forBrowser(engine.collect(req.params.id))));
  app.get('/api/jobs/:id/exports/:index',async(req,res)=>{
    const job=store.get(req.params.id);invariant(/^\d+$/.test(req.params.index),'视频片段不存在。',404);
    const clip=job.partialExport?.clips?.find(item=>item.index===Number(req.params.index));invariant(clip&&clip.file===`exports/clip-${clip.index}.mp4`,'该片段尚未下载整理。',404);
    if(req.query.download==='1')res.attachment(`已完成片段-${clip.index+1}-${job.id.slice(0,8)}.mp4`);
    res.sendFile(path.join(directory,'jobs',job.id,clip.file),{dotfiles:'allow'});
  });
  app.post('/api/jobs/:id/quality', (req, res) => { invariant(review && req.body?.confirmAnalysis === true, '画面检查会使用 Omni-Analysis 分析用量。'); res.json(forBrowser(review.enqueue('quality', req.params.id))); });
  app.post('/api/jobs/:id/quality/reparse', async (req, res) => { invariant(review, '检查服务未就绪。'); res.json(forBrowser(await review.reparse('quality', req.params.id))); });
  app.post('/api/jobs/:id/quality/resume', (req, res) => { invariant(review, '检查服务未就绪。'); review.resume('quality', req.params.id); res.json(forBrowser(store.get(req.params.id))); });
  app.post('/api/jobs/:id/quality/:index/retry', (req, res) => { invariant(review && /^\d+$/.test(req.params.index), '检查分段无效。'); review.retry('quality', req.params.id, Number(req.params.index), req.body?.verifiedPrevious === true && req.body?.confirmAnalysis === true); res.json(forBrowser(store.get(req.params.id))); });
  const comparisons = new Map();
  app.get('/api/jobs/:id/quality/:index/video', async (req, res) => {
    const job = store.get(req.params.id), index = Number(req.params.index), windows = qualityWindows(job);
    invariant(/^\d+$/.test(req.params.index) && job.state === 'completed' && windows[index], '检查片段不存在。', 404);
    const key = `${job.id}/${index}`;
    if (!comparisons.has(key)) comparisons.set(key, prepareComparisonVideo(path.join(directory, 'jobs', job.id), job, windows[index]).finally(() => comparisons.delete(key)));
    res.sendFile(await comparisons.get(key), { dotfiles: 'allow' });
  });
  app.post('/api/jobs/:id/segments/:index/regenerate', async (req, res) => {
    invariant(/^\d+$/.test(req.params.index) && req.body?.confirmNewCharge === true, '局部重做会提交新的 WAN 请求。');
    const id = req.body?.requestId, index = Number(req.params.index);
    invariant(typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id), '重做请求编号无效。');
    const existing = store.list().find(job => job.id === id);
    if (existing) { invariant(existing.parentJobId === req.params.id && existing.repairedSegment === index, '此编号已用于其他版本。', 409); return res.json(forBrowser(existing)); }
    invariant(!uploading.has(id), '该重做版本正在保存。', 409); uploading.add(id);
    try { const parent = store.get(req.params.id); const job = await regenerateSegment({ store, vault, directory, engine, parent, index, id, notes: req.body.notes }); res.status(201).json(forBrowser(job)); }
    finally { uploading.delete(id); }
  });
  app.post('/api/jobs', async (req, res) => {
    vault.require();
    invariant(toolsStatus.ffmpeg && toolsStatus.ffprobe, 'FFmpeg / FFprobe 未就绪，请重启启动器检查运行环境。', 503);
    const keyHash = vault.hash();
    const id = req.get('x-job-request-id') || randomUUID();
    invariant(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id), '请求编号不正确。');
    const existing = store.list().find(job => job.id === id);
    if (existing) {
      vault.require(existing.keyHash);
      req.resume();
      return res.json(forBrowser(existing));
    }
    invariant(!uploading.has(id), '同一份素材正在上传，请等待当前上传完成。', 409);
    uploading.add(id);
    const staging = path.join(directory, 'incoming', id);
    const destination = path.join(directory, 'jobs', id);
    let moved = false, persisted = false;
    try {
      await mkdir(staging, { recursive: true });
      const { fields, files } = await receiveUpload(req, staging);
      invariant(['face', 'product'].includes(fields.mode), '请选择换脸或换产品模式。');
      invariant(['wan3.0-480p', 'wan3.0-720p'].includes(fields.model), '请选择有效的清晰度。');
      invariant((fields.target || '').length <= 300 && (fields.title || '').length <= 100, '任务名称或目标说明过长。');
      const source = await probe(path.join(staging, files.video.filename));
      invariant(/(?:mov|mp4|matroska|webm|avi)/.test(source.format), '文件内容不是受支持的视频容器。');
      invariant(source.width <= 8192 && source.height <= 8192 && Math.max(source.width / source.height, source.height / source.width) <= 8, '视频单边不能超过 8192 像素，宽高比须在 1:8 到 8:1 之间。');
      const segments = planSegments(source.duration);
      const reference = await prepareImage(path.join(staging, files.image.filename), path.join(staging, 'reference.png'));
      vault.require(keyHash);
      await mkdir(path.dirname(destination), { recursive: true });
      await rename(staging, destination);
      moved = true;
      const now = new Date().toISOString();
      const job = {
        id, created: now, updated: now, title: fields.title?.trim() || files.video.name,
        mode: fields.mode, model: fields.model, target: fields.target?.trim() || '', keyHash,
        sourceFile: files.video.filename, sourceName: files.video.name, imageName: files.image.name,
        sourceBytes: files.video.bytes, source, reference, output: outputDimensions(source, fields.model),
        state: 'queued', phase: '等待处理', pauseRequested: false, prepared: false,
        segments, generationOptions: generationOptions(), error: null, events: [{ at: now, message: `已创建${fields.mode === 'face' ? '换脸' : '产品替换'}任务，计划 ${segments.length} 段。` }],
      };
      store.create(job);
      persisted = true;
      res.status(201).json(forBrowser(job));
      engine.pump();
    } catch (error) {
      // Only the fresh, generated UUID directory belonging to this failed request is removed.
      if (!persisted) await rm(moved ? destination : staging, { recursive: true, force: true });
      throw error;
    } finally {
      uploading.delete(id);
    }
  });
  app.post('/api/jobs/:id/pause', (req, res) => res.json(forBrowser(engine.pause(req.params.id))));
  app.post('/api/jobs/:id/resume', (req, res) => res.json(forBrowser(engine.resume(req.params.id))));
  app.post('/api/jobs/:id/segments/:index/bind', async (req, res) => {
    invariant(/^\d+$/.test(req.params.index) && typeof req.body?.taskId === 'string', '分段或任务 ID 不正确。');
    await engine.bindTask(req.params.id, Number(req.params.index), req.body.taskId.trim());
    res.json(forBrowser(store.get(req.params.id)));
  });
  app.post('/api/jobs/:id/segments/:index/retry', async (req, res) => {
    invariant(/^\d+$/.test(req.params.index) && req.body?.confirmNewCharge === true, '重新生成需要确认新的平台调用。');
    await engine.retryFailed(req.params.id, Number(req.params.index));
    res.json(forBrowser(store.get(req.params.id)));
  });
  app.get('/api/jobs/:id/prompt', (req, res) => {
    const job = store.get(req.params.id);
    res.type('text/plain').send(job.workflow === 'studio' ? job.segments.map(s => `分段 ${s.index + 1}\n${s.prompt}`).join('\n\n') : editPrompt(job.mode, job.target, job.segments[0]));
  });
  app.get('/api/jobs/:id/receipt', (req, res) => {
    const job = store.get(req.params.id);
    res.attachment('wan-edit-receipt.json').json(publicJob(job));
  });
  app.get('/api/jobs/:id/media/:kind', async (req, res) => {
    const job = store.get(req.params.id);
    const map = { source: job.sourceFile, reference: 'reference.png', result: 'result.mp4',partial:'partial-result.mp4' };
    invariant(Object.hasOwn(map, req.params.kind), '素材不存在。', 404);
    const file = map[req.params.kind];
    invariant(file, '素材不存在。', 404);
    if (req.params.kind === 'result') invariant(job.state === 'completed', '成片尚未完成。', 404);
    if (req.params.kind === 'partial') invariant(job.partialExport?.state==='ready','尚无可导出的已完成视频。',404);
    const location = path.join(directory, 'jobs', job.id, file);
    try { await stat(location); } catch { throw new AppError('素材文件不存在。', 404); }
    if (req.query.download === '1') res.attachment((req.params.kind === 'partial' ? '已完成内容' : job.workflow === 'studio' ? '视频编辑' : job.mode === 'face' ? '换脸' : '换产品') + '-' + job.id.slice(0, 8) + '.mp4');
    // Only the three named job artifacts above are reachable. Hidden workspace/data folders are valid.
    res.sendFile(location, { dotfiles: 'allow' });
  });
  const publicRoot = path.resolve(import.meta.dirname, '..', 'public');
  // Resolve only these known pages under a root. Parent folders may contain dots;
  // hidden request paths remain protected by Express's default dotfile policy.
  if (analysis) app.get('/', (req, res) => {if(edition==='user')return res.sendFile('user.html',{root:publicRoot});return res.sendFile('studio.html', { root: publicRoot });});
  app.get('/legacy', (req, res) => {if(edition==='user')return res.sendFile('user-quick.html',{root:publicRoot});return res.sendFile('index.html', { root: publicRoot });});
  app.use(express.static(publicRoot, { etag: true, maxAge: 0 }));
  app.use((req, res) => res.status(404).json({ error: '接口不存在。' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error instanceof AppError ? error.status : error.type === 'entity.too.large' ? 413 : error instanceof SyntaxError ? 400 : 500;
    res.status(status).json({ error: safeError(error), code: error instanceof AppError ? error.code : 'local_error' });
  });
  return app;
}
