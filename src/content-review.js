import { invariant } from './errors.js';
import { parseFullDialogue } from './full-dialogue.js';
import { normalizeProductScope, isProductProp } from './product-scope.js';
import { actionContracts } from './continuity.js';

export const QUALITY_VERSION = 3;
export const QUALITY_KINDS = ['framing', 'boundary', 'material', 'dialogue', 'subtitles', 'products'];
const confidenceLevels = ['high', 'medium', 'low'];
const numeralPattern = /[零〇一二两三四五六七八九十百千万亿]+/gu;
const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const units = { 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 };

function chineseNumber(value) {
  if (value.includes('两') && value.length > 1 && ![...value].some(c => units[c])) return value;
  if (![...value].some(c => units[c])) return [...value].map(c => digits[c]).join('');
  let total = 0, section = 0, number = 0;
  for (const c of value) {
    if (digits[c] !== undefined) { number = digits[c]; continue; }
    const unit = units[c];
    if (unit < 10000) { section += (number || 1) * unit; number = 0; }
    else { section += number; total = unit === 100000000 ? (total + section) * unit : total + section * unit; section = 0; number = 0; }
  }
  return String(total + section + number);
}

// Permit punctuation and spoken numeric spellings only. Homophones, brand
// aliases and semantic rewrites are deliberately not treated as an exact match.
export function normalizeSpokenText(value = '') {
  const expanded = String(value).normalize('NFKC').toLowerCase().replace(numeralPattern, chineseNumber).replace(/(?<=\d)点(?=\d)/g, '.');
  return expanded.replace(/[\s\p{P}\p{S}]/gu, (character, position) => character === '.' && /\d/.test(expanded[position - 1] || '') && /\d/.test(expanded[position + 1] || '') ? '.' : '');
}

const intersects = (line, start, end) => Number.isFinite(line.start) && Number.isFinite(line.end) && line.start < end && line.end > start;

export function contentExpectation(job, window) {
  const recipe = job.recipe || {}, story = recipe.story || {}, edits = recipe.edits || {};
  const coreStart = window.coreStart ?? job.segments?.find(s => s.index === window.segmentIndex)?.start ?? window.start;
  const coreEnd = coreStart + (window.coreDuration ?? job.segments?.find(s => s.index === window.segmentIndex)?.duration ?? window.duration);
  let lines = recipe.dialoguePlan?.lines || job.dialoguePlan?.lines;
  if (!lines) {
    const frozen = job.segments?.flatMap(s => s.dialogueLines || []);
    if (frozen?.length) lines = [...new Map(frozen.map(line => [line.id, line])).values()];
    else {
      const changes = new Map((edits.dialogues || []).filter(l => l.enabled).map(l => [l.id, l]));
      lines = [...(story.dialogues || []).map(l => changes.has(l.id) ? { ...l, ...changes.get(l.id) } : l), ...(edits.dialogues || []).filter(l => l.enabled && !(story.dialogues || []).some(o => o.id === l.id))];
    }
  }
  const overlapping = lines.filter(l => intersects(l, coreStart, coreEnd)).sort((a, b) => a.start - b.start);
  const partial = overlapping.some(l => l.start < coreStart - 0.04 || l.end > coreEnd + 0.04);
  const text = overlapping.map(l => l.text || '').join('');
  const allText = lines.map(l => l.text || '').join('');
  const independentSpeech = ['voiceover', 'uploaded'].includes(edits.fullDialogue?.delivery);
  const frozenText = recipe.dialoguePlan?.spokenText ?? job.dialoguePlan?.spokenText ?? (edits.fullDialogue?.enabled && typeof edits.fullDialogue.text === 'string' ? parseFullDialogue(edits.fullDialogue.text, story.assets || []).spokenText : allText);
  const contract = job.contentContract || recipe.contentContract || {};
  const productScope = normalizeProductScope(recipe);
  const dialogueCritical = typeof edits.fullDialogue?.criticalTerms === 'string' ? edits.fullDialogue.criticalTerms.split(/[，,、;；\n|/]/u).map(term => term.trim()).filter(Boolean) : [];
  const targetBrands = productScope.groups.map(group => group.targetBrand).filter(Boolean);
  const allCriticalTerms = [...new Set([...(contract.brands || []), ...(contract.criticalTerms || []), ...dialogueCritical, ...targetBrands])];
  const props = (story.assets || []).filter(a => isProductProp(a, edits.assets?.[a.id]) && edits.assets?.[a.id]?.main).map(a => ({ id: a.id, name: a.name, description: a.description, notes: edits.assets[a.id].notes || '' }));
  const authorizedBrands = normalizeSpokenText(allText + targetBrands.join(''));
  const oldBrands = edits.fullDialogue?.enabled || contract.brands?.length ? props.flatMap(a => (a.name || '').match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) || []).filter(value => !authorizedBrands.includes(normalizeSpokenText(value))) : [];
  const forbiddenTerms = [...new Set([...(contract.forbiddenTerms || []), ...oldBrands])];
  const materialActions = recipe.story ? actionContracts(recipe, { start: window.start, duration: window.duration }) : [];
  return {
    coreStart, coreEnd, localStart: Math.max(0, coreStart - window.start), localEnd: Math.min(window.duration, coreEnd - window.start),
    lines: overlapping.map(({ id, start, end, text }) => ({ id, start, end, text })), text, partial,
    criticalTerms: allCriticalTerms.filter(term => normalizeSpokenText(text).includes(normalizeSpokenText(term))), allCriticalTerms,
    forbiddenTerms, numbers: normalizeSpokenText(text).match(/\d+(?:\.\d+)?/g) || [], subtitleNumbers: normalizeSpokenText(allText).match(/\d+(?:\.\d+)?/g) || [], props, productScope,
    referenceAssetIds: window.referenceAssetIds || job.quality?.referenceAssetIds || [],
    fullReplacement: edits.fullDialogue?.enabled === true,
    independentSpeech, frozenText,
    materialActions,
  };
}

