import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, copyFile, rename, readFile, writeFile, rm, access, readdir } from 'node:fs/promises';
import { AppError, invariant, safeError } from './errors.js';
import * as media from './media.js';
import { propRole } from '../public/prop-role.js';
import { LOCAL_MATERIAL_VERSION, LOCAL_MATERIAL_POLICY, localUUID, localObject, normalizeLocalRanges, normalizeLocalCalibration, normalizeSourceSkinReference, normalizeLocalOcclusionReconstruction, normalizeLocalAppearanceReconstruction, localCalibrationReady, validateLocalWorkerResult } from './local-material-contract.js';

const creating = new Map();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const localPath = (root, relative) => {
  invariant(typeof relative === 'string' && relative && !path.isAbsolute(relative), '本地修复文件路径无效。');
  const file = path.resolve(root, relative); invariant(file.startsWith(path.resolve(root) + path.sep), '本地修复文件必须位于当前任务目录。'); return file;
};
const atomicJSON = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); const temp = file + '.' + randomUUID() + '.tmp'; await writeFile(temp, JSON.stringify(value, null, 2)); await rename(temp, file); };
async function runtimeRecord(runtime) {
  if (!runtime?.executable || !runtime.workerFile || !runtime.manifestFile) return { ready: false, version: 'not-installed' };
  invariant([runtime.executable, runtime.workerFile, runtime.manifestFile].every(path.isAbsolute), 'CPU运行包须使用捆绑的绝对路径。');
  await Promise.all([access(runtime.executable), access(runtime.workerFile), access(runtime.manifestFile)]);
  const workerFiles = [{ file: '<entrypoint>', sha256: await media.fileSHA256(runtime.workerFile) }];
  if (runtime.workerDirectory) {
    invariant(path.isAbsolute(runtime.workerDirectory), 'CPU处理模块必须位于捆绑的绝对目录。');
    const visit = async relative => {
      const folder = relative ? localPath(runtime.workerDirectory, relative) : runtime.workerDirectory;
      for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === '__pycache__') continue;
        invariant(!entry.isSymbolicLink(), 'CPU处理模块目录不能包含外部链接。', 503);
        const file = relative ? path.join(relative, entry.name) : entry.name;
        if (entry.isDirectory()) await visit(file);
        else if (entry.isFile() && entry.name.endsWith('.py')) workerFiles.push({ file: file.replaceAll('\\', '/'), sha256: await media.fileSHA256(localPath(runtime.workerDirectory, file)) });
      }
    };
    await visit('');
  }
  const models = {};
  for (const key of ['face', 'hand']) {
    const file = runtime.models?.[key]?.file; invariant(file && path.isAbsolute(file), '本地人脸或手部模型尚未安装。', 503);
    models[key] = { file, sha256: await media.fileSHA256(file) };
    if (runtime.models[key].sha256) invariant(models[key].sha256 === runtime.models[key].sha256, 'CPU模型校验失败。', 503);
  }
  return { ready: true, version: runtime.version || 'local-worker-v1', manifestSHA256: await media.fileSHA256(runtime.manifestFile), workerSHA256: hash(workerFiles), workerFiles, models };
}

