import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { invariant } from './errors.js';
import { studioUpload } from './studio-upload.js';
import { probe, prepareImage, fileSHA256 } from './media.js';
import { localUUID, localObject, normalizeLocalAppearanceReconstruction } from './local-material-contract.js';
import { localPath, createLocalMaterialDraft, updateLocalCalibration } from './local-material.js';

/** Install behind createApp's localhost/CSRF middleware. No vault or provider. */
export function installLocalMaterialAPI(app, { store, directory, engine, runtime }) {
  const saving = new Set();
  let pendingWrites = 0;
  const tracked = handler => async (req, res) => { pendingWrites++; try { await handler(req, res); } finally { pendingWrites--; } };
  const rootOf = id => { invariant(localUUID(id), '本地修复编号无效。'); return localPath(path.join(directory, 'jobs'), id); };
  const get = id => { const job = store.get(id); invariant(job.recipe?.localMaterialRepair, '这不是本地修复任务。', 404); return job; };
  const view = job => {
    const { keyHash, ...visible } = job;
    const copy = structuredClone(visible), url = `/api/local-material/${job.id}/media/`;
    const spec = copy.recipe.localMaterialRepair;
    spec.processing.appearanceReconstruction = normalizeLocalAppearanceReconstruction({ enabled: spec.processing.appearanceReconstruction?.enabled === true });
    spec.calibration.appearanceKeyframes ??= [];
    for (const artifact of copy.local.artifacts || []) artifact.url = `/api/local-material/${job.id}/artifacts/${encodeURIComponent(artifact.id)}`;
    copy.local.media = { base: url + 'base', source: url + 'source', donor: job.recipe.localMaterialRepair.donor ? url + 'donor' : null, preview: job.local.preview ? url + 'preview' : null };
    for (const [index, frame] of copy.recipe.localMaterialRepair.calibration.handKeyframes.entries()) {
      if (frame.mask) frame.maskUrl = `/api/local-material/${job.id}/hand-mask/${index}?revision=${job.local.revision}`;
      delete frame.mask;
    }
    return copy;
  };
  const upload = async (id, kind) => {
    invariant(localUUID(id), '素材上传编号无效。');
    const root = localPath(path.join(directory, 'local-material-inputs'), id), value = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
    invariant(value.id === id && value.kind === kind, '素材用途不匹配。');
    const file = localPath(root, value.file); invariant(await fileSHA256(file) === value.sha256, '上传素材已变化，请重新导入。', 409);
    return { ...value, file };
  };
  app.post('/api/local-material/uploads', tracked(async (req, res) => {
    invariant(Object.keys(req.query).every(key => key === 'kind') && ['source', 'donor', 'mask'].includes(req.query.kind), '请明确原视频、清肤图或手部mask用途。');
    const kind = req.query.kind, id = randomUUID(), root = localPath(path.join(directory, 'local-material-inputs'), id); let saved = false;
    try {
      await mkdir(root, { recursive: true });
      const { files } = await studioUpload(req, root, { kind: kind === 'source' ? 'video' : 'image', count: 1, fields: [] });
      const input = path.join(root, files[0].file); let file, info;
      if (kind === 'donor') { file = 'donor.png'; await prepareImage(input, path.join(root, file)); info = await probe(path.join(root, file)); }
      else if (kind === 'mask') { info = await probe(input); invariant(info.codec === 'png', '手部mask请使用原尺寸PNG，不能缩放。'); file = 'mask.png'; await copyFile(input, path.join(root, file)); }
      else { info = await probe(input); invariant(info.frames !== 1 && info.duration > 0 && info.duration <= 600, '请导入真正的原视频。'); file = files[0].file; }
      const metadata = { id, kind, file, name: files[0].name, sha256: await fileSHA256(path.join(root, file)), ...info };
      await writeFile(path.join(root, 'manifest.json'), JSON.stringify(metadata)); saved = true;
      const { file: hidden, ...visible } = metadata; res.status(201).json(visible);
    } finally { if (!saved) await rm(root, { recursive: true, force: true }); }
  }));
  app.get('/api/local-material/uploads/:id/media', async (req, res) => {
    invariant(localUUID(req.params.id), '素材编号无效。');
    const root = localPath(path.join(directory, 'local-material-inputs'), req.params.id), saved = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
    res.sendFile(localPath(root, saved.file), { dotfiles: 'allow' });
  });
  app.post('/api/jobs/:parentId/local-material', tracked(async (req, res) => {
    const input = localObject(req.body, ['requestId', 'sourceUploadId', 'donor', 'sourceActorId', 'targetActorId', 'materialAssetId', 'ranges', 'sourceSkinReference', 'sourceOcclusionReconstruction', 'appearanceReconstruction'], '本地修复草稿');
    invariant(localUUID(input.requestId) && !saving.has(input.requestId), '请求编号无效或正在保存。', 409); saving.add(input.requestId);
    try {
      let donor;
      if (input.donor) { localObject(input.donor, ['uploadId', 'frameIndex'], '目标清肤参考'); invariant((input.donor.uploadId !== undefined) !== (input.donor.frameIndex !== undefined), '请选择上传清肤图或目标自身帧之一。'); donor = input.donor.uploadId ? await upload(input.donor.uploadId, 'donor') : input.donor; }
      const sourceUpload = input.sourceUploadId ? await upload(input.sourceUploadId, 'source') : undefined;
      const existing = store.list().find(job => job.id === input.requestId);
      const job = await createLocalMaterialDraft({ store, directory, parent: store.get(req.params.parentId), id: input.requestId,
        sourceUpload, donor, sourceActorId: input.sourceActorId, targetActorId: input.targetActorId, materialAssetId: input.materialAssetId, ranges: input.ranges, runtime, sourceSkinReference: input.sourceSkinReference, sourceOcclusionReconstruction: input.sourceOcclusionReconstruction, appearanceReconstruction: input.appearanceReconstruction });
      res.status(existing ? 200 : 201).json(view(job));
    } finally { saving.delete(input.requestId); }
  }));
  app.get('/api/local-material/:id', (req, res) => res.json(view(get(req.params.id))));
  app.put('/api/local-material/:id/calibration', tracked(async (req, res) => {
    const job = get(req.params.id); invariant(Number.isInteger(req.body?.revision) && req.body.revision === job.local.revision && !saving.has(job.id), '校准已修改或正在保存。', 409); saving.add(job.id);
    try {
      if (engine.active?.id === job.id) await engine.cancel(job.id);
      const updated = await updateLocalCalibration({ store, directory, id: job.id, revision: req.body.revision, input: req.body, resolveUpload: upload }); res.json(view(updated));
    } finally { saving.delete(job.id); }
  }));
  for (const action of ['analyse', 'render', 'resume', 'cancel', 'confirm']) app.post(`/api/local-material/:id/${action}`, tracked(async (req, res) => {
    const input = localObject(req.body, action === 'confirm' ? ['revision', 'confirmPreview'] : ['revision'], '本地处理操作');
    const job = get(req.params.id); invariant(Number.isInteger(input.revision) && input.revision === job.local.revision && !saving.has(job.id), '本地版本已改变，请重新读取。', 409);
    const result = action === 'confirm' ? await engine.confirm(job.id, input.revision, input.confirmPreview)
      : action === 'cancel' ? await engine.cancel(job.id)
        : action === 'resume' ? engine.resume(job.id, input.revision) : engine.enqueue(job.id, input.revision, action);
    res.json(view(result));
  }));
  app.get('/api/local-material/:id/media/:kind', (req, res) => {
    const job = get(req.params.id), spec = job.recipe.localMaterialRepair, files = { base: spec.base.file, source: spec.source.file, donor: spec.donor?.file, preview: job.local.preview?.file };
    invariant(Object.hasOwn(files, req.params.kind) && files[req.params.kind], '该预览素材尚未就绪。', 404); res.sendFile(localPath(rootOf(job.id), files[req.params.kind]), { dotfiles: 'allow' });
  });
  app.get('/api/local-material/:id/artifacts/:artifactId', (req, res) => {
    const job = get(req.params.id), artifact = job.local.artifacts?.find(item => item.id === req.params.artifactId);
    invariant(artifact, '校准图尚未就绪。', 404); res.sendFile(localPath(rootOf(job.id), artifact.file), { dotfiles: 'allow' });
  });
  app.get('/api/local-material/:id/hand-mask/:keyframeIndex', async (req, res) => {
    const job = get(req.params.id);
    invariant(Object.keys(req.query).every(key => key === 'revision') && (req.query.revision === undefined || /^\d+$/.test(String(req.query.revision)) && Number(req.query.revision) === job.local.revision), '手部保护图版本已变化，请重新读取校准。', 409);
    invariant(/^\d+$/.test(req.params.keyframeIndex), '手部关键帧编号无效。', 404);
    const frame = job.recipe.localMaterialRepair.calibration.handKeyframes[Number(req.params.keyframeIndex)];
    invariant(frame?.mask, '该关键帧尚未导入保护图。', 404);
    const file = localPath(rootOf(job.id), frame.mask.file);
    invariant(await fileSHA256(file) === frame.mask.sha256, '冻结手部保护图已变化，请重新导入。', 409);
    res.set('Cache-Control', 'no-store'); res.type('png').sendFile(file, { dotfiles: 'allow' });
  });
  return { pendingWrites: () => pendingWrites, waitForWrites: async () => { while (pendingWrites) await new Promise(resolve => setTimeout(resolve, 10)); } };
}