function validateObservationTime(item, window, range = false) {
  if (range) invariant(Number.isFinite(item.start) && Number.isFinite(item.end) && item.start >= 0 && item.end >= item.start && item.end <= window.duration + 0.001, '台词听辨时间超出检查范围。', 422);
  else invariant(Number.isFinite(item.time) && item.time >= 0 && item.time <= window.duration, '内容检查证据时间超出范围。', 422);
}

export function normalizeSpeechReview(raw, expected, window) {
  const base = { kind: 'dialogue', status: 'uncertain', time: null, detail: '没有完整、独立的声音听辨证据，台词尚未核验。', expectedText: expected.text, observedText: typeof raw?.heardText === 'string' ? raw.heardText.slice(0, 20000) : '', confidence: raw?.confidence || 'low', coverage: raw?.coverage || 'unavailable' };
  if (!normalizeSpokenText(expected.text) && raw?.audioAvailable === false && raw.coverage === 'silent' && raw.confidence === 'high' && !normalizeSpokenText(base.observedText) && (!raw.observations || raw.observations.length === 0)) return { ...base, status: 'not_applicable', detail: '本段未安排台词，检查素材没有声音轨道，未将预期稿件当作听辨结果。' };
  if (!raw || raw.audioAvailable !== true || !confidenceLevels.includes(raw.confidence) || !['complete', 'partial', 'silent', 'unavailable'].includes(raw.coverage)) return base;
  const observations = Array.isArray(raw.observations) ? raw.observations : [];
  for (const item of observations) {
    validateObservationTime(item, window, true);
    invariant(typeof item.text === 'string' && confidenceLevels.includes(item.confidence), '声音听辨证据格式无效。', 422);
  }
  base.observations = observations;
  if (!expected.independentSpeech && expected.partial) { base.detail = '正文跨越检查区间边界，不能用不完整句子判定逐字通过。'; return base; }
  if (raw.confidence !== 'high' || !['complete', 'silent'].includes(raw.coverage) || observations.some(o => o.confidence !== 'high')) { base.detail = '声音听辨存在缺失或不确定，需要人工核对正文。'; return base; }
  const heard = normalizeSpokenText(base.observedText), target = normalizeSpokenText(expected.text);
  if (!expected.independentSpeech && target && (!observations.length || raw.coverage !== 'complete')) return base;
  const observedByTime = normalizeSpokenText(observations.filter(o => o.start < expected.localEnd && o.end > expected.localStart).map(o => o.text).join(''));
  if (heard !== observedByTime) { base.detail = '独立逐段听辨与汇总正文不一致，不能依据预期稿件判定通过。'; return base; }
  if (expected.independentSpeech) {
    if (observations.some(o => o.start < expected.localStart - 0.04 || o.end > expected.localEnd + 0.04)) { base.detail = '声音观察包含邻段上下文，不能重复计入整篇听辨。'; return base; }
    base.auditReady = true; base.scope = 'full_script'; base.detail = '本区间的独立听辨已保存，等待按实际配音顺序合并核验整篇正文，不按画面估计的句子时段判错。';
    return base;
  }
  const numericMismatch = (heard.match(/\d+(?:\.\d+)?/g) || []).join('|') !== expected.numbers.join('|');
  const criticalMismatches = expected.criticalTerms.filter(term => !heard.includes(normalizeSpokenText(term)));
  const oldTerms = expected.forbiddenTerms.filter(term => heard.includes(normalizeSpokenText(term)));
  base.criticalMismatches = criticalMismatches; base.forbiddenTermsHeard = oldTerms;
  if (heard !== target || numericMismatch || criticalMismatches.length || oldTerms.length) {
    base.status = 'fail'; base.time = Number((window.start + (observations[0]?.start ?? expected.localStart)).toFixed(3));
    base.detail = `独立听辨与冻结台词不一致${numericMismatch ? '，价格或数量等数字发生变化' : ''}${criticalMismatches.length ? `，未听到指定关键词：${criticalMismatches.join('、')}` : ''}${oldTerms.length ? `，仍听到旧词：${oldTerms.join('、')}` : ''}。请核对保存的预期正文与实际听辨正文。`;
  } else { base.status = target ? 'pass' : 'not_applicable'; base.detail = target ? '独立逐段听辨与冻结正文逐字一致；已统一标点和中文数字读法。此结论仍需用户验收。' : '本段未安排台词，独立听辨确认没有人声正文。'; }
  return base;
}

