import {installFundingUI} from './funding-ui.js';
import {outputActions,partialOutputPanel,installOutputRecovery} from './output-recovery.js';
import { generationStatus, generationProgress, jobProgressMarkup, jobRecoveryActions } from './user-job-view.js';
import { validateAssetFiles, assetUploadForm, bindAssetDrop, preventFileNavigation } from './user-asset-drop.js';
import { demoProject } from './studio-demo.js';
import { propRoleEditor, applyPropRoleControl } from './prop-role-ui.js';
import { materialReferenceTools, openMaterialCrop, finishReferenceCharacter } from './material-reference-ui.js';
import { propRole, materialReferenceMode } from './prop-role.js';
import {reconstructionButton,openReconstruction} from './reconstruction-ui.js';
import {localMaterialButton,openLocalMaterialRepair} from './local-material-ui.js';
import {isLocalMaterialJob,localMaterialThumbnail,localMaterialStatus,localMaterialProgress,localMaterialJobActions,localMaterialRecordDetails,localMaterialOpenContext,localMaterialInstallHint} from './local-material-view.js';

import { productScopeEditor, readProductScopeEditor, applyProductScopeAction } from './product-scope-ui.js';
import { updateNarrationField } from './narration-ui.js';
import { initializeFullDialogue, fullDialogueEditor, allocationPreview, completeScript } from './user-dialogue.js';
import { characterEditMode, characterModeLabels, visualSlots } from './character-edit.js';
import { continuityEditor, qualityPanel, qualityLabel } from './user-continuity.js';
import { workflowPages, pageTitles, availablePage, viewURL, friendly, connectionSummary } from './user-flow.js';

const $ = selector => document.querySelector(selector), $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = name => `<svg aria-hidden="true"><use href="#s-${name}"/></svg>`;
const state = { csrf: '', key: {}, projects: [], jobs: [], project: null, edits: null, tab: 'character', demo: false, file: null, fileURL: '', importing: false, busy: false, dirty: false, serial: 0, saving: null, plan: null, planError: '', closed: false, projectNonce: crypto.randomUUID(), generationNonce: null, selectedJob: null, page: 'import', generationStage: 'setup', restoringRoute: true };
const statuses = { waiting_key: '等待连接服务', funds_required:'等待继续生成',stopped:'已中止',timed_out:'等待超时',stopping:'正在中止',collecting:'收取已完成视频',queued: '排队中', processing: '处理中', completed: '已完成', paused: '已暂停', needs_attention: '需要处理', pending: '待处理', uploading: '上传中', submitting: '提交中', submitted: '排队中', running: '生成中', downloading: '下载中', failed: '失败', unknown: '结果待核对', analysis_queued: '等待分析', analyzing: '正在分析', analysis_attention: '分析需处理', ready: '可编辑', preparing: '准备片段', response_saved: '整理已保存结果', parse_error: '结果已保存，本地校验需处理' };
const typeNames = { character: '人物', scene: '场景', prop: '道具', dialogue: '台词', shots: '分镜' };
let action, toastTimer, saveTimer, refreshing = false, projectSignature = '', jobsSignature = '', videoSelection = 0;
const finishSelections = new Map();
const finishSelectionKey = asset => `${state.project?.id}:${asset}`;
const finishSelection = asset => finishSelections.has(finishSelectionKey(asset)) ? finishSelections.get(finishSelectionKey(asset)) : $$('[data-finish-character]').find(control => control.dataset.finishCharacter === asset)?.value || '';

