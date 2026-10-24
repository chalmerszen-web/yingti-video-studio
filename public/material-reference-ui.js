import { propRole } from './prop-role.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const baseUrl = (project, asset) => `/api/projects/${encodeURIComponent(project.id)}/assets/${encodeURIComponent(asset.id)}`;

/** Freeze the actor before a save/render can replace the selector. */
export function finishReferenceCharacter(project, asset, edit, selectedId) {
  if (propRole(asset, edit) !== 'material') throw new Error('薄匀终态图只能用于膏体或液体材质，请先确认素材分类。');
  if (typeof selectedId !== 'string' || !selectedId) throw new Error('请先选择薄匀终态图对应的涂抹人物，再导入同一目标人物的图片。');
  if (!(project.story?.assets || []).some(item => item.type === 'character' && item.id === selectedId)
    || !(project.story?.actions || []).some(action => action.propId === asset.id && action.characterId === selectedId && ['apply', 'spread', 'residue'].includes(action.type)))
    throw new Error('薄匀终态图的人物与此材质的涂抹动作不对应，请重新选择，不能借用其他人物的状态图。');
  return selectedId;
}

/** Shared crop and finish-image controls; application handlers perform uploads. */
export function materialReferenceTools(project, asset, edit = {}, demo = false) {
  if (propRole(asset, edit) !== 'material') return '';
  const ids = new Set((project.story?.actions || []).filter(action => action.propId === asset.id && ['apply', 'spread', 'residue'].includes(action.type)).map(action => action.characterId).filter(Boolean));
  const actors = (project.story?.assets || []).filter(item => item.type === 'character' && (ids.has(item.id) || item.id === edit.materialFinish?.characterId));
  const selected = edit.materialFinish?.characterId || (actors.length === 1 ? actors[0].id : '');
  const url = baseUrl(project, asset), main = edit.main, finish = edit.materialFinish;
  return `<section class="material-reference-tools"><h5>材质取样与涂后状态</h5><p class="asset-view-help">取样只选图片中清楚可见的膏体，避开罐沿、包装和文字。运动模式下图片留存核对；图片模式下使用所选膏体区域。</p>${main?.file ? `<button type="button" class="secondary" data-action="material-crop" data-asset="${esc(asset.id)}" ${demo ? 'disabled' : ''}>${main.materialFile ? '重新选取膏体区域' : '选取图片中的膏体区域'}</button>` : '<p class="asset-view-help">上传材质图片后，可在图上拖选膏体区域。</p>'}${main?.materialFile && !demo ? `<figure class="material-reference-preview"><img src="${url}/material/media?v=${encodeURIComponent(main.materialRevision || '')}" alt="${esc(asset.name)}已选膏体区域"><figcaption>已选取局部膏体${main.cropRect ? ` · ${main.cropRect.width} × ${main.cropRect.height}` : ''}</figcaption></figure>` : ''}<label class="full-dialogue-label">薄匀终态对应人物<select class="studio-input" data-finish-character="${esc(asset.id)}" ${demo ? 'disabled' : ''}><option value="">${actors.length ? '选择此涂抹动作对应的人物' : '请先确认涂抹动作对应的人物'}</option>${actors.map(actor => `<option value="${esc(actor.id)}" ${selected === actor.id ? 'selected' : ''}>${esc(actor.name)} · ${esc(actor.id)}${ids.has(actor.id) ? '' : '（已保存，未关联当前动作）'}</option>`).join('')}</select></label><button type="button" class="reference-upload material-finish-drop" data-asset-drop data-action="choose-asset" data-asset="${esc(asset.id)}" data-slot="finish" aria-label="${esc(asset.id)} 点击或拖入薄匀终态图" ${demo || !actors.length ? 'disabled' : ''}><span>${finish ? '点击或拖入图片，更换薄匀终态' : '点击或拖入薄匀终态图'}</span><small>1 张图片 · 与所选目标人物一致</small></button><input type="file" class="file-input" tabindex="-1" id="asset-${esc(asset.id)}-finish" data-asset="${esc(asset.id)}" data-slot="finish" accept=".png,.jpg,.jpeg,.webp,.bmp">${finish?.file && !demo ? `<figure class="material-reference-preview"><img src="${url}/finish/media?v=${encodeURIComponent(finish.revision || '')}" alt="${esc(asset.name)}薄匀终态参考"><figcaption>${esc(finish.names?.join('、') || '薄匀终态参考')}<button type="button" data-action="remove-asset" data-asset="${esc(asset.id)}" data-slot="finish">移除</button></figcaption></figure>` : ''}<p class="asset-view-help">终态图只参考对应部位的薄匀肤质，不改变人物身份，也不能一开始删除膏体。必须保留实际接触与推开过程，生成后核验动作和终态。选择人物只用于下一次导入，不会改绑已有状态图；更换人物后须导入该人物的对应图片。</p></section>`;
}

