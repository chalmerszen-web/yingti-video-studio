// Shared by both editors and the frozen generation recipe. A material is not a
// detachable object: its reference may change appearance, never container shape.
export const PROP_REFERENCE_VERSION = 'prop-reference-v1';
export const propRoles = Object.freeze(['jar', 'packaging', 'material', 'object', 'graphic']);
export const propRoleLabels = Object.freeze({ jar: '瓶罐', packaging: '包装盒', material: '膏体或液体材质', object: '其他实物', graphic: '字幕或图形' });
export const materialReferenceModes = Object.freeze(['motion', 'image']);
export const materialReferenceModeLabels = Object.freeze({ motion: '运动主导（推荐）', image: '图片材质参考' });
export const materialReferenceMode = edit => materialReferenceModes.includes(edit?.materialReferenceMode) ? edit.materialReferenceMode : 'motion';
const text = value => typeof value === 'string' ? value.trim() : '';
const graphics = /贴纸|字幕|水印|角标|标语|图形|贴片/u;
const jars = /瓶|罐|容器|管装|软管/u;
const packages = /包装盒|纸盒|盒装|外盒|礼盒|纸质包装|产品包装/u;
const materialName = /膏体|膏状物|乳霜(?:质地|材质)|霜体|料体|液体(?:材质|质地)|涂抹材料|粉体|粉末/u;
const materialDescription = /膏体|膏状(?:物|质地)|乳霜质地|霜体|料体|液体|粉体|粉末/u;
const materialUse = /涂(?:在|到|上|抹)|抹(?:在|到|上|开)|脸上|皮肤|指腹|铺展|摊开|推开|涂匀/u;

/** Conservative compatibility inference for old saved analyses; never read filenames. */
export function propRoleEvidence(asset) {
  if (asset?.type !== 'prop') return { role: null, inferred: false, reason: '' };
  if (propRoles.includes(asset.sourceRole)) return { role: asset.sourceRole, inferred: false, reason: '已保存的原片素材分类' };
  const name = text(asset.name), description = text(asset.description);
  if (graphics.test(name)) return { role: 'graphic', inferred: true, reason: '原片名称明确描述字幕或图形' };
  // Container names win over descriptions of the cream inside them. “面霜罐”
  // remains a jar, even if its description mentions taking cream onto the face.
  if (packages.test(name)) return { role: 'packaging', inferred: true, reason: '原片名称明确描述包装盒' };
  if (jars.test(name)) return { role: 'jar', inferred: true, reason: '原片名称明确描述瓶罐或管状容器' };
  if (materialName.test(name) || materialDescription.test(description) && materialUse.test(description)) return {
    role: 'material', inferred: true, reason: '原片名称或实际用途明确描述用于涂抹的膏体、液体或粉体',
  };
  return { role: 'object', inferred: true, reason: '尚未明确为瓶罐、包装盒或涂抹材质，按其他实物处理' };
}

export function propRole(asset, edit) {
  if (asset?.type !== 'prop') return null;
  return propRoles.includes(edit?.propRole) ? edit.propRole : propRoleEvidence(asset).role;
}
export const isPhysicalProp = (asset, edit) => ['jar', 'packaging', 'object'].includes(propRole(asset, edit));

/** Classification is human/model evidence, never an inference from the upload name. */
export function referenceRoleIssue(asset, edit) {
  if (asset?.type !== 'prop') return null;
  const sourceRole = propRole(asset, edit), imageRole = propRoles.includes(edit?.uploadedImageRole) ? edit.uploadedImageRole : null;
  const issue = (code, blocking, message) => ({ code, severity: blocking ? 'error' : 'warning', blocking, message, assetId: asset.id, sourceRole, imageRole });
  if (sourceRole === 'material' && materialReferenceMode(edit) === 'image' && !edit?.main) return issue('material_reference_missing', true,
    `「${asset.name}」（${asset.id}）选择了图片材质参考，请上传实际可见膏体的图片，或改为运动主导。`);
  if (!edit?.main) return null;
  if (sourceRole === 'material' && materialReferenceMode(edit) === 'motion') return imageRole && imageRole !== 'material'
    ? issue('material_reference_audit_only', false, `「${asset.name}」（${asset.id}）采用运动主导，上传图仅保存供核对，不把其中的罐、包装或固定膏块形状送入视频生成。需要改变颜色和质地时，请填写材质说明。`)
    : null;
  if (!imageRole) return issue('prop_reference_unconfirmed', false, `「${asset.name}」（${asset.id}）的参考图分类尚未确认，请查看图片核对；软件不会根据文件名猜测图中是罐、包装盒还是膏体。`);
  if (sourceRole === 'material') {
    if (imageRole === 'graphic') return issue('prop_reference_role_mismatch', true, `「${asset.name}」（${asset.id}）是膏体或液体材质，不能使用字幕或图形参考。`);
    if (imageRole !== 'material') return issue('material_reference_container', false, `「${asset.name}」（${asset.id}）只参考图片中实际可见膏体的颜色和质地，不替换成整只罐、包装或其他实物。建议裁出清晰膏体；看不到膏体时请更换图片。`);
    return null;
  }
  const differentContainer = ['jar', 'packaging'].includes(sourceRole) && ['jar', 'packaging'].includes(imageRole) && sourceRole !== imageRole;
  const materialOnObject = isPhysicalProp(asset, edit) && ['material', 'graphic'].includes(imageRole);
  const graphicOnObject = sourceRole === 'graphic' && imageRole !== 'graphic';
  if (differentContainer || materialOnObject || graphicOnObject) return issue('prop_reference_role_mismatch', true,
    `「${asset.name}」（${asset.id}）的原片分类为${propRoleLabels[sourceRole]}，参考图分类为${propRoleLabels[imageRole]}，两者不匹配。请核对原片分类或重新上传对应图片，不能静默把罐换成盒或把实物图贴到膏体上。`);
  if (['jar', 'packaging'].includes(sourceRole) && imageRole === 'object') return issue('prop_reference_unspecific', false,
    `「${asset.name}」（${asset.id}）的参考图仅标为其他实物，请进一步确认是对应的${propRoleLabels[sourceRole]}，避免罐与包装盒错绑。`);
  return null;
}
