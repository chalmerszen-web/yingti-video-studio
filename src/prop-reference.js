import { AppError, invariant } from './errors.js';
import { effectiveAction } from '../public/action-evidence.js';
import { PROP_REFERENCE_VERSION, propRoles, propRole, referenceRoleIssue, materialReferenceModes, materialReferenceMode } from '../public/prop-role.js';

export { PROP_REFERENCE_VERSION };
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const overlaps = (a, b) => Number.isFinite(a.start) && Number.isFinite(a.end) && a.start < b.end - 0.001 && a.end > b.start + 0.001;
const interval = segment => ({ start: segment.start, end: segment.start + segment.duration });
const assetsOf = project => project.story?.assets || [];
const assetOf = (project, id) => assetsOf(project).find(asset => asset.id === id && asset.type === 'prop');
const actionsOf = project => (project.story?.actions || []).map(action => effectiveAction(action, project.edits?.continuity?.actions?.[action.id] || 'auto')).filter(Boolean);

/** Validate only role fields. Uploaded file bindings remain owned by the server. */
export function normalizePropEditPolicy(project, asset, input = {}, previous = project.edits?.assets?.[asset.id] || {}) {
  invariant(input && typeof input === 'object' && !Array.isArray(input), '素材分类格式不正确。');
  const output = {};
  for (const field of ['propRole', 'uploadedImageRole']) {
    const value = own(input, field) ? input[field] : previous[field];
    if (value === undefined || value === '') continue;
    invariant(asset?.type === 'prop' && typeof value === 'string' && propRoles.includes(value), '素材分类须为瓶罐、包装盒、膏体材质、其他实物或字幕图形；人物和场景不能使用道具分类。');
    output[field] = value;
  }
  const role = propRole(asset, output);
  for (const field of ['materialReferenceMode', 'materialDescription']) {
    const explicit = own(input, field), value = explicit ? input[field] : previous[field];
    if (value === undefined) continue;
    // A changed classification does not retain settings for the former material.
    if (role !== 'material' && !explicit) continue;
    if (field === 'materialReferenceMode') {
      invariant(typeof value === 'string' && (value === '' || materialReferenceModes.includes(value)), '材质参考方式须为运动主导或图片材质参考。');
      invariant(value === '' || role === 'material', '只有膏体或液体材质可以设置材质参考方式。');
      if (role === 'material') output[field] = value || 'motion';
    } else {
      invariant(typeof value === 'string' && value.length <= 600, '材质说明须为不超过 600 字的明确颜色和质地文字。');
      invariant(!value.trim() || role === 'material', '只有膏体或液体材质可以设置材质说明。');
      if (role === 'material') output[field] = value.trim();
    }
  }
  return output;
}

export function propReferencePolicy(asset, edit) {
  const role = propRole(asset, edit);
  if (!role) return null;
  return { role, referenceRole: propRoles.includes(edit?.uploadedImageRole) ? edit.uploadedImageRole : null,
    usage: role === 'material' ? materialReferenceMode(edit) === 'motion' ? 'material_motion' : 'material_appearance' : role === 'graphic' ? 'graphic_replacement' : 'object_replacement',
    issue: referenceRoleIssue(asset, edit) };
}

/** The crop is a server-owned image derivative; clients cannot supply this path. */
export function propReferenceFile(asset, edit) {
  return propRole(asset, edit) === 'material' ? edit?.main?.materialFile || edit?.main?.file : edit?.main?.file;
}

/** An end-state picture is tied to the actor reference at the time it was saved. */
export function materialFinishReferenceIssue(project, assetId, finish = project.edits?.assets?.[assetId]?.materialFinish) {
  if (!finish?.file) return null;
  const asset = assetOf(project, assetId), actor = assetsOf(project).find(item => item.id === finish.characterId && item.type === 'character');
  const label = `「${asset?.name || assetId}」（${assetId}）的终态图`;
  const issue = (code, blocking, message, details = {}) => ({ code, severity: blocking ? 'error' : 'warning', blocking, message, assetId, characterId: finish.characterId, ...details });
  if (!actor) return issue('material_finish_actor_invalid', true, `${label}没有对应的原片人物，请重新选择人物并上传终态图，或移除这张终态图。`);
  if (!own(finish, 'actorReference')) return issue('material_finish_reference_unverified', false,
    `${label}是历史参考，未保存当时的人物参考记录，不能确认它与当前人物一致。请重新上传针对同一人物的终态图，或先人工核对；不会把历史标记当作已验证。`);
  const expected = finish.actorReference;
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)
    || !['main', 'views'].every(slot => own(expected, slot) && (expected[slot] === null || typeof expected[slot] === 'string' && expected[slot]))) return issue(
      'material_finish_reference_invalid', true, `${label}的人物参考记录不完整，请重新上传或移除终态图，再生成。`);
  const actorEdit = project.edits?.assets?.[actor.id];
  const current = { main: actorEdit?.main?.file || null, views: actorEdit?.views?.file || null };
  if (expected.main !== current.main || expected.views !== current.views) return issue('material_finish_reference_stale', true,
    `${label}保存后，「${actor.name}」（${actor.id}）的人物参考已更换或移除，不能继续使用旧终态图。请为当前人物重新上传终态参考图，或移除旧图后生成。`,
    { expected: { main: expected.main, views: expected.views }, current });
  return null;
}