function time(seconds, decimal = false) {
  const n = Math.max(0, Number(seconds) || 0);
  return Math.floor(n / 60).toString().padStart(2, '0') + ':' + (decimal ? (n % 60).toFixed(1).padStart(4, '0') : Math.floor(n % 60).toString().padStart(2, '0'));
}
function notice(selector, value, kind = 'error') { const el = $(selector); el.textContent = friendly(value); el.className = `notice ${kind}${value ? '' : ' hidden'}`; }
function toast(value) { $('#studio-toast').textContent = friendly(value); $('#studio-toast').classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#studio-toast').classList.add('hidden'), 5500); }
async function api(url, options = {}) {
  const result = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf, ...(options.headers || {}) } });
  const body = await result.json().catch(() => ({ error: '本地服务返回异常，请刷新页面。' }));
  if (!result.ok) throw new Error(body.error || '操作未完成。'); return body;
}
const post = (url, body = {}) => api(url, { method: 'POST', body: JSON.stringify(body) });
function upload(url, form, headers = {}, progress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest(); request.open('POST', url); request.timeout = 3600000;
    request.setRequestHeader('X-CSRF-Token', state.csrf); for (const [key, value] of Object.entries(headers)) request.setRequestHeader(key, value);
    request.upload.onprogress = event => { if (event.lengthComputable) progress?.(Math.round(event.loaded / event.total * 100)); };
    request.onload = () => { let data; try { data = JSON.parse(request.responseText); } catch { reject(new Error('服务响应异常，请检查项目列表后重试。')); return; } request.status >= 200 && request.status < 300 ? resolve(data) : reject(new Error(data.error || '上传未完成。')); };
    request.onerror = request.ontimeout = () => reject(new Error('上传连接中断。请先检查项目记录，再继续同一份导入。'));
    request.send(form);
  });
}
function updateKey() { $('#key-summary').textContent = state.key.configured ? '访问密钥已导入' : '连接视频服务'; $('#key-dot').classList.toggle('muted', !state.key.configured); $('#key-clear').disabled = !state.key.configured; $('#remember-key').disabled = !state.key.canRemember; }
function setVideo(element, url) { if (element.getAttribute('src') === (url || null)) return; element.pause(); if (url) element.src = url; else element.removeAttribute('src'); element.load(); }
function initEdits(project) { state.edits = structuredClone(project.edits); state.edits.continuity ||= { actions: {}, autoReview: true }; state.migrated = initializeFullDialogue(project, state.edits); state.dirty = state.migrated; state.serial++; state.generationNonce = null; }
function modified() {
  state.dirty = true; state.serial++; state.generationNonce = null;
  $('#save-state').textContent = state.demo ? '示例编辑，仅供预览' : '待保存'; renderChanges();
  clearTimeout(saveTimer); if (!state.demo) saveTimer = setTimeout(() => saveEdits().catch(error => toast(error.message)), 800);
}
function currentGeneration() {
  if (!state.project || state.demo || state.dirty) return null;
  return state.jobs.find(j => j.id === state.generationNonce) || state.jobs.find(j => j.projectId === state.project.id && j.projectRevision === state.project.revision) || null;
}
async function saveEdits() {
  clearTimeout(saveTimer);
  if (state.demo || !state.project || !state.dirty) return;
  if (!state.fullDialogueSupported) throw new Error('服务正在升级，整篇台词尚未保存。请保留当前页面，待升级完成后刷新。');
  if (state.saving) { await state.saving; if (state.dirty) return saveEdits(); return; }
  const id = state.project.id, serial = state.serial;
  const edits = { model: state.edits.model, assets: Object.fromEntries(Object.entries(state.edits.assets).map(([key, value]) => [key, { notes: value.notes || '', ...(state.project.story.assets.find(a=>a.id===key)?.type==='prop' ? { propRole:value.propRole||'', uploadedImageRole:value.uploadedImageRole||'', materialReferenceMode:value.materialReferenceMode||'', materialDescription:value.materialDescription||'' } : {}) }])), dialogues: structuredClone(state.edits.dialogues), fullDialogue: structuredClone(state.edits.fullDialogue), continuity: structuredClone(state.edits.continuity), productScope: structuredClone(state.edits.productScope || { groups: [] }) };
  $('#save-state').textContent = '正在保存…';
  state.saving = (async () => {
    const updated = await api(`/api/projects/${id}/edits`, { method: 'PUT', body: JSON.stringify({ revision: state.project.revision, edits }) });
    if (state.project?.id !== id) return;
    state.project = updated;
    if (state.serial === serial) { state.edits = structuredClone(updated.edits); state.dirty = false; state.migrated = false; }
    $('#save-state').textContent = state.dirty ? '待保存' : '已保存';
    await refreshPlan();
  })();
  try { await state.saving; } catch (error) { $('#save-state').textContent = '保存未完成'; throw error; } finally { state.saving = null; }
  if (state.dirty && state.project?.id === id) return saveEdits();
}
async function refreshPlan() {
  if (!state.project || state.project.state !== 'ready') return;
  if (state.demo) { state.plan = { segments: [{}, {}], billableSeconds: 24, warnings: [], audioMode: state.edits.fullDialogue?.enabled ? 'mixed' : 'original' }; state.planError = ''; renderChanges(); return; }
  const id = state.project.id;
  try { const plan = await api(`/api/projects/${id}/plan`); if (state.project?.id !== id) return; state.plan = plan; state.planError = ''; }
  catch (error) { if (state.project?.id !== id) return; state.plan = null; state.planError = error.message; }
  renderChanges();
  if (state.tab === 'continuity') renderContent();
}
function renderChanges() {
  if (!state.edits) return;
  $('#save-button').disabled = state.demo || state.busy;
  $('#studio-model').disabled = state.busy;
  $('#asset-content').inert = state.busy;
  const values = Object.values(state.edits.assets);
  const images = state.project.story.assets.reduce((n, asset) => n + visualSlots(asset, state.edits.assets[asset.id]).length, 0), voices = values.filter(a => a.voice).length;
  const full = state.edits.fullDialogue, dialogues = full?.enabled && !!full.text.trim() ? 1 : 0;
  $('#image-changes').textContent = images; $('#voice-changes').textContent = voices; $('#dialogue-changes').textContent = full?.enabled ? '整篇' : '保留';
  let characterSummary = $('#character-change-summary');
  if (!characterSummary) { characterSummary = document.createElement('div'); characterSummary.id = 'character-change-summary'; characterSummary.className = 'asset-target-scope'; characterSummary.setAttribute('role', 'status'); $('#audio-policy').before(characterSummary); }
  const people = state.project.story.assets.filter(asset => asset.type === 'character' && characterEditMode(state.edits.assets[asset.id]) !== 'preserve');
  characterSummary.classList.toggle('hidden', !people.length);
  characterSummary.textContent = people.map(asset => `${asset.name}：${characterModeLabels[characterEditMode(state.edits.assets[asset.id])]}`).join('；');
  const sound = voices > 0 || dialogues > 0;
  $('#audio-policy').classList.toggle('modified', sound);
  $('#audio-policy span').textContent = full?.enabled && ['voiceover','uploaded'].includes(full.delivery) ? '使用完整新录音；原音乐和环境声不会自动保留。' : full?.enabled ? '整篇替换原对白，使用新的配音；生成时尽量保留音乐和环境声。' : sound ? '已选人物使用参考音色；涉及声音修改的画面使用新音轨，其他部分沿用原声。' : '保留原视频对白、音乐和环境声。';
  const materialChanges = state.project.story.assets.some(asset => propRole(asset, state.edits.assets[asset.id]) === 'material' && (state.edits.assets[asset.id]?.materialDescription?.trim() || state.edits.assets[asset.id]?.materialFinish?.file));
  const changed = images + voices + dialogues > 0 || materialChanges;
  $('#generation-plan').textContent = state.demo ? '示例用于查看编辑方式，不会发起分析或生成。' : state.plan ? `本次生成计费用量合计 ${state.plan.billableSeconds} 秒。${state.plan.qualityCalls ? `生成后会调用 ${state.plan.qualityCalls} 次画面检查，另计分析用量。` : '生成后请人工检查画面。'}${state.dirty ? ' 保存后更新计划。' : ''}` : '保存修改后更新生成计划。';
  $('#auto-quality').checked = state.edits.continuity?.autoReview !== false;
  $('#auto-quality').disabled = state.busy;
  notice('#plan-error', !state.demo && !state.characterEditModesSupported ? '服务尚未加载合图与台词保护规则，请退出并重新打开软件后再生成。' : state.planError || (state.plan?.blockers || []).join('\n')); notice('#plan-warnings', (state.plan?.warnings || []).join('\n'), 'info');
  const currentJob = currentGeneration();
  $('#generate-button span').textContent = state.demo ? '导入真实视频开始' : state.busy ? '正在保存版本…' : currentJob ? currentJob.state === 'completed' ? '再生成一版' : '查看当前任务' : '生成编辑版本';
  $('#generate-button').disabled = state.busy || (!state.demo && (!state.characterEditModesSupported || !changed || (!!state.planError || !!state.plan?.blockers?.length) && !state.dirty));
  const preview = $('#full-script-allocation');
  if (preview) preview.innerHTML = allocationPreview(state.plan ? { ...state.plan, people: Object.fromEntries(state.project.story.assets.map(a => [a.id, a.name])) } : null, state.planError, state.demo, state.dirty);
}
function stepState() {
  const index = workflowPages.indexOf(state.page);
  $$('#process-steps [data-page]').forEach((el, i) => {
    el.classList.toggle('active', i === index); el.classList.toggle('done', i < index);
    el.disabled = i > 0 && !state.project || i > 1 && state.project?.state !== 'ready';
    if(i === index) el.setAttribute('aria-current','step'); else el.removeAttribute('aria-current');
  });
}
function renderPage() {
  $$('.user-screen').forEach(el => { el.hidden = el.dataset.screen !== state.page; });
  $('#process-steps').hidden = !workflowPages.includes(state.page);
  if (state.demo && $('#studio-notice').textContent.startsWith('交互示例：')) $('#studio-notice').classList.toggle('hidden', !workflowPages.includes(state.page));
  $('#project-breadcrumb').textContent = pageTitles[state.page];
  $('#page-breadcrumb').textContent = ['projects','records','record'].includes(state.page) ? '创作空间' : state.project?.title || '创作空间';
  $('#studio-new').classList.toggle('selected', workflowPages.includes(state.page));
  $('#studio-project-nav').classList.toggle('selected', state.page === 'projects');
  $('#studio-jobs-nav').classList.toggle('selected', ['records','record'].includes(state.page));
  const host = state.page === 'generate' ? $('#generation-detail-host') : state.page === 'record' ? $('#record-detail-host') : $('#detail-storage');
  if ($('#studio-job-detail').parentElement !== host) host.append($('#studio-job-detail'));
  $$('video').forEach(video => { const screen = video.closest('[data-screen]'); if(screen && screen.hidden) video.pause(); });
  stepState(); renderGenerationOverview();
}
function setPage(page, {replace = false} = {}) {
  state.page = availablePage(page, state.project);
  if (!state.restoringRoute) {
    const url = viewURL(state.page, {projectId:state.project?.id,jobId:state.page === 'generate' && state.generationStage !== 'progress' ? null : state.selectedJob,demo:state.demo});
    if(location.pathname + location.search !== url) history[replace ? 'replaceState' : 'pushState'](null,'',url);
  }
  renderPage(); window.scrollTo({top:0,behavior:'instant'});
}
async function goPage(page) {
  if(state.importing || state.busy) return toast('当前操作正在保存，请稍候。');
  await saveEdits();
  if(page === 'generate' && state.project?.state === 'ready') { await refreshPlan(); state.generationStage='setup'; state.selectedJob = currentGeneration()?.id || null; renderJobDetail(); }
  setPage(page);
}
function renderGenerationOverview() {
  if(!state.project || state.project.state !== 'ready') return;
  const p=state.project, edits=state.edits;
  const job=state.jobs.find(j=>j.id===state.selectedJob), progress=state.generationStage==='progress' && !!job;
  $('#generation-setup').hidden=progress; $('#generation-footer').hidden=progress;
  $('#generation-state-title').textContent=progress&&isLocalMaterialJob(job)?localMaterialStatus(job):progress ? generationStatus(job) : '确认修改，生成新版本';
  $('#generation-state-help').textContent=progress?'当前版本的进度和结果保存在这里，也可以从左侧生成记录继续查看。':'检查本次修改和画质，开始后可随时查看进度。';
  $('#generation-footer-note').textContent=state.demo?'使用示例不会生成视频':state.plan?`本次处理 ${state.plan.billableSeconds} 秒视频${state.plan.qualityCalls?` · 另有 ${state.plan.qualityCalls} 次画面检查`:''}`:'保存后更新生成计划';
  $('#generation-project-title').textContent=p.title;
  $('#generation-source-caption').textContent='原片时长 '+time(p.source.duration)+' · 生成后保留为独立版本';
  $('#generation-source-video').classList.toggle('hidden',state.demo); $('#generation-demo-note').classList.toggle('hidden',!state.demo); $('#generation-demo-image').hidden = !state.demo;
  setVideo($('#generation-source-video'), state.demo ? null : '/api/projects/'+p.id+'/media/source');
  const rows = p.story.assets.filter(a=>visualSlots(a,edits.assets[a.id]).length || edits.assets[a.id]?.voice).map(a=>{
    const edit=edits.assets[a.id], changes=[];
    if(visualSlots(a,edit).length) changes.push(a.type==='character'?characterModeLabels[characterEditMode(edit)]:'替换参考图');
    if(edit.voice)changes.push('替换音色');
    return '<div><strong>'+esc(a.name)+'</strong> · '+esc(changes.join('，'))+'</div>';
  });
  rows.push('<div><strong>台词</strong> · '+(edits.fullDialogue?.enabled?'替换为你填写的完整正文':'保留原片台词')+'</div>');
  $('#generation-edit-summary').innerHTML=rows.join('');
}

