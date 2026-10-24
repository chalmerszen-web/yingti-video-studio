import { invariant } from './errors.js';
import { createHash } from 'node:crypto';
import { REFERENCE_SPEECH_RATE, DEFAULT_SPEECH_RATE } from '../public/generation-policy.js';

const FPS = 30;
const MAX_SLOT = 12 * FPS;
const compact = text => text.replace(/\s+/gu, '');
export const blankFullDialogue = () => ({ enabled: false, text: '', speakerId: 'auto' });
export function fullDialogueScriptHash(project, full = project.edits.fullDialogue) {
  return createHash('sha256').update(parseFullDialogue(full?.text || '', project.story.assets).spokenText.replace(/\s+/gu,'')).digest('hex');
}

export function validateFullDialogue(project, input) {
  invariant(input && typeof input.enabled === 'boolean' && typeof input.text === 'string', '整篇台词格式不正确。');
  invariant(input.text.length <= 20000, '整篇台词最多 20000 字符，请精简后再保存。');
  const speakerId = input.speakerId ?? 'auto';
  invariant(['auto', 'narrator'].includes(speakerId) || project.story.assets.some(a => a.type === 'character' && a.id === speakerId), '整篇台词的默认说话人不存在。');
  invariant(input.pronunciation === undefined || typeof input.pronunciation === 'string' && input.pronunciation.length <= 1200, '发音说明最多 1200 字符。');
  const delivery = input.delivery ?? 'generated';
  invariant(['generated', 'voiceover', 'uploaded'].includes(delivery), '请选择有效的台词声音制作方式。');
  const voiceId = input.voiceId ?? '';
  invariant(typeof voiceId === 'string' && (!voiceId || /^voice_[A-Za-z0-9_-]{1,180}$/.test(voiceId)), '请使用当前账户已有的公开音色编号。');
  const speed = input.speed ?? 1;
  invariant(Number.isFinite(Number(speed)) && Number(speed) >= 0.5 && Number(speed) <= 2, '配音语速须在 0.5–2.0 范围内。');
  const criticalTerms = input.criticalTerms ?? '';
  invariant(typeof criticalTerms === 'string' && criticalTerms.length <= 1200, '重点核对词最多 1200 字符。');
  const subtitles = input.subtitles ?? (input.enabled ? 'replace' : 'preserve');
  invariant(['replace', 'remove', 'preserve'].includes(subtitles), '字幕处理选项无效。');
  const subtitlesExplicit=input.subtitlesExplicit ?? false;
  invariant(typeof subtitlesExplicit==='boolean','字幕选择状态无效。');
  invariant(!input.enabled || delivery === 'generated' || speakerId === 'narrator', '独立配音适用于画外口播，请选择画外旁白；需要人物对口型时使用画内对白。');
  return { enabled: input.enabled, text: input.text.replace(/\r\n?/g, '\n'), speakerId, delivery, voiceId, speed: Number(speed), criticalTerms: criticalTerms.trim(), subtitles, subtitlesExplicit, ...(input.pronunciation !== undefined ? { pronunciation: input.pronunciation.trim() } : {}) };
}

