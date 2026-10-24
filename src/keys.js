import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, unlink, rename } from 'node:fs/promises';
import path from 'node:path';
import { AppError, invariant } from './errors.js';

export function parseKey(raw) {
  invariant(typeof raw === 'string' && raw.length <= 16384, 'KEY 文件格式不正确，最大 16 KB。');
  let key = raw.replace(/^\uFEFF/, '').trim();
  if (key.startsWith('{')) {
    let object;
    try { object = JSON.parse(key); } catch { throw new AppError('KEY JSON 文件无法解析。'); }
    key = object.api_key ?? object.apikey ?? object.key ?? object.token;
  }
  invariant(typeof key === 'string', 'KEY 文件中应包含 api_key、key 或 token。');
  key = key.replace(/^Bearer\s+/i, '').trim();
  invariant(/^[\x21-\x7e]{8,4096}$/.test(key), '请输入单个有效 KEY，不要包含空格或换行。');
  return key;
}

// DPAPI binds the saved secret to the current Windows account. Plaintext goes over stdin only.
function dpapi(value, decrypt = false) {
  invariant(process.platform === 'win32', '当前系统仅支持本次运行使用 KEY。');
  const script = `Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($v); $o=[Security.Cryptography.ProtectedData]::${decrypt ? 'Unprotect' : 'Protect'}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($o))`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new AppError('Windows 凭据加密超时。')); }, 15000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.on('error', () => { clearTimeout(timer); reject(new AppError('无法调用 Windows 凭据保护。')); });
    child.stdin.on('error', () => {});
    child.on('close', code => {
      clearTimeout(timer);
      code === 0 && output ? resolve(output.trim()) : reject(new AppError('无法读取或保存加密 KEY，请重新导入。'));
    });
    child.stdin.end(value);
  });
}

export class KeyVault {
  constructor(directory) {
    this.file = path.join(directory, 'credential.dpapi');
    this.key = null;
    this.remember = false;
  }
  async load() {
    try {
      this.key = parseKey(Buffer.from(await dpapi(await readFile(this.file, 'utf8'), true), 'base64').toString('utf8'));
      this.remember = true;
    } catch { this.key = null; this.remember = false; }
  }
  async set(raw, remember = false) {
    const key = parseKey(raw);
    if (remember) {
      const encrypted = await dpapi(Buffer.from(key).toString('base64'));
      await writeFile(this.file + '.tmp', encrypted, { mode: 0o600 });
      await rename(this.file + '.tmp', this.file);
    } else {
      await unlink(this.file).catch(e => { if (e.code !== 'ENOENT') throw e; });
    }
    this.key = key;
    this.remember = remember;
  }
  async clear() {
    await unlink(this.file).catch(e => { if (e.code !== 'ENOENT') throw e; });
    this.key = null;
    this.remember = false;
  }
  hash() { return this.key ? createHash('sha256').update(this.key).digest('hex') : null; }
  status() { return { configured: !!this.key, remembered: this.remember, canRemember: process.platform === 'win32' }; }
  require(hash) {
    invariant(this.key, '请先导入 VocalignTech KEY。', 409);
    invariant(!hash || hash === this.hash(), '此任务绑定了另一枚 KEY，请导入创建任务时使用的 KEY 后继续。', 409);
    return this.key;
  }
}
