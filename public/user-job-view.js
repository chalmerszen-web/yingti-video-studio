import {isLocalMaterialJob,localMaterialStatus,localMaterialProgress,localMaterialProgressMarkup} from './local-material-view.js';
// Presentation only: never submit, retry or estimate provider progress here.
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);

export function generationStatus(job) {
  if(isLocalMaterialJob(job))return localMaterialStatus(job);
  if (job.state === 'completed') return '视频已生成';
  if (job.state === 'funds_required') return '等待继续生成';
  if (job.state === 'stopped') return '已中止生成';
  if (job.state === 'timed_out') return '等待已超过3600秒';
  if (job.state === 'stopping') return '正在中止并保留结果';
  if (job.state === 'collecting') return '正在收取已完成视频';
  if (job.state === 'needs_attention') return '需要处理';
  if (job.state === 'paused') return '已暂停';
  if (job.state === 'waiting_key') return '等待连接视频服务';
  if (job.pauseRequested) return '正在暂停';
  if (job.state === 'queued') return '排队中';
  const phase = String(job.phase || '');
  if (/额度/.test(phase)) return '正在核对生成额度';
  if (/拼接|合成|封装/.test(phase)) return '正在合成成片';
  if (/下载|校准|校验/.test(phase)) return '正在保存生成结果';
  if (/上传/.test(phase)) return '正在上传素材';
  if (/提交|排队|等待/.test(phase)) return '等待云端处理';
  if (/准备|读取|冻结|规划/.test(phase)) return '正在准备素材';
  return '正在生成视频';
}

export function generationProgress(job) {
  if(isLocalMaterialJob(job))return localMaterialProgress(job);
  if (job.state === 'completed') return 100;
  // The backend reports completed work. Do not invent a smooth timer-based percent.
  const parts = job.segments || [];
  const value = Number.isFinite(job.progress) ? job.progress : parts.length ? parts.filter(p => p.state === 'completed').length / parts.length * 95 : 0;
  return Math.max(0, Math.min(97, Math.round(value)));
}

export function jobProgressMarkup(job) {
  if(isLocalMaterialJob(job))return localMaterialProgressMarkup(job);
  const progress = generationProgress(job), status = generationStatus(job);
  const hint = job.state === 'completed' ? '成片已保存，请预览并检查画面与声音。'
    : ['stopped','timed_out'].includes(job.state) ? '已完成内容已保留，可在下方查看和导出。'
    : ['stopping','collecting'].includes(job.state) ? '不再提交新的生成请求，正在保存已经完成的内容。'
    : job.state === 'needs_attention' ? '已完成的内容已保留，处理下方提示后可继续。'
    : job.state === 'paused' ? '恢复后会从已保存的进度继续。'
    : job.pauseRequested ? '当前处理完成后暂停，进度会自动保存。'
    : '进度按已完成的内容更新，完成后可直接预览和下载。';
  return `<section class="user-job-progress" aria-label="视频生成进度"><div class="user-progress-heading"><span>整体进度</span><strong>${progress}<small>%</small></strong></div><progress max="100" value="${progress}" aria-label="视频生成总进度" aria-valuetext="${esc(status)}，${progress}%">${progress}%</progress><div class="user-progress-status" role="status"><span>${esc(status)}</span><span>${hint}</span></div></section>`;
}

export function jobRecoveryActions(job, actions = { retry:'retry-job', bind:'bind-job', resume:'resume-job' }) {
  if(isLocalMaterialJob(job))return '';
  if (job.state === 'completed') return '';
  const parts = job.segments || [];
  const unresolved = parts.filter(p => ['failed', 'unknown'].includes(p.state));
  const stamp = n => `${String(Math.floor((n || 0) / 60)).padStart(2,'0')}:${String(Math.floor((n || 0) % 60)).padStart(2,'0')}`;
  const buttons = unresolved.map(part => {
    const unknown = part.state === 'unknown';
    const range = unresolved.length > 1 ? `（${stamp(part.start)}–${stamp(part.start + part.duration)}）` : '';
    return `<button class="secondary" data-action="${esc(unknown ? actions.bind : actions.retry)}" data-id="${esc(job.id)}" data-index="${esc(part.index)}">${unknown ? '找回已提交任务' : '重新生成未完成内容'}${range}</button>`;
  });
  if (job.state === 'needs_attention' && !unresolved.length && !parts.some(p => p.state === 'submitting')) buttons.push(`<button class="secondary" data-action="${esc(actions.resume)}" data-id="${esc(job.id)}">继续处理</button>`);
  return buttons.length ? `<div class="user-recovery-actions">${buttons.join('')}</div>` : '';
}

// The developer edition keeps its disclosure UI; the user edition displays it directly.
export function expandedSections(html) {
  return html.replace(/<details\b([^>]*)>/g, '<section$1>').replaceAll('</details>', '</section>')
    .replace(/<summary\b[^>]*>/g, '<h4 class="disclosure-heading">').replaceAll('</summary>', '</h4>')
    .replaceAll('查看原片完整台词（只读）', '原片完整台词（只读）')
    .replaceAll('查看自动时间分配（只读，无需逐段修改）', '台词时间安排（只读）');
}