export function normalizeSubtitleReview(raw, expected, window, modelCheck) {
  const check = { ...modelCheck, observations: [], absenceEvidence: typeof raw?.absenceEvidence === 'string' ? raw.absenceEvidence.slice(0, 1800) : '' };
  if (Array.isArray(raw?.observations)) for (const observation of raw.observations) {
    validateObservationTime(observation, window);
    invariant(typeof observation.text === 'string' && confidenceLevels.includes(observation.confidence), '字幕识别证据格式无效。', 422);
    check.observations.push({ ...observation, time: Number((window.start + observation.time).toFixed(3)) });
  }
  const seen = check.observations.filter(o => o.confidence === 'high').map(o => normalizeSpokenText(o.text)).join('|');
  const old = expected.forbiddenTerms.filter(term => seen.includes(normalizeSpokenText(term)));
  const wrongOffers = check.observations.filter(o => o.confidence === 'high' && /只要|到手|拍[一二两三四五六七八九十\d]|元|￥|¥/.test(o.text) && (normalizeSpokenText(o.text).match(/\d+(?:\.\d+)?/g) || []).some(n => !(expected.subtitleNumbers || expected.numbers).includes(n)));
  if (old.length || wrongOffers.length) {
    check.status = 'fail'; check.time = wrongOffers[0]?.time ?? check.observations.find(o => old.some(term => normalizeSpokenText(o.text).includes(normalizeSpokenText(term))))?.time ?? window.start;
    check.detail = `画面仍有与新正文冲突的品牌或优惠文字${old.length ? `：${old.join('、')}` : ''}${wrongOffers.length ? `：${wrongOffers.map(o => o.text).join('；')}` : ''}。`;
  } else if (check.status === 'pass' && (raw?.coverage !== 'complete' || raw?.confidence !== 'high' || (!check.observations.length && !(raw?.visible === false && check.absenceEvidence.trim())) || check.observations.some(o => o.confidence !== 'high'))) { check.status = 'uncertain'; check.time = null; check.detail = '字幕与品牌文字未完成全时段清晰识别，不能判定没有旧信息残留。'; }
  if (check.status === 'not_applicable' && (expected.fullReplacement || expected.props.length || expected.criticalTerms.length)) { check.status = 'uncertain'; check.detail = '本次涉及台词或商品替换，需要检查旧字幕、旧品牌及优惠文字，不能跳过。'; }
  if (check.status === 'fail' && !check.observations.some(o => o.confidence === 'high')) { check.status = 'uncertain'; check.time = null; check.detail = '疑似字幕冲突缺少清晰文字证据，需人工核对，不能将猜测当作确认错误。'; }
  return check;
}