/** Convert two normalized pointer locations to a bounded original-pixel crop. */
export function normalizedCropRect(start, end, width, height) {
  if (![width, height].every(value => Number.isInteger(value) && value >= 24) || !start || !end) return null;
  const clamp = value => Math.min(1, Math.max(0, value));
  if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) return null;
  const x1 = Math.round(clamp(Math.min(start.x, end.x)) * width), x2 = Math.round(clamp(Math.max(start.x, end.x)) * width);
  const y1 = Math.round(clamp(Math.min(start.y, end.y)) * height), y2 = Math.round(clamp(Math.max(start.y, end.y)) * height);
  const result = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  if (result.width < 24 || result.height < 24 || Math.max(result.width / result.height, result.height / result.width) > 8) return null;
  return result;
}

/** No API calls: the caller saves the confirmed rectangle and refreshes state. */
export function openMaterialCrop(project, asset, onConfirm) {
  const main = project.edits?.assets?.[asset.id]?.main;
  if (!main?.file || typeof onConfirm !== 'function') throw new Error('请先上传此素材的图片。');
  const width = Number(main.width), height = Number(main.height);
  if (![width, height].every(value => Number.isInteger(value) && value >= 24)) throw new Error('图片尺寸信息不完整，请重新导入图片。');
  const dialog = document.createElement('dialog');
  dialog.className = 'material-crop-dialog';
  dialog.setAttribute('aria-label', '选取膏体取样区域');
  dialog.innerHTML = `<div class="dialog-heading"><h2>选取膏体区域</h2><button type="button" class="secondary" data-crop-cancel>取消</button></div><div class="dialog-body"><p>在图片上拖出矩形，只框清楚可见的膏体，避开罐沿、标签及包装。</p><div class="material-crop-stage"><img src="${baseUrl(project, asset)}/main/media?v=${encodeURIComponent(main.revision || '')}" alt="${esc(asset.name)}原始参考图" draggable="false"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><rect class="material-crop-selection" x="0" y="0" width="0" height="0"></rect></svg></div><p class="material-crop-status" role="status">拖动选取区域，最小24 × 24像素。</p><div class="material-crop-actions"><button type="button" class="primary" data-crop-save disabled>保存取样区域</button></div></div>`;
  document.body.append(dialog);
  const image = dialog.querySelector('img'), stage = dialog.querySelector('.material-crop-stage'), selection = dialog.querySelector('rect');
  const save = dialog.querySelector('[data-crop-save]'), cancel = dialog.querySelector('[data-crop-cancel]'), status = dialog.querySelector('[role=status]');
  let anchor = null, current = null, crop = null, busy = false, loaded = false;
  const point = event => {
    const bounds = image.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height };
  };
  const draw = () => {
    crop = normalizedCropRect(anchor, current, width, height);
    if (crop) {
      for (const key of ['x', 'y', 'width', 'height']) selection.setAttribute(key, crop[key]);
      status.textContent = `已选 ${crop.width} × ${crop.height} 像素；确认区域只包含实际可见膏体。`;
    } else {
      for (const key of ['width', 'height']) selection.setAttribute(key, 0);
      status.textContent = '区域太小或太狭长，请重新拖选清晰的膏体区域。';
    }
    save.disabled = !crop || busy;
  };
  image.addEventListener('load', () => {
    loaded = true;
    if (main.cropRect) {
      anchor = { x: main.cropRect.x / width, y: main.cropRect.y / height };
      current = { x: (main.cropRect.x + main.cropRect.width) / width, y: (main.cropRect.y + main.cropRect.height) / height };
      draw(); anchor = null;
    }
  });
  image.addEventListener('error', () => { loaded = false; status.textContent = '图片加载失败，请关闭后重新打开。'; });
  stage.addEventListener('pointerdown', event => {
    if (!loaded || busy || event.button !== 0) return;
    event.preventDefault(); anchor = point(event); current = anchor; stage.setPointerCapture(event.pointerId); draw();
  });
  stage.addEventListener('pointermove', event => { if (anchor && !busy) { current = point(event); draw(); } });
  stage.addEventListener('pointerup', event => {
    if (!anchor || busy) return;
    current = point(event); draw(); anchor = null;
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
  });
  stage.addEventListener('pointercancel', () => { anchor = null; });
  cancel.addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  save.addEventListener('click', async () => {
    if (!crop || busy) return;
    busy = true; save.disabled = true; cancel.disabled = true; status.textContent = '正在保存取样区域…';
    try { await onConfirm({ ...crop }); dialog.close(); }
    catch (error) { status.textContent = error?.message || '保存失败，请重试。'; busy = false; save.disabled = false; cancel.disabled = false; }
  });
  dialog.showModal();
  return dialog;
}