function renderProject() {
  const p=state.project, ready=p?.state==='ready';
  $('#import-section').classList.remove('hidden');
  $('#analysis-state').classList.toggle('hidden',!p || ready);
  $('#analysis-empty').hidden=!!p; $('#analysis-complete').hidden=!ready;
  $('#studio-workbench').classList.toggle('hidden',!ready); $('#analysis-next').disabled=!ready;
  $('#existing-source-actions').hidden=!p;
  $('#analyze-button span').textContent=p?'查看视频分析':'导入并分析视频';
  if(p && !state.file){ $('#source-label').textContent=p.sourceName || p.title; $('#source-description').textContent='已导入 · '+time(p.source.duration); setVideo($('#import-video'),state.demo?null:'/api/projects/'+p.id+'/media/source'); $('#import-video').classList.toggle('hidden',state.demo); $('#import-placeholder').classList.toggle('hidden',!state.demo); }
  if(!p) { renderPage(); return; }
  if(!ready){renderAnalysis();renderPage();return;}
  $('#workbench-title').textContent=p.title; $('#analysis-summary').textContent=p.story.summary;
  $('#analysis-complete-title').textContent=(state.demo?'使用示例 · ':'')+p.title+' · '+time(p.source.duration);
  $('#analysis-complete-summary').textContent=p.story.summary;
  $('#analysis-counts').innerHTML=[['character','人物'],['scene','场景'],['prop','物品']].map(([kind,label])=>'<div><strong>'+p.story.assets.filter(a=>a.type===kind).length+'</strong><span>'+label+'</span></div>').join('')+'<div><strong>'+p.story.shots.length+'</strong><span>镜头</span></div>';
  $('#source-time').textContent=time(p.source.duration);
  $('#script-export').classList.toggle('hidden',state.demo); $('#script-export').href='/api/projects/'+p.id+'/script';
  $('#save-button').disabled=state.demo||state.busy; $('#save-state').textContent=state.demo?'使用示例':state.dirty?'待保存':'已保存';
  $('#studio-model').value=state.edits.model;
  $('#studio-video').classList.toggle('hidden',state.demo); $('#demo-preview').classList.toggle('hidden',!state.demo);
  setVideo($('#studio-video'),state.demo?null:'/api/projects/'+p.id+'/media/source'); notice('#story-warnings',p.story.warnings.join('\n'),'info');
  for(const type of ['character','scene','prop']) $('#'+type+'-count').textContent=p.story.assets.filter(a=>a.type===type).length;
  $('#dialogue-count').textContent='全文'; $('#shot-count').textContent=p.story.shots.length;
  renderContent(); renderChanges(); renderPage();
}

