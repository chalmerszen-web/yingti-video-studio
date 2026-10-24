import { narrationEditor } from './narration-ui.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const stamp = n => `${Math.floor(n / 60).toString().padStart(2, '0')}:${(n % 60).toFixed(2).padStart(5, '0')}`;

export function completeScript(project, includeEdits = false) {
  const changes = new Map((project.edits.dialogues || []).filter(l => l.enabled).map(l => [l.id, l]));
  const lines = project.story.dialogues.map(line => includeEdits && changes.has(line.id) ? { ...line, ...changes.get(line.id) } : line);
  if (includeEdits) lines.push(...(project.edits.dialogues || []).filter(l => l.enabled && !project.story.dialogues.some(o => o.id === l.id)));
  lines.sort((a, b) => a.start - b.start);
  const multiple = new Set(lines.map(l => l.characterId)).size > 1;
  return lines.filter(l => l.text.trim()).map(l => multiple ? `[${l.characterId || '旁白'}] ${l.text}` : l.text).join('\n');
}

export function initializeFullDialogue(project, edits) {
  if (edits.fullDialogue) return false;
  const legacy = (edits.dialogues || []).some(l => l.enabled);
  edits.fullDialogue = { enabled: legacy, text: legacy ? completeScript(project, true) : '', speakerId: 'auto' };
  return legacy;
}

export function allocationPreview(plan, error, demo = false, dirty = false) {
  if (demo) return '<p class="script-allocation-note">示例可体验全文输入。真实项目保存后，会在本地自动分配时间，不单独调用模型。</p>';
  if (dirty) return '<p class="script-allocation-note">正在保存全文，保存后会自动更新分配预览。</p>';
  if (error) return `<p class="notice error">${esc(error)}</p>`;
  if (!plan?.dialoguePlan?.enabled) return '<p class="script-allocation-note">当前保留原台词。启用整篇替换并填写正文后，会自动生成预览。</p>';
  const people = plan.people || {};
  if (plan.blockers?.length) return `<p class="notice error">${esc(plan.blockers.join('\n'))}</p><p class="script-allocation-note">全文仍保存在上方输入框；请修正无效输入后再提交。</p>`;
  return `<p class="script-allocation-note">全文 ${plan.dialoguePlan.characterCount} 字符，可用时间约 ${plan.dialoguePlan.speakingSeconds.toFixed(1)} 秒；本次分配发声约 ${plan.dialoguePlan.estimatedSpeechSeconds.toFixed(1)} 秒。${['duration-fit', 'visual-segments'].includes(plan.dialoguePlan.timingMode) ? '已按当前时长安排全文，语速提示仅供参考，可继续生成。' : '优先按自然语速和原镜头安排。'}以下为自动安排，无需逐项填写，生成后请预听语速与口型。</p><div class="script-table-wrap"><table class="script-allocation-table"><thead><tr><th>时间</th><th>说话人</th><th>自动分配的新台词</th></tr></thead><tbody>${plan.dialoguePlan.lines.map(line => `<tr><td>${stamp(line.start)}<br>— ${stamp(line.end)}</td><td>${esc(people[line.characterId] || line.characterId || '旁白')}</td><td>${esc(line.text)}</td></tr>`).join('')}</tbody></table></div>`;
}

export function fullDialogueEditor(project, edits, options = {}) {
  const full = edits.fullDialogue || { enabled: false, text: '', speakerId: 'auto' };
  const people = project.story.assets.filter(a => a.type === 'character');
  const independent = ['voiceover','uploaded'].includes(full.delivery);
  const count = [...full.text].length;
  const original = completeScript(project);
  const placeholder = people.length > 1 ? `单人口播：直接粘贴完整正文。\n\n多人对话可写：\n${people[0].name}：第一位人物的台词。\n${people[1].name}：第二位人物的台词。` : '直接粘贴完整的新台词。\n\n不需要时间戳，也不需要与原来的句数对应。软件会自动分配时间；默认沿用原片说话人，也可以在下方指定。';
  return `<section class="full-dialogue-editor"><div class="full-dialogue-heading"><label class="full-dialogue-toggle"><input id="full-dialogue-enabled" type="checkbox" ${full.enabled ? 'checked' : ''}>替换整篇台词</label><span class="script-mode-badge ${full.enabled ? 'enabled' : ''}">${full.enabled ? '整篇新台词生效' : '默认保留原台词'}</span></div><p class="full-dialogue-intro">直接粘贴完整口播稿或对话，无需输入时间戳，也不需要与原来的句数对应。未启用时保留原对白。</p>${options.migrated ? '<div class="notice info">已把旧版保存的台词修改整理成全文，原修改记录仍保留。保存后使用整篇模式。</div>' : ''}<label class="full-dialogue-label" for="full-dialogue-text">完整替换台词</label><textarea id="full-dialogue-text" rows="12" maxlength="20000" ${full.enabled ? '' : 'disabled'} placeholder="${esc(placeholder)}">${esc(full.text)}</textarea><div class="full-dialogue-toolbar"><button class="secondary" data-action="copy-original-script" type="button">使用原台词作为底稿</button><span id="full-script-counter">${count} / 20000 字符</span></div><div class="full-speaker-control"><label for="full-dialogue-speaker">未标注人物时，交给谁说</label><select id="full-dialogue-speaker" ${full.enabled && !independent ? '' : 'disabled'}><option value="auto" ${full.speakerId === 'auto' ? 'selected' : ''}>沿用原片的说话顺序</option>${people.map(p => `<option value="${p.id}" ${full.speakerId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}<option value="narrator" ${full.speakerId === 'narrator' ? 'selected' : ''}>画外旁白</option></select></div><label class="full-dialogue-label" for="full-dialogue-pronunciation">发音说明（可选，不改正文）</label><textarea id="full-dialogue-pronunciation" rows="2" maxlength="1200" ${full.enabled ? '' : 'disabled'} placeholder="例如：VC 按英文字母 V、C 朗读；填写品牌名或特殊词的读法">${esc(full.pronunciation || '')}</textarea>${narrationEditor(project, full, options)}${people.length > 1 ? `<div class="script-role-help"><p>多人对话可在每次发言前标注人物名。点击下方按钮可插入标签：</p><div class="script-role-buttons">${people.map(p => `<button type="button" class="secondary" data-action="insert-script-role" data-person="${p.id}" ${full.enabled && !independent ? '' : 'disabled'}>${esc(p.name)}</button>`).join('')}</div></div>` : ''}<div class="script-policy-note">整篇替换会移除所有原对白，并按新正文生成声音。软件保留全文和发言顺序，不会为凑时长自动删词；软件优先按完整句子分配；稿件偏长时提示语速风险，仍可按当前稿件生成。必要时按标点或词语边界分段，保留全文和原镜头。</div><details class="full-script-details"><summary>查看原片完整台词（只读）</summary><pre class="script-original">${esc(original || '原片没有识别到明确对白。')}</pre></details><details class="full-script-details" id="full-allocation-details"><summary>查看自动时间分配（只读，无需逐段修改）</summary><div id="full-script-allocation">${allocationPreview(options.plan, options.error, options.demo, options.dirty)}</div></details></section>`;
}
