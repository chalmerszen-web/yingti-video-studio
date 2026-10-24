import { isPhysicalProp } from './prop-role.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const physicalProps = (project, edits = project.edits) => (project.story?.assets || []).filter(asset => isPhysicalProp(asset, edits?.assets?.[asset.id]));
const groupsOf = edits => edits.productScope?.groups || [];
const imageLabel = (edits, id) => edits.assets?.[id]?.main ? '已上传替换图' : '未上传图，保持原样';

/** Shared, always-open controls for the customer and developer workbenches. */
export function productScopeEditor(project, edits = project.edits) {
  const props = physicalProps(project, edits), groups = groupsOf(edits);
  if (!props.length) return '';
  const used = new Set(groups.flatMap(group => group.assetIds));
  const canAdd = props.some(asset => !used.has(asset.id)) && groups.length < 60;
  return `<section class="full-dialogue-editor product-scope-editor" data-product-scope-editor><div class="full-dialogue-heading"><h3>商品与包装关联</h3><button type="button" class="secondary" data-action="product-scope-add" ${canAdd ? '' : 'disabled'}>新增商品组</button></div><p class="full-dialogue-intro">上传的商品图会用于全片中这个商品的所有出现处。把同款瓶罐、包装盒放进同一组，再勾选提袋或盒子里装着的商品，可减少内部包装漏换。原片没有出现的商品不会新增。</p>${groups.length ? groups.map((group, index) => {
    const members = new Set(group.assetIds), otherGroups = new Set(groups.filter(item => item.id !== group.id).flatMap(item => item.assetIds));
    const controls = `data-product-group="${esc(group.id)}"`;
    return `<article class="action-observation product-scope-group" ${controls}><div class="action-heading"><strong>商品组 ${index + 1}</strong><button type="button" class="secondary" data-action="product-scope-remove" data-group-id="${esc(group.id)}">删除此组</button></div><label class="full-dialogue-label">组名称<input type="text" class="studio-input" data-product-scope="name" ${controls} maxlength="120" value="${esc(group.name)}" placeholder="例如：面霜与包装"></label><label class="full-dialogue-label">目标品牌文字（可选）<input type="text" class="studio-input" data-product-scope="target-brand" ${controls} maxlength="120" value="${esc(group.targetBrand || '')}" placeholder="填写确认后的品牌名，不会自动改写口播稿"></label><fieldset class="product-scope-members"><legend>选择这组商品和包装</legend><div class="review-actions">${props.map(asset => `<label class="full-dialogue-toggle"><input type="checkbox" data-product-scope="member" ${controls} data-asset-id="${esc(asset.id)}" ${members.has(asset.id) ? 'checked' : ''} ${otherGroups.has(asset.id) ? 'disabled' : ''}><span>${esc(asset.name)}<small> · ${otherGroups.has(asset.id) ? '已在其他商品组' : imageLabel(edits, asset.id)}</small></span></label>`).join('')}</div></fieldset><fieldset class="product-scope-containers"><legend>容器里面装着哪些商品</legend><p class="full-dialogue-intro">逐项勾选实际装在里面的商品。未上传容器替换图时，袋子或盒子外部保持原样，内部已上传图的商品仍会替换。</p>${props.map(container => {
      const available = props.filter(asset => members.has(asset.id) && asset.id !== container.id);
      if (!available.length) return '';
      const selected = new Set((group.containers || []).find(item => item.assetId === container.id)?.contains || []);
      return `<div class="product-scope-container"><strong>${esc(container.name)}里面：</strong><div class="review-actions">${available.map(asset => `<label class="full-dialogue-toggle"><input type="checkbox" data-product-scope="contains" ${controls} data-container-id="${esc(container.id)}" data-asset-id="${esc(asset.id)}" ${selected.has(asset.id) ? 'checked' : ''}>${esc(asset.name)}</label>`).join('')}</div></div>`;
    }).join('')}</fieldset></article>`;
  }).join('') : '<p class="script-allocation-note">尚未建立商品组。每张替换图仍只对应自己的商品；新增组后，可明确关联包装和提袋内的商品。</p>'}<p class="script-policy-note">每个商品和包装使用自己上传的图片；未上传图的成员保持原样。不同商品不会自动合并，也不会把包装图用作瓶罐图。</p></section>`;
}

/** Read only rendered controls; server validation remains authoritative. */
export function readProductScopeEditor(container, project, edits = project?.edits) {
  const editor = container?.matches?.('[data-product-scope-editor]') ? container : container?.querySelector?.('[data-product-scope-editor]');
  if (!editor) return project?.edits?.productScope ? structuredClone(project.edits.productScope) : { groups: [] };
  const allowed = project ? new Set(physicalProps(project, edits).map(asset => asset.id)) : null;
  const groups = [...editor.querySelectorAll('.product-scope-group')].map(card => {
    const fields = [...card.querySelectorAll('[data-product-scope]')];
    const value = key => fields.find(field => field.dataset.productScope === key)?.value || '';
    const assetIds = fields.filter(field => field.dataset.productScope === 'member' && field.checked && (!allowed || allowed.has(field.dataset.assetId))).map(field => field.dataset.assetId);
    const contained = new Map();
    for (const field of fields.filter(field => field.dataset.productScope === 'contains' && field.checked)) {
      const { containerId, assetId } = field.dataset;
      if (!assetIds.includes(assetId) || containerId === assetId || allowed && !allowed.has(containerId)) continue;
      if (!contained.has(containerId)) contained.set(containerId, new Set());
      contained.get(containerId).add(assetId);
    }
    return { id: card.dataset.productGroup, name: value('name'), targetBrand: value('target-brand'), assetIds: [...new Set(assetIds)], containers: [...contained].map(([assetId, contents]) => ({ assetId, contains: [...contents] })) };
  });
  return { groups };
}

/** Called by the existing delegated click handler, followed by modified/render. */
export function applyProductScopeAction(project, edits, buttonOrDataset) {
  const data = buttonOrDataset?.dataset || buttonOrDataset;
  if (!['product-scope-add', 'product-scope-remove'].includes(data?.action)) return false;
  edits.productScope ||= { groups: [] };
  if (data.action === 'product-scope-remove') {
    edits.productScope.groups = edits.productScope.groups.filter(group => group.id !== data.groupId);
    return true;
  }
  const used = new Set(edits.productScope.groups.flatMap(group => group.assetIds));
  const available = physicalProps(project, edits).filter(asset => !used.has(asset.id));
  const first = available.find(asset => edits.assets?.[asset.id]?.main) || available[0];
  if (!first || edits.productScope.groups.length >= 60) return false;
  edits.productScope.groups.push({ id: `G_${globalThis.crypto.randomUUID()}`, name: `商品组 ${edits.productScope.groups.length + 1}`, assetIds: [first.id], containers: [], targetBrand: '' });
  return true;
}
