import { propRoles, propRoleLabels, propRole, propRoleEvidence, referenceRoleIssue, materialReferenceModes, materialReferenceMode } from './prop-role.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const options = (selected, emptyLabel) => `<option value="">${esc(emptyLabel)}</option>${propRoles.map(role => `<option value="${role}" ${selected === role ? 'selected' : ''}>${esc(propRoleLabels[role])}</option>`).join('')}`;

/** Always visible asset/reference purposes, shared by both editions. */
export function propRoleEditor(asset, edit = {}) {
  if (asset.type !== 'prop') return '';
  const evidence = propRoleEvidence(asset), source = propRole(asset, edit), issue = referenceRoleIssue(asset, edit);
  const hasImage = !!(edit.main || edit.views);
  const mode = materialReferenceMode(edit);
  const materialControls = source === 'material' ? `<label class="full-dialogue-label">涂抹参考方式<select class="studio-input" data-prop-role="materialReferenceMode" data-asset-id="${esc(asset.id)}"><option value="motion" ${mode === 'motion' ? 'selected' : ''}>保留原片涂抹运动（推荐）</option><option value="image" ${mode === 'image' ? 'selected' : ''}>直接使用膏体图片（需短片验证）</option></select></label><p class="asset-view-help">${mode === 'motion' ? '原片提供手指接触与膏体铺展过程；上传的材质图留存核对，不直接传入视频模型。下方文字描述确认后的膏体颜色、质地。' : '膏体局部图直接作为视频生成参考，可能影响材料形态；请先验证短片中的接触、铺展和终态。'}</p><label class="full-dialogue-label">膏体颜色与质地<textarea class="studio-input" data-prop-role="materialDescription" data-asset-id="${esc(asset.id)}" rows="3" maxlength="600" placeholder="例如：淡杏粉色乳霜，薄涂后保留自然肤质">${esc(edit.materialDescription || '')}</textarea></label><p class="asset-view-help">只填写已确认的颜色和质地，不写瓶罐或包装外形。文字描述不代表涂抹已经完成，生成后仍需逐段核验。</p>` : '';
  const usageHint = source === 'material' ? mode === 'motion'
    ? '运动模式使用原片接触动作和材质文字，上传图仅保存供核对，不把罐、盒或固定膏块外形贴到脸上。'
    : '膏体或液体图片只参考颜色和质地，不把整只罐、盒子的外形贴到脸上。建议上传能看清膏体的局部图；涂抹变化跟随原片真实接触过程。'
    : source === 'jar' ? '瓶罐使用自己的瓶罐参考图；包装盒请放到包装素材中。'
      : source === 'packaging' ? '包装盒使用自己的包装参考图；瓶罐请放到瓶罐素材中。'
        : '请按原片对象和上传图片分别确认类型，避免外形与材质用途混淆。';
  return `<section class="asset-role-editor" data-prop-role-editor="${esc(asset.id)}"><label class="full-dialogue-label">原片素材类型<select class="studio-input" data-prop-role="propRole" data-asset-id="${esc(asset.id)}">${options(edit.propRole, `按识别结果：${propRoleLabels[evidence.role] || '其他实物'}`)}</select></label>${hasImage ? `<label class="full-dialogue-label">上传图片内容<select class="studio-input" data-prop-role="uploadedImageRole" data-asset-id="${esc(asset.id)}">${options(edit.uploadedImageRole, '请选择图片中的主要内容')}</select></label>` : ''}${materialControls}<p class="asset-view-help">${usageHint}</p>${issue ? `<p class="asset-notice ${issue.blocking ? 'asset-role-error' : 'asset-role-warning'}" role="status">${esc(issue.message)}</p>` : ''}</section>`;
}

/** Existing delegated change handlers call this, then modified/render. */
export function applyPropRoleControl(project, edits, target) {
  const field = target?.dataset?.propRole, id = target?.dataset?.assetId;
  if (!['propRole', 'uploadedImageRole', 'materialReferenceMode', 'materialDescription'].includes(field)) return false;
  const asset = project.story?.assets?.find(item => item.id === id && item.type === 'prop');
  if (!asset || typeof target.value !== 'string') return false;
  if (['propRole', 'uploadedImageRole'].includes(field) && !['', ...propRoles].includes(target.value)) return false;
  if (['materialReferenceMode', 'materialDescription'].includes(field)) {
    if (propRole(asset, edits.assets?.[id]) !== 'material') return false;
    if (field === 'materialReferenceMode' && !['', ...materialReferenceModes].includes(target.value)) return false;
    if (field === 'materialDescription' && target.value.length > 600) return false;
  }
  edits.assets ||= {};
  edits.assets[id] ||= {};
  if (target.value || field === 'materialDescription') edits.assets[id][field] = target.value;
  else delete edits.assets[id][field];
  if (field === 'propRole' && propRole(asset, edits.assets[id]) !== 'material') {
    delete edits.assets[id].materialReferenceMode;
    delete edits.assets[id].materialDescription;
  }
  return true;
}