async function tracedSource(store, directory, parent) {
  let current = parent; const visited = new Set();
  for (let count = 0; count < 100; count++) {
    invariant(localUUID(current.id) && !visited.has(current.id), '原视频来源链不完整，请导入真正的原视频。', 409); visited.add(current.id);
    if (current.recipe?.localMaterialRepair?.sourceNative) {
      const saved = current.recipe.localMaterialRepair.sourceNative;
      return { file: localPath(path.join(directory, 'jobs', current.id), saved.file), expectedSHA: saved.sha256, provenance: { kind: 'frozen_original', jobId: current.id } };
    }
    if (current.parentJobId) { current = store.get(current.parentJobId); continue; }
    if (current.workflow === 'studio' && !current.recipe?.actionRebuild && current.sourceFile && current.sourceFile !== 'base.mp4') return {
      file: localPath(path.join(directory, 'jobs', current.id), current.sourceFile), expectedSHA: current.sourceSHA256, provenance: { kind: 'initial_studio', jobId: current.id } };
    break;
  }
  if (parent.projectId) {
    const project = store.project(parent.projectId);
    if (project.sourceFile) return { file: localPath(path.join(directory, 'projects', project.id), project.sourceFile), expectedSHA: project.sourceSHA256,
      provenance: { kind: 'project_original', projectId: project.id } };
  }
  throw new AppError('未找到真正的原视频。当前派生成片不能替代原片，请导入原视频后继续。', 409, 'local_original_missing');
}
async function freezeSource(root, source, suffix) {
  const inputSHA = await media.fileSHA256(source.file);
  if (source.expectedSHA) invariant(inputSHA === source.expectedSHA, '原视频与保存的来源SHA不一致，请重新核对。', 409);
  const nativeFile = `inputs/source-${suffix}${path.extname(source.file) || '.mp4'}`, file = `inputs/original-${suffix}.mp4`;
  await copyFile(source.file, localPath(root, nativeFile));
  const nativeInfo = await media.probe(localPath(root, nativeFile));
  const frames = Math.round(nativeInfo.duration * 30);
  invariant(Number.isInteger(frames) && frames > 0 && frames <= 18000, '原视频时长无效。');
  await media.ffmpeg(['-xerror', '-protocol_whitelist', 'file,pipe', '-i', localPath(root, nativeFile), '-map', '0:v:0', '-an',
    '-vf', 'setpts=PTS-STARTPTS,fps=30,pad=ceil(iw/2)*2:ceil(ih/2)*2,setsar=1', '-frames:v', String(frames), '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv420p', localPath(root, file)]);
  const info = await media.probe(localPath(root, file)); invariant(info.frames === frames, '原片规范化未覆盖全部帧。', 422);
  return { sourceNative: { file: nativeFile, sha256: inputSHA, ...nativeInfo, provenance: source.provenance, knownHashVerified: source.expectedSHA ? true : null },
    source: { file, sha256: await media.fileSHA256(localPath(root, file)), ...info, fps: 30, transformation: 'native-timeline-sampled-at-30fps; even-canvas-pad' } };
}
async function freezeDonor(root, donor, base, suffix) {
  if (!donor) return null;
  const file = `inputs/donor-${suffix}.png`;
  if (donor.file) await copyFile(donor.file, localPath(root, file));
  else {
    invariant(Number.isInteger(donor.frameIndex) && donor.frameIndex >= 0 && donor.frameIndex < base.frames, '请选目标人物自己的有效干净帧。');
    await media.ffmpeg(['-i', localPath(root, base.file), '-vf', `select=eq(n\\,${donor.frameIndex})`, '-frames:v', '1', '-update', '1', localPath(root, file)]);
  }
  const info = await media.probe(localPath(root, file)); invariant(info.codec === 'png', '清肤参考须为处理后的PNG。');
  return { file, sha256: await media.fileSHA256(localPath(root, file)), width: info.width, height: info.height, origin: donor.file ? 'target-own-upload' : 'target-own-base-frame', frameIndex: donor.frameIndex ?? null };
}

