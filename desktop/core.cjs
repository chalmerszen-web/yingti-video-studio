const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');

function identity(directory) {
  const absolute = path.resolve(directory).replace(/[\\/]+$/, '');
  return createHash('sha256').update(process.platform === 'win32' ? absolute.toLowerCase() : absolute).digest('hex').slice(0, 24);
}
async function readJSON(file, fallback = null) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; } }
async function writeJSON(file, value) { await fs.writeFile(file + '.tmp', JSON.stringify(value, null, 2) + '\n'); await fs.rename(file + '.tmp', file); }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function getJSON(url, timeout = 3000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error('本地服务未就绪。');
  return response.json();
}
function runScript(root, script, args, directory, timeout = 240000) {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', script), ...args], { cwd: root, env: { ...process.env, WAN_EDITOR_DATA_DIR: directory }, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => reject(new Error('本地服务处理超时，请查看数据目录的日志后重试。')), timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('本地服务操作未完成。请查看 launcher-error.log 或 update-error.log。')); });
  });
}
async function startBackend(root, directory) {
  await runScript(root, 'start.ps1', ['-NoBrowser'], directory, 45000);
  const address = await readJSON(path.join(directory, 'runtime.json'));
  if (!address || address.instanceId !== identity(directory) || !Number.isInteger(address.port) || address.port < 1024 || address.port > 65535) throw new Error('本地工作台地址无效，请重新启动应用。');
  const origin = `http://127.0.0.1:${address.port}`;
  const health = await getJSON(origin + '/api/health');
  if (health.instanceId !== address.instanceId || health.app !== 'wan-replace-studio') throw new Error('本地端口不属于此工作台。');
  return { origin, pid: address.pid, instanceId: address.instanceId };
}
function isLocalURL(value, origin) {
  try { const url = new URL(value); return url.origin === origin && !url.username && !url.password; } catch { return false; }
}
function savedRoute(value) {
  try {
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null;
    const url = new URL(value, 'http://local.invalid');
    if (url.origin !== 'http://local.invalid') return null;
    if (!['/', '/legacy'].includes(url.pathname)) return null;
    const project = url.searchParams.get('project');
    if (project && !/^[a-f0-9-]{36}$/i.test(project)) return null;
    return url.pathname + (project ? '?project=' + project : '');
  } catch { return null; }
}
function externalURL(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.port && !url.username && !url.password && ['platform.vocaligntech.com', 'www.vocaligntech.com'].includes(url.hostname); } catch { return false; }
}
module.exports = { identity, readJSON, writeJSON, sleep, getJSON, runScript, startBackend, isLocalURL, savedRoute, externalURL };
