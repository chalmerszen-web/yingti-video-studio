import {installFundingUI} from './funding-ui.js';
import {outputActions,partialOutputPanel,installOutputRecovery} from './output-recovery.js';
import {isLocalMaterialJob,localMaterialThumbnail,localMaterialStatus,localMaterialProgress,localMaterialProgressMarkup,localMaterialRecordDetails,localMaterialLegacyActions} from './local-material-view.js';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const state = { csrf: '', key: {}, jobs: [], mode: 'face', video: null, image: null, duration: null, videoURL: '', imageURL: '', selected: null, view: 'source', uploading: false, readingVideo: false, requestId: crypto.randomUUID() };
const labels = { funds_required:'等待继续生成',stopped:'已中止',timed_out:'等待超时',stopping:'正在中止',collecting:'收取已完成视频',queued: '等待处理', processing: '处理中', paused: '已暂停', needs_attention: '需要处理', waiting_key: '等待 KEY', completed: '已完成', pending: '待提交', uploading: '上传中', submitting: '提交中', submitted: '排队中', running: '生成中', downloading: '下载中', failed: '生成失败', unknown: '结果待核对' };
let toastTimer, action, jobsSignature = '', pollBusy = false, videoSelection = 0;

function durationLabel(seconds) {
  if (!Number.isFinite(seconds)) return '00:00';
  return Math.floor(seconds / 60).toString().padStart(2, '0') + ':' + Math.floor(seconds % 60).toString().padStart(2, '0');
}
function bytesLabel(bytes) { return bytes >= 1024 ** 3 ? (bytes / 1024 ** 3).toFixed(2) + ' GB' : (bytes / 1024 ** 2).toFixed(1) + ' MB'; }
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), 4800);
}
function message(selector, text, kind = 'error') {
  const element = $(selector);
  element.textContent = text;
  element.className = 'notice ' + kind + (text ? '' : ' hidden');
}
async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf, ...options.headers },
  });
  const data = await response.json().catch(() => ({ error: '服务响应异常，请刷新页面重试。' }));
  if (!response.ok) throw new Error(data.error || '操作未完成。');
  return data;
}
const post = (url, body = {}) => api(url, { method: 'POST', body: JSON.stringify(body) });

function localPlan(duration) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 600) return [];
  const lengths = [];
  let left = Math.max(1, Math.round(duration * 30));
  for (let i = 0; i < Math.ceil(duration / 15); i++) { const frames = Math.min(left, 450); lengths.push(frames); left -= frames; }
  if (lengths.length > 1 && lengths.at(-1) < 60) { lengths[lengths.length - 2] -= 60 - lengths.at(-1); lengths[lengths.length - 1] = 60; }
  let start = 0;
  return lengths.map((frames, index) => { const part = { index, start, frames, duration: frames / 30, requestDuration: Math.max(2, Math.ceil(frames / 30)), state: 'pending' }; start += part.duration; return part; });
}
function newDraft() { state.requestId = crypto.randomUUID(); }

function updateKey() {
  $('#key-summary').textContent = state.key.configured ? 'KEY 已导入' : '导入 API KEY';
  $('#key-dot').classList.toggle('muted', !state.key.configured);
  $('#key-clear').disabled = !state.key.configured;
  $('#remember-key').disabled = !state.key.canRemember;
  if (!state.key.canRemember) $('.remember small').textContent = '当前系统仅支持本次运行使用 KEY。';
}

function changeMode(mode) {
  if (state.mode !== mode) newDraft();
  state.mode = mode;
  $$('.mode-card').forEach(button => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', active);
  });
  $('#image-heading').textContent = mode === 'face' ? '替换人脸图' : '替换产品图';
  $('#image-tip').textContent = mode === 'face' ? '单人、清晰、正面' : '完整外观、包装清晰';
  $('#target').placeholder = mode === 'face' ? '例如：画面左侧穿白衣的女人' : '例如：女人右手拿着的白色瓶子';
  if (!state.image) $('#image-label').textContent = mode === 'face' ? '上传一张人脸照片' : '上传一张产品图片';
}