function assertFinishReferenceIssue(issue) {
  if (!issue?.blocking) return;
  const error = new AppError(issue.message, 400, issue.code);
  error.details = { assetId: issue.assetId, characterId: issue.characterId, ...(issue.expected ? { expected: issue.expected, current: issue.current } : {}) };
  throw error;
}

export function assertPropReferencePolicies(project) {
  for (const asset of assetsOf(project)) {
    const edit = project.edits?.assets?.[asset.id];
    // Also validate saved overrides when a project is loaded directly rather
    // than patched through the editor; invalid role strings are never ignored.
    normalizePropEditPolicy(project, asset, {}, edit || {});
    const issue = referenceRoleIssue(asset, edit);
    if (issue?.blocking) {
      const error = new AppError(issue.message, 400, issue.code);
      error.details = { assetId: asset.id, sourceRole: issue.sourceRole, imageRole: issue.imageRole };
      throw error;
    }
    if (propRole(asset, edit) === 'material') assertFinishReferenceIssue(materialFinishReferenceIssue(project, asset.id));
  }
}

function materialActions(project, assetId, segment) {
  return actionsOf(project).filter(action => action.propId === assetId && (!segment || overlaps(action, interval(segment))));
}

const materialEdited = (asset, edit) => propRole(asset, edit) === 'material'
  && !!(edit?.main || edit?.materialDescription?.trim() || edit?.materialFinish?.file);

/** Materials are local appearance references, never global replacement objects. */
export function materialScopeForAsset(project, assetId) {
  const asset = assetOf(project, assetId), edit = project.edits?.assets?.[assetId];
  if (!materialEdited(asset, edit)) return null;
  return { mode: materialReferenceMode(edit) === 'motion' ? 'material_motion' : 'material_appearance', ranges: materialActions(project, assetId).map(action => ({ start: action.start, end: action.end })) };
}

export function selectMaterialAssetIds(project, segment) {
  return new Set(assetsOf(project).filter(asset => materialEdited(asset, project.edits?.assets?.[asset.id])
    && materialActions(project, asset.id, segment).length).map(asset => asset.id));
}

export function propReferenceWarnings(project) {
  const warnings = [];
  for (const asset of assetsOf(project)) {
    const edit = project.edits?.assets?.[asset.id], issue = referenceRoleIssue(asset, edit);
    if (issue) warnings.push(issue.message);
    if (propRole(asset, edit) === 'material') {
      const finishIssue = materialFinishReferenceIssue(project, asset.id);
      if (finishIssue) warnings.push(finishIssue.message);
    }
    if (materialEdited(asset, edit) && !materialActions(project, asset.id).length) warnings.push(
      `「${asset.name}」（${asset.id}）的材质编辑没有对应的明确人物、部位及涂抹时段，本次不把它作为全片实物替换；请先核对动作记录。`);
  }
  return warnings;
}

/** Structured source/action/reference evidence for prompt and output review. */
export function materialReviewTargets(project, segment) {
  const targets = [];
  const finishReferences = new Map(), mainReferences = new Map();
  let imageIndex = 0;
  for (const binding of segment.bindings || []) {
    if (binding.type !== 'reference_image') continue;
    imageIndex++;
    if (binding.slot === 'materialFinish') finishReferences.set(binding.assetId, { imageIndex, file: binding.file, characterId: binding.characterId });
    if (binding.slot === 'main') mainReferences.set(binding.assetId, { imageIndex, file: binding.file });
  }
  const candidateIds = [...new Set([...(segment.assetIds || []), ...(segment.bindings || []).map(binding => binding.assetId)])];
  for (const assetId of candidateIds) {
    const asset = assetOf(project, assetId), edit = project.edits?.assets?.[assetId];
    if (propRole(asset, edit) !== 'material') continue;
    const actions = materialActions(project, asset.id, segment).map(action => ({
      id: action.id, start: Math.max(0, action.start - segment.start), end: Math.min(segment.duration, action.end - segment.start),
      characterId: action.characterId, propId: action.propId, region: action.region, type: action.type, target: action.target,
      before: action.before, after: action.after, contact: action.contact || '', motion: action.motion || '', evidence: action.evidence,
    }));
    const mode = materialReferenceMode(edit), boundReference = mode === 'image' ? mainReferences.get(assetId) : null;
    const cropped = boundReference && edit?.main?.materialFile && boundReference.file === edit.main.materialFile;
    const candidateFinish = finishReferences.get(assetId);
    const finishReference = candidateFinish && actions.some(action => action.characterId === candidateFinish.characterId) ? candidateFinish : null;
    let finishReferenceVerification = null;
    if (finishReference) {
      const saved = edit?.materialFinish;
      if (saved && (saved.file !== finishReference.file || saved.characterId !== finishReference.characterId)) throw new AppError(
        `「${asset.name}」（${assetId}）的终态素材绑定与保存人物不一致，请重新上传终态图并生成新版本。`, 400, 'material_finish_binding_mismatch');
      const metadata = saved || finishReference;
      const finishIssue = materialFinishReferenceIssue(project, assetId, metadata);
      assertFinishReferenceIssue(finishIssue);
      finishReferenceVerification = finishIssue ? { state: 'unverified', reason: finishIssue.message }
        : { state: 'matched', actorReference: structuredClone(metadata.actorReference) };
    }
    if (actions.length) targets.push({ assetId: asset.id, sourceName: asset.name,
      reference: boundReference ? { ...boundReference, ...(cropped ? { cropped: true, sourceFile: edit.main.file, cropRect: structuredClone(edit.main.cropRect || null) } : {}) } : null,
      referenceRole: propRoles.includes(edit?.uploadedImageRole) ? edit.uploadedImageRole : null,
      referenceMode: mode, materialDescription: edit?.materialDescription?.trim() || '',
      usage: mode === 'motion' ? 'material_motion' : 'material_appearance', actions, finishReference, finishReferenceVerification,
      forbiddenReferenceFeatures: ['container', 'lid', 'packaging', 'label', 'background', 'rigid_shape'] });
  }
  return { version: PROP_REFERENCE_VERSION, targets };
}