function speakerResolver(assets) {
  const names = new Map();
  const add = (name, id) => {
    if (!name) return;
    if (names.has(name) && names.get(name) !== id) names.set(name, undefined);
    else names.set(name, id);
  };
  for (const asset of assets.filter(a => a.type === 'character')) {
    add(asset.id, asset.id); add(asset.name.trim(), asset.id);
    add(asset.name.split(/[·（(]/)[0].trim(), asset.id);
  }
  for (const label of ['旁白', '画外音', 'narrator']) if (!names.has(label)) names.set(label, null);
  return label => ({ found: names.has(label) && names.get(label) !== undefined, id: names.get(label) });
}

export function parseFullDialogue(text, assets) {
  const resolve = speakerResolver(assets);
  const input = text.replace(/\r\n?/g, '\n').trim();
  const paragraphs = input.split('\n');
  const identify = line => {
    const bracket = /^\s*[\[【]([^\]】]+)[\]】]\s*[:：]?\s*(.*)$/.exec(line);
    const colon = /^\s*([^:：\n]{1,50})[:：]\s*(.*)$/.exec(line);
    const match = bracket || colon;
    if (!match) return null;
    const label = match[1].trim(), person = resolve(label);
    return { label, ...person, content: match[2], explicit: !!bracket || /^C\d+$/i.test(label) };
  };
  const marked = paragraphs.map(identify);
  const labelled = marked.some(m => m?.found || m?.explicit);
  if (!labelled) return { blocks: [{ text: input, characterId: undefined }], labelled: false, spokenText: input };
  const blocks = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const line = paragraphs[i], mark = marked[i];
    if (!line.trim()) continue;
    if (mark) {
      invariant(mark.found, `未识别说话人「${mark.label}」，请使用原片人物名称、C 编号或「旁白」。`);
      blocks.push({ text: mark.content, characterId: mark.id });
    } else if (blocks.length) blocks.at(-1).text += '\n' + line;
    else blocks.push({ text: line, characterId: undefined });
  }
  invariant(blocks.every(b => b.text.trim()), '角色标签后需要填写台词正文。');
  return { blocks, labelled: true, spokenText: blocks.map(b => b.text).join('\n') };
}

