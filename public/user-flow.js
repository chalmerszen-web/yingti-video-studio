// Presentation state only. Analysis, edits, generation and billing remain on
// the existing API; visiting a page never creates a model request.
export const workflowPages = ['import', 'analysis', 'edit', 'generate'];
export const pageTitles = { import: '导入原片', analysis: '视频分析', edit: '编辑内容', generate: '视频生成', projects: '我的项目', records: '生成记录', record: '查看生成结果' };
export function availablePage(requested, project) {
  if (!Object.hasOwn(pageTitles, requested)) return 'import';
  if (['projects', 'records', 'record', 'import'].includes(requested)) return requested;
  if (!project) return 'import';
  if (['edit', 'generate'].includes(requested) && project.state !== 'ready') return 'analysis';
  return requested;
}
export function viewURL(page, { projectId, jobId, demo } = {}) {
  const query = new URLSearchParams({ view: page });
  if (projectId && !demo) query.set('project', projectId);
  if (jobId && ['generate', 'record'].includes(page)) query.set('job', jobId);
  if (demo) query.set('demo', '1');
  return '/?' + query;
}
export function friendly(value) {
  return String(value ?? '')
    .replace(/Omni[ -]?(?:Analysis|Plus)/gi, '视频分析')
    .replace(/wan3\.0-(?:480|720)p/gi, model => model.endsWith('480p') ? '标准画质' : '高清画质')
    .replace(/WAN\s*3\.0|WAN3\.0|\bWAN\b/gi, '视频生成')
    .replace(/VocalignTech/gi, '视频服务平台')
    .replace(/API\s*KEY|\bKEY\b/gi, '访问密钥')
    .replace(/FFmpeg\s*\/\s*FFprobe|FFmpeg|FFprobe/g, '视频处理组件')
    .replace(/JSON\.parse|JSON/g, '数据格式')
    .replace(/SSE/g, '分析连接')
    .replace(/本地服务暂时断开/g, '软件连接暂时中断')
    .replace(/本地服务返回异常/g, '软件暂时未能读取结果')
    .replace(/一键启动器/g, '软件桌面图标')
    .replace(/提示词扩写已开启。/g, '')
    .replace(/提示词扩写：已开启/g, '已保存本次编辑要求')
    .replace(/模型/g, '视频服务')
    .replace(/结构化动作观察/g, '动作分析结果');
}

export function connectionSummary(models) {
  const analysis = models.includes('Omni-Analysis');
  const generation = models.some(model => /^wan3\.0-(480|720)p$/i.test(model));
  return { analysis, generation, text: `视频分析：${analysis ? '可用' : '暂不可用'}；视频生成：${generation ? '可用' : '暂不可用'}。${analysis && generation ? '连接正常，可以开始创作。' : '请确认访问密钥已开通所需服务。'}` };
}