export async function createLocalMaterialDraft(options) {
  const { directory, id } = options; invariant(path.isAbsolute(directory) && localUUID(id), '本地修复请求编号无效。');
  const key = path.join(directory, 'jobs', id);
  if (creating.has(key)) { await creating.get(key); return createLocalMaterialDraft(options); }
  const promise = createDraft(options); creating.set(key, promise);
  try { return await promise; } finally { if (creating.get(key) === promise) creating.delete(key); }
}
async function createDraft({ store, directory, parent, id, sourceUpload, donor, sourceActorId, targetActorId, materialAssetId, ranges, runtime, sourceSkinReference, sourceOcclusionReconstruction, appearanceReconstruction }) {
  const appearance = normalizeLocalAppearanceReconstruction(appearanceReconstruction);
  invariant(localUUID(parent?.id) && parent.state === 'completed' && parent.workflow === 'studio', '请选择已完成的编辑成片。', 409);
  const existing = store.list().find(job => job.id === id);
  if (existing) { invariant(existing.parentJobId === parent.id && existing.recipe?.localMaterialRepair, '请求编号已用于其他版本。', 409); return existing; }
  const assets = parent.recipe?.story?.assets || [];
  invariant([sourceActorId, targetActorId].every(id => typeof id === 'string' && assets.some(asset => asset.id === id && asset.type === 'character'))
    && assets.some(asset => asset.id === materialAssetId && propRole(asset, parent.recipe.edits?.assets?.[asset.id]) === 'material'), '请明确原片人物、目标人物和膏体材质。');
  const root = localPath(path.join(directory, 'jobs'), id); let owned = false, saved = false;
  try {
    const original = sourceUpload ? { file: sourceUpload.file, expectedSHA: sourceUpload.sha256, provenance: { kind: 'user_original_upload', uploadId: sourceUpload.id } } : await tracedSource(store, directory, parent);
    await mkdir(root); owned = true; await mkdir(path.join(root, 'inputs'));
    await copyFile(localPath(path.join(directory, 'jobs', parent.id), 'result.mp4'), path.join(root, 'base.mp4'));
    const info = await media.probe(path.join(root, 'base.mp4'));
    invariant(Number.isInteger(info.frames) && Math.abs(info.duration - info.frames / 30) < 0.06, '目标成片必须有完整30帧时间轴。', 422);
    const base = { file: 'base.mp4', sha256: await media.fileSHA256(path.join(root, 'base.mp4')), ...info, fps: 30 };
    const source = await freezeSource(root, original, 'r0'), targetSkin = await freezeDonor(root, donor, base, 'r0');
    const spec = { version: LOCAL_MATERIAL_VERSION, policy: LOCAL_MATERIAL_POLICY, ...source, base, donor: targetSkin,
      sourceSkinReference: normalizeSourceSkinReference(sourceSkinReference, source.source),
      actors: { sourceActorId, targetActorId, materialAssetId }, ranges: normalizeLocalRanges(ranges, source.source, base), runtime: await runtimeRecord(runtime),
      processing: { materialSignal: 'same-frame-visible-colour-residual', targetMaterialCandidateMethod: 'reviewed-region-or-own-donor-relative-residual-v1', targetMaterialCandidateIsGroundTruth: false,
        temporalMaterialFade: false, sourceActorRGBPaste: false, sourceOcclusionReconstruction: normalizeLocalOcclusionReconstruction(sourceOcclusionReconstruction), appearanceReconstruction: appearance, outsideROI: 'exact-base-before-encode', outputCodec: 'h264-high-yuv420p' }, cost: { providerCalls: 0 }, audioPolicy: 'preserve-base-packets' };
    spec.calibration = normalizeLocalCalibration({}, spec.ranges);
    const now = new Date().toISOString(), job = { id, parentJobId: parent.id, projectId: parent.projectId, title: parent.title + ' · 保留原片真实涂抹',
      created: now, updated: now, workflow: 'studio', mode: 'local_material', model: 'local-cpu', state: 'needs_calibration', sourceFile: 'base.mp4', source: info,
      output: { width: info.width, height: info.height }, recipe: { ...structuredClone(parent.recipe), localMaterialRepair: spec }, billableSeconds: 0, audioMode: 'original', error: null,
      local: { revision: 0, state: 'needs_calibration', progress: null, riskFrames: [], history: [], media: {} },
      segments: [{ index: 0, frames: info.frames, start: 0, duration: info.frames / 30, state: 'local_pending', generationMode: 'local_material', bindings: [] }],
      events: [{ at: now, message: '已分别冻结真正原视频与已编辑成片。本地处理不使用KEY、不调用云生成；请校准手部遮挡与源材料区域。' }] };
    store.create(job); saved = true; return job;
  } finally { if (owned && !saved) await rm(root, { recursive: true, force: true }); }
}