export function propReferenceLocks(project, segment) {
  const { targets } = materialReviewTargets(project, segment);
  if (!targets.length) return [];
  const lines = ['【膏体与液体材质参考】以下对象是可涂抹材料，不是瓶罐、包装盒或固定形状的实物。材料的形状、位置、厚薄和变化采用原片真实接触与运动；不得将容器、瓶盖、包装、标签、文字、背景、整件商品轮廓或固定膏块形状贴到皮肤上，也不得把膏体完整替换成整只罐或盒。'];
  for (const target of targets) {
    const reference = target.referenceMode === 'motion'
      ? '采用运动主导，不使用上传局部材料图作为固定形状或几何参考；保留原片真实膏体随手指铺展、变薄的过程。'
      : target.reference ? `对应图片${target.reference.imageIndex}，仅参考实际可见材料的颜色、质地和表面光泽，不能固定图片中的膏块形状。` : '没有可用材料图片，不能根据容器或包装推测膏体；颜色和质地按明确文字或原片实际可见材料。';
    const description = target.materialDescription ? `明确指定的材料颜色与质地：${target.materialDescription}。此文字只改变材料外观，不授权新增厚膏块或替代真实铺展。` : '没有明确材料颜色与质地说明时保留原片实际可见材料，不从瓶罐、包装配色猜测。';
    lines.push(`「${target.sourceName}」（${target.assetId}）${reference}${description}${target.actions.map(action => `本段${action.start.toFixed(3)}–${action.end.toFixed(3)}秒，人物${action.characterId}的「${action.region}」按已确认的${action.type === 'spread' ? '推开 / 揉匀' : action.type === 'apply' ? '点涂' : '可见残留'}过程变化`).join('；')}。材料位置、数量与变化跟随原片实际手部接触和已确认动作；不因提供图片而新增点涂，不改变手部或皮肤运动。`);
    const notes = project.edits?.assets?.[target.assetId]?.notes?.trim();
    if (notes) lines.push(`本材质的补充要求（仅对已确认人物、部位和时段的材质外观与接触过程生效，不新增人物、瓶罐、包装、点涂动作或台词）：${notes}`);
    if(target.finishReference)lines.push(`图片${target.finishReference.imageIndex}是人物${target.finishReference.characterId}的薄匀完成状态参考，${target.finishReferenceVerification?.state === 'unverified' ? '该人物编号仅来自历史标记，未保存当时的人物参考证据，尚未确认与当前人物参考一致，不能当作已验证的身份依据；' : ''}只约束本人物完成后的皮肤表面：保留自然肤纹，不再有独立厚膏点、片状白块或清晰膏体边界。它不替换人物身份、服装、背景、手势、构图或机位；这些仍使用既定人物参考和视频1。起始状态按本事件原片实际可见状态；实际起始有厚膏时保留厚膏并随真实接触推开变薄，不能从第一帧直接清除膏体，不能用于其他人物。已确认切镜后的薄匀镜头保留其真实薄匀状态，不因终态图或前镜头有厚膏就重新点涂。`);
  }
  lines.push('在同一个未切镜的连续动作内，膏体随手指实际接触变形和铺展；已推开区域的覆盖面积增大、厚度降低、边缘散开，未接触区域按该镜头原片保持。手指经过后不能保持同一厚膏块的固定轮廓，不能像贴片随脸滑动；手部遮挡不等于揉匀或吸收。原片已确认的切镜后采用剪辑后的真实展示状态，不能把前镜头的膏体点带入已经薄匀的后镜头；剪辑后的状态变化不当作连续吸收或无因消失。终态以动作目标与真实可见证据为准。');
  return lines;
}
