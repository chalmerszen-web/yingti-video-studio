import { AppError, invariant } from './errors.js';
import { isPhysicalProp, propRole } from '../public/prop-role.js';

export const PRODUCT_SCOPE_VERSION = 'product-instances-v1';
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const props = project => new Map((project.story?.assets || []).filter(asset => asset.type === 'prop').map(asset => [asset.id, asset]));
const mainImage = (project, id) => project.edits?.assets?.[id]?.main;
export const isProductProp = (asset, edit) => isPhysicalProp(asset, edit);
const productProp = (project, asset) => isProductProp(asset, project.edits?.assets?.[asset?.id]);

/** Only human-confirmed relations are executable; old analysis names never form groups. */
export function normalizeProductScope(project, input = project.edits?.productScope) {
  if (input === undefined) return { groups: [] };
  invariant(object(input) && Array.isArray(input.groups) && input.groups.length <= 60, '商品关联格式不正确，最多建立 60 个商品组。');
  const assets = props(project), ids = new Set(), membership = new Set(), edges = new Map();
  const groups = input.groups.map(group => {
    invariant(object(group) && typeof group.id === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(group.id) && !ids.has(group.id), '商品组编号缺失、重复或格式无效。');
    ids.add(group.id);
    invariant(typeof group.name === 'string' && group.name.trim() && group.name.length <= 120, '请填写不超过 120 字的商品组名称。');
    invariant(Array.isArray(group.assetIds) && group.assetIds.length > 0 && group.assetIds.length <= 100 && new Set(group.assetIds).size === group.assetIds.length, '商品组必须包含不重复的商品或包装编号。');
    for (const id of group.assetIds) {
      invariant(typeof id === 'string' && productProp(project, assets.get(id)), '商品组只能关联已识别的实物商品和包装，不能关联人物、场景、字幕贴纸或膏体材质。');
      invariant(!membership.has(id), '同一商品或包装不能同时属于多个商品组，请先核对关联范围。');
      membership.add(id);
    }
    const rawContainers = group.containers ?? [];
    invariant(Array.isArray(rawContainers) && rawContainers.length <= 100, '商品容器关联格式不正确。');
    const containerIds = new Set();
    const containers = rawContainers.map(container => {
      invariant(object(container) && typeof container.assetId === 'string' && productProp(project, assets.get(container.assetId)), '容器必须对应已识别的实物道具，不能把涂抹膏体作为容器。');
      invariant(!containerIds.has(container.assetId), '同一商品组的容器不能重复，请合并内部商品编号。');
      containerIds.add(container.assetId);
      invariant(Array.isArray(container.contains) && container.contains.length > 0 && new Set(container.contains).size === container.contains.length, '请为容器选择不重复的内部商品或包装。');
      for (const id of container.contains) {
        invariant(group.assetIds.includes(id) && id !== container.assetId, '容器内部只能关联本商品组中的其他商品或包装，不能包含自身。');
        if (!edges.has(container.assetId)) edges.set(container.assetId, new Set());
        edges.get(container.assetId).add(id);
      }
      return { assetId: container.assetId, contains: [...container.contains] };
    });
    const targetBrand = group.targetBrand ?? '';
    invariant(typeof targetBrand === 'string' && targetBrand.length <= 120, '目标品牌须为不超过 120 字的明确文字。');
    return { id: group.id, name: group.name.trim(), assetIds: [...group.assetIds], containers, targetBrand: targetBrand.trim() };
  });
  const visiting = new Set(), visited = new Set();
  const visit = id => {
    invariant(!visiting.has(id), '商品容器关系不能循环，请核对谁包含谁。');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const contained of edges.get(id) || []) visit(contained);
    visiting.delete(id); visited.add(id);
  };
  for (const id of edges.keys()) visit(id);
  return { groups };
}

/** Include references in every segment so an incomplete shot catalog cannot omit them. */
export function selectProductAssetIds(project, visibleIds = []) {
  normalizeProductScope(project);
  const assets = new Map((project.story?.assets || []).map(asset => [asset.id, asset]));
  // Material refs are selected separately by confirmed actor/region/action time.
  // A shot catalogue ID alone must not turn cream into a global solid object.
  const selected = new Set(visibleIds.filter(id => propRole(assets.get(id), project.edits?.assets?.[id]) !== 'material'));
  for (const asset of project.story?.assets || []) if (productProp(project, asset) && mainImage(project, asset.id)) selected.add(asset.id);
  return selected;
}

export function productScopeWarnings(project) {
  const { groups } = normalizeProductScope(project), assets = props(project), warnings = [];
  for (const group of groups) {
    if (!group.assetIds.some(id => mainImage(project, id))) continue;
    const missing = group.assetIds.filter(id => !mainImage(project, id));
    if (missing.length) warnings.push(`商品组「${group.name}」中${missing.map(id => `「${assets.get(id).name}」（${id}）`).join('、')}未上传替换图，将保留各自外观；其他成员的参考图不会自动用于这些对象。`);
    for (const container of group.containers) {
      const targets = container.contains.filter(id => mainImage(project, id));
      if (targets.length && !mainImage(project, container.assetId)) warnings.push(`「${assets.get(container.assetId).name}」（${container.assetId}）外部保持原样，内部${targets.map(id => `「${assets.get(id).name}」`).join('、')}的全部可见实例按对应替换图修改。`);
    }
  }
  const uploaded = [...assets.values()].filter(asset => productProp(project, asset) && mainImage(project, asset.id));
  if (uploaded.length) warnings.push('已上传的实物替换图将覆盖该对象全片所有可见实例，包括开盒、成排陈列和已确认容器内部；镜头未出现该对象时不新增。未建立商品关联的其他道具仍保持原样。');
  return warnings;
}

