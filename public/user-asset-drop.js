const imageFile = /\.(png|jpe?g|webp|bmp)$/i;
const audioFile = /\.(wav|mp3|m4a|aac|ogg|flac)$/i;

export function validateAssetFiles(files, slot) {
  const selected = Array.from(files || []);
  if (!['main', 'views', 'voice', 'finish'].includes(slot)) throw new Error('请选择对应的素材导入区域。');
  if (slot === 'views' ? ![1, 3].includes(selected.length) : selected.length !== 1) {
    throw new Error(slot === 'views' ? '三视图请导入 1 张合图，或按正面、侧面、背面顺序导入 3 张图片。' : slot === 'voice' ? '参考音色每次只能导入 1 个音频文件。' : slot === 'finish' ? '薄匀终态每次只能导入 1 张图片。' : '主视图每次只能导入 1 张图片。');
  }
  if (selected.some(file => file.size === 0)) throw new Error('文件为空或不是有效文件，请重新选择素材。');
  if (selected.some(file => file.size > 20 * 1024 ** 2)) throw new Error('单个素材不能超过 20 MB。');
  if (selected.some(file => !(slot === 'voice' ? audioFile : imageFile).test(file.name))) {
    throw new Error(slot === 'voice' ? '请导入 WAV、MP3、M4A、AAC、OGG 或 FLAC 音频。' : '请导入 JPG、PNG、WebP 或 BMP 图片。');
  }
  return selected; // Preserve the same file order as the existing picker workflow.
}

/** Only finish uploads carry an already validated, frozen actor identifier. */
export function assetUploadForm(files, slot, characterId = '') {
  const selected = validateAssetFiles(files, slot);
  if (slot === 'finish' && (typeof characterId !== 'string' || !characterId)) throw new Error('请先选择薄匀终态图对应的涂抹人物。');
  const form = new FormData();
  selected.forEach(file => form.append('file', file));
  if (slot === 'finish') form.append('characterId', characterId);
  return form;
}

export function bindAssetDrop(root, onFiles, onError) {
  const hasFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files') || event.dataTransfer?.files?.length > 0;
  const zoneAt = event => {
    const zone = event.target?.closest?.('[data-asset-drop]');
    return zone && root.contains(zone) ? zone : null;
  };
  const clear = () => root.querySelectorAll('[data-asset-drop].dragover').forEach(zone => zone.classList.remove('dragover'));
  const enter = event => {
    if (!hasFiles(event)) return;
    const zone = zoneAt(event); if (!zone) return;
    event.preventDefault(); zone.classList.add('dragover');
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };
  const leave = event => {
    const zone = zoneAt(event);
    if (zone && !zone.contains(event.relatedTarget)) zone.classList.remove('dragover');
  };
  const drop = async event => {
    const zone = zoneAt(event); if (!zone || !hasFiles(event)) return;
    event.preventDefault(); event.stopPropagation(); clear();
    try { await onFiles(zone.dataset.asset, zone.dataset.slot, Array.from(event.dataTransfer.files)); }
    catch (error) { onError(error.message); }
  };
  const handlers = { dragenter:enter, dragover:enter, dragleave:leave, drop, dragend:clear };
  for (const [type, handler] of Object.entries(handlers)) root.addEventListener(type, handler);
  return () => { for (const [type, handler] of Object.entries(handlers)) root.removeEventListener(type, handler); clear(); };
}

// An accidental file drop outside a target must not replace the app with that file.
export function preventFileNavigation(root) {
  const prevent = event => {
    if (Array.from(event.dataTransfer?.types || []).includes('Files') || event.dataTransfer?.files?.length) event.preventDefault();
  };
  root.addEventListener('dragover', prevent); root.addEventListener('drop', prevent);
  return () => { root.removeEventListener('dragover', prevent); root.removeEventListener('drop', prevent); };
}