export async function updateLocalCalibration({ store, directory, id, revision, input, resolveUpload }) {
  const job = store.get(id); invariant(job.recipe?.localMaterialRepair && job.local.revision === revision && job.local.state !== 'confirmed', '校准版本已变化或成片已确认，请重新读取。', 409);
  localObject(input, ['revision', 'ranges', 'calibration', 'donor', 'sourceUploadId', 'sourceSkinReference', 'sourceOcclusionReconstruction', 'appearanceReconstruction'], '校准更新');
  const root = localPath(path.join(directory, 'jobs'), id), spec = structuredClone(job.recipe.localMaterialRepair), next = revision + 1;
  const appearance = normalizeLocalAppearanceReconstruction(Object.hasOwn(input, 'appearanceReconstruction')
    ? input.appearanceReconstruction : { enabled: spec.processing.appearanceReconstruction?.enabled === true });
  if (input.sourceUploadId) { const uploaded = await resolveUpload(input.sourceUploadId, 'source'); Object.assign(spec, await freezeSource(root, { file: uploaded.file, expectedSHA: uploaded.sha256, provenance: { kind: 'user_original_upload', uploadId: uploaded.id } }, `r${next}`)); }
  if (Object.hasOwn(input, 'donor')) {
    localObject(input.donor, ['uploadId', 'frameIndex'], '目标清肤参考');
    invariant((input.donor.uploadId !== undefined) !== (input.donor.frameIndex !== undefined), '请选择清肤上传图或目标自身帧之一。');
    const supplied = input.donor.uploadId ? await resolveUpload(input.donor.uploadId, 'donor') : input.donor;
    spec.donor = await freezeDonor(root, supplied, spec.base, `r${next}`);
  }
  spec.ranges = normalizeLocalRanges(input.ranges || spec.ranges, spec.source, spec.base);
  spec.sourceSkinReference = normalizeSourceSkinReference(Object.hasOwn(input, 'sourceSkinReference') ? input.sourceSkinReference : input.sourceUploadId ? null : spec.sourceSkinReference, spec.source);
  spec.calibration = normalizeLocalCalibration(input.calibration || {}, spec.ranges);
  spec.processing.targetMaterialCandidateMethod = 'reviewed-region-or-own-donor-relative-residual-v1';
  spec.processing.targetMaterialCandidateIsGroundTruth = false;
  spec.processing.sourceOcclusionReconstruction = normalizeLocalOcclusionReconstruction(Object.hasOwn(input, 'sourceOcclusionReconstruction')
    ? input.sourceOcclusionReconstruction : { enabled: spec.processing.sourceOcclusionReconstruction?.enabled === true });
  spec.processing.appearanceReconstruction = appearance;
  for (const [index, frame] of spec.calibration.handKeyframes.entries()) if (frame.uploadId) {
    const mask = await resolveUpload(frame.uploadId, 'mask'), dimensions = frame.side === 'source' ? spec.source : spec.base;
    invariant(mask.width === dimensions.width && mask.height === dimensions.height, '手部mask尺寸必须与对应原片或目标帧一致。');
    const file = `inputs/mask-r${next}-${index}.png`; await copyFile(mask.file, localPath(root, file)); frame.mask = { file, sha256: await media.fileSHA256(localPath(root, file)), width: mask.width, height: mask.height };
  }
  invariant(store.get(id).local.revision === revision, '校准已被其他操作修改，请重新读取。', 409);
  return store.update(id, current => {
    current.local.history.push({ revision, inputHash: hash(current.recipe.localMaterialRepair), preview: current.local.preview || null });
    current.recipe.localMaterialRepair = spec; current.local.revision = next; current.local.state = 'needs_calibration'; current.state = 'needs_calibration';
    current.local.riskFrames = []; current.local.progress = null; delete current.local.preview; delete current.local.requestHash; current.error = null;
  });
}

export function runLocalWorker({ runtime, requestFile, resultFile, outputDirectory, cancelFile, signal, onProgress, spawnProcess = spawn }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new AppError('本地处理已取消。', 409, 'local_cancelled')); return; }
    const child = spawnProcess(runtime.executable, ['-X', 'utf8', '-I', '-B', runtime.workerFile, '--request', requestFile, '--result', resultFile, '--output-dir', outputDirectory, '--cancel-file', cancelFile],
      { windowsHide: true, cwd: outputDirectory, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    let pending = '', diagnostics = ''; const timer = setTimeout(() => { child.kill(); }, 1800000);
    const abort = () => child.kill(); signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', data => { pending += data; if (pending.length >= 1000000) { child.kill(); pending = ''; return; }
      let newline; while ((newline = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, newline); pending = pending.slice(newline + 1); try { onProgress?.(JSON.parse(line)); } catch {} } });
    child.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-4000); });
    child.on('error', () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new AppError('捆绑CPU运行器未能启动，请检查安装完整性。', 503)); });
    child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(new AppError('本地处理已取消，校准和缓存保留。', 409, 'local_cancelled'));
      else if (code) reject(new AppError('CPU运行器未完成，输入和缓存已保留。' + diagnostics.slice(-500), 422, 'local_worker_failed'));
      else resolve(); });
  });
}