function speechUnits(blocks) {
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
  const units = [];
  for (const [index, block] of blocks.entries()) {
    const local = []; let prefix = '';
    for (const item of segmenter.segment(block.text)) {
      if (item.isWordLike) {
        const han = [...item.segment].filter(c => /\p{Script=Han}/u.test(c)).length;
        const symbols = [...item.segment].length;
        const weight = han || (/^[A-Z]{2,6}$|^\d[\d.,]*$/u.test(item.segment) ? symbols : Math.max(1, symbols / 3));
        local.push({ text: prefix + item.segment, weight, characterId: block.characterId }); prefix = '';
      } else if (local.length) local.at(-1).text += item.segment;
      else prefix += item.segment;
    }
    invariant(local.length, '台词需要包含可发声的文字，不能只有标点或角色标签。');
    if (index < blocks.length - 1) local.at(-1).text += '\n';
    for (const item of local) { item.boundary = /[。！？!?；;\n][”’"」』）)]*\s*$/u.test(item.text) ? 2 : /[，,：:]\s*$/u.test(item.text) ? 1 : 0; units.push(item); }
  }
  return units;
}

function speechSlots(project, warnings) {
  const duration = project.source?.duration ?? Math.max(...project.story.shots.map(s => s.end), ...project.story.dialogues.map(s => s.end), 0);
  invariant(Number.isFinite(duration) && duration > 0 && duration <= 600, '无法确定整篇台词的可用视频时长。');
  const totalFrames = Math.max(1, Math.round(duration * FPS));
  const original = project.story.dialogues.map(line => ({ start: Math.max(0, Math.round(line.start * FPS)), end: Math.min(totalFrames, Math.round(line.end * FPS)), characterId: line.characterId ?? null })).filter(s => s.end > s.start);
  let ranges;
  if (!original.length) {
    const people = project.story.assets.filter(a => a.type === 'character');
    ranges = [{ start: 0, end: totalFrames, characterId: people.length === 1 ? people[0].id : null, ambiguous: false }];
    warnings.push('原片未识别出对白时段，将在视频时长内安排整篇台词；请预览说话人与语速。');
  } else {
    const boundaries = [...new Set(original.flatMap(s => [s.start, s.end]))].sort((a, b) => a - b);
    ranges = [];
    for (let i = 1; i < boundaries.length; i++) {
      const start = boundaries[i - 1], end = boundaries[i], active = original.filter(s => s.start < end && s.end > start);
      if (!active.length) continue;
      const speakers = [...new Set(active.map(s => s.characterId))];
      ranges.push({ start, end, characterId: speakers.length === 1 ? speakers[0] : null, ambiguous: speakers.length > 1 });
    }
  }
  const slots = [];
  for (const range of ranges) for (let start = range.start; start < range.end; start += MAX_SLOT) slots.push({ ...range, start, end: Math.min(start + MAX_SLOT, range.end) });
  return { slots, duration };
}

export function speechWeight(text) {
  return /[\p{L}\p{N}]/u.test(text) ? speechUnits([{ text, characterId: null }]).reduce((sum, unit) => sum + unit.weight, 0) : 0;
}

function dialogueWindows(project, start, end) {
  const shots = project.story.shots;
  const cuts = [...new Set([start, end, ...shots.flatMap(s => [Math.round(s.start * FPS), Math.round(s.end * FPS)]).filter(frame => frame > start && frame < end)])].sort((a, b) => a - b);
  return cuts.slice(1).map((stop, i) => {
    const first = cuts[i], middle = (first + stop) / (2 * FPS);
    const shot = shots.find(s => s.start <= middle && s.end >= middle);
    return { start: first, end: stop, shotId: shot?.id || null, characterIds: shot?.characterIds || [] };
  });
}

// Complete sentences stay in one analyzed source shot and one generation request.
// Prefer natural pace and source-shot boundaries; estimates are advisory.
function allocateSentences(sentences, windows, rate, visiblePeople) {
  const lines = []; let cursor = windows[0].start;
  for (const sentence of sentences) {
    const minFrames = Math.max(1, Math.ceil(sentence.weight / REFERENCE_SPEECH_RATE * FPS));
    if (minFrames > MAX_SLOT) return null;
    const preferredFrames = Math.max(minFrames, Math.min(MAX_SLOT, Math.ceil(sentence.weight / rate * FPS)));
    let placed = false;
    for (const window of windows) {
      if (window.end <= cursor) continue;
      if (sentence.characterId && visiblePeople.has(sentence.characterId) && !window.characterIds.includes(sentence.characterId)) continue;
      const start = Math.max(cursor, window.start), available = window.end - start;
      if (available < minFrames) continue;
      const frames = Math.min(preferredFrames, available);
      const end = start + frames;
      lines.push({ id: 'FULL' + String(lines.length + 1).padStart(3, '0'), start: Number((start / FPS).toFixed(3)), end: Number((end / FPS).toFixed(3)), characterId: sentence.characterId, text: sentence.text, shotId: window.shotId, changed: true, fullReplacement: true, originalText: '', uncertain: false });
      cursor = end; placed = true; break;
    }
    if (!placed) return null;
  }
  return lines;
}

// If the preferred schedule cannot fit, still submit the complete user script.
// Prefer sentence boundaries, then punctuation, and never split a word or role.
function allocateToDuration(units, startFrame, availableFrames, estimatedRate, windows) {
  const weight = units.reduce((sum, unit) => sum + unit.weight, 0);
  const frames = Math.min(availableFrames, Math.max(1, Math.ceil(weight / estimatedRate * FPS)));
  const maximumWeight = frames <= MAX_SLOT ? weight : weight * MAX_SLOT / frames * 0.98;
  const chunks = []; let partialSentences = false;
  for (let cursor = 0; cursor < units.length;) {
    const speaker = units[cursor].characterId;
    let end = cursor, used = 0, sentenceBreak = -1, pauseBreak = -1;
    while (end < units.length && units[end].characterId === speaker) {
      if (used + units[end].weight > maximumWeight && end > cursor) break;
      used += units[end].weight;
      if (units[end].boundary === 2) sentenceBreak = end + 1;
      if (units[end].boundary) pauseBreak = end + 1;
      end++;
      if (used >= maximumWeight) break;
    }
    if (end < units.length && units[end].characterId === speaker) {
      if (sentenceBreak > cursor) end = sentenceBreak;
      else if (pauseBreak > cursor) end = pauseBreak;
      if (units[end - 1].boundary !== 2) partialSentences = true;
    }
    invariant(end > cursor, '无法为台词安排有效时间。');
    const selected = units.slice(cursor, end), chunkWeight = selected.reduce((sum, unit) => sum + unit.weight, 0);
    invariant(chunkWeight / weight * frames <= MAX_SLOT + 0.01, '单个连续词语无法放进生成分段，请在稿件中补充标点或空格。');
    chunks.push({ text: selected.map(unit => unit.text).join('').trim(), weight: chunkWeight, characterId: speaker });
    cursor = end;
  }
  invariant(chunks.length <= frames && chunks.length <= 600, '人物切换过密，无法分配有效的画面帧。');
  const lengths = chunks.map(chunk => Math.max(1, Math.min(MAX_SLOT, Math.floor(chunk.weight / weight * frames))));
  let remainder = frames - lengths.reduce((sum, length) => sum + length, 0);
  while (remainder) {
    const candidates = lengths.map((_, index) => index).filter(index => remainder > 0 ? lengths[index] < MAX_SLOT : lengths[index] > 1);
    invariant(candidates.length, '无法分配完整台词时间，请调整稿件。');
    candidates.sort((a, b) => remainder > 0 ? chunks[b].weight / weight * frames - lengths[b] - (chunks[a].weight / weight * frames - lengths[a]) : lengths[b] - lengths[a]);
    const delta = remainder > 0 ? 1 : -1; lengths[candidates[0]] += delta; remainder -= delta;
  }
  let cursorFrame = startFrame;
  const lines = chunks.map((chunk, index) => {
    const first = cursorFrame; cursorFrame += lengths[index];
    const window = windows.find(item => item.start <= first && item.end >= cursorFrame);
    return { id: 'FULL' + String(index + 1).padStart(3, '0'), start: Number((first / FPS).toFixed(3)), end: Number((cursorFrame / FPS).toFixed(3)), characterId: chunk.characterId, text: chunk.text, shotId: window?.shotId || null, changed: true, fullReplacement: true, originalText: '', uncertain: false };
  });
  return { lines, partialSentences, speakingSeconds: frames / FPS };
}

function allocateVisualWindows(units, windows) {
  const lines = []; let cursor = 0, partialSentences = false;
  const prefix = [0]; for (const unit of units) prefix.push(prefix.at(-1) + unit.weight);
  for (let i = 0; i < windows.length && cursor < units.length; i++) {
    const window = windows[i], frames = window.end - window.start;
    const remainingFrames = windows.slice(i).reduce((sum, w) => sum + w.end - w.start, 0);
    const target = (prefix.at(-1) - prefix[cursor]) * frames / remainingFrames;
    let end = units.length;
    if (i < windows.length - 1) {
      let best = Infinity;
      for (let stop = cursor + 1; stop <= units.length; stop++) {
        const weight = prefix[stop] - prefix[cursor];
        const punctuation = units[stop - 1].boundary;
        const imbalance = Math.abs(weight - target) / Math.max(1, target);
        const rate = weight / (frames / FPS);
        const remainingWeight = prefix.at(-1) - prefix[stop];
        const remainingSeconds = (remainingFrames - frames) / FPS;
        const nextRate = remainingSeconds > 0 ? remainingWeight / remainingSeconds : 0;
        // Prefer balanced phrases over preserving a sentence at an unnaturally
        // fast pace in one segment. This remains an advisory scheduling cost.
        const score = imbalance * 3 + (punctuation === 2 ? 0 : punctuation === 1 ? 0.12 : 0.35)
          + Math.max(0, rate - REFERENCE_SPEECH_RATE) ** 2 + Math.max(0, nextRate - REFERENCE_SPEECH_RATE) ** 2;
        if (score < best) { best = score; end = stop; }
        if (weight > target * 1.6) break;
      }
      if (end < units.length && units[end - 1].boundary !== 2) partialSentences = true;
    }
    const selected = units.slice(cursor, end), groups = []; let group;
    for (const unit of selected) {
      if (!group || group.characterId !== unit.characterId) { group = { text: '', weight: 0, characterId: unit.characterId }; groups.push(group); }
      group.text += unit.text; group.weight += unit.weight;
      if (unit.boundary === 2) group = null;
    }
    invariant(groups.length <= frames, '此时段发言切换过密，请调整人物标签或标点。');
    const weight = selected.reduce((sum, unit) => sum + unit.weight, 0);
    let first = window.start, used = 0;
    for (let n = 0; n < groups.length; n++) {
      const chunk = groups[n]; used += chunk.weight;
      const last = n === groups.length - 1 ? window.end : Math.max(first + 1, Math.min(window.end - (groups.length - n - 1), window.start + Math.round(used / weight * frames)));
      lines.push({ id: 'FULL' + String(lines.length + 1).padStart(3, '0'), start: Number((first / FPS).toFixed(3)), end: Number((last / FPS).toFixed(3)), characterId: chunk.characterId, text: chunk.text.trim(), shotId: null, changed: true, fullReplacement: true, originalText: '', uncertain: false });
      first = last;
    }
    cursor = end;
  }
  invariant(cursor === units.length, '未能容纳完整台词，未提交生成。');
  return { lines, partialSentences, speakingSeconds: windows.reduce((n, w) => n + w.end - w.start, 0) / FPS };
}

export function compileFullDialogue(project, visualRanges) {
  const full = validateFullDialogue(project, project.edits.fullDialogue);
  if (!full.enabled) return { enabled: false, lines: [], warnings: [], blockers: [], spokenText: '', characterCount: 0, speakingSeconds: 0 };
  invariant(full.text.trim(), '请粘贴完整的新台词；不替换时取消「替换整篇台词」。');
  const parsed = parseFullDialogue(full.text, project.story.assets), units = speechUnits(parsed.blocks), warnings = [], blockers = [];
  if (full.delivery !== 'generated' && parsed.blocks.some(block => block.characterId != null)) blockers.push('独立画外配音不支持人物对话标签，请改为旁白全文或选择画内对白。');
  if (full.delivery === 'voiceover' && !full.voiceId) blockers.push('精确画外配音需要选择当前账户已有音色；也可以导入已录好的整篇配音。');
  if (full.delivery === 'uploaded' && !project.edits.narration?.file) blockers.push('请导入与当前全文一致的整篇配音。');
  else if (full.delivery === 'uploaded' && project.edits.narration?.scriptHash !== fullDialogueScriptHash(project, full)) blockers.push('全文已修改或录音尚未关联当前稿件，请重新导入与当前全文一致的录音，避免新字幕配旧台词。');
  const { slots, duration } = speechSlots(project, warnings);
  if (full.speakerId === 'auto' && units.some(u => u.characterId === undefined) && slots.some(s => s.ambiguous)) invariant(false, '原片有多人同时发声，请给整篇台词标注人物名，或选择一个默认说话人。');
  const totalWeight = units.reduce((n, u) => n + u.weight, 0);
  const availableFrames = slots.at(-1).end - slots[0].start, speakingSeconds = availableFrames / FPS;
  const originalSeconds = slots.reduce((n, slot) => n + slot.end - slot.start, 0) / FPS;
  const oldWeight = speechWeight(project.story.dialogues.map(line => line.text).join('\n'));
  const estimatedRate = oldWeight ? Math.max(2, Math.min(REFERENCE_SPEECH_RATE, oldWeight / originalSeconds)) : DEFAULT_SPEECH_RATE;
  const speakers = project.story.dialogues.slice().sort((a, b) => a.start - b.start).map(line => line.characterId ?? null);
  let sentenceIndex = 0;
  for (const unit of units) {
    if (unit.characterId === undefined) unit.characterId = full.speakerId === 'auto' ? speakers[Math.min(sentenceIndex, speakers.length - 1)] ?? slots[0].characterId : full.speakerId === 'narrator' ? null : full.speakerId;
    if (unit.boundary === 2) sentenceIndex++;
  }
  const sentences = []; let current;
  for (const unit of units) {
    if (!current || current.characterId !== unit.characterId) { current = { text: '', weight: 0, characterId: unit.characterId }; sentences.push(current); }
    current.text += unit.text; current.weight += unit.weight;
    if (unit.boundary === 2) current = null;
  }
  sentences.forEach(sentence => { sentence.text = sentence.text.trim(); });
  invariant(sentences.length <= 600, '新台词句数超过 600，请合并过短的句子。');
  const minimumSeconds = totalWeight / REFERENCE_SPEECH_RATE;
  const budget = { speechUnits: Number(totalWeight.toFixed(2)), requestedRate: Number((totalWeight / speakingSeconds).toFixed(2)), referenceRate: REFERENCE_SPEECH_RATE, recommendedRate: Number(estimatedRate.toFixed(2)), referenceSeconds: Number(minimumSeconds.toFixed(2)), availableSeconds: Number(speakingSeconds.toFixed(2)), approximateCapacity: Math.floor(speakingSeconds * REFERENCE_SPEECH_RATE) };
  if (minimumSeconds > speakingSeconds + 0.001) warnings.push(`台词偏快（仅提醒，可继续生成）：约 ${Math.ceil(totalWeight)} 个发声字/单位，原片 ${speakingSeconds.toFixed(1)} 秒，估计 ${(totalWeight / speakingSeconds).toFixed(1)} 字/秒。每秒 ${REFERENCE_SPEECH_RATE} 字只是软件参考值，不是 WAN 硬性限制。全文会完整提交，较快语速可能出现吞字或错读，请预览确认。`);
  const generationWindows = visualRanges?.map(range => ({ start: Math.max(slots[0].start, range.startFrame), end: Math.min(slots.at(-1).end, range.startFrame + range.frames) })).filter(w => w.end > w.start);
  const windows = generationWindows ? generationWindows.flatMap(w => dialogueWindows(project, w.start, w.end)) : dialogueWindows(project, slots[0].start, slots.at(-1).end);
  const visiblePeople = new Set(project.story.shots.flatMap(shot => shot.characterIds));
  let lines = [], allocatedRate = estimatedRate, timingMode = 'source-shot';
  if (minimumSeconds <= speakingSeconds + 0.001) {
    const rates = [...new Set([estimatedRate, ...Array.from({ length: 17 }, (_, i) => 2 + i * 0.25).filter(rate => rate > estimatedRate), REFERENCE_SPEECH_RATE])];
    for (const rate of rates) { const candidate = allocateSentences(sentences, windows, rate, visiblePeople); if (candidate) { lines = candidate; allocatedRate = rate; break; } }
  }
  if (!lines.length) {
    const fitted = generationWindows ? allocateVisualWindows(units, generationWindows) : allocateToDuration(units, slots[0].start, availableFrames, estimatedRate, windows);
    lines = fitted.lines; allocatedRate = totalWeight / fitted.speakingSeconds; timingMode = generationWindows ? 'visual-segments' : 'duration-fit';
    warnings.push('已按当前原片时长分配完整稿件，优先在句末分段；部分台词可能跨原片切镜，原镜头仍保留。可以继续生成，成片请核对语速、口型和说话人。');
    if (fitted.partialSentences) warnings.push('个别长句需在标点或词语边界分配到相邻生成段；全文和词语顺序没有删改。');
  }
  invariant(lines.length && compact(lines.map(line => line.text).join('')) === compact(parsed.spokenText), '整篇台词分配校验失败，未提交生成。');
  const estimatedSpeechSeconds = totalWeight / allocatedRate;
  const phraseBudget = lines.map(line => ({ id: line.id, start: line.start, end: line.end, units: speechWeight(line.text), rate: Number((speechWeight(line.text) / (line.end - line.start)).toFixed(2)) }));
  for (const phrase of phraseBudget.filter(item => item.rate > REFERENCE_SPEECH_RATE + 0.05)) warnings.push(`台词 ${phrase.id} 在 ${phrase.start.toFixed(1)}–${phrase.end.toFixed(1)} 秒约 ${phrase.rate.toFixed(1)} 字/秒，局部语速偏快；正文未删改，建议使用独立配音或调整停顿。此值不是平台限制。`);
  if (lines.length && lines.at(-1).end < slots.at(-1).end / FPS * 0.8) warnings.push('新稿比原稿短，可提前说完；未安排新台词的时间不再保留原对白。');
  if (!parsed.labelled && full.speakerId === 'auto' && new Set(speakers).size > 1) warnings.push('未标注人物，已按原片发言顺序安排完整句子；请核对说话人。');
  if (parsed.labelled) warnings.push(timingMode === 'source-shot' ? '按人物标签保留发言顺序，完整句子安排在同一个分析镜头内；分镜时间仍需人工核对。' : '按人物标签保留发言顺序，时间按当前视频重新分配；请核对画面中的说话人。');
  return { enabled: true, lines, warnings, blockers, timingMode, spokenText: parsed.spokenText, delivery: full.delivery, phraseBudget, pronunciation: full.pronunciation || '', characterCount: [...compact(parsed.spokenText)].length, speakingSeconds: Number(speakingSeconds.toFixed(3)), estimatedSpeechSeconds: Number(estimatedSpeechSeconds.toFixed(3)), speechBudget: budget, labelled: parsed.labelled };
}