export function normalizeProductReview(raw, expected, window, modelCheck) {
  const check = { ...modelCheck, observations: [], assetCoverage: [], absenceEvidence: typeof raw?.absenceEvidence === 'string' ? raw.absenceEvidence.slice(0, 1800) : '' };
  if (Array.isArray(raw?.observations)) for (const observation of raw.observations) {
    validateObservationTime(observation, window);
    invariant(typeof observation.assetId === 'string' && typeof observation.detail === 'string' && observation.detail.trim() && ['matched', 'old_product', 'mixed', 'uncertain'].includes(observation.status) && confidenceLevels.includes(observation.confidence), '商品实例检查证据格式无效。', 422);
    check.observations.push({ ...observation, time: Number((window.start + observation.time).toFixed(3)) });
  }
  if (Array.isArray(raw?.assetCoverage)) for (const item of raw.assetCoverage) {
    invariant(typeof item.assetId === 'string' && ['visible', 'absent', 'uncertain'].includes(item.visibility) && confidenceLevels.includes(item.confidence) && typeof item.detail === 'string' && item.detail.trim(), '商品检查范围证据格式无效。', 422);
    check.assetCoverage.push({ ...item, detail: item.detail.slice(0, 1800) });
  }
  const failed = check.observations.find(o => o.confidence === 'high' && ['old_product', 'mixed'].includes(o.status));
  if (failed) { check.status = 'fail'; check.time = failed.time; check.detail = `商品实例漏换或混搭：${failed.detail}`; }
  else if (check.status === 'not_applicable' && raw?.coverage === 'complete' && raw?.visible === false && raw?.confidence === 'high' && check.absenceEvidence.trim()) return check;
  else if (expected.props.length && ['pass', 'not_applicable'].includes(check.status)) {
    const referenced = expected.props.every(p => expected.referenceAssetIds.includes(p.id));
    const observed = check.observations.length && check.observations.every(o => o.confidence === 'high' && o.status === 'matched');
    const allAssets = expected.props.every(prop => {
      const rows = check.assetCoverage.filter(item => item.assetId === prop.id);
      return rows.length === 1 && rows[0].confidence === 'high' && (rows[0].visibility === 'absent' || rows[0].visibility === 'visible' && check.observations.some(o => o.assetId === prop.id && o.status === 'matched' && o.confidence === 'high'));
    });
    if (!referenced || raw?.coverage !== 'complete' || raw?.confidence !== 'high' || !observed || !allAssets) { check.status = 'uncertain'; check.time = null; check.detail = !referenced ? '检查没有获得全部目标商品参考图，不能凭商品名称判断替换完成。' : '商品、包装及袋内实例的检查证据不完整，需逐镜头核对是否漏换。'; }
  }
  if (check.status === 'fail' && !failed) { check.status = 'uncertain'; check.time = null; check.detail = '疑似漏换缺少可定位且清晰的商品实例证据，需人工核对。'; }
  return check;
}

const materialStates = ['thick', 'thin', 'none', 'occluded', 'uncertain'];
const materialContact = ['continuous', 'lost', 'occluded', 'not_applicable', 'uncertain'];
const materialProgression = ['spreading', 'static_patch', 'floating', 'disappeared', 'reappeared', 'not_applicable', 'uncertain'];
const clearMaterial = state => ['thick', 'thin', 'none'].includes(state);

