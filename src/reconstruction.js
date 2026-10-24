import path from 'node:path';
import { mkdir, copyFile, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { invariant } from './errors.js';
import * as media from './media.js';
import { FPS } from './plan.js';
import { QUALITY_VERSION } from './content-review.js';
import { propRole } from '../public/prop-role.js';

export const RECONSTRUCTION_POLICY = 'action-keyframes-v1';
export const RECONSTRUCTION_STAGE_POLICY = 'action-keyframes-contact-stages-v1';
const active = new Map();
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const within = (root, file) => {
  invariant(typeof file === 'string' && file && !path.isAbsolute(file), '冻结素材路径不正确。');
  const resolved = path.resolve(root, file);
  invariant(resolved.startsWith(path.resolve(root) + path.sep), '冻结素材不能位于任务目录之外。');
  return resolved;
};

export function reconstructionRange(totalFrames, start, end) {
  invariant(Number.isInteger(totalFrames) && totalFrames > 0, '基底成片帧数无效。');
  invariant(typeof start === 'number' && typeof end === 'number' && Number.isFinite(start) && Number.isFinite(end), '请填写有效的动作重建起止秒数。');
  const startFrame = Math.round(start * FPS), endFrame = Math.round(end * FPS), frames = endFrame - startFrame;
  invariant(start >= 0 && end > start && startFrame >= 0 && endFrame <= totalFrames && frames >= 2 * FPS && frames <= 15 * FPS, '动作重建范围须在当前成片内，长度为 2–15 秒。');
  return { startFrame, frames, start: startFrame / FPS, duration: frames / FPS, requestDuration: Math.ceil(frames / FPS) };
}

export function reconstructionPrompt(spec, actorName = spec.characterId, notes = '') {
  return `使用首帧和尾帧生成 ${spec.requestDuration} 秒单一连续镜头，重建人物「${actorName}」（${spec.characterId}）的面霜涂抹过程。首尾图片已包含同一个目标人物、服装、场景、光照及商品状态，不能换脸换装、换背景、改变机位或新增人物。\n起点保留首帧实际厚膏与手部位置，指腹持续真实接触膏体和皮肤，沿脸颊自然推动、揉匀；接触路径上的膏体逐步铺展，面积扩大、厚度下降、边缘推散，随后自然收手并展示尾帧薄匀状态，保持自然肤纹。中间必须能看清接触导致铺展，不能保留固定贴片、悬浮膏块或用遮挡、突然消失代替揉开。\n从首帧动作连续到达尾帧，不切镜、不跳剪、不先涂匀再恢复厚块，不增加新的点涂。允许仅在这段中重建真实连贯的手部轨迹与节奏。尾部停留清楚展示已薄匀面部，完整到达指定尾帧。\n仅生成画面，不朗读、不新增口播或配乐；原成片音轨由软件本地保留。不得新增字幕、品牌文字、水印、拼版、平台尾页或黑屏。${notes ? `\n用户确认的局部动作要求（仅约束这段，不改变人物身份和场景）：${notes}` : ''}`;
}

const regions = { cheek: '脸颊', forehead: '额头', chin: '下巴' };
export function reconstructionStagePrompt(spec, stage, actorName = spec.characterId, notes = '') {
  invariant(Object.hasOwn(regions, stage.region), '分部位涂抹阶段无效。');
  const alreadyThin = stage.region === 'forehead' ? '脸颊' : stage.region === 'chin' ? '脸颊和额头' : '';
  const notTouched = stage.region === 'cheek' ? '额头和下巴' : stage.region === 'forehead' ? '下巴' : '';
  return `使用本阶段首帧和尾帧生成 ${stage.requestDuration} 秒连续镜头，只处理人物「${actorName}」（${spec.characterId}）的${regions[stage.region]}涂抹。两帧是同一人物、衣着、场景、光照和机位；不能换脸、换装、换背景或切镜。本阶段不是重新开始的镜头，要沿用首帧真实手势、膏体位置和此前完成状态。\n指腹从首帧手势自然移动到${regions[stage.region]}现有厚膏，持续真实接触皮肤和膏体，沿接触路径缓慢推开；覆盖面积扩大、厚度逐步降低、边缘推散，保留自然肤纹。只在指腹实际推过的区域发生变薄。${alreadyThin ? `${alreadyThin}已经薄匀，保持薄匀，不重新出现膏点、不重新点涂。` : ''}${notTouched ? `${notTouched}本阶段尚未触及，保留首帧对应膏点，不能提前清除。` : ''}\n在手指仍贴着${regions[stage.region]}、接触仍清楚可见时，到达尾帧所示薄匀状态；先真实完成推开，再结束本阶段。不要先收手再让膏体消失，不用遮挡、淡出、溶解、变形过渡或跳变把厚片抹掉，不用静态厚片贴在皮肤上。不凭空吸收，不靠皮肤变白伪装成铺展。尾帧继续保留指定接触手势，供下一阶段连续续接；不添加点涂，不恢复此前厚膏。\n仅生成画面，不生成语音、音乐、字幕、品牌贴字、水印、拼图、黑屏或尾页。原音在本地合成。${notes ? `\n本阶段补充要求（不能改变上述部位与材料状态范围）：${notes}` : ''}`;
}

export function reconstructionStages(range, anchors) {
  const intermediates = anchors.intermediates || [];
  invariant(Array.isArray(intermediates) && [0, 2].includes(intermediates.length), '分部位重建须提供两张中间状态图。');
  if (!intermediates.length) return [];
  invariant(range.frames >= 4.5 * FPS && range.frames <= 15 * FPS, '三阶段涂抹重建范围须为 4.5–15 秒。');
  const step = Math.floor(range.frames / 3), remainder = range.frames % 3;
  const pairs = [anchors.first, ...intermediates, anchors.last];
  let cursor = range.startFrame;
  return ['cheek', 'forehead', 'chin'].map((region, index) => {
    const frames = step + (index < remainder ? 1 : 0), startFrame = cursor; cursor += frames;
    return { index, region, startFrame, frames, start: startFrame / FPS, duration: frames / FPS,
      requestDuration: Math.max(2, Math.ceil(frames / FPS)), first: pairs[index], last: pairs[index + 1],
      bridgePolicy: index ? 'previous_actual_last_frame' : 'provided_first_frame', continuous: true };
  });
}

export function reconstructionSegments(totalFrames, range, bindings, prompt, stages = []) {
  const pieces = [];
  if (range.startFrame) pieces.push({ startFrame: 0, frames: range.startFrame, generationMode: 'base_copy' });
  if (stages.length) {
    for (const stage of stages) pieces.push({ ...stage, generationMode: 'keyframe_rebuild', reconstructionStageIndex: stage.index,
      reconstructionRegion: stage.region, bindings: stage.bindings, prompt: stage.prompt });
  } else pieces.push({ ...range, generationMode: 'keyframe_rebuild', bindings, prompt });
  const tail = totalFrames - range.startFrame - range.frames;
  if (tail) pieces.push({ startFrame: range.startFrame + range.frames, frames: tail, generationMode: 'base_copy' });
  let previousGenerationIndex = null;
  return pieces.map((piece, index) => {
    const bridgeFromIndex = piece.generationMode === 'keyframe_rebuild' && piece.reconstructionStageIndex > 0 ? previousGenerationIndex : undefined;
    if (piece.generationMode === 'keyframe_rebuild') previousGenerationIndex = index;
    return ({ start: piece.startFrame / FPS, duration: piece.frames / FPS,
    requestDuration: piece.generationMode === 'base_copy' ? 0 : range.requestDuration,
    bindings: [], assetIds: [], dialogueIds: [], dialogueLines: [], state: 'pending', taskId: null, error: null,
    attempts: 0, affinity: randomUUID(), idempotencyKey: 'wan-reconstruct-' + randomUUID(), ...piece, index,
    ...(bridgeFromIndex === undefined ? {} : { bridgeFromIndex }) });
  });
}

/** One derived job; all expensive create calls remain the queue engine's job. */
export async function createReconstruction(options) {
  const { directory, id } = options;
  invariant(path.isAbsolute(directory) && uuid(id), '动作重建任务编号或保存目录无效。');
  const key = path.join(directory, 'jobs', id);
  if (active.has(key)) { await active.get(key); return createReconstruction(options); }
  const pending = create(options);
  active.set(key, pending);
  try { return await pending; } finally { if (active.get(key) === pending) active.delete(key); }
}

async function create({ store, vault, directory, engine, parent, id, start, end, characterId, materialAssetId, first, last, intermediates = [], notes = '', analysisModel }) {
  invariant(uuid(parent?.id) && parent.id !== id && parent.state === 'completed' && parent.workflow === 'studio', '请选择已完成的用户版编辑成片作为重建基底。', 409);
  invariant(Array.isArray(intermediates) && [0, 2].includes(intermediates.length), '请按顺序提供脸颊完成、额头完成两张中间状态图，或仅使用首尾两帧。');
  const existing = store.list().find(job => job.id === id);
  if (existing) {
    const saved = existing.recipe?.actionRebuild;
    invariant(saved?.parentJobId === parent.id && saved.characterId === characterId && saved.materialAssetId === materialAssetId
      && saved.startFrame === Math.round(start * FPS) && saved.frames === Math.round(end * FPS) - Math.round(start * FPS), '此请求编号已用于其他重建范围，请另存新版本。', 409);
    invariant((saved.intermediates?.length || 0) === intermediates.length, '此请求编号已冻结不同的涂抹阶段，请另存新版本。', 409);
    return existing;
  }
  vault.require(parent.keyHash);
  const reviewModel = 'Omni-Analysis';
  invariant(analysisModel == null || analysisModel === reviewModel, '动作复核仅使用 Omni-Analysis。');
  invariant(['wan3.0-720p', 'wan3.0-480p'].includes(parent.model), '该成片模型不支持动作重建。');
  invariant(typeof notes === 'string' && notes.length <= 1200, '动作说明不能超过 1200 字。');
  const actor = parent.recipe?.story?.assets?.find(asset => asset.id === characterId && asset.type === 'character');
  const material = parent.recipe?.story?.assets?.find(asset => asset.id === materialAssetId && asset.type === 'prop');
  invariant(actor && propRole(material, parent.recipe?.edits?.assets?.[materialAssetId]) === 'material', '请选择这段中已确认的人物和膏体材质。');
  for (const input of [first, ...intermediates, last]) invariant(input && typeof input.file === 'string' && path.isAbsolute(input.file), '请上传已处理的完整首尾和中间状态图，不能使用客户端文件路径。');
  const sourceRoot = within(path.join(directory, 'jobs'), parent.id), target = within(path.join(directory, 'jobs'), id);
  const base = within(sourceRoot, 'result.mp4'), info = await media.probe(base);
  invariant(Number.isInteger(info.frames) && info.frames > 0 && Math.abs(info.duration - info.frames / FPS) < 0.06, '当前成片不是完整的 30 帧时间轴，请先恢复成片后再重建。', 422);
  const range = reconstructionRange(info.frames, start, end);
  if (intermediates.length) invariant(range.frames >= 4.5 * FPS, '三阶段涂抹重建范围须为 4.5–15 秒。');
  const imageInfo = await Promise.all([first, ...intermediates, last].map(input => media.probe(input.file)));
  invariant(imageInfo.every(image => image.codec === 'png' && Math.abs(image.width / image.height - info.width / info.height) < 0.02)
    && imageInfo.every(image => Math.abs(imageInfo[0].width / imageInfo[0].height - image.width / image.height) < 0.001),
  '首尾帧必须是与成片相同画幅的完整 PNG 画面，不能上传头像裁图或四联图。', 422);
  let owned = false, saved = false;
  try {
    await mkdir(target); owned = true; await mkdir(path.join(target, 'anchors'));
    await copyFile(base, path.join(target, 'base.mp4'));
    const baseSHA256 = await media.fileSHA256(path.join(target, 'base.mp4'));
    const frozenFiles = [];
    const freeze = async (input, file) => {
      const output = within(target, file); await mkdir(path.dirname(output), { recursive: true }); await copyFile(input, output);
      const sha256 = await media.fileSHA256(output); frozenFiles.push({ file, sha256 }); return { file, sha256 };
    };
    const anchors = { first: await freeze(first.file, 'anchors/first.png'), last: await freeze(last.file, 'anchors/last.png') };
    anchors.intermediates = [];
    for (const [index, input] of intermediates.entries()) anchors.intermediates.push(await freeze(input.file, `anchors/mid-${index === 0 ? 'cheek' : 'forehead'}.png`));
    for (const [frozen, input] of [[anchors.first, first], [anchors.last, last], ...anchors.intermediates.map((item, index) => [item, intermediates[index]])]) if (input.sha256) invariant(frozen.sha256 === input.sha256,
      '冻结首尾帧已改变，不能沿用旧记录重做，尚未提交生成任务。', 409);
    // Keep prior target evidence readable for output review, without uploading it.
    for (const frozen of parent.frozenFiles || []) {
      if (['base.mp4', 'anchors/first.png', 'anchors/last.png', 'anchors/mid-cheek.png', 'anchors/mid-forehead.png'].includes(frozen.file) || frozen.file.startsWith('bridges/')) continue;
      const copied = await freeze(within(sourceRoot, frozen.file), frozen.file);
      invariant(copied.sha256 === frozen.sha256, '原版本冻结素材校验失败，未提交动作重建。', 409);
    }
    frozenFiles.push({ file: 'base.mp4', sha256: baseSHA256 });
    const actorEdit = parent.recipe.edits.assets[characterId] || {};
    const spec = { version: 1, policy: RECONSTRUCTION_POLICY, parentJobId: parent.id, baseFile: 'base.mp4', baseSHA256,
      fps: FPS, totalFrames: info.frames, ...range, characterId, materialAssetId, ...anchors,
      actorReference: { main: actorEdit.main?.file || null, views: actorEdit.views?.file || null },
      singleShot: true, authorisedActionChange: true, audioPolicy: 'preserve_base', timeMapping: 'whole-return-endpoints-v1', notes: notes.trim() };
    spec.stages = reconstructionStages(range, anchors);
    if (spec.stages.length) { spec.version = 2; spec.policy = RECONSTRUCTION_STAGE_POLICY; }
    for (const stage of spec.stages) {
      stage.bindings = [{ assetId: materialAssetId, slot: 'first', type: 'first_frame', file: stage.first.file },
        { assetId: materialAssetId, slot: 'last', type: 'last_frame', file: stage.last.file }];
      stage.prompt = reconstructionStagePrompt(spec, stage, '状态帧中指定的目标人物', notes.trim());
    }
    spec.billableSeconds = spec.stages.length ? spec.stages.reduce((total, stage) => total + stage.requestDuration, 0) : range.requestDuration;
    const bindings = [{ assetId: materialAssetId, slot: 'first', type: 'first_frame', file: anchors.first.file },
      { assetId: materialAssetId, slot: 'last', type: 'last_frame', file: anchors.last.file }];
    const segments = reconstructionSegments(info.frames, range, bindings, reconstructionPrompt(spec, '状态帧中指定的目标人物', notes.trim()), spec.stages);
    const recipe = structuredClone(parent.recipe); recipe.actionRebuild = spec; recipe.source = { duration: info.frames / FPS };
    const rangeEnd = range.start + range.duration;
    recipe.sourceCuts = (recipe.sourceCuts || []).filter(time => time <= range.start || time >= rangeEnd);
    const actionId = 'REBUILD_' + id;
    const retainedActions = [];
    for (const action of recipe.story.actions || []) {
      if (action.end <= range.start || action.start >= rangeEnd) { retainedActions.push(action); continue; }
      for (const clipped of [action.start < range.start ? { ...action, id: action.id + '_before', end: range.start } : null,
        action.end > rangeEnd ? { ...action, id: action.id + '_after', start: rangeEnd } : null].filter(Boolean)) {
        retainedActions.push(clipped);
        if (recipe.edits.continuity?.actions?.[action.id]) recipe.edits.continuity.actions[clipped.id] = recipe.edits.continuity.actions[action.id];
      }
    }
    recipe.story.actions = retainedActions;
    const goals = spec.stages.length ? spec.stages : [{ index: 0, start: range.start, duration: range.duration, region: null }];
    for (const goal of goals) recipe.story.actions.push({ id: actionId + (goal.region ? '_' + goal.region : ''), start: goal.start, end: goal.start + goal.duration, type: 'spread', characterId, propId: materialAssetId,
      region: goal.region ? regions[goal.region] : '面部', before: '人工指定本阶段部位已有可见厚膏，此前完成部位保持薄匀', after: '人工指定本部位薄匀、自然肤纹，手指仍接触该部位，不用收手后的消失代替推开',
      contact: `编辑目标：指腹持续接触${goal.region ? regions[goal.region] : '脸颊'}已有膏体`, motion: '连续沿当前部位推动揉匀',
      evidence: '用户授权的编辑目标：手指接触已有膏体并推开，面积扩大、厚度下降；须生成后独立验证，非原片识别事实。',
      confidence: 'high', evidenceKind: 'user_reconstruction_goal', verification: 'pending' });
    recipe.edits.continuity ||= { actions: {} }; recipe.edits.continuity.actions ||= {};
    for (const action of recipe.story.actions.filter(action => action.id.startsWith(actionId))) recipe.edits.continuity.actions[action.id] = 'spread_finish';
    recipe.story.shots = (recipe.story.shots || []).flatMap(shot => {
      if (shot.end <= range.start || shot.start >= rangeEnd) return [shot];
      return [shot.start < range.start ? { ...shot, id: shot.id + '_before', end: range.start } : null,
        shot.end > rangeEnd ? { ...shot, id: shot.id + '_after', start: rangeEnd } : null].filter(Boolean);
    });
    recipe.story.shots.push({ id: 'SH_' + actionId, start: range.start, end: rangeEnd, characterIds: [characterId], propIds: [materialAssetId], sceneId: null,
      summary: '用户授权的单镜头连续涂抹重建', camera: '按同人物首尾帧保持机位与构图', authorisedReconstruction: true });
    recipe.story.shots.sort((a, b) => a.start - b.start);
    for (const selected of segments.filter(segment => segment.generationMode === 'keyframe_rebuild')) {
      selected.assetIds = [characterId, materialAssetId]; selected.shotIds = ['SH_' + actionId];
    }
    const now = new Date().toISOString();
    const job = { id, created: now, updated: now, projectId: parent.projectId, projectRevision: parent.projectRevision,
      parentJobId: parent.id, workflow: 'studio', mode: 'studio', title: parent.title + ' · 局部动作重建', model: parent.model, analysisModel: reviewModel, keyHash: parent.keyHash,
      sourceFile: 'base.mp4', sourceName: parent.sourceName, sourceSHA256: baseSHA256, source: info, sourceBytes: (await stat(path.join(target, 'base.mp4'))).size,
      output: { width: info.width, height: info.height }, state: 'queued', phase: '等待局部动作重建', segments, recipe,
      audioMode: 'original', generationOptions: { promptExtend: false, promptPolicy: spec.policy }, frozenFiles,
      prepared: false, pauseRequested: false, error: null, billableSeconds: spec.billableSeconds,
      continuityVersion: parent.continuityVersion || 2, quality: { enabled: true, version: QUALITY_VERSION, model: reviewModel, state: 'waiting' },
      events: [{ at: now, message: `已冻结${spec.stages.length ? '四张状态帧，按脸颊、额头、下巴连续生成' : '首尾帧'}，仅重建 ${range.start.toFixed(3)}–${rangeEnd.toFixed(3)} 秒（${spec.billableSeconds} 秒平台用量）；其他画面和成片原音在本地保留，连续涂抹需实际验收。` }] };
    for (const segment of segments.filter(item => item.generationMode === 'base_copy')) {
      await media.prepareBaseCopy(target, job, segment); segment.state = 'completed'; segment.completedAt = now;
    }
    await copyFile(path.join(target, anchors.first.file), path.join(target, 'reference.png'));
    vault.require(parent.keyHash); store.create(job); saved = true; engine.pump(); return job;
  } finally { if (owned && !saved) await rm(target, { recursive: true, force: true }); }
}