export function assertProductReferenceBudget(segment, maxImages = 10) {
  invariant(Number.isInteger(maxImages) && maxImages > 0, '图片数量限制无效。');
  const images = (segment.bindings || []).filter(binding => binding.type === 'reference_image');
  if (images.length <= maxImages) return;
  const error = new AppError(`第 ${(segment.index || 0) + 1} 段需要 ${images.length} 张图片，超过 WAN 的 ${maxImages} 张限制；全片商品参考不能被静默省略，请减少替换对象或合并同一人物的参考图后再生成。`, 400, 'product_reference_budget');
  error.details = { segmentIndex: segment.index || 0, imageCount: images.length, limit: maxImages, assetIds: [...new Set(images.map(binding => binding.assetId))] };
  throw error;
}

/** The same frozen scope is consumed by the edit prompt and output review. */
export function productScopeReviewTargets(project, segment) {
  const { groups } = normalizeProductScope(project), assets = props(project), references = new Map();
  let index = 0;
  for (const binding of segment.bindings || []) {
    if (binding.type !== 'reference_image') continue;
    index++;
    if (binding.slot === 'main' && productProp(project, assets.get(binding.assetId))) references.set(binding.assetId, { imageIndex: index, file: binding.file });
  }
  const targets = [...references].map(([assetId, reference]) => {
    const group = groups.find(item => item.assetIds.includes(assetId));
    return {
      assetId, sourceName: assets.get(assetId).name, reference, allInstances: true,
      expectedVisibility: 'match_source_only', targetBrand: group?.targetBrand || '', groupIds: group ? [group.id] : [],
      containedBy: groups.flatMap(item => item.containers.filter(container => container.contains.includes(assetId)).map(container => ({ assetId: container.assetId, sourceName: assets.get(container.assetId).name, replaceExterior: references.has(container.assetId) }))),
    };
  });
  const containers = groups.flatMap(group => group.containers.filter(container => container.contains.some(id => references.has(id))).map(container => ({
    assetId: container.assetId, sourceName: assets.get(container.assetId).name, groupId: group.id,
    exterior: references.has(container.assetId) ? 'replace' : 'preserve',
    containedAssetIds: container.contains.filter(id => references.has(id)),
  })));
  return { version: PRODUCT_SCOPE_VERSION, targets, containers };
}

export function productScopeLocks(project, segment) {
  const scope = productScopeReviewTargets(project, segment);
  if (!scope.targets.length) return [];
  const lines = ['【全部商品实例替换】原片资产名称、旧品牌和旧包装文字仅用于定位，不是输出目标，也不作为新台词朗读。同一对象在本段所有实际可见实例均使用各自对应参考，含前景、背景陈列、开盒展示、成排商品和已确认容器内的商品；参考图不授权新增原片没有的商品。'];
  for (const target of scope.targets) {
    lines.push(`「${target.sourceName}」（${target.assetId}）的全部可见实例使用图片${target.reference.imageIndex}；该图片只对应此资产，不误用于未指定的其他道具。外形、配色、材质、附件和可辨识标识前后一致；涉及瓶罐或包装时，包括瓶身、瓶盖、盒体。随原片开合、旋转、接触、遮挡及数量连续变化，不恢复旧外观；已分别提供瓶罐和盒子替换图时，不出现新瓶配旧盒。${target.targetBrand ? ` 本商品组明确指定的目标品牌文字为「${target.targetBrand}」，逐字保留；不可辨识的细小包装字不猜写。` : ' 未明确提供目标品牌文字时不猜测、编造或纠正品牌名称。'}`);
  }
  for (const container of scope.containers) {
    const labels = container.containedAssetIds.map(id => `${id}（图片${scope.targets.find(target => target.assetId === id).reference.imageIndex}）`).join('、');
    lines.push(`容器「${container.sourceName}」（${container.assetId}）内部属于${labels}的每一件可见商品仍必须分别替换，不能因只识别到容器就漏换其内部商品。${container.exterior === 'preserve' ? '容器外壳、透明材质、提手和人物握持位置保持原样，内部商品的替换不改变容器外部。' : '容器外部仅按它自己的替换图处理，不借用内部商品图片替换容器。'} 保留内外遮挡、原有数量、布局和提起运动。`);
  }
  lines.push('本段没有出现某个参考对象时不把它补入画面。没有对应替换图的对象及无图商品组成员保持各自原样；只保留它们不代表允许已上传参考的商品残留旧品牌、旧配色或旧包装。');
  return lines;
}

export function productScopeForAsset(project, assetId) {
  const asset = props(project).get(assetId);
  if (!productProp(project, asset) || !mainImage(project, assetId)) return null;
  const detectedRanges = (project.story.shots || []).filter(shot => (shot.propIds || []).includes(assetId)).map(shot => ({ start: shot.start, end: shot.end }));
  return { mode: 'all_appearances', ranges: [{ start: 0, end: project.source.duration }], detectedRanges };
}

export function productScopeFromEdits(project, input) {
  return normalizeProductScope(project, own(input || {}, 'productScope') ? input.productScope : project.edits?.productScope);
}