// Material conclusions must retain localized observations. A free-form model
// "pass" cannot stand in for a visible, unoccluded endpoint, and white area is
// not a thickness measurement: spreading can increase the covered area.
export function normalizeMaterialReview(raw, expected, window, modelCheck) {
  const actions = expected.materialActions || [];
  const check = { ...modelCheck, status: 'uncertain', time: null, observations: [], actionCoverage: [], absenceEvidence: typeof raw?.absenceEvidence === 'string' ? raw.absenceEvidence.slice(0, 1800) : '' };
  const unverified = detail => ({ ...check, status: 'uncertain', time: null, detail });
  if (Array.isArray(raw?.observations)) for (const item of raw.observations) {
    validateObservationTime(item, window);
    invariant(typeof item.actionId === 'string' && ['entry', 'during', 'exit'].includes(item.phase)
      && materialStates.includes(item.sourceState) && materialStates.includes(item.generatedState)
      && materialContact.includes(item.contact) && materialProgression.includes(item.progression)
      && confidenceLevels.includes(item.confidence) && typeof item.detail === 'string' && item.detail.trim(), '膏体动作检查证据格式无效。', 422);
    check.observations.push({ ...item, localTime: item.time, time: Number((window.start + item.time).toFixed(3)), detail: item.detail.slice(0, 1800) });
  }
  if (Array.isArray(raw?.actionCoverage)) for (const item of raw.actionCoverage) {
    invariant(typeof item.actionId === 'string' && ['visible', 'absent', 'uncertain'].includes(item.visibility)
      && confidenceLevels.includes(item.confidence) && typeof item.detail === 'string' && item.detail.trim(), '膏体动作检查范围证据格式无效。', 422);
    invariant(item.continuityEvidence === undefined || ['same_shot', 'cut', 'occluded', 'uncertain', 'not_applicable'].includes(item.continuityEvidence), '膏体动作连续性证据格式无效。', 422);
    check.actionCoverage.push({ ...item, detail: item.detail.slice(0, 1800) });
  }
  if (!actions.length) {
    if (raw?.visible === false && raw?.confidence === 'high' && raw?.coverage === 'complete' && check.absenceEvidence.trim() && !check.observations.length)
      return { ...check, status: 'not_applicable', detail: '逐时段观察确认没有涂抹过程或可见膏体残留；本段不凭商品名或台词加入涂抹检查。' };
    return unverified('缺少已确认的动作范围或无涂抹的完整观察证据，不能凭笼统结论判定材料动作通过。');
  }
  if (check.observations.some(item => !actions.some(action => action.id === item.actionId
    && item.localTime >= action.localStart - 0.04 && item.localTime <= action.localEnd + 0.04))
    || check.actionCoverage.some(item => !actions.some(action => action.id === item.actionId)))
    return unverified('膏体观察未对应本区间已确认的人物、部位和动作时间，不能套用其他镜头或后续切镜的结论。');
  for (const action of actions) {
    const rows = check.observations.filter(item => item.actionId === action.id
      && item.localTime >= action.localStart - 0.04 && item.localTime <= action.localEnd + 0.04);
    const high = rows.filter(item => item.confidence === 'high');
    const displayMismatch = action.type === 'residue' && high.find(item => ['thin', 'none'].includes(item.sourceState) && item.generatedState === 'thick');
    if (displayMismatch) return { ...check, status: 'fail', time: displayMismatch.time, detail: `涂后展示状态不一致（${action.id}，${action.region}）：原片同一时刻无明显厚膏块，生成片仍有厚块。${displayMismatch.detail}` };
    const physicalFailure = high.find(item => ['floating', 'disappeared', 'reappeared'].includes(item.progression)
      || action.type === 'spread' && item.progression === 'static_patch' && item.contact === 'continuous'
      || ['apply', 'spread'].includes(action.type) && item.contact === 'lost' && item.phase !== 'exit');
    if (physicalFailure) return { ...check, status: 'fail', time: physicalFailure.time, detail: `涂抹接触或材料变化异常（${action.id}，${action.region}）：${physicalFailure.detail}` };
    const exit = high.filter(item => item.phase === 'exit' && Math.abs(item.localTime - action.localEnd) <= 0.35).sort((a, b) => b.localTime - a.localTime)[0];
    if (exit && action.exit?.kind !== 'continuation' && clearMaterial(exit.sourceState) && clearMaterial(exit.generatedState)) {
      const requiresThin = action.exit?.kind === 'spread_finish' || ['thin', 'none'].includes(exit.sourceState);
      if (requiresThin && exit.generatedState === 'thick') return { ...check, status: 'fail', time: exit.time, detail: `推开终态未达到（${action.id}，${action.region}）：${action.exit?.kind === 'spread_finish' ? '已确认目标为薄匀' : '原片同一时刻已无明显厚膏块'}，生成片仍有厚膏块。${exit.detail}` };
      if (action.exit?.kind === 'observed' && exit.sourceState === 'thick' && exit.generatedState !== 'thick') return { ...check, status: 'fail', time: exit.time, detail: `未确认改变涂抹终态（${action.id}）：原片此刻仍有厚膏，生成片提前清除或推匀。${exit.detail}` };
    }
  }
  if (raw?.coverage !== 'complete' || raw?.confidence !== 'high') return unverified('膏体接触过程及终态未完整、清晰观察，不能把遮挡或文字描述当作完成。');
  for (const action of actions) {
    const coverage = check.actionCoverage.filter(item => item.actionId === action.id);
    const rows = check.observations.filter(item => item.actionId === action.id && item.localTime >= action.localStart - 0.04 && item.localTime <= action.localEnd + 0.04);
    const start = rows.find(item => item.phase === 'entry' && Math.abs(item.localTime - action.localStart) <= 0.35);
    const end = rows.find(item => item.phase === 'exit' && Math.abs(item.localTime - action.localEnd) <= 0.35);
    const during = rows.filter(item => item.phase === 'during' && item.localTime > action.localStart + 0.04 && item.localTime < action.localEnd - 0.04);
    if (coverage.length !== 1 || coverage[0].visibility !== 'visible' || coverage[0].confidence !== 'high' || !start || !end || action.type !== 'residue' && !during.length)
      return unverified(`动作 ${action.id} 缺少对应起点、接触过程或终点附近的实际观察，尚未完成涂抹核验。`);
    if (['apply', 'spread'].includes(action.type) && coverage[0].continuityEvidence !== 'same_shot')
      return unverified(`动作 ${action.id} 缺少同一镜头中连续接触至终态的证据；跳剪后的干净脸只能说明后续外观，不能证明厚膏真正被推开。`);
    if (rows.some(item => item.confidence !== 'high' || !clearMaterial(item.sourceState) || !clearMaterial(item.generatedState)))
      return unverified(`动作 ${action.id} 的起止或过程被手遮挡、看不清，无法确认厚块是否真正推散。`);
    if (action.type === 'spread' && !during.some(item => item.contact === 'continuous' && item.progression === 'spreading'))
      return unverified(`动作 ${action.id} 没有手指持续接触并使膏体铺展、变薄的清晰过程证据。`);
    if (['apply', 'spread'].includes(action.type) && during.some(item => ['uncertain', 'occluded'].includes(item.contact) || item.progression === 'uncertain'))
      return unverified(`动作 ${action.id} 的接触与厚薄变化仍不确定，不能判定涂抹完成。`);
    if (['apply', 'spread'].includes(action.type)) {
      const times = [...new Set(rows.map(item => item.localTime))].sort((a, b) => a - b);
      if (times.some((time, index) => index && time - times[index - 1] > 1.04))
        return unverified(`动作 ${action.id} 的材料变化观察间隔超过一秒，不能用少数首尾静帧判定连续铺展。`);
    }
    if (action.type === 'residue' && rows.some(item => item.progression !== 'not_applicable'))
      return unverified(`动作 ${action.id} 仅记录涂后残留，观察却包含未确认的涂抹变化，需要核对动作范围。`);
  }
  return { ...check, status: 'pass', detail: '本区间各已确认动作均有对应起点、接触过程及清晰终点证据；未发现厚块固定、接触丢失或终态冲突。此观察结论仍需用户验收。' };
}