function renderAnalysis() {
  const p = state.project;
  const unknown = p.analysis.windows.some(w => ['unknown', 'submitting'].includes(w.state));
  const hasSaved = p.analysis.windows.some(w => ['parse_error', 'response_saved'].includes(w.state));
  const needsModel = p.analysis.windows.some(w => !['completed', 'parse_error', 'response_saved'].includes(w.state));
  const detail = p.analysis.windows.map(w => `<div class="analysis-part"><div><span>第 ${w.index + 1} 部分</span><span>${statuses[w.state] || esc(w.state)}</span></div><small>${time(w.start)} — ${time(w.start + w.duration)}${w.charactersReceived ? ` · 已接收 ${w.charactersReceived} 字` : ''}</small>${w.state === 'parse_error' ? '<small>完整分析已保存，可先在本地重新整理，无需再次分析或产生新费用。</small>' : ''}${['unknown', 'parse_error'].includes(w.state) ? `<section class="analysis-more"><h4 class="disclosure-heading">分析恢复</h4><button class="secondary" data-action="retry-analysis" data-index="${w.index}">重新分析这一部分（计费用量）</button></section>` : ''}${['parse_error', 'response_saved', 'completed'].includes(w.state) ? `<a target="_blank" rel="noreferrer" href="/api/projects/${p.id}/analysis/${w.index}/raw">原始结果 ↗</a>` : ''}</div>`).join('');
  $('#analysis-state').innerHTML = `<div class="analysis-status-heading">${p.state !== 'analysis_attention' ? '<span class="spinner"></span>' : icon('film')}<div><h2>${esc(friendly(p.phase || '正在分析视频'))}</h2><p>${esc(p.title)} · ${p.source.duration.toFixed(3)} 秒 · ${p.analysis.windows.length} 个分析部分</p></div></div>${p.error ? `<div class="notice error">${esc(friendly(p.error))}${hasSaved ? '<br><button class="secondary" data-action="reparse-analysis">重新整理已保存结果（免费）</button>' : ''}${needsModel && !unknown ? '<br><button class="secondary" data-action="resume-analysis">继续尚未完成的分析部分</button>' : ''}</div>` : ''}${!p.keyMatches ? '<div class="notice info">继续分析需要此项目原来的访问密钥；整理已保存结果不需要密钥。</div>' : ''}<div class="analysis-progress">${detail}</div><div class="analysis-budget-note">分析完成后即可继续编辑。识别结果可能有少量误差，请在下一步核对人物、物品和台词。</div>`;
}
function referenceSlot(asset, slot) {
  const binding = state.edits.assets[asset.id]?.[slot];
  const material = propRole(asset, state.edits.assets[asset.id]) === 'material';
  const label = slot === 'main' ? material ? '材质原图' : '主视图' : '三视图 / 四联图';
  const hint = material ? materialReferenceMode(state.edits.assets[asset.id]) === 'motion' ? '可选，仅留存核对' : '仅取可见膏体颜色与质地' : asset.type === 'character' ? slot === 'main' ? '仅主视图：只换脸' : '可单独上传：替换人物造型' : '可选';
  const url = !state.demo && binding ? `/api/projects/${state.project.id}/assets/${asset.id}/${slot}/media?v=${binding.revision}` : '';
  return `<div class="reference-slot"><label>${label}<small>${hint}</small></label><button class="reference-upload" data-asset-drop data-action="choose-asset" data-asset="${asset.id}" data-slot="${slot}" aria-label="${asset.id} 导入${label}">${url ? `<img src="${url}" draggable="false" alt="${esc(asset.name)}${label}"><span class="replace-cover">点击或拖入图片更换</span>` : `${icon(slot === 'main' ? 'plus' : 'grid')}<span>${slot === 'main' ? '点击或拖入替换图' : '点击或拖入三视图 / 四联图'}</span><small>${slot === 'main' ? 'JPG / PNG / WebP' : '1 张合图，或按正 / 侧 / 背顺序导入 3 张'}</small>`}</button><input type="file" class="file-input" tabindex="-1" id="asset-${asset.id}-${slot}" data-asset="${asset.id}" data-slot="${slot}" accept=".png,.jpg,.jpeg,.webp,.bmp" ${slot === 'views' ? 'multiple' : ''}><div class="slot-footer"><span>${binding ? esc(binding.names.join('、')) : slot === 'views' ? '同一人物、同一套造型的正面 · 侧面 · 背面' : asset.type === 'character' ? '仅主图换脸；也可直接用三视图或合图替换' : '未导入时保留原样'}</span>${binding ? `<button data-action="remove-asset" data-asset="${asset.id}" data-slot="${slot}">移除</button>` : ''}</div></div>`;
}
function assetCard(asset) {
  const edits = state.edits.assets[asset.id] || {}, voice = edits.voice;
  const mode = asset.type === 'character' ? characterEditMode(edits) : null;
  const material = propRole(asset, edits) === 'material';
  const hasVisual = visualSlots(asset, edits).length > 0 || material && !!(edits.materialDescription?.trim() || edits.materialFinish?.file);
  const label = material ? materialReferenceMode(edits) === 'motion' ? '跟随原片涂抹运动' : '仅参考膏体颜色与质地' : mode ? characterModeLabels[mode] : edits.main ? '将替换外观' : '保持原样';
  const characterHelp = mode === 'face' ? '仅使用主视图中的人脸身份，保留原片服装、发型、配饰和身形。需要替换整体造型时，可上传三视图或四联图。' : mode === 'appearance' ? (edits.main ? '主视图确定人脸，三视图确定统一造型。' : '已启用合图替换：这张三视图或四联图会直接提交，图中各视角按同一个人物处理，无需另补主视图。') + ' 请使用同一人物、同一套造型；参考图背景不作为场景参考。' : '仅主视图时只换脸；三视图或四联图可单独上传，用于替换人物整体造型。';
  const noteLabel = mode === 'face' ? '附加要求（仅在人脸替换范围内生效）' : mode === 'appearance' ? '附加要求（人物造型替换）' : '附加要求（上传替换主图后生效）';
  const notePlaceholder = mode === 'face' ? '例如：保持原表情；如需换装，请上传三视图' : '例如：保留动作与位置';
  const scope = state.plan?.visualPlan?.find(item => item.assetId === asset.id);
  const scopeText = scope ? scope.mode === 'all_appearances' ? '将替换全片中该商品的所有出现处，包括同款包装及已关联的袋内商品；未出现时不新增。' : scope.ranges.length ? `原片中识别的出现时段：${scope.ranges.map(r => `${time(r.start, true)}–${time(r.end, true)}`).join('、')}` : '原分析没有关联到具体镜头，将作为全片替换约束，请核对。' : '';
  const replacementStatus = `<div class="asset-replacement-state ${hasVisual ? 'enabled' : ''}">${icon(hasVisual ? 'check' : 'film')}<strong>${hasVisual ? '已上传素材 · ' : asset.type === 'character' ? '未上传人物图 · ' : '未上传替换图 · '}${label}</strong></div>${asset.type === 'prop' && edits.main ? `<p class="asset-target-scope">这张图对应原片中的「${esc(asset.name)}」，不会自动作为其他物品的参考。${scopeText ? `<br>${esc(scopeText)}` : ''}</p>` : ''}`;
  const symbol = asset.type === 'character' ? 'person' : asset.type === 'scene' ? 'scene' : 'box';
  return `<article class="asset-card" id="card-${asset.id}"><div class="asset-card-header"><button class="original-thumb" data-action="seek" data-time="${asset.firstSeen}" title="查看原片中的此资产">${state.demo ? icon(symbol) : `<img src="/api/projects/${state.project.id}/poster/${asset.id}" alt="原片中的${esc(asset.name)}">`}</button><div><div class="asset-code">${asset.id} · ${time(asset.firstSeen, true)} 首次出现</div><h4>${esc(asset.name)}</h4></div>${asset.confidence !== 'high' ? '<span class="confidence">需核对</span>' : ''}</div>${replacementStatus}${propRoleEditor(asset,edits)}${materialReferenceTools(state.project,asset,edits,state.demo)}${mode ? `<p class="asset-target-scope" data-character-mode="${mode}">${characterHelp}</p>` : ''}<p class="asset-description">${esc(asset.description)}</p><div class="reference-slots ${asset.type === 'character' ? '' : 'single'}">${referenceSlot(asset, 'main')}${asset.type === 'character' ? referenceSlot(asset, 'views') : ''}</div>${asset.type === 'character' ? `<div class="voice-block"><label>参考音色<small>可单独替换 · 3–5 秒</small></label>${voice && !state.demo ? `<audio controls preload="metadata" src="/api/projects/${state.project.id}/assets/${asset.id}/voice/media?v=${voice.revision}"></audio><div class="slot-footer"><span>${voice.duration.toFixed(2)} 秒 · ${esc(voice.names[0])}</span><button data-action="remove-asset" data-asset="${asset.id}" data-slot="voice">移除</button></div>` : ''}<button class="voice-upload" data-asset-drop data-action="choose-asset" data-asset="${asset.id}" data-slot="voice" aria-label="${asset.id} 导入参考音色">${icon('mic')}${voice ? '点击或拖入音频，替换当前音色' : '点击或拖入 3–5 秒参考音频'}</button><input type="file" class="file-input" tabindex="-1" id="asset-${asset.id}-voice" data-asset="${asset.id}" data-slot="voice" accept=".wav,.mp3,.m4a,.aac,.ogg,.flac"></div>` : ''}<div class="asset-notes"><label for="notes-${asset.id}">${noteLabel}</label><textarea ${hasVisual ? '' : 'disabled'} id="notes-${asset.id}" data-note="${asset.id}" maxlength="1200" rows="2" placeholder="${notePlaceholder}">${esc(edits.notes || '')}</textarea></div></article>`;
}
function renderContent() {
  if (!state.project || state.project.state !== 'ready') return;
  const story = state.project.story;
  $$('.asset-tabs button').forEach(button => { const active = button.dataset.tab === state.tab; button.classList.toggle('active', active); button.setAttribute('aria-selected', active); });
  const descriptions = {
    character: ['人物与音色', '主视图用于换脸，三视图或四联图用于换整体造型；参考音色可单独替换。'],
    scene: ['场景资产', '只替换上传了新场景图的场景，其余场景默认保留。'],
    prop: ['道具与产品', '瓶罐和包装使用各自的替换图；膏体按已确认的材质说明与涂抹动作处理。'],
    dialogue: ['整篇台词替换', '粘贴完整正文即可，软件在内部自动安排说话人与时间，不用逐句填写。'],
    shots: ['原片分镜与脚本', '这份时间轴来自视频分析，用于识别资产、定位台词和规划分段；生成指令只描述你指定的编辑。'],
    continuity: ['动作与衔接', '确认涂抹时段、涂后残留和切点。只增强原片已有过程，不添加新的动作。'],
  };
  $('#tab-title').textContent = descriptions[state.tab][0]; $('#tab-help').textContent = descriptions[state.tab][1];
  if (state.tab === 'continuity') {
    $('#asset-content').innerHTML = continuityEditor(state.project, state.edits, state.plan, state.demo);
  } else if (state.tab === 'dialogue') {
    $('#asset-content').innerHTML = fullDialogueEditor(state.project, state.edits, { plan: state.plan ? { ...state.plan, people: Object.fromEntries(story.assets.map(a => [a.id, a.name])) } : null, error: state.planError, demo: state.demo, dirty: state.dirty, migrated: state.migrated, voices: state.voices || [] });
  } else if (state.tab === 'shots') {
    const name = id => story.assets.find(a => a.id === id)?.name || '';
    $('#asset-content').innerHTML = story.shots.map(shot => `<article class="shot-row"><div class="shot-stamp"><b>${shot.id}</b>${time(shot.start, true)}<br>— ${time(shot.end, true)}<button class="shot-play" data-action="seek" data-time="${shot.start}">查看原片 ↗</button></div><div class="shot-body"><strong>${esc(shot.summary)}</strong><p>${esc(shot.camera)}</p><div class="shot-badges">${[...shot.characterIds, shot.sceneId, ...shot.propIds].filter(Boolean).map(id => `<span>${esc(name(id))}</span>`).join('')}</div></div></article>`).join('');
  } else {
    const assets = story.assets.filter(a => a.type === state.tab);
    $('#asset-content').innerHTML = assets.length ? `<div class="asset-grid">${assets.map(assetCard).join('')}</div>` : `<div class="asset-empty">这段视频没有识别到${typeNames[state.tab]}资产。<br>其他编辑项仍可使用。</div>`;
  }
  if (state.tab === 'prop') $('#asset-content').insertAdjacentHTML('afterbegin', productScopeEditor(state.project, state.edits));
  $$('[data-finish-character]').forEach(control => { const key = finishSelectionKey(control.dataset.finishCharacter); if (finishSelections.has(key)) control.value = finishSelections.get(key); });
  $('#asset-content').setAttribute('aria-busy', state.busy);
}
function renderProjects() {
  $('#project-count').textContent = state.projects.length;
  $('#recent-projects').innerHTML = state.projects.length ? state.projects.slice(0, 5).map(p => `<button data-action="select-project" data-id="${p.id}" title="${esc(p.title)}">${esc(p.title)}</button>`).join('') : '<span>从一段视频开始</span>';
  $('#project-list').innerHTML = state.projects.length ? state.projects.map(p => `<button class="project-item ${state.project?.id === p.id ? 'selected' : ''}" data-action="select-project" data-id="${p.id}">${icon('film')}<span><strong>${esc(p.title)}</strong><small>${time(p.source.duration)} · ${statuses[p.state] || esc(p.state)}${p.state === 'ready' ? ` · ${p.story.assets.filter(a => a.type === 'character').length} 位人物` : ''}</small></span></button>`).join('') : `<div class="project-empty">${icon('film')}<div><strong>开始你的第一个视频项目</strong><p>原片、分析结果和编辑内容，会一起保存在这里。</p></div><button class="primary accent" data-page="import">导入一段视频</button></div>`;
}
function jobButtons(job) {
  if(job.state==='funds_required')return `<button class="secondary" data-action="resume-job" data-id="${job.id}">继续生成</button>`;
  if(['stopped','timed_out','stopping','collecting'].includes(job.state))return outputActions(job)+`<button class="secondary" data-action="job-detail" data-id="${job.id}">查看已完成内容</button>`;
  return originalJobButtons(job)+outputActions(job);
}
function originalJobButtons(job) {
  if(isLocalMaterialJob(job))return localMaterialJobActions(job,{enabled:state.localMaterialRepairSupported});
  if (job.state === 'completed') return `<button class="secondary" data-action="job-detail" data-id="${job.id}">检查 / 重做</button>${reconstructionButton(job)}${localMaterialButton(job,{enabled:state.localMaterialRepairSupported})}<button class="secondary" data-action="preview-result" data-id="${job.id}">预览</button><a class="download-button" href="/api/jobs/${job.id}/media/result?download=1">${job.quality?.version===3 && job.quality?.contentState==='passed' ? '下载 MP4 ↓' : '下载待核对视频 ↓'}</a>`;
  if (job.state === 'needs_attention' || job.segments.some(s => ['failed', 'unknown'].includes(s.state))) return `<button class="secondary" data-action="job-detail" data-id="${job.id}">处理问题</button>`;
  return `<button class="secondary" data-action="${job.state === 'paused' || job.pauseRequested ? 'resume-job' : 'pause-job'}" data-id="${job.id}">${job.state === 'paused' || job.pauseRequested ? '继续处理' : '暂停后续'}</button>`;
}
function renderJobs() {
  $('#generation-count').textContent = state.jobs.length; $('#job-count').textContent = state.jobs.length;
  $('#studio-job-list').innerHTML = state.jobs.length ? state.jobs.map(job => `<article class="job-card"><button class="job-select" data-action="job-detail" data-id="${job.id}"><img class="job-thumbnail" src="${localMaterialThumbnail(job)}" alt="任务参考图"><span class="job-text"><strong>${esc(job.title)}</strong><small>${isLocalMaterialJob(job)?'本地涂抹修复 · 平台用量 0':job.workflow === 'studio' ? '资产与台词编辑' : job.mode === 'face' ? '快速换脸' : '快速换产品'} · ${time(job.source.duration)}</small></span></button><div class="job-progress"><span>${esc(job.state === 'completed' ? qualityLabel(job) : generationStatus(job))}</span><div class="progress-line"><i data-progress="${generationProgress(job)}"></i></div></div><div class="studio-job-actions">${jobButtons(job)}</div></article>`).join('') : `<div class="queue-empty">${icon('list')}<div><strong>生成记录会出现在这里</strong><p>完成分析与编辑后，生成独立的视频版本。</p></div><button class="secondary" data-page="import">开始创作</button></div>`;
  $$('#studio-job-list [data-progress]').forEach(el => { el.style.width = el.dataset.progress + '%'; }); renderJobDetail(); renderChanges(); renderPage();
}
function renderJobDetail() {
  const job = state.jobs.find(j => j.id === state.selectedJob); $('#studio-job-detail').classList.toggle('hidden', !job); if (!job) return;
  if(isLocalMaterialJob(job)){ $('#studio-job-detail').innerHTML=`<div class="detail-header"><div><h2>${esc(job.title)}</h2><p>${esc(localMaterialStatus(job))}</p></div><a href="/api/jobs/${encodeURIComponent(job.id)}/receipt">导出本地修复记录 ↓</a></div>${localMaterialRecordDetails(job,{enabled:state.localMaterialRepairSupported})}`;return;}
  const savedModes = Object.entries(job.recipe?.characterModes || {}).filter(([, mode]) => mode !== 'preserve').map(([id, mode]) => `${job.recipe.story.assets.find(a => a.id === id)?.name || id}：${characterModeLabels[mode] || mode}`).join('；');
  const characterHistory = job.workflow === 'studio' ? `<p class="asset-target-scope">${savedModes ? '本次保存的人物模式：' + esc(savedModes) : '此版本保留了生成时的编辑要求。'}</p>` : '';
  const detailActions = job.state === 'completed' ? `${reconstructionButton(job)}${localMaterialButton(job,{enabled:state.localMaterialRepairSupported})}<button class="secondary" data-action="preview-result" data-id="${job.id}">预览成片</button><a class="download-button" href="/api/jobs/${job.id}/media/result?download=1">${job.quality?.version===3 && job.quality?.contentState==='passed' ? '下载 MP4 ↓' : '下载待核对视频 ↓'}</a>` : ['stopped','timed_out','stopping','collecting'].includes(job.state) ? outputActions(job) : job.state === 'needs_attention' ? '' : jobButtons(job);
  const error = job.error ? friendly(job.error).replace(/第\s*\d+\s*段/g, '部分内容').replaceAll('分段', '内容') : '';
  $('#studio-job-detail').innerHTML = `<div class="detail-header"><div><h2>${esc(job.title)}</h2><p>${esc(generationStatus(job))} · ${job.audioMode === 'narration' ? '使用独立整篇配音' : job.audioMode === 'mixed' ? '使用编辑后的声音' : '使用原音轨'}</p></div><div class="studio-job-actions">${detailActions}</div></div>${jobProgressMarkup(job)}${partialOutputPanel(job,{includeActions:false})}${error ? '<div class="notice error">'+esc(error)+'</div>' : ''}${jobRecoveryActions(job)}${characterHistory}${qualityPanel(job)}`;
}

