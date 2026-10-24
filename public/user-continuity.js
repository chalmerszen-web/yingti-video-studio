import { friendly } from './user-flow.js';
import {isLocalMaterialJob,localMaterialStatus,localMaterialQualityPanel} from './local-material-view.js';
import { actionEvidence, effectiveAction } from './action-evidence.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const time = value => `${Math.floor(value / 60).toString().padStart(2, '0')}:${(value % 60).toFixed(2).padStart(5, '0')}`;
const actionNames = { apply: '点涂', spread: '推开 / 揉匀', residue: '涂后残留', none: '无涂抹', uncertain: '画面不确定' };
const checks = { framing: '构图与动作', boundary: '分段接头', material: '涂抹与残留', dialogue: '台词正文', subtitles: '字幕与品牌文案', products: '商品与包装实例' };
const verdicts = { pass: '未发现异常', fail: '发现问题', uncertain: '需人工核对', not_applicable: '不适用' };
export function qualityLabel(job) {
  if(isLocalMaterialJob(job))return localMaterialStatus(job);
  const quality = job.quality;
  if (!quality) return '视频已生成 · 内容未核验';
  if(quality.state==='completed' && (quality.version!==3 || quality.contentState==='unverified'))return '视频已生成 · 内容未核验';
  if (quality.state === 'completed') return quality.verdict === 'issues' ? '视频已生成 · 发现内容问题' : quality.verdict === 'uncertain' ? '已完成 · 需复核' : '本轮内容核验未发现问题 · 待人工验收';
  return quality.state === 'attention' ? '已完成 · 检查需处理' : '视频已生成 · 内容检查中';
}
function recovery(review, kind, id) {
  if (!review || review.state !== 'attention') return '';
  const attrs = `data-kind="${kind}" data-id="${id}"`;
  return `<div class="notice error">${esc(friendly(review.error))}<div class="review-actions">${review.windows?.some(w => ['parse_error', 'response_saved'].includes(w.state)) ? `<button class="secondary" data-action="review-reparse" ${attrs}>本地整理（免费）</button>` : ''}${!review.windows?.some(w => ['unknown', 'submitting'].includes(w.state)) ? `<button class="secondary" data-action="review-resume" ${attrs}>继续未完成检查</button>` : ''}${(review.windows || []).filter(w => ['unknown', 'parse_error'].includes(w.state)).map(w => `<button class="secondary" data-action="review-retry" ${attrs} data-index="${w.index}">核对并重试第 ${w.index + 1} 部分</button>`).join('')}</div></div>`;
}
export function continuityEditor(project, edits, plan, demo = false) {
  const actions = project.story.actions || [], review = project.actionReview;
  const complete = (project.story.actionWindows?.length || 0) >= (project.analysis?.windows?.length || 1);
  return `<section class="continuity-editor"><p>只对原片中确认出现的动作添加约束；涂抹结束后的残留单独保留。未识别到的动作不会凭台词或产品名称自动补出。</p>${!complete ? `<div class="notice info">旧分析尚未包含完整动作记录。补充分析保留人物、素材和台词，只补充涂抹观察。${!review ? `<button class="secondary" data-action="analyze-actions" ${demo ? 'disabled' : ''}>补充动作分析 </button>` : `<p>${review.state === 'completed' ? '补充已完成' : review.state === 'attention' ? '补充分析需处理' : `正在补充动作分析 · ${(review.windows || []).filter(w => w.state === 'completed').length}/${review.windows?.length || 0}`}</p>`}</div>` : ''}${recovery(review, 'actions', project.id)}${actions.length ? actions.map(a => {
    const mode = edits.continuity?.actions?.[a.id] || 'auto';
    const observation = actionEvidence(a), resolved = effectiveAction(a, mode);
    const known = observation.complete && observation.grounded && !observation.uncertain && !observation.conflict && ['apply', 'spread', 'residue'].includes(a.type);
    return `<article class="action-observation"><div class="action-heading"><strong>${time(a.start)}–${time(a.end)} · ${actionNames[resolved?.type || a.type]}</strong><span class="confidence">${resolved ? mode === 'spread_finish' ? '将推开至薄匀状态' : '将加入约束' : a.type === 'none' ? '无需约束' : '未启用'}</span></div><p>${esc(project.story.assets.find(p => p.id === a.characterId)?.name || '人物待核对')} · ${esc(a.region || '位置待核对')}</p><p>${esc(a.evidence)}</p>${observation.reviewReason && a.type !== 'none' ? `<div class="notice info">${esc(observation.reviewReason)}</div>` : ''}<p>开始：${esc(a.before || '未识别')}<br>结束：${esc(a.after || '未识别')}</p><div class="review-actions"><button class="secondary" data-action="seek" data-time="${a.start}">查看原片</button><label>动作与完成目标<select data-action-mode="${esc(a.id)}"><option value="auto" ${mode === 'auto' ? 'selected' : ''}>自动（仅明确识别时启用）</option><option value="off" ${mode === 'off' ? 'selected' : ''}>关闭</option>${known ? `<option value="on" ${mode === 'on' ? 'selected' : ''}>已人工核对，沿用原片</option>` : ''}${observation.canSpread ? `<option value="spread" ${mode === 'spread' ? 'selected' : ''}>已核对：按原片推开 / 揉匀</option><option value="spread_finish" ${mode === 'spread_finish' ? 'selected' : ''}>要求完成涂抹：推开至薄匀状态</option>` : ''}</select></label></div>${mode === 'spread_finish' ? '<p>仅改善此人物此部位已有的推开过程，完成后不重新出现厚膏；不会要求膏体凭空消失。</p>' : ''}</article>`;
  }).join('') : `<p>${complete ? '本次分析未识别到涂抹或残留，不添加涂抹要求。' : '尚无动作分析结果。'}</p>`}<section class="full-script-details"><h4 class="disclosure-heading">画面衔接提醒</h4><p>${plan?.segments?.some(s => s.boundaryRisk) ? '部分连续动作需要重点核对，请在生成后检查画面是否自然衔接。' : '软件会自动安排画面衔接，生成后请预览动作与声音是否连贯。'}</p></section></section>`;
}
export function qualityPanel(job) {
  if(isLocalMaterialJob(job))return localMaterialQualityPanel(job);
  if (job.state !== 'completed') return '';
  const quality = job.quality;
  const rebuilt = !!job.recipe?.actionRebuild, firstRebuildIndex = job.segments.find(segment => segment.generationMode === 'keyframe_rebuild')?.index;
  return `<section class="quality-panel"><h3>内容检查与局部重做</h3><p>对照视频左侧为原片，右侧为新片；声音来自新片，下方为目标商品参考。检查台词、字幕、商品实例、涂抹及画面衔接。自动检查用于定位问题，最终效果仍需人工预览；不会自动重做。</p>${!quality ? `<button class="secondary" data-action="review-quality" data-id="${job.id}">检查画面 </button>` : `<p role="status">${qualityLabel(job)}${quality.windows ? ` · ${quality.windows.filter(w => w.state === 'completed').length}/${quality.windows.length} 部分` : ''}</p>${recovery(quality, 'quality', job.id)}`}${job.segments.map(segment => {
    const windows = quality?.windows || [];
    const window = windows.some(item => Number.isInteger(item.segmentIndex)) ? windows.find(item => item.segmentIndex === segment.index) : windows[segment.index];
    return `<article class="quality-part"><strong>画面 ${time(segment.start)}–${time(segment.start + segment.duration)}</strong>${window?.result?.map(check => `<p class="quality-check ${check.status}"><b>${checks[check.kind]} · ${verdicts[check.status]}</b>${check.time !== null ? ` · ${time(check.time)}` : ''}<br>${esc(check.detail)}</p>`).join('') || '<p>可先打开原片对照，检查动作和相邻接头。</p>'}<div class="review-actions"><button class="secondary" data-action="preview-comparison" data-id="${job.id}" data-index="${segment.index}">播放原片对照</button>${job.workflow === 'studio' && segment.generationMode !== 'base_copy' && (!rebuilt || segment.index === firstRebuildIndex) ? `<button class="secondary" data-action="regenerate-segment" data-id="${job.id}" data-index="${segment.index}">${rebuilt ? '重新生成整段涂抹' : '重做此处画面'}</button>` : ''}</div></article>`;
  }).join('')}</section>`;
}