export function summarizeQuality(review) {
  if (!review || review.version !== QUALITY_VERSION) return { state: 'unverified', verdict: 'unverified', reason: '此结果尚未完成新版台词、字幕、商品实例及涂抹过程与终态证据检查。' };
  if (review.state !== 'completed') return { state: 'unverified', verdict: 'unverified', reason: review.error || '内容检查尚未完成。' };
  const windows = review.windows || [];
  if (!windows.length || windows.some(w => w.state !== 'completed' || !Array.isArray(w.result) || w.result.length !== QUALITY_KINDS.length || QUALITY_KINDS.some(kind => w.result.filter(c => c.kind === kind).length !== 1) || w.result.some(c => !['pass', 'fail', 'uncertain', 'not_applicable'].includes(c.status) || typeof c.detail !== 'string' || !c.detail.trim()))) return { state: 'unverified', verdict: 'unverified', reason: '内容检查项目缺失或格式无效，不能判定通过。' };
  const checks = windows.flatMap(w => w.result);
  if (review.speechAudit && !['pass', 'fail'].includes(review.speechAudit.status)) return { state: 'uncertain', verdict: 'uncertain', reason: '整篇独立配音尚未核验清晰，需要人工核对。' };
  if (review.speechAudit?.status === 'fail') return { state: 'issues', verdict: 'issues', reason: '整篇独立配音与冻结正文不一致，需要修正。' };
  if (checks.some(c => c.status === 'fail')) return { state: 'issues', verdict: 'issues', reason: '检查发现台词、画面文字、商品或动作问题，需要修正。' };
  if (checks.some(c => c.status === 'uncertain')) return { state: 'uncertain', verdict: 'uncertain', reason: '部分正文或画面无法确认，需要人工核对。' };
  return { state: 'passed', verdict: 'no_issues_detected', reason: '本轮六项检查未发现问题，仍需用户验收。' };
}