async function chooseVideo(file) {
  if (!file) return;
  message('#form-error', '');
  if (file.size > 2 * 1024 ** 3) return message('#form-error', '视频文件不能超过 2 GB。');
  if (!/\.(mp4|mov|mkv|webm|avi)$/i.test(file.name)) return message('#form-error', '请选择 MP4、MOV、MKV、WebM 或 AVI 视频。');
  const selection = ++videoSelection;
  state.readingVideo = true; $('#start-button').disabled = true;
  const url = URL.createObjectURL(file);
  const metadata = await new Promise(resolve => {
    const video = document.createElement('video');
    const timeout = setTimeout(() => finish(null), 8000);
    let settled = false;
    function finish(value) { if (settled) return; settled = true; clearTimeout(timeout); video.removeAttribute('src'); video.load(); resolve(value); }
    video.preload = 'metadata'; video.onloadedmetadata = () => finish({ duration: video.duration, width: video.videoWidth, height: video.videoHeight }); video.onerror = () => finish(null); video.src = url;
  });
  if (selection !== videoSelection) { URL.revokeObjectURL(url); return; }
  state.readingVideo = false; $('#start-button').disabled = state.uploading;
  if (metadata && (!Number.isFinite(metadata.duration) || metadata.duration <= 0 || metadata.duration > 600)) { URL.revokeObjectURL(url); return message('#form-error', '请选择大于 0 且不超过 10 分钟的视频。'); }
  if (state.videoURL) URL.revokeObjectURL(state.videoURL);
  Object.assign(state, { video: file, videoURL: url, duration: metadata?.duration ?? null, selected: null, view: 'source' });
  newDraft();
  $('#video-label').textContent = file.name;
  $('#video-meta').textContent = `${bytesLabel(file.size)}${metadata ? ' · ' + durationLabel(metadata.duration) + ' · ' + metadata.width + ' × ' + metadata.height : ' · 浏览器无法预览，提交后由本地检查'}`;
  $('#video-actions').classList.remove('hidden');
  renderPreview(); renderSummary(); renderJobs();
}
function chooseImage(file) {
  if (!file) return;
  message('#form-error', '');
  if (file.size > 20 * 1024 ** 2) return message('#form-error', '替换图片不能超过 20 MB。');
  if (!/\.(png|jpe?g|webp|bmp)$/i.test(file.name)) return message('#form-error', '请选择 JPG、PNG、WebP 或 BMP 图片。');
  if (state.imageURL) URL.revokeObjectURL(state.imageURL);
  state.image = file; state.imageURL = URL.createObjectURL(file); newDraft();
  $('#reference-preview').src = state.imageURL; $('#reference-preview').classList.remove('hidden');
  $('.small-image-icon').classList.add('hidden');
  $('#image-label').textContent = file.name; $('#image-meta').textContent = bytesLabel(file.size);
  $('#image-actions').classList.remove('hidden');
}
function clearVideo() {
  videoSelection++; state.readingVideo = false; $('#start-button').disabled = state.uploading;
  if (state.videoURL) URL.revokeObjectURL(state.videoURL);
  Object.assign(state, { video: null, duration: null, videoURL: '', selected: null, view: 'source' }); newDraft();
  $('#video-file').value = ''; $('#video-label').textContent = '点击上传或将视频拖到这里';
  $('#video-meta').textContent = 'MP4、MOV、MKV、WebM、AVI · 最大 2 GB'; $('#video-actions').classList.add('hidden');
  renderPreview(); renderSummary(); renderJobs();
}
function clearImage() {
  if (state.imageURL) URL.revokeObjectURL(state.imageURL);
  state.image = null; state.imageURL = ''; newDraft();
  $('#image-file').value = ''; $('#reference-preview').classList.add('hidden'); $('#reference-preview').removeAttribute('src');
  $('.small-image-icon').classList.remove('hidden'); $('#image-meta').textContent = 'JPG、PNG、WebP、BMP · 最大 20 MB';
  $('#image-actions').classList.add('hidden'); changeMode(state.mode);
}
function renderSummary() {
  const parts = localPlan(state.duration);
  $('#submit-summary').innerHTML = parts.length ? `原视频 <strong>${state.duration.toFixed(2)} 秒</strong>，自动分为 <strong>${parts.length} 段</strong>。<br>平台按各段请求时长计费，预计合计 <strong>${parts.reduce((sum, s) => sum + s.requestDuration, 0)} 秒</strong>（含补帧）。` : '添加素材后，软件将自动规划分段。';
}
function renderPreview() {
  const job = state.jobs.find(j => j.id === state.selected);
  if (!job || job.state !== 'completed') state.view = 'source';
  const video = $('#preview-video');
  const url = job ? `/api/jobs/${job.id}/media/${state.view === 'result' ? 'result' : 'source'}` : state.videoURL;
  if (video.getAttribute('src') !== (url || null)) {
    video.pause();
    if (url) video.setAttribute('src', url); else video.removeAttribute('src');
    video.load();
  }
  video.classList.toggle('hidden', !url); $('#viewer-empty').classList.toggle('hidden', !!url);
  $('#view-source').classList.toggle('active', state.view === 'source'); $('#view-result').classList.toggle('active', state.view === 'result');
  $('#view-result').disabled = job?.state !== 'completed';
  $('#preview-tag').textContent = job ? isLocalMaterialJob(job)?localMaterialStatus(job):labels[job.state] || job.state : state.video ? '原视频预览' : '等待素材';
  $('#viewer-resolution').textContent = job ? `${job.output.width} × ${job.output.height} · 30 fps` : '自适应画幅';
  const parts = job?.segments || localPlan(state.duration);
  const duration = job?.source.duration || state.duration || 0;
  $('#timeline-duration').textContent = `00:00 / ${durationLabel(duration)}`;
  $('#timeline-info').textContent = parts.length ? `${parts.length} 段 · ${parts.filter(s => s.state === 'completed').length} 段完成` : '添加视频后自动分段';
  if (isLocalMaterialJob(job)) { $('#timeline-info').textContent=localMaterialStatus(job); $('#timeline-track').innerHTML=localMaterialProgressMarkup(job); return; }
  $('#timeline-track').replaceChildren();
  if (!parts.length) $('#timeline-track').innerHTML = '<div class="empty-track"></div>';
  for (const segment of parts) {
    const block = document.createElement('div');
    block.className = 'timeline-part ' + (segment.state === 'completed' ? 'complete' : segment.state);
    block.title = `第 ${segment.index + 1} 段 · ${segment.duration.toFixed(2)} 秒 · ${labels[segment.state] || segment.state}`;
    block.textContent = parts.length <= 18 ? String(segment.index + 1).padStart(2, '0') : '';
    block.style.flexGrow = segment.frames;
    $('#timeline-track').append(block);
  }
}
function jobActions(job) {
  if(job.state==='funds_required')return `<button class="secondary" data-action="resume" data-id="${job.id}">继续生成</button>`;
  if(['stopped','timed_out','stopping','collecting'].includes(job.state))return outputActions(job)+`<button class="secondary" data-action="detail" data-id="${job.id}">查看已完成内容</button>`;
  return originalJobActions(job)+outputActions(job);
}
function originalJobActions(job) {
  if (isLocalMaterialJob(job)) return localMaterialLegacyActions(job);
  if (job.state === 'completed') return `<a class="download-button" href="/api/jobs/${job.id}/media/result?download=1"><svg><use href="#i-download"/></svg>下载成片</a>`;
  if (job.state === 'needs_attention') return `<button class="secondary" data-action="detail" data-id="${job.id}">处理问题</button>`;
  if (job.state === 'paused' || job.pauseRequested) return `<button class="secondary" data-action="resume" data-id="${job.id}">继续处理</button>`;
  return `<button class="secondary" data-action="pause" data-id="${job.id}">暂停后续</button>`;
}
function renderJobs() {
  $('#nav-count').textContent = state.jobs.filter(j => j.state !== 'completed').length;
  $('#queue-count').textContent = state.jobs.length;
  if (state.jobs.length) $('#job-list').innerHTML = state.jobs.map(job => `<article class="job-card ${state.selected === job.id ? 'chosen' : ''}"><button class="job-select" data-action="select" data-id="${job.id}"><img class="job-thumbnail" src="${localMaterialThumbnail(job)}" alt="替换参考图"><span class="job-text"><strong>${escapeHTML(job.title)}</strong><small>${isLocalMaterialJob(job)?'本地涂抹修复 · 平台用量 0':job.mode === 'face' ? '换脸' : '换产品'} · ${durationLabel(job.source.duration)} · ${job.segments.length} 段 · ${isLocalMaterialJob(job)?'沿用当前画幅':job.model.endsWith('720p') ? '720P' : '480P'}</small></span></button><div class="job-progress"><span>${escapeHTML(isLocalMaterialJob(job)?localMaterialStatus(job):job.state === 'processing' ? job.pauseRequested ? '本段完成后暂停' : job.phase : labels[job.state] || job.state)}</span><div class="progress-line"><i data-progress="${isLocalMaterialJob(job)?localMaterialProgress(job):job.progress}"></i></div></div><div class="job-buttons">${jobActions(job)}</div></article>`).join('');
  $$('#job-list [data-progress]').forEach(item => { item.style.width = item.dataset.progress + '%'; });
  renderDetail();
}
function renderDetail() {
  const job = state.jobs.find(j => j.id === state.selected);
  const container = $('#job-detail');
  container.classList.toggle('hidden', !job);
  if (!job) return;
  if (isLocalMaterialJob(job)) { container.innerHTML = localMaterialRecordDetails(job,{actions:localMaterialLegacyActions(job)}); return; }
  const eventsOpen = !!container.querySelector('details[open]');
  const safeResume = job.state === 'needs_attention' && !job.segments.some(s => ['failed', 'unknown', 'submitting'].includes(s.state));
  container.innerHTML = `<div class="detail-header"><div><h2>${escapeHTML(job.title)}</h2><p>${escapeHTML(job.phase)} · ${new Date(job.created).toLocaleString('zh-CN', { hour12: false })}</p></div><div class="detail-links"><a href="/api/jobs/${job.id}/prompt" target="_blank" rel="noreferrer">查看编辑指令 ↗</a><a href="/api/jobs/${job.id}/receipt">导出任务记录 ↓</a></div></div>${!job.keyMatches && job.state !== 'completed' ? '<div class="notice info">请导入创建此任务时使用的 KEY，再继续处理。</div>' : ''}${job.error ? `<div class="notice error">${escapeHTML(job.error)} ${safeResume ? `<button class="secondary" data-action="resume" data-id="${job.id}">恢复原任务</button>` : ''}</div>` : ''}${partialOutputPanel(job)}<div class="segment-list">${job.segments.map(segment => `<div class="segment-card"><div class="segment-top"><strong>分段 ${String(segment.index + 1).padStart(2, '0')}</strong><span>${labels[segment.state] || escapeHTML(segment.state)}</span></div><p>${durationLabel(segment.start)} – ${durationLabel(segment.start + segment.duration)} · 请求 ${segment.requestDuration} 秒</p>${segment.taskId ? `<p class="segment-id">ID: ${escapeHTML(segment.taskId)}</p>` : ''}${segment.state === 'unknown' ? `<button class="secondary" data-action="bind" data-id="${job.id}" data-index="${segment.index}">绑定原平台任务</button>` : ''}${segment.state === 'failed' ? `<button class="secondary" data-action="retry" data-id="${job.id}" data-index="${segment.index}">重新生成此段</button>` : ''}</div>`).join('')}</div><details class="events" ${eventsOpen ? 'open' : ''}><summary>查看处理记录 · ${job.events.length} 条</summary>${job.events.slice().reverse().map(event => `<div class="event-row"><time>${new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false })}</time><span>${escapeHTML(event.message)}</span></div>`).join('')}</details>`;
}
async function refreshJobs() {
  if (pollBusy) return;
  pollBusy = true;
  try {
    const jobs = await api('/api/jobs');
    const signature = JSON.stringify(jobs);
    if (signature !== jobsSignature) {
      const before = state.jobs.find(j => j.id === state.selected);
      state.jobs = jobs;
      if (before && before.state !== 'completed' && jobs.find(j => j.id === before.id)?.state === 'completed') { state.view = 'result'; toast(isLocalMaterialJob(jobs.find(j=>j.id===before.id))?'局部修复版本已保存，整片仍需人工核对。':'成片已完成，可以预览和下载。'); }
      jobsSignature = signature;
      renderJobs(); renderPreview();
    }
  } finally { pollBusy = false; }
}
function uploadJob(form) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/jobs');
    request.setRequestHeader('X-CSRF-Token', state.csrf);
    request.setRequestHeader('X-Job-Request-Id', state.requestId);
    request.timeout = 3600000;
    request.upload.onprogress = event => {
      if (!event.lengthComputable) return;
      const value = Math.round(event.loaded / event.total * 100);
      $('#upload-progress progress').value = value;
      $('#upload-progress span').textContent = value === 100 ? '正在检查视频并规划分段…' : `正在上传至本地工作空间… ${value}%`;
    };
    request.onload = () => {
      let data;
      try { data = JSON.parse(request.responseText); } catch { reject(new Error('服务响应异常，请检查队列后重试。')); return; }
      request.status >= 200 && request.status < 300 ? resolve(data) : reject(new Error(data.error || '上传未完成。'));
    };
    request.onerror = request.ontimeout = () => reject(new Error('连接中断，请检查任务队列；再次提交同一份表单会优先恢复已有任务。'));
    request.send(form);
  });
}
$('#create-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.uploading || state.readingVideo) return;
  message('#form-error', '');
  if (!state.key.configured) { $('#key-dialog').showModal(); message('#key-message', '先导入你自己的 KEY，素材会保留在表单中。', 'info'); return; }
  if (!state.video || !state.image) return message('#form-error', '请添加原视频和一张替换图片。');
  if (state.duration > 600) return message('#form-error', '视频不能超过 10 分钟。');
  const form = new FormData();
  form.append('mode', state.mode); form.append('model', $('#model').value); form.append('target', $('#target').value); form.append('title', $('#job-title').value);
  form.append('video', state.video); form.append('image', state.image);
  state.uploading = true; document.body.classList.add('uploading'); $('#start-button').disabled = true; $('#start-label').textContent = '正在准备任务…'; $('#upload-progress').classList.remove('hidden');
  const controls = [...$$('.mode-card'), ...$$('#create-form input'), $('#model'), $('#video-remove'), $('#image-remove')]; controls.forEach(control => { control.disabled = true; });
  try {
    const job = await uploadJob(form);
    state.selected = job.id; state.view = 'source';
    await refreshJobs(); renderJobs(); renderPreview();
    toast('任务已加入队列，处理进度会自动更新。');
    $('#queue-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Keep this request ID while this draft is unchanged: a repeated click cannot duplicate a paid job.
  } catch (error) { message('#form-error', error.message); await refreshJobs().catch(() => {}); }
  finally { state.uploading = false; document.body.classList.remove('uploading'); $('#start-button').disabled = false; $('#start-label').textContent = '开始替换'; $('#upload-progress').classList.add('hidden'); controls.forEach(control => { control.disabled = false; }); }
});