async function importNarration(file) {
  if (!file || state.busy) return;
  if (state.demo) return toast('整篇配音在真实项目中导入，示例不上传文件。');
  if (file.size > 20*1024**2 || !/\.(wav|mp3|m4a|aac|ogg|flac)$/i.test(file.name)) return toast('请选择不超过20MB的音频文件。');
  await saveEdits(); state.busy=true;
  try { const form=new FormData();form.append('file',file);state.project=await upload(`/api/projects/${state.project.id}/narration`,form);initEdits(state.project);renderContent();await refreshPlan();toast('整篇录音已导入，并关联当前稿件。'); }
  catch(error){toast(error.message);}
  finally {state.busy=false;renderChanges();}
}
$('#asset-content').addEventListener('dragover',event=>{if(event.target.closest('[data-action="choose-narration"]'))event.preventDefault();});
$('#asset-content').addEventListener('drop',event=>{if(!event.target.closest('[data-action="choose-narration"]'))return;event.preventDefault();if(event.dataTransfer.files.length!==1)return toast('请一次导入一份整篇录音。');importNarration(event.dataTransfer.files[0]).catch(error=>toast(error.message));});

async function refresh() {
  if (refreshing || state.closed) return; refreshing = true;
  try {
    const [projects, jobs] = await Promise.all([api('/api/projects'), api('/api/jobs')]);
    state.projects = projects;
    const pSignature = JSON.stringify(projects);
    if (pSignature !== projectSignature) {
      projectSignature = pSignature; renderProjects();
    }
    if (state.project && !state.demo) {
      const next = projects.find(p => p.id === state.project.id);
      if (next && next.updated !== state.project.updated && !state.dirty && !state.saving && !state.busy) {
        const becameReady = state.project.state !== 'ready' && next.state === 'ready';
        state.project = next; initEdits(next);
        if (becameReady) { state.tab = next.story.assets.some(a => a.type === 'character') ? 'character' : 'shots'; toast('视频分析完成，可以继续编辑。'); }
        renderProject(); if (next.state === 'ready') await refreshPlan();
      }
    }
    const jSignature = JSON.stringify(jobs);
    if (jSignature !== jobsSignature) { state.jobs = jobs; jobsSignature = jSignature; renderJobs(); }
  } finally { refreshing = false; }
}
async function selectProject(id) {
  if (state.busy || state.importing) return toast('请等待当前素材或版本保存完成。');
  await saveEdits(); const project = await api(`/api/projects/${id}`);
  state.demo = false; state.project = project; state.plan = null; state.planError = ''; initEdits(project);
  state.selectedJob = null;
  state.tab = project.story.assets.some(a => a.type === 'character') ? 'character' : project.state === 'ready' ? 'shots' : 'character';
  notice('#studio-notice', ''); renderProject(); renderProjects(); if (project.state === 'ready') await refreshPlan();
  setPage(project.state === 'ready' ? 'edit' : 'analysis');
}
async function newProject() {
  if (state.busy || state.importing) return toast('请等待当前素材或版本保存完成。');
  await saveEdits(); state.project = null; state.edits = null; state.demo = false; state.plan = null; state.planError = ''; state.projectNonce = crypto.randomUUID();
  notice('#import-error', '');
  notice('#studio-notice', ''); state.selectedJob=null; state.file=null; if(state.fileURL) URL.revokeObjectURL(state.fileURL); state.fileURL=''; $('#source-file').value=''; $('#project-title').value=''; $('#source-label').textContent='点击上传，或拖入原视频'; $('#source-description').textContent='MP4 / MOV / MKV / WebM / AVI'; setVideo($('#import-video'),null); $('#import-video').classList.add('hidden'); $('#import-placeholder').classList.remove('hidden'); renderProject(); renderProjects(); setPage('import');
}
async function openDemo() {
  if (state.busy || state.importing) return toast('请等待当前素材或版本保存完成。');
  await saveEdits(); state.project = demoProject(); state.demo = true; state.tab = 'character'; initEdits(state.project);
  notice('#studio-notice', '交互示例：2 位人物、1 个场景、2 件道具、4 句台词。这里没有分析用户视频，修改仅用于预览，不会调用模型。', 'info');
  state.selectedJob=null; renderProject(); renderProjects(); await refreshPlan(); setPage('analysis');
}
async function chooseSource(file) {
  if (!file || state.importing) return; if(state.project) await newProject(); notice('#import-error', '');
  if (file.size > 2 * 1024 ** 3 || !/\.(mp4|mov|mkv|webm|avi)$/i.test(file.name)) return notice('#import-error', '请选择不超过 2 GB 的 MP4、MOV、MKV、WebM 或 AVI 视频。');
  const sequence = ++videoSelection, url = URL.createObjectURL(file);
  $('#analyze-button').disabled = true;
  const duration = await new Promise(resolve => { const element = document.createElement('video'); let finished = false; const timer = setTimeout(() => finish(null), 6000); function finish(value) { if (finished) return; finished = true; clearTimeout(timer); element.removeAttribute('src'); element.load(); resolve(value); } element.onloadedmetadata = () => finish(element.duration); element.onerror = () => finish(null); element.preload = 'metadata'; element.src = url; });
  if (sequence !== videoSelection) { URL.revokeObjectURL(url); return; } $('#analyze-button').disabled = false;
  if (duration !== null && (!Number.isFinite(duration) || duration <= 0 || duration > 600)) { URL.revokeObjectURL(url); return notice('#import-error', '原视频最长支持 10 分钟。'); }
  if (state.fileURL) URL.revokeObjectURL(state.fileURL);
  state.file = file; state.fileURL = url; state.projectNonce = crypto.randomUUID();
  $('#source-label').textContent = file.name; $('#source-description').textContent = `${(file.size / 1024 ** 2).toFixed(1)} MB${duration ? ' · ' + time(duration) : ' · 提交后由本地探测时长'}`;
  $('#import-video').classList.remove('hidden'); $('#import-placeholder').classList.add('hidden'); setVideo($('#import-video'), url);
}
$('#source-file').addEventListener('change', e => chooseSource(e.target.files[0]).catch(error => notice('#import-error', error.message)));
$('#source-drop').addEventListener('keydown', e => { if (['Enter', ' '].includes(e.key)) { e.preventDefault(); $('#source-file').click(); } });
$('#source-drop').addEventListener('dragover', e => { e.preventDefault(); $('#source-drop').classList.add('dragover'); });
$('#source-drop').addEventListener('dragleave', () => $('#source-drop').classList.remove('dragover'));
$('#source-drop').addEventListener('drop', e => { e.preventDefault(); $('#source-drop').classList.remove('dragover'); if (e.dataTransfer.files.length !== 1) return notice('#import-error', '请选择一段原视频。'); chooseSource(e.dataTransfer.files[0]).catch(error => notice('#import-error', error.message)); });
$('#project-title').addEventListener('input', () => { state.projectNonce = crypto.randomUUID(); });
$('#analyze-button').addEventListener('click', async () => {
  if (state.importing) return;
  if(state.project){await goPage('analysis');return;}
  if (!state.file) return notice('#import-error', '请先导入原视频。');
  if (!state.key.configured) { $('#key-dialog').showModal(); notice('#key-message', '请先导入拥有 Omni-Analysis 与 WAN 3.0 权限的 KEY。', 'info'); return; }
  state.importing = true; $('#analyze-button').disabled = true; $('#source-file').disabled = true; $('#project-title').disabled = true; $('#source-progress').classList.remove('hidden'); notice('#import-error', '');
  try {
    const form = new FormData(); form.append('title', $('#project-title').value); form.append('file', state.file);
    const p = await upload('/api/projects', form, { 'X-Project-Request-Id': state.projectNonce }, value => { $('#source-progress progress').value = value; $('#source-progress span').textContent = value === 100 ? '正在检查视频并创建分析项目…' : `正在导入原视频… ${value}%`; });
    const wasImport = state.page === 'import';
    state.project = p; state.demo = false; initEdits(p); renderProject(); await refresh(); toast('视频已导入，开始分析。'); if(wasImport)setPage('analysis');
  } catch (error) { notice('#import-error', error.message); await refresh().catch(() => {}); }
  finally { state.importing = false; $('#analyze-button').disabled = false; $('#source-file').disabled = false; $('#project-title').disabled = false; $('#source-progress').classList.add('hidden'); }
});