export function contentReviewState(job) {
  if (['voiceover', 'uploaded'].includes(job?.recipe?.edits?.fullDialogue?.delivery) && job.quality?.state === 'completed' && !job.quality.speechAudit) return { state: 'unverified', verdict: 'unverified', reason: '独立整篇配音尚未合并核验全文，不能使用估计句界判定通过。' };
  return summarizeQuality(job?.quality);
}

export function auditFullSpeech(job, windows = job.quality?.windows || []) {
  const first = windows[0];
  if (!first) return { status: 'uncertain', detail: '没有完整声音检查区间。', observedText: '', expectedText: '', time: null };
  const expected = contentExpectation(job, first);
  if (!expected.independentSpeech) return null;
  const ordered = [...windows].sort((a, b) => (a.coreStart ?? a.start) - (b.coreStart ?? b.start));
  const parts = ordered.map(w => ({ window: w, check: w.result?.find(c => c.kind === 'dialogue') }));
  const heardText = parts.map(p => p.check?.observedText || '').join('');
  const base = { version: QUALITY_VERSION, scope: 'full_script', status: 'uncertain', expectedText: expected.frozenText, observedText: heardText, time: null, detail: '各区间独立听辨尚未全部清晰完成，整篇台词不能判定通过。' };
  if (parts.some(p => p.window.state !== 'completed' || p.check?.auditReady !== true)) return base;
  // The core ranges must tile the actual result. Overlaps duplicate spoken
  // words and gaps can hide omissions; contextual padding is never included.
  let end = 0;
  for (const { window: w } of parts) {
    const start = w.coreStart ?? w.start, duration = w.coreDuration ?? w.duration;
    if (Math.abs(start - end) > 0.04 || !Number.isFinite(duration) || duration <= 0) { base.detail = '声音核心区间不连续或重叠，不能拼接上下文文字判定通过。'; return base; }
    end = start + duration;
  }
  const duration = (job.segments || []).reduce((sum, s) => sum + (Number.isFinite(s.frames) ? s.frames / 30 : s.duration || 0), 0);
  if (duration && Math.abs(end - duration) > 0.04) { base.detail = '声音检查未覆盖完整成片时长，不能判定整篇台词通过。'; return base; }
  const target = normalizeSpokenText(expected.frozenText), heard = normalizeSpokenText(heardText);
  if (target === heard) return { ...base, status: 'pass', detail: '按实际配音时刻合并的独立听辨与冻结整篇正文逐字一致；已统一标点及中文数字读法，未使用画面估计句界。' };
  const wrongTerms = expected.forbiddenTerms.filter(term => heard.includes(normalizeSpokenText(term)));
  const criticalMismatches = expected.allCriticalTerms.filter(term => target.includes(normalizeSpokenText(term)) && !heard.includes(normalizeSpokenText(term)));
  const numericMismatch = (heard.match(/\d+(?:\.\d+)?/g) || []).join('|') !== (target.match(/\d+(?:\.\d+)?/g) || []).join('|');
  let position = 0;
  while (position < Math.min(target.length, heard.length) && target[position] === heard[position]) position++;
  let counted = 0, time = end;
  for (const { window: w, check } of parts) {
    for (const observation of check.observations || []) {
      const length = normalizeSpokenText(observation.text).length;
      if (counted + length > position) { time = w.start + observation.start; break; }
      counted += length;
    }
    if (time !== end) break;
  }
  return { ...base, status: 'fail', time: Number(time.toFixed(3)), numericMismatch, criticalMismatches, forbiddenTermsHeard: wrongTerms, detail: `整篇独立听辨与冻结正文不一致${numericMismatch ? '，价格或数量等数字发生变化' : ''}${criticalMismatches.length ? `，未听到指定关键词：${criticalMismatches.join('、')}` : ''}${wrongTerms.length ? `，仍听到旧词：${wrongTerms.join('、')}` : ''}；已定位到最接近的实际声音观察时刻。` };
}