export class LocalMaterialEngine {
  constructor({ store, directory, runtime, runner = runLocalWorker }) { Object.assign(this, { store, directory, runtime, runner }); this.active = null; this.stopping = false; }
  start() {
    for (const job of this.store.list().filter(job => job.local?.state === 'processing')) this.store.update(job.id, current => { current.local.state = 'paused'; current.state = 'local_paused'; current.error = '本地处理上次中断，可恢复；不会提交云生成。'; });
    this.timer = setInterval(() => this.pump(), 1000); this.timer.unref(); this.pump();
  }
  enqueue(id, revision, action) {
    const job = this.store.get(id); invariant(job.local && job.local.revision === revision && job.local.state !== 'confirmed' && ['analyse', 'render'].includes(action), '本地修复版本或操作无效。', 409);
    if (action === 'render') invariant(localCalibrationReady(job.recipe.localMaterialRepair), '请标明材料转移或保留原画面的镜头；材料镜头须完成区域、至少四个源裸肤点、同镜头绘制帧与双方手部mask、目标自身清肤参考确认。手工配对请保存为画面对应锚点，逐帧对应表须覆盖完整目标范围且不能跨镜头。启用艺术重建时，每个授权区域须至少三个点、已人工核对且位于材料镜头的精确目标帧；关闭后区域可保留编辑但不参与处理。仅保留原画面时须有已核对的局部清理。', 422);
    invariant(!['processing', 'local_queued'].includes(job.local.state), '这份本地修复正在处理。', 409);
    const result = this.store.update(id, current => { current.local.action = action; current.local.state = 'local_queued'; current.state = 'local_queued'; current.error = null; }); this.pump(); return result;
  }
  async cancel(id) {
    const job = this.store.get(id); invariant(job.local && job.local.state !== 'confirmed', '本地修复不能取消。', 409);
    if (this.active?.id === id) { await writeFile(this.active.cancelFile, 'cancel'); this.active.controller.abort(); }
    return this.store.update(id, current => { current.local.state = 'paused'; current.state = 'local_paused'; });
  }
  resume(id, revision) { const job = this.store.get(id); return this.enqueue(id, revision, job.local.action || 'analyse'); }
  async pump() {
    if (this.active || this.stopping) return;
    const job = this.store.list().find(job => job.local?.state === 'local_queued'); if (!job) return;
    this.active = { id: job.id, controller: new AbortController(), cancelFile: localPath(path.join(this.directory, 'jobs', job.id), 'local-cancel.flag') };
    try { await this.process(job.id, this.active); }
    catch (error) { if (this.store.get(job.id).local.revision === job.local.revision) this.store.update(job.id, current => { current.local.state = error.code === 'local_cancelled' ? 'paused' : 'needs_calibration'; current.state = error.code === 'local_cancelled' ? 'local_paused' : 'needs_calibration'; current.error = safeError(error); }); }
    finally { this.active = null; if (!this.stopping) setImmediate(() => this.pump()); }
  }
  async process(id, control) {
    const job = this.store.get(id), revision = job.local.revision, spec = structuredClone(job.recipe.localMaterialRepair), root = localPath(path.join(this.directory, 'jobs'), id);
    spec.processing.appearanceReconstruction = normalizeLocalAppearanceReconstruction({ enabled: spec.processing.appearanceReconstruction?.enabled === true });
    spec.calibration.appearanceKeyframes ??= [];
    spec.runtime = await runtimeRecord(this.runtime); invariant(spec.runtime.ready, '本地CPU运行包尚未安装，已保留校准草稿。', 503);
    if (control.controller.signal.aborted || this.stopping) return;
    const action = job.local.action, requestHash = hash({ action, revision, spec });
    const folder = localPath(root, 'local-cache/' + requestHash); await mkdir(folder, { recursive: true }); await rm(control.cancelFile, { force: true });
    const absolute = reference => reference ? { ...reference, file: localPath(root, reference.file) } : null;
    for (const reference of [spec.sourceNative, spec.source, spec.base, spec.donor, ...spec.calibration.handKeyframes.map(frame => frame.mask)].filter(Boolean)) invariant(await media.fileSHA256(localPath(root, reference.file)) === reference.sha256, '冻结视频、清肤参考或mask已变化，已停止本地处理。', 409);
    const request = { schemaVersion: LOCAL_MATERIAL_VERSION, action, jobId: id, revision, requestHash, sourceVideo: absolute(spec.source), baseVideo: absolute(spec.base),
      frameRanges: spec.ranges, actors: spec.actors, targetSkin: absolute(spec.donor), calibration: { ...spec.calibration, handKeyframes: spec.calibration.handKeyframes.map(frame => ({ ...frame, ...(frame.mask ? { mask: absolute(frame.mask) } : {}) })) },
      sourceSkinReference: spec.sourceSkinReference, processing: spec.processing,
      runtime: spec.runtime, outputDirectory: folder, outputClipFile: path.join(folder, 'visual.mp4'), cancelFile: control.cancelFile };
    const requestFile = path.join(folder, 'request.json'), resultFile = path.join(folder, 'result.json');
    await atomicJSON(requestFile, request);
    this.store.update(id, current => { current.recipe.localMaterialRepair.runtime = spec.runtime; current.local.state = 'processing'; current.state = 'local_processing'; current.local.requestHash = requestHash; });
    let raw;
    try { raw = JSON.parse(await readFile(resultFile, 'utf8')); } catch {}
    if (!raw) {
      if (control.controller.signal.aborted || this.stopping || this.store.get(id).local.revision !== revision) return;
      await this.runner({ runtime: this.runtime, request, requestFile, resultFile, outputDirectory: folder, cancelFile: control.cancelFile, signal: control.controller.signal,
        onProgress: value => { if (this.store.get(id).local.revision === revision && typeof value?.phase === 'string') this.store.update(id, current => {
          const totalFrames = Number.isInteger(value.totalFrames) && value.totalFrames > 0 && value.totalFrames <= 36000 ? value.totalFrames : request.frameRanges.target.frames;
          current.local.progress = { phase: value.phase.slice(0, 120), processedFrames: Number.isInteger(value.processedFrames) ? Math.min(totalFrames, Math.max(0, value.processedFrames)) : 0, totalFrames };
        }); } });
      if (control.controller.signal.aborted || this.store.get(id).local.revision !== revision) return;
      raw = JSON.parse(await readFile(resultFile, 'utf8'));
    }
    if (control.controller.signal.aborted || this.store.get(id).local.revision !== revision) return;
    const result = validateLocalWorkerResult(raw, request);
    const inside = file => { const relative = path.relative(folder, file); return localPath(folder, relative); };
    let preview;
    if (result.status === 'preview_ready') {
      const clip = path.join(folder, 'normalized-local.mp4');
      if (Array.isArray(result.frames) && result.frames.length === spec.ranges.target.frames) {
        const list = result.frames.slice().sort((a, b) => a.targetFrame - b.targetFrame);
        for (const [index, frame] of list.entries()) {
          invariant(frame.targetFrame === spec.ranges.target.startFrame + index, '本地结果缺少连续真实目标帧。', 422);
          const frameFile = inside(frame.file); if (frame.sha256) invariant(await media.fileSHA256(frameFile) === frame.sha256, '本地结果帧与缓存SHA不一致。', 409);
          await copyFile(frameFile, path.join(folder, `render-${String(index).padStart(6, '0')}.png`));
        }
        await media.ffmpeg(['-framerate', '30', '-i', path.join(folder, 'render-%06d.png'), '-an', '-frames:v', String(list.length), '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv420p', clip]);
      } else { invariant(result.localClip?.file, '本地渲染未返回完整帧或视频。', 422); const incoming = inside(result.localClip.file), info = await media.probe(incoming);
        invariant(info.frames === spec.ranges.target.frames && info.width === spec.base.width && info.height === spec.base.height, '本地视频帧数或尺寸不正确。', 422);
        await media.ffmpeg(['-i', incoming, '-map', '0:v:0', '-an', '-vf', 'setpts=N/(30*TB),setsar=1', '-frames:v', String(info.frames), '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv420p', clip]); }
      const clipInfo = await media.probe(clip); invariant(clipInfo.width === spec.base.width && clipInfo.height === spec.base.height && clipInfo.frames === spec.ranges.target.frames, '本地帧输出尺寸不正确。', 422);
      const parts = [], range = spec.ranges.target;
      if (range.startFrame) parts.push({ startFrame: 0, frames: range.startFrame, generationMode: 'base_copy' });
      parts.push({ startFrame: range.startFrame, frames: range.frames, generationMode: 'local_material_clip' });
      if (range.startFrame + range.frames < spec.base.frames) parts.push({ startFrame: range.startFrame + range.frames, frames: spec.base.frames - range.startFrame - range.frames, generationMode: 'base_copy' });
      const composeFolder = path.join(folder, 'composition'); await mkdir(path.join(composeFolder, 'segments'), { recursive: true });
      await copyFile(localPath(root, spec.base.file), path.join(composeFolder, 'base.mp4'));
      const movie = { sourceFile: 'base.mp4', source: spec.base, output: { width: spec.base.width, height: spec.base.height }, audioMode: 'original',
        recipe: { actionRebuild: { localOnly: true } }, segments: parts.map((part, index) => ({ ...part, index, start: part.startFrame / 30, duration: part.frames / 30, state: 'completed' })) };
      for (const part of movie.segments) if (part.generationMode === 'base_copy') await media.prepareBaseCopy(composeFolder, movie, part); else await copyFile(clip, path.join(composeFolder, 'segments', `output-${part.index}.mp4`));
      await media.assemble(composeFolder, movie);
      const file = `local-cache/${requestHash}/preview.mp4`, tempPreview = localPath(root, file) + '.partial.mp4';
      // Keep lossless intermediate evidence; deliver normal High/yuv420p for
      // target-player compatibility rather than claiming compressed bit equality.
      // The lossless picture already has the frozen frame count. An output
      // -frames:v cap can stop muxing before the base's final AAC packets;
      // read its complete accepted audio directly and verify picture after EOF.
      await media.ffmpeg(['-xerror', '-i', path.join(composeFolder, 'result.mp4'), '-i', localPath(root, spec.base.file), '-map', '0:v:0', '-map', '1:a:0?', '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-video_track_timescale', '15360', '-movflags', '+faststart', tempPreview]);
      await media.ffmpeg(['-xerror', '-i', tempPreview, '-f', 'null', '-']);
      const finalInfo = await media.probe(tempPreview); invariant(finalInfo.frames === spec.base.frames && finalInfo.hasAudio === spec.base.hasAudio, '本地交付编码未保持完整时间轴或原音。', 422);
      let audioPacketMD5 = null;
      if (spec.base.hasAudio) {
        const digest = async file => (await media.ffmpeg(['-i', file, '-map', '0:a:0', '-c:a', 'copy', '-f', 'md5', '-'])).trim();
        audioPacketMD5 = await digest(tempPreview);
        invariant(audioPacketMD5 === await digest(localPath(root, spec.base.file)) && Math.abs(finalInfo.audioOffset - spec.base.audioOffset) < .001,
          '本地交付未保持完整原音包或声画偏移，已保留输入和诊断缓存。', 422);
      }
      await rename(tempPreview, localPath(root, file));
      preview = { file, sha256: await media.fileSHA256(localPath(root, file)), ...finalInfo, revision, requestHash,
        encoding: { codec: 'h264', profile: 'high', pixelFormat: 'yuv420p', exactnessStage: 'worker-PNG-before-colour-conversion-and-delivery-encoding', audio: 'base-packets-copy', audioPacketMD5 } };
    }
    const rawArtifacts = Array.isArray(result.artifacts) ? result.artifacts : [...(result.artifacts?.frames || []), ...(result.artifacts?.diagnostics || [])];
    const artifacts = rawArtifacts.filter(artifact => artifact?.file).map((artifact, index) => {
      const kind = String(artifact.kind || 'frame').replace(/[^a-z0-9_-]/gi, '-').slice(0, 50), side = ['source', 'target'].includes(artifact.side) ? artifact.side : 'target';
      const declaredFrame = artifact.frameIndex ?? artifact.targetFrame;
      const frameIndex = Number.isInteger(declaredFrame) && declaredFrame >= 0 ? declaredFrame : index;
      const mapped = { ...artifact, id: `r${revision}-${kind}-${side}-${frameIndex}-${index}`, file: path.relative(root, inside(artifact.file)) };
      if (kind.startsWith('appearance_')) mapped.isGroundTruth = false;
        if (artifact.cleanupBoundaryFile) mapped.cleanupBoundaryFile = path.relative(root, inside(artifact.cleanupBoundaryFile));
        if (artifact.cleanupBoundaryReconstruction) mapped.cleanupBoundaryReconstruction = { ...artifact.cleanupBoundaryReconstruction, isGroundTruth: false };
      if (artifact.appearanceReconstruction) mapped.appearanceReconstruction = { ...artifact.appearanceReconstruction,
        method: spec.processing.appearanceReconstruction.method, isGroundTruth: false, temporalFade: false };
      if (artifact.appearanceArtifacts) mapped.appearanceArtifacts = Object.fromEntries(Object.entries(artifact.appearanceArtifacts).map(([field, file]) => {
        invariant(['requestedPatchFile', 'acceptedPatchFile', 'reviewedRegionFile', 'currentMeasuredFile', 'timeInferredBoundaryFile', 'timeInferredPatchFile',
          'harmonicInferredFile', 'remainingUnknownFile', 'rejectedPatchFile', 'oldHandOverrideFile', 'evidenceFile'].includes(field), '艺术重建诊断字段无效。', 422);
        return [field, path.relative(root, inside(file))];
      }));
      return mapped;
    });
    if (control.controller.signal.aborted || this.store.get(id).local.revision !== revision) return;
    this.store.update(id, current => { current.recipe.localMaterialRepair.runtime = spec.runtime; current.local.state = result.status; current.state = result.status;
      current.local.riskFrames = result.riskFrames; current.local.artifacts = artifacts; current.local.result = { checks: result.checks || {}, requestHash, revision,
        appearanceReconstruction: { ...result.artifacts?.appearanceReconstruction, ...spec.processing.appearanceReconstruction } };
      if (preview) current.local.preview = preview; current.local.progress = null; current.error = null; });
  }
  async confirm(id, revision, confirmed) {
    const job = this.store.get(id); invariant(confirmed === true && job.local?.revision === revision && job.local.state === 'preview_ready' && job.local.preview?.revision === revision
      && !job.local.riskFrames.some(risk => risk.resolved !== true), '请先校准并完整预览当前版本，再确认局部效果。', 409);
    const root = localPath(path.join(this.directory, 'jobs'), id), preview = job.local.preview;
    invariant(await media.fileSHA256(localPath(root, preview.file)) === preview.sha256, '预览视频已变化，不能沿用旧验收。', 409);
    await copyFile(localPath(root, preview.file), path.join(root, 'result.partial.mp4')); await rename(path.join(root, 'result.partial.mp4'), path.join(root, 'result.mp4'));
    return this.store.update(id, current => { current.local.state = 'confirmed'; current.state = 'completed'; current.result = preview; current.completedAt = new Date().toISOString();
      current.local.confirmedAt = current.completedAt; current.segments[0].state = 'completed'; current.quality = { version: 3, state: 'completed', verdict: 'uncertain', contentState: 'unverified', localUserConfirmed: true }; });
  }
  async stop() {
    this.stopping = true; clearInterval(this.timer); if (this.active) await this.cancel(this.active.id);
    while (this.active) await new Promise(resolve => setTimeout(resolve, 10));
  }
}
