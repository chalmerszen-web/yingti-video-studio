import path from 'node:path';
import { mkdir, copyFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { invariant, AppError } from './errors.js';
import { studioPrompt } from './story.js';
import { QUALITY_VERSION } from './content-review.js';
import { propRole, materialReferenceMode } from '../public/prop-role.js';
import { assertPropReferencePolicies } from './prop-reference.js';
import { fileSHA256 } from './file-hash.js';
import { createReconstruction } from './reconstruction.js';

const within = (root, file) => {
  const result = path.resolve(root, file);
  invariant(result.startsWith(path.resolve(root) + path.sep), '保存的素材路径不正确。'); return result;
};

export async function regenerateSegment({ store, vault, directory, engine, parent, index, id, notes = '' }) {
  invariant(typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id) && id !== parent.id, '重做版本编号无效。');
  invariant(parent.state === 'completed' && parent.workflow === 'studio', '只有已完成的编辑版本支持局部重做。', 409);
  invariant(parent.segments[index]?.state === 'completed', '分段不存在或尚未完成。', 409);
  invariant(typeof notes === 'string' && notes.length <= 1200, '修正说明最多 1200 字。');
  const segment = parent.segments[index];
  invariant(segment.generationMode !== 'base_copy', '这部分已沿用基底画面，无需重复付费重做；请选择动作重建范围。', 409);
  if (segment.generationMode === 'keyframe_rebuild') {
    const spec = parent.recipe?.actionRebuild;
    invariant(spec?.first?.file && spec?.last?.file, '冻结首尾帧记录不完整，请重新选择状态图。', 409);
    const root = path.join(directory, 'jobs', parent.id);
    const coupled = !!spec.stages?.length;
    const job = await createReconstruction({store,vault,directory,engine,parent,id,start:coupled?spec.start:segment.start,end:coupled?spec.start+spec.duration:segment.start+segment.duration,
      characterId:spec.characterId,materialAssetId:spec.materialAssetId,first:{...spec.first,file:within(root,spec.first.file)},last:{...spec.last,file:within(root,spec.last.file)},
      intermediates:spec.intermediates?.map(frame=>({...frame,file:within(root,frame.file)})),notes:[spec.notes,notes.trim()].filter(Boolean).join('\n').slice(0,1200),analysisModel:parent.analysisModel});
    return store.update(job.id,current=>{current.repairedSegment=index;});
  }
  assertPropReferencePolicies(parent.recipe);
  for (const binding of parent.segments[index].bindings || []) {
    const asset = parent.recipe.story.assets.find(item => item.id === binding.assetId);
    const edit = parent.recipe.edits.assets[binding.assetId];
    if (binding.type === 'reference_image' && binding.slot === 'main' && propRole(asset, edit) === 'material' && materialReferenceMode(edit) === 'motion')
      throw new AppError('这个历史版本仍把膏体整图作为实物参考，不能仅改提示词继续重做。请返回编辑核对瓶罐、包装盒和膏体分类，选择材质参考方式后生成新版本；旧成片会保留。', 409, 'material_reference_legacy');
  }
  vault.require(parent.keyHash);
  const source = path.join(directory, 'jobs', parent.id), target = path.join(directory, 'jobs', id);
  const segments = structuredClone(parent.segments);
  for (const segment of segments) segment.reusedFrom = { jobId: parent.id, index: segment.index };
  const part = segments[index];
  delete part.reusedFrom;
  for (const key of ['requestSettings', 'submittedAt', 'completedAt', 'checkedAt', 'remoteStatus', 'history']) delete part[key];
  Object.assign(part, { state: 'pending', taskId: null, affinity: randomUUID(), idempotencyKey: 'wan-repair-' + randomUUID(), attempts: 0, error: null, repairNotes: notes.trim() });
  // A repair uses this version's frozen recipe and timings, never today's edits.
  const recipe = structuredClone(parent.recipe);
  if (parent.continuityVersion) part.prompt = studioPrompt({ recipe }, part);
  else part.prompt = parent.segments[index].prompt + (notes.trim() ? `\n本段复核修正（不改变原编辑范围、原台词及原时间）：${notes.trim()}` : '');
  invariant(part.prompt.length <= 20000, '修正后的提示词过长。');
  const now = new Date().toISOString();
  const job = { ...structuredClone(parent), id, created: now, updated: now, parentJobId: parent.id, repairedSegment: index,
    title: parent.title + ` · 重做第 ${index + 1} 段`, state: 'queued', phase: `等待重做第 ${index + 1} 段`, prepared: !recipe.edits.fullDialogue?.enabled, pauseRequested: false,
    segments, recipe, result: null, completedAt: null, error: null, billableSeconds: part.requestDuration,
    quality: { enabled: true, version: QUALITY_VERSION, state: 'waiting' }, events: [{ at: now, message: `另存局部重做版本：仅第 ${index + 1} 段提交新 WAN 请求（${part.requestDuration} 秒），其他片段复用；完成后检查台词、商品、涂抹及接头。旧版本保留。` }] };
  job.generationOptions = { ...(parent.generationOptions || {}), promptExtend: true, repairPolicy: 'frozen-segment-v1' };
  const files = new Set([parent.sourceFile, 'canonical.mp4', 'reference.png', ...segments.flatMap(s => s.bindings.map(b => b.file)), ...(parent.frozenFiles || []).map(item => item.file), ...segments.map(s => `segments/input-${s.index}.mp4`), ...segments.filter(s => s.index !== index).map(s => `segments/output-${s.index}.mp4`)]);
  if (parent.source.hasAudio) files.add('original-audio.wav');
  for (const file of [parent.narration?.file,parent.narration?.sourceFile,recipe.edits.narration?.file]) if(file) files.add(file);
  let saved = false;
  try {
    await mkdir(target, { recursive: true });
    for (const file of files) {
      if(recipe.edits.fullDialogue?.enabled && file===`segments/input-${index}.mp4`) continue;
      const output = within(target, file); await mkdir(path.dirname(output), { recursive: true }); await copyFile(within(source, file), output);
      const frozen = parent.frozenFiles?.find(item => item.file === file);
      if (frozen) invariant(typeof frozen.sha256 === 'string' && await fileSHA256(output) === frozen.sha256, '保存的参考素材校验失败，已停止局部重做，尚未提交新的生成请求。', 409);
    }
    vault.require(parent.keyHash); store.create(job); saved = true; engine.pump(); return job;
  } finally { if (!saved) await rm(target, { recursive: true, force: true }); }
}