$('#save-button').addEventListener('click', () => saveEdits().then(() => toast('编辑内容已保存。')).catch(error => toast(error.message)));
$('#studio-model').addEventListener('change', e => { state.edits.model = e.target.value; modified(); });
$('#auto-quality').addEventListener('change', e => { state.edits.continuity ||= { actions: {} }; state.edits.continuity.autoReview = e.target.checked; modified(); });
$('#asset-content').addEventListener('input', e => {
  if(e.target.dataset.propRole==='materialDescription' && applyPropRoleControl(state.project,state.edits,e.target)) { modified(); return; }
  if (e.target.dataset.productScope) { state.edits.productScope = readProductScopeEditor($('#asset-content'),state.project,state.edits); modified(); return; }
  if (updateNarrationField(state.edits.fullDialogue,e.target)) { modified(); return; }
  if (e.target.dataset.note) { const id = e.target.dataset.note; state.edits.assets[id] ||= {}; state.edits.assets[id].notes = e.target.value; modified(); }
  if (e.target.id === 'full-dialogue-pronunciation') { state.edits.fullDialogue.pronunciation = e.target.value; modified(); }
  if (e.target.id === 'full-dialogue-text') { state.edits.fullDialogue.text = e.target.value; const counter = $('#full-script-counter'); if (counter) counter.textContent = `${[...e.target.value].length} / 20000 字符`; modified(); }
});
$('#asset-content').addEventListener('change', async e => {
  const target = e.target;
  if (target.dataset.finishCharacter) { finishSelections.set(finishSelectionKey(target.dataset.finishCharacter), target.value); return; }
  if(target.dataset.propRole && applyPropRoleControl(state.project,state.edits,target)) { modified(); renderContent(); return; }
  if (target.dataset.productScope) { state.edits.productScope = readProductScopeEditor($('#asset-content'),state.project,state.edits); modified(); renderContent(); return; }
  if (updateNarrationField(state.edits.fullDialogue,target)) { modified(); if(target.id==='full-dialogue-delivery')renderContent(); return; }
  if (target.id === 'narration-file' && target.files.length) { await importNarration(target.files[0]); target.value=''; return; }
  if (target.dataset.actionMode) { state.edits.continuity ||= { actions: {} }; state.edits.continuity.actions[target.dataset.actionMode] = target.value; modified(); renderContent(); return; }
  if (target.id === 'full-dialogue-enabled') { state.edits.fullDialogue.enabled = target.checked; if(target.checked && !state.edits.fullDialogue.subtitlesExplicit)state.edits.fullDialogue.subtitles='replace'; modified(); renderContent(); return; }
  if (target.id === 'full-dialogue-speaker') { state.edits.fullDialogue.speakerId = target.value; modified(); return; }
  if (target.type !== 'file' || !target.dataset.asset || !target.files.length) return;
  try { await importAssetFiles(target.dataset.asset, target.dataset.slot, target.files); }
  catch (error) { toast(error.message); }
  finally { target.value = ''; }
});

async function importAssetFiles(asset, slot, selected) {
  if (state.demo) throw new Error('请先导入真实视频，分析完成后即可拖入素材。');
  if (state.busy || state.importing) throw new Error('当前素材正在保存，请完成后再导入。');
  const target = state.project?.story?.assets.find(item => item.id === asset);
  if (!target || (slot !== 'main' && slot !== 'finish' && target.type !== 'character')) throw new Error('请选择对应的素材导入区域。');
  const files = validateAssetFiles(selected, slot);
  const projectId = state.project.id;
  const characterId = slot === 'finish' ? finishReferenceCharacter(state.project, target, state.edits.assets?.[asset], finishSelection(asset)) : '';
  state.busy = true; $('#asset-content').setAttribute('aria-busy', 'true'); renderChanges();
  try {
    await saveEdits();
    if (state.project?.id !== projectId) throw new Error('当前项目已切换，请在新项目中重新选择素材。');
    if (slot === 'finish') finishReferenceCharacter(state.project, target, state.edits.assets?.[asset], characterId);
    const form = assetUploadForm(files, slot, characterId);
    const p = await upload(`/api/projects/${projectId}/assets/${asset}/${slot}`, form);
    if (slot === 'finish') finishSelections.delete(`${projectId}:${asset}`);
    if (state.project?.id !== projectId) throw new Error('素材已保存到原项目；当前项目已切换，请返回原项目查看。');
    state.project = p; initEdits(p); await refreshPlan(); renderProject();
    toast(slot === 'voice' ? '参考音色已导入，将只绑定这个人物。' : slot === 'finish' ? '薄匀终态图已绑定到所选人物，只参考肤质与涂后状态。' : '参考图片已绑定到对应资产。');
  } finally { state.busy = false; $('#asset-content').setAttribute('aria-busy', 'false'); renderChanges(); }
}
bindAssetDrop($('#asset-content'), importAssetFiles, toast);
preventFileNavigation(document);

$('#generate-button').addEventListener('click', async () => {
  if (state.demo) return newProject(); if (state.busy) return;
  if (!state.characterEditModesSupported) return toast('请退出并重新打开软件，加载新的人物编辑规则后再生成。');
  const current = currentGeneration();
  if (current && current.state !== 'completed') { state.selectedJob = current.id; state.generationStage='progress'; renderJobDetail(); setPage('generate'); return; }
  if (current?.state === 'completed') state.generationNonce = null;
  if (!state.key.configured) return $('#key-dialog').showModal();
  state.busy = true; renderChanges();
  try {
    await saveEdits(); await refreshPlan(); if (state.planError) throw new Error(state.planError); if (state.plan?.blockers?.length) throw new Error(state.plan.blockers.join('\n'));
    state.generationNonce ||= crypto.randomUUID();
    const job = await post(`/api/projects/${state.project.id}/generate`, { revision: state.project.revision, requestId: state.generationNonce });
    state.selectedJob = job.id; state.generationStage='progress'; await refresh(); setPage('generate'); toast('视频已加入生成队列，本次修改已保存。');
    renderPage();
  } catch (error) { toast(error.message); }
  finally { state.busy = false; renderChanges(); }
});

