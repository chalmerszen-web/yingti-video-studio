// One rule shared by the workbench, planning and frozen generation requests.
export const CHARACTER_EDIT_POLICY = 'views-or-main-character-v2';
export function characterEditMode(edit) {
  if (edit?.views) return 'appearance';
  return edit?.main ? 'face' : 'preserve';
}
export function visualSlots(asset, edit) {
  return (asset.type === 'character' ? ['main', 'views'] : ['main']).filter(slot => edit?.[slot]);
}
export const characterModeLabels = Object.freeze({ preserve: '保持原样', face: '仅换脸', appearance: '替换人物造型' });
export function characterModes(story, edits) {
  return Object.fromEntries(story.assets.filter(asset => asset.type === 'character').map(asset => [asset.id, characterEditMode(edits.assets[asset.id])]));
}