$$('.mode-card').forEach(button => button.addEventListener('click', () => changeMode(button.dataset.mode)));
$('#video-file').addEventListener('change', event => chooseVideo(event.target.files[0]).catch(error => message('#form-error', error.message)));
$('#image-file').addEventListener('change', event => chooseImage(event.target.files[0]));
$('#video-remove').addEventListener('click', clearVideo); $('#image-remove').addEventListener('click', clearImage);
for (const [selector, handle] of [['#video-drop', chooseVideo], ['#image-drop', chooseImage]]) {
  const zone = $(selector);
  zone.addEventListener('dragover', event => { event.preventDefault(); if (!state.uploading) zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', async event => { event.preventDefault(); zone.classList.remove('dragover'); if (state.uploading) return; if (event.dataTransfer.files.length !== 1) return message('#form-error', '每次请选择一个文件。'); try { await handle(event.dataTransfer.files[0]); } catch (error) { message('#form-error', error.message); } });
}
for (const selector of ['#target', '#job-title', '#model']) $(selector).addEventListener('input', newDraft);
$('#view-source').addEventListener('click', () => { state.view = 'source'; renderPreview(); });
$('#view-result').addEventListener('click', () => { state.view = 'result'; renderPreview(); });
$('#preview-video').addEventListener('timeupdate', () => { const duration = state.jobs.find(j => j.id === state.selected)?.source.duration || state.duration || 0; $('#timeline-duration').textContent = durationLabel($('#preview-video').currentTime) + ' / ' + durationLabel(duration); });
$('#queue-nav').addEventListener('click', () => $('#queue-section').scrollIntoView({ behavior: 'smooth' }));
$('#new-project').addEventListener('click', () => { state.selected = null; state.view = 'source'; newDraft(); renderPreview(); renderJobs(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
$('#help-open').addEventListener('click', () => $('#help-dialog').showModal());
$('#shutdown-button').addEventListener('click', () => {
  action = { operation: 'shutdown' };
  $('#action-title').textContent = '退出本地软件';
  $('#action-description').textContent = '任务与素材会保留。已经提交的平台任务仍会继续；下次双击「启动映替.cmd」可恢复查询。';
  $('#bind-task-id').classList.add('hidden'); $('#task-id-label').classList.add('hidden');
  $('#action-confirm').textContent = '保存进度并退出'; message('#action-error', ''); $('#action-dialog').showModal();
});
$('#key-open').addEventListener('click', () => { $('#api-key').value = ''; $('#remember-key').checked = !!state.key.remembered; message('#key-message', ''); $('#key-dialog').showModal(); });
$('#key-dialog').addEventListener('close', () => { $('#api-key').value = ''; $('#api-key').type = 'password'; $('#key-reveal').textContent = '显示'; $('#key-file').value = ''; });
$('#key-reveal').addEventListener('click', () => { const field = $('#api-key'); field.type = field.type === 'password' ? 'text' : 'password'; $('#key-reveal').textContent = field.type === 'password' ? '显示' : '隐藏'; });
$('#key-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try { if (file.size > 16384) throw new Error('KEY 文件不能超过 16 KB。'); $('#api-key').value = await file.text(); message('#key-message', '文件已读取，点击保存 KEY 即可使用。', 'info'); }
  catch (error) { message('#key-message', error.message); }
});
$('#key-save').addEventListener('click', async () => {
  $('#key-save').disabled = true;
  try { state.key = await post('/api/key', { key: $('#api-key').value, remember: $('#remember-key').checked }); updateKey(); $('#key-dialog').close(); toast('KEY 已导入。'); await refreshJobs(); }
  catch (error) { message('#key-message', error.message); }
  finally { $('#key-save').disabled = false; }
});
$('#key-check').addEventListener('click', async () => {
  $('#key-check').disabled = true; message('#key-message', '正在检查连接与模型权限，不会创建生成任务…', 'info');
  try { const result = await post('/api/key/check', { key: $('#api-key').value || undefined }); message('#key-message', result.models.length ? `连接成功，可用模型：${result.models.join('、')}${$('#api-key').value ? '。点击保存后即可使用。' : '。'}` : 'KEY 可连接，但当前分组未列出 WAN 3.0，请检查模型权限。', result.models.length ? 'success' : 'error'); }
  catch (error) { message('#key-message', error.message); }
  finally { $('#key-check').disabled = false; }
});
$('#key-clear').addEventListener('click', async () => {
  try { state.key = await api('/api/key', { method: 'DELETE' }); $('#api-key').value = ''; updateKey(); message('#key-message', 'KEY 已清除。任务记录会保留。', 'info'); await refreshJobs(); }
  catch (error) { message('#key-message', error.message); }
});
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]'); if (!button) return;
  const { action: operation, id, index } = button.dataset;
  try {
    if (isLocalMaterialJob(state.jobs.find(job => job.id === id)) && ['pause','resume','bind','retry'].includes(operation)) throw new Error('这是本地修复记录，请在创作页面继续校准。不会提交平台生成。');
    if (operation === 'select' || operation === 'detail') {
      state.selected = id; state.view = state.jobs.find(j => j.id === id)?.state === 'completed' ? 'result' : 'source'; renderJobs(); renderPreview();
      if (operation === 'detail') $('#job-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (operation === 'pause' || operation === 'resume') {
      button.disabled = true; await post(`/api/jobs/${id}/${operation}`); await refreshJobs(); toast(operation === 'pause' ? '已暂停后续提交；已提交分段会继续查询和下载。' : '已继续处理，完成的分段会复用。');
    } else if (operation === 'bind' || operation === 'retry') {
      action = { operation, id, index };
      const bind = operation === 'bind';
      $('#action-title').textContent = bind ? `绑定第 ${Number(index) + 1} 段原任务` : `重新生成第 ${Number(index) + 1} 段`;
      $('#action-description').textContent = bind ? '请在 VocalignTech 使用记录中找到此分段已提交的原任务，核对素材、模型和时间后粘贴任务 ID。绑定后点击继续处理，软件只查询和下载该任务。' : '平台已确认这段生成失败。重新生成会发起一次新的收费调用；已完成分段会保留。';
      $('#bind-task-id').value = ''; $('#bind-task-id').classList.toggle('hidden', !bind); $('#task-id-label').classList.toggle('hidden', !bind);
      $('#action-confirm').textContent = bind ? '核对并绑定' : '确认重新生成'; message('#action-error', ''); $('#action-dialog').showModal();
    }
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});
$('#action-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#action-confirm').disabled = true;
  if (action.operation === 'shutdown') {
    try {
      if(window.yingtiDesktop) await window.yingtiDesktop.exit(); else await post('/api/shutdown'); state.closed = true; $('#action-dialog').close();
      message('#environment-error', '本地服务已停止接收新任务。再次使用时，请双击「启动映替.cmd」。', 'info');
      $('#start-button').disabled = true;
    } catch (error) { message('#action-error', error.message); }
    finally { $('#action-confirm').disabled = false; }
    return;
  }
  try { await post(`/api/jobs/${action.id}/segments/${action.index}/${action.operation}`, action.operation === 'bind' ? { taskId: $('#bind-task-id').value } : { confirmNewCharge: true }); $('#action-dialog').close(); await refreshJobs(); toast(action.operation === 'bind' ? '已绑定原任务，点击继续处理即可恢复。' : '失败段已重新加入队列。'); }
  catch (error) { message('#action-error', error.message); }
  finally { $('#action-confirm').disabled = false; }
});

if(window.yingtiDesktop)window.yingtiDesktop.onPrepareExit(async()=>{
  const deadline=Date.now()+60000;
  while(state.uploading||state.readingVideo){if(Date.now()>deadline)throw new Error('素材仍在读取或上传，请稍后再更新。');await new Promise(resolve=>setTimeout(resolve,100));}
});
try {
  const bootstrap = await api('/api/bootstrap'); state.csrf = bootstrap.csrf; state.key = bootstrap.key; updateKey();
  if (!bootstrap.tools.ffmpeg || !bootstrap.tools.ffprobe) message('#environment-error', '未检测到 FFmpeg / FFprobe。请关闭服务，并使用一键启动器检查安装环境。');
  if (bootstrap.tools.testing) message('#environment-error', '仅供界面测试：生成端为模拟接口，不会调用或计费真实 WAN。', 'info');
  await refreshJobs();
  setInterval(() => { if (!state.closed) refreshJobs().catch(() => message('#environment-error', '本地服务暂时断开。请检查软件是否运行，重启后刷新页面即可恢复。')); }, 3000);
} catch (error) { message('#environment-error', '无法连接本地服务，请运行一键启动器后刷新页面。'); }

installOutputRecovery({csrf:()=>state.csrf,refresh:refreshJobs,onError:toast});

installFundingUI({csrf:()=>state.csrf,onError:toast}).catch(error=>toast(error.message));