function openAction(config) {
  action = config; $('#action-title').textContent = friendly(config.title); $('#action-message').textContent = friendly(config.message);
  $('#action-task-id').classList.toggle('hidden', config.kind !== 'bind-job'); $('#action-task-id').value = '';
  $('#analysis-retry-check').classList.toggle('hidden', !['retry-analysis', 'review-retry'].includes(config.kind)); $('#verified-analysis').checked = false;
  $('#repair-notes').classList.toggle('hidden', config.kind !== 'regenerate-segment'); $('#repair-notes').value = config.notes || '';
  $('#action-submit').textContent = config.confirm || '确认'; $('#action-submit').disabled = ['retry-analysis', 'review-retry'].includes(config.kind); notice('#action-error', ''); $('#studio-action').showModal();
}
$('#verified-analysis').addEventListener('change', e => { $('#action-submit').disabled = !e.target.checked; });
document.addEventListener('click', async e => {
  const page=e.target.closest('[data-page]'); if(page){goPage(page.dataset.page).catch(error=>toast(error.message));return;}
  const tab = e.target.closest('[data-tab]');
  if (tab) { state.tab = tab.dataset.tab; renderContent(); return; }
  const button = e.target.closest('[data-action]'); if (!button) return;
  const data = button.dataset;
  if (applyProductScopeAction(state.project,state.edits,button)) { modified(); renderContent(); return; }
  try {
    if (data.action === 'analyze-actions') { await saveEdits(); openAction({ kind: data.action, projectId: state.project.id, title: '补充动作分析', message: '使用 Omni-Analysis 重新观看原片，补充涂抹和残留时段。会产生分析用量，人物、素材和台词保留。', confirm: '开始补充分析' }); }
    if (data.action === 'review-quality') openAction({ kind: data.action, id: data.id, title: '检查生成画面', message: '用 Omni-Analysis 逐段对照原片与成片，检查接头、动作和膏体变化，会产生分析用量。不重新生成视频。', confirm: '开始画面检查' });
    if (data.action === 'review-reparse' || data.action === 'review-resume') { const base = data.kind === 'actions' ? `/api/projects/${data.id}/actions` : `/api/jobs/${data.id}/quality`; await post(base + (data.action === 'review-reparse' ? '/reparse' : '/resume')); await refresh(); }
    if (data.action === 'review-retry') openAction({ kind: data.action, id: data.id, reviewKind: data.kind, index: data.index, title: '重新调用这部分检查', message: '上次调用可能已计费。请先核对平台使用记录；完整结果优先本地整理。确认后仅重试所选部分。', confirm: '确认新的分析调用' });
    if (data.action === 'regenerate-segment') {
      const job = state.jobs.find(j => j.id === data.id), index = Number(data.index), part = job.segments[index];
      const notes = job.quality?.windows?.filter(w => Math.abs(w.segmentIndex - index) <= 1).flatMap(w => (w.result || []).filter(c => c.status === 'fail').map(c => c.detail)).join('\n').slice(0, 1200) || '';
      if(job.recipe?.actionRebuild)openAction({kind:data.action,id:job.id,index,requestId:crypto.randomUUID(),notes,title:'重新生成涂抹片段',message:`将重新生成整段连续涂抹，WAN 用量合计 ${job.recipe.actionRebuild.billableSeconds} 秒，其他画面与声音沿用。生成后使用 ${job.analysisModel||'Omni-Analysis'} 复核，会产生新的生成及分析用量。`,confirm:'另存动作重建版本'});
      else openAction({ kind: data.action, id: job.id, index, requestId: crypto.randomUUID(), notes, title: `只重做第 ${index + 1} 段`, message: `只新提交本段 ${part.requestDuration} 秒 WAN 请求，其余片段复用。另存新版本并用 Omni-Analysis 复查 ${job.segments.length} 部分（包含相邻接头），会产生生成和分析用量。使用此版本生成时的图片和台词。`, confirm: '另存并重做此段' });
    }
    if (data.action === 'preview-comparison') { $('#result-video').src = `/api/jobs/${data.id}/quality/${data.index}/video`; $('#result-dialog h2').textContent = '画面对照 · 左原片、右新片，声音来自新片'; $('#result-download').classList.add('hidden'); $('#result-dialog').showModal(); }
    if(data.action === 'new-source') return await newProject();
    if (data.action === 'select-project') return await selectProject(data.id);
    if(data.action==='material-crop') { if(state.demo)return toast('真实项目中可选择膏体区域。');await saveEdits(); const asset=state.project.story.assets.find(a=>a.id===data.asset);openMaterialCrop(state.project,asset,async rect=>{state.project=await post(`/api/projects/${state.project.id}/assets/${asset.id}/material/crop`,{revision:state.project.revision,...rect});initEdits(state.project);await refreshPlan();renderContent();toast('膏体区域已保存，来源全图仍保留。');}); }
    if (data.action === 'load-voices') { if(state.demo)return toast('真实项目中可读取账户已有音色。'); state.voices=await api('/api/voices');renderContent();toast('账户音色已读取。'); }
    if (data.action === 'choose-narration') $('#narration-file').click();
    if (data.action === 'remove-narration') { await saveEdits(); state.project=await api(`/api/projects/${state.project.id}/narration`,{method:'DELETE'});initEdits(state.project);renderContent();await refreshPlan(); }
    if (data.action === 'copy-original-script') { state.edits.fullDialogue.enabled = true; state.edits.fullDialogue.text = completeScript(state.project); modified(); renderContent(); $('#full-dialogue-text').focus(); }
    if (data.action === 'insert-script-role') { const field = $('#full-dialogue-text'); const prefix = field.selectionStart > 0 && field.value[field.selectionStart - 1] !== '\n' ? '\n' : ''; field.setRangeText(prefix + `[${data.person}] `, field.selectionStart, field.selectionEnd, 'end'); state.edits.fullDialogue.text = field.value; modified(); field.focus(); $('#full-script-counter').textContent = `${[...field.value].length} / 20000 字符`; }
    if (data.action === 'choose-asset') { if (state.demo) return toast('这是交互示例。导入真实视频后，可在这里为对应资产上传素材。'); if (!state.busy) { if (data.slot === 'finish') { const asset = state.project.story.assets.find(item => item.id === data.asset); const character = finishReferenceCharacter(state.project, asset, state.edits.assets?.[data.asset], finishSelection(data.asset)); finishSelections.set(finishSelectionKey(data.asset), character); } $(`#asset-${data.asset}-${data.slot}`).click(); } }
    if (data.action === 'remove-asset') {
      await saveEdits(); const p = await api(`/api/projects/${state.project.id}/assets/${data.asset}/${data.slot}`, { method: 'DELETE' }); state.project = p; initEdits(p); await refreshPlan(); renderProject();
    }
    if (data.action === 'seek') { if (state.demo) return toast('示例没有原视频。真实项目可在这里定位到对应时间。'); const video = $('#studio-video'); video.currentTime = Number(data.time); video.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    if (data.action === 'resume-analysis') { await post(`/api/projects/${state.project.id}/analysis/resume`); await refresh(); }
    if (data.action === 'reparse-analysis') {
      button.disabled = true;
      try {
        const project = await post(`/api/projects/${state.project.id}/analysis/reparse`);
        state.project = project; initEdits(project); renderProject(); await refresh();
        if (project.state === 'ready') await refreshPlan();
        toast(project.state === 'ready' ? '已复用保存的分析结果恢复编辑，未调用模型。' : '已整理本地完整结果，剩余部分未发起调用。');
      } finally { button.disabled = false; }
    }
    if (data.action === 'retry-analysis') openAction({ kind: data.action, index: data.index, projectId: state.project.id, title: '重新分析这一部分', message: '上次分析可能已产生费用。请先核对平台记录；确认后将只重新调用这一部分，已完成部分保留。', confirm: '确认新的分析调用' });
    if(data.action==='local-material-job'||data.action==='local-material-resume'){if(!state.localMaterialRepairSupported)throw new Error(localMaterialInstallHint);const selected=state.jobs.find(item=>item.id===data.id);const context=await localMaterialOpenContext(selected,id=>state.jobs.find(item=>item.id===id),id=>api(`/api/jobs/${encodeURIComponent(id)}`));openLocalMaterialRepair(context.parent,{csrf:state.csrf,existingDraftId:context.existingDraftId,onUpdated:async next=>{state.selectedJob=next.id;state.jobs=[next,...state.jobs.filter(item=>item.id!==next.id)];await refresh();renderJobs();},onCreated:async next=>{state.selectedJob=next.id;state.jobs=[next,...state.jobs.filter(item=>item.id!==next.id)];await refresh();renderJobs();setPage('record');}});}if(data.action==='preview-local-result'){$('#result-dialog h2').textContent='本地局部预览 · 待人工核对';$('#result-download').classList.add('hidden');$('#result-video').src=`/api/local-material/${encodeURIComponent(data.id)}/media/preview`;$('#result-dialog').showModal();}
    if (data.action === 'reconstruct-job') { const job=state.jobs.find(item=>item.id===data.id);openReconstruction(job,{csrf:state.csrf,onCreated:async next=>{state.selectedJob=next.id;await refresh();renderJobDetail();setPage('record');}}); }
    if (data.action === 'job-detail') { state.selectedJob = data.id; renderJobDetail(); setPage('record'); }
    if (data.action === 'pause-job' || data.action === 'resume-job') { await post(`/api/jobs/${data.id}/${data.action === 'pause-job' ? 'pause' : 'resume'}`); await refresh(); }
    if (data.action === 'retry-job') openAction({ kind: data.action, id: data.id, index: data.index, title: '重新生成未完成内容', message: '这部分内容已确认生成失败。继续会产生新的生成用量，已完成内容保留。', confirm: '确认重新生成' });
    if (data.action === 'bind-job') openAction({ kind: data.action, id: data.id, index: data.index, title: '找回已提交任务', message: '请从平台使用记录中找到对应任务，核对素材与提交时间后粘贴原任务编号。绑定后只查询与下载，不重复生成。', confirm: '核对并绑定' });
    if (data.action === 'preview-result') { $('#result-dialog h2').textContent = '成片预览'; $('#result-download').classList.remove('hidden'); $('#result-video').src = `/api/jobs/${data.id}/media/result`; $('#result-download').href = `/api/jobs/${data.id}/media/result?download=1`; $('#result-dialog').showModal(); }
  } catch (error) { toast(error.message); }
});
$('#action-form').addEventListener('submit', async e => {
  e.preventDefault(); $('#action-submit').disabled = true;
  try {
    if (action.kind === 'analyze-actions') await post(`/api/projects/${action.projectId}/actions`, { confirmAnalysis: true });
    if (action.kind === 'review-quality') await post(`/api/jobs/${action.id}/quality`, { confirmAnalysis: true });
    if (action.kind === 'review-retry') await post(`${action.reviewKind === 'actions' ? `/api/projects/${action.id}/actions` : `/api/jobs/${action.id}/quality`}/${action.index}/retry`, { confirmAnalysis: true, verifiedPrevious: $('#verified-analysis').checked });
    if (action.kind === 'regenerate-segment') { const job = await post(`/api/jobs/${action.id}/segments/${action.index}/regenerate`, { requestId: action.requestId, confirmNewCharge: true, notes: $('#repair-notes').value }); state.selectedJob = job.id; setPage('record'); }
    if (action.kind === 'retry-analysis') await post(`/api/projects/${action.projectId}/analysis/${action.index}/retry`, { confirmNewCharge: true, verifiedPrevious: $('#verified-analysis').checked });
    if (action.kind === 'retry-job') await post(`/api/jobs/${action.id}/segments/${action.index}/retry`, { confirmNewCharge: true });
    if (action.kind === 'bind-job') await post(`/api/jobs/${action.id}/segments/${action.index}/bind`, { taskId: $('#action-task-id').value });
    if (action.kind === 'exit') { await saveEdits(); if(window.yingtiDesktop) await window.yingtiDesktop.exit(); else await post('/api/shutdown'); state.closed = true; notice('#studio-notice', '软件正在退出，项目与任务已保留。下次双击映替图标继续。', 'info'); }
    $('#studio-action').close(); if (!state.closed) await refresh();
  } catch (error) { notice('#action-error', error.message); }
  finally { $('#action-submit').disabled = false; }
});
$('#result-dialog').addEventListener('close', () => $('#result-video').pause());
$('#studio-new').addEventListener('click', () => newProject().catch(error => toast(error.message)));
$('#demo-open').addEventListener('click', () => openDemo().catch(error => toast(error.message))); $('#example-button').addEventListener('click', () => openDemo().catch(error => toast(error.message)));
$('#studio-project-nav').addEventListener('click', () => goPage('projects').catch(error=>toast(error.message))); $('#studio-jobs-nav').addEventListener('click', () => goPage('records').catch(error=>toast(error.message)));
$('#analysis-next').addEventListener('click',()=>goPage('edit').catch(error=>toast(error.message))); $('#edit-next').addEventListener('click',()=>goPage('generate').catch(error=>toast(error.message)));
$('#project-refresh').addEventListener('click', () => refresh().catch(error => toast(error.message)));
$('#studio-exit').addEventListener('click', () => openAction({ kind: 'exit', title: '保存进度并退出', message: '项目、分析结果和生成任务都会保留。已经提交的任务仍继续运行；下次打开软件可以继续查看。', confirm: '退出应用' }));
$('#key-open').addEventListener('click', () => { $('#api-key').value = ''; $('#remember-key').checked = !!state.key.remembered; notice('#key-message', ''); $('#key-dialog').showModal(); });
$('#key-dialog').addEventListener('close', () => { $('#api-key').value = ''; $('#api-key').type = 'password'; $('#key-reveal').textContent = '显示'; $('#key-file').value = ''; });
$('#key-reveal').addEventListener('click', () => { const input = $('#api-key'); input.type = input.type === 'password' ? 'text' : 'password'; $('#key-reveal').textContent = input.type === 'password' ? '显示' : '隐藏'; });
$('#key-file').addEventListener('change', async e => { const file = e.target.files[0]; if (!file) return; try { if (file.size > 16384) throw new Error('KEY 文件不能超过 16 KB。'); $('#api-key').value = await file.text(); notice('#key-message', '文件已读取，点击保存即可使用。', 'info'); } catch (error) { notice('#key-message', error.message); } });
$('#key-save').addEventListener('click', async () => { $('#key-save').disabled = true; try { state.key = await post('/api/key', { key: $('#api-key').value, remember: $('#remember-key').checked }); updateKey(); $('#key-dialog').close(); toast('KEY 已导入。'); await refresh(); } catch (error) { notice('#key-message', error.message); } finally { $('#key-save').disabled = false; } });
$('#key-check').addEventListener('click', async () => { $('#key-check').disabled = true; notice('#key-message', '正在读取模型权限，不会创建分析或生成任务…', 'info'); try { const result = await post('/api/key/check', { key: $('#api-key').value || undefined }); const summary=connectionSummary(result.models); notice('#key-message',summary.text,summary.analysis&&summary.generation?'success':'error'); } catch (error) { notice('#key-message', error.message); } finally { $('#key-check').disabled = false; } });
$('#key-clear').addEventListener('click', async () => { try { state.key = await api('/api/key', { method: 'DELETE' }); updateKey(); $('#api-key').value = ''; notice('#key-message', 'KEY 已清除，项目和任务仍保留。', 'info'); } catch (error) { notice('#key-message', error.message); } });
if(window.yingtiDesktop){
  window.yingtiDesktop.onPrepareExit(async()=>{
    const deadline=Date.now()+60000;
    document.body.inert=true;
    try{
      while(state.importing||state.busy){if(Date.now()>deadline)throw new Error('素材仍在导入或版本仍在保存，请稍后再更新。');await new Promise(resolve=>setTimeout(resolve,100));}
      if(state.saving)await state.saving;
      await saveEdits();
    }finally{document.body.inert=false;}
  });
  $('#studio-exit').textContent='退出应用';
}
try {
  const boot = await api('/api/bootstrap'); state.csrf = boot.csrf; state.key = boot.key; updateKey();
  state.fullDialogueSupported = !!boot.features?.fullDialogue;
  state.localMaterialRepairSupported = boot.features?.localMaterialRepair === true;
  state.characterEditModesSupported = !!boot.features?.combinedCharacterReference && !!boot.features?.dialogueSafety && !!boot.features?.continuity && !!boot.features?.productScope && !!boot.features?.independentNarration && !!boot.features?.contentReview && !!boot.features?.materialReferenceRoles;
  if (!boot.analysisEnabled) throw new Error('新版分析服务尚未启动。请退出旧服务，再双击启动器加载新版。');
  if (!state.fullDialogueSupported) notice('#studio-notice', '服务正在更新，整篇台词暂不可保存。升级完成后请刷新页面。', 'info');
  if (!boot.tools.ffmpeg || !boot.tools.ffprobe) notice('#studio-notice', 'FFmpeg / FFprobe 未就绪，请检查启动器。');
  if (boot.tools.testing) notice('#studio-notice', '独立测试环境：使用模拟分析和生成响应，不调用真实平台。', 'info');
  await refresh();
  const query = new URLSearchParams(location.search);
  if (query.get('demo') === '1') await openDemo();
  else if (state.projects.some(p => p.id === query.get('project'))) await selectProject(query.get('project'));
  state.restoringRoute=false; if(query.get('job') && state.jobs.some(j=>j.id===query.get('job'))) state.selectedJob=query.get('job'); state.generationStage=query.get('job')?'progress':'setup'; renderJobDetail(); setPage(query.get('view') || (state.project ? state.project.state==='ready' ? 'edit' : 'analysis' : 'import'),{replace:true});
  setInterval(() => refresh().catch(() => { if (!state.closed) notice('#studio-notice', '本地服务暂时断开。请检查软件是否运行，再刷新页面。'); }), 2500);
} catch (error) { notice('#studio-notice', error.message); }

window.addEventListener('popstate',async()=>{
  const query=new URLSearchParams(location.search); state.restoringRoute=true;
  try { const id=query.get('project'); if(id&&state.project?.id!==id&&state.projects.some(p=>p.id===id)) await selectProject(id); state.selectedJob=state.jobs.some(j=>j.id===query.get('job'))?query.get('job'):null; state.generationStage=query.get('job')?'progress':'setup'; renderJobDetail(); setPage(query.get('view')||'import'); } catch(error){toast(error.message);} finally{state.restoringRoute=false;}
});

installOutputRecovery({csrf:()=>state.csrf,refresh:refresh,onError:toast});

installFundingUI({csrf:()=>state.csrf,onError:toast}).catch(error=>toast(error.message));
