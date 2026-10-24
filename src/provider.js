import { openAsBlob } from 'node:fs';
import { stat, rename, unlink, open } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AppError, invariant } from './errors.js';

export const API_ORIGIN = 'https://platform.vocaligntech.com';
export const ANALYSIS_MODEL = 'Omni-Analysis';
export const ANALYSIS_MODELS = Object.freeze([ANALYSIS_MODEL]);
// Recognise saved historical metadata only; no request can select this old model.
export function currentAnalysisModel(saved) {
  invariant(saved == null || saved === 'Omni-Plus' || saved === ANALYSIS_MODEL, '已保存的分析模型无法识别，请核对任务。');
  return ANALYSIS_MODEL;
}
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export class ProviderError extends AppError {
  constructor(message, status = 502, code = 'provider_error') { super(message, status, code); }
}

export class VocalignProvider {
  constructor(key, { fetchImpl = fetch, origin = API_ORIGIN, sleep = delay, allowTestHttp = false } = {}) {
    this.key = key;
    this.fetch = fetchImpl;
    this.origin = origin;
    this.sleep = sleep;
    this.allowTestHttp = allowTestHttp;
  }
  validateURL(value) {
    const url = new URL(value);
    invariant((url.protocol === 'https:' || this.allowTestHttp && url.protocol === 'http:') && !url.username && !url.password && !url.hash, '平台返回了不支持的素材地址。');
    return url;
  }
  async request(endpoint, { method = 'GET', headers = {}, json, timeout = 60000, signal, retries = 3 } = {}) {
    invariant((endpoint.startsWith('/v1/') || method==='GET' && ['/api/status','/api/usage/token/'].includes(endpoint)) && !endpoint.includes('..'), '无效的平台请求路径。');
    const read = method === 'GET';
    const options = {
      method, headers: { ...headers, Authorization: 'Bearer ' + this.key }, redirect: 'manual',
      ...(json ? { body: JSON.stringify(json) } : {}),
    };
    if (json) options.headers['Content-Type'] = 'application/json';
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await this.fetch(this.origin + endpoint, { ...options, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
      } catch {
        if (signal?.aborted) throw new ProviderError('操作已中止，原任务记录已保留。', 409, 'operation_aborted');
        if (read && attempt < retries) { await this.sleep(1000 * 2 ** attempt); continue; }
        throw new ProviderError(read ? '查询连接中断，已保留原任务 ID，可稍后恢复查询。' : '提交结果未知。请在平台核对原任务，并填回任务 ID；软件不会自动重复提交。', 502, read ? 'read_network' : 'submit_unknown');
      }
      if (read && RETRYABLE.has(response.status) && attempt < retries) {
        await response.body?.cancel();
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!response.ok) {
        const status = response.status;
        await response.body?.cancel();
        const hint = status === 401 || status === 403 ? '请检查 KEY、余额与模型分组权限。' : status === 429 ? '平台限流，请稍后恢复。' : '请查看平台使用记录。';
        throw new ProviderError(`平台返回 HTTP ${status}。${hint}${!read ? '本次提交不会自动重发。' : ''}`, 502, 'http_' + status);
      }
      try { return await response.json(); }
      catch { throw new ProviderError(read ? '平台查询返回格式异常，可恢复原任务。' : '平台未返回有效任务回执，请先核对平台记录。', 502, read ? 'invalid_response' : 'submit_unknown'); }
    }
  }
  async check() {
    const response = await this.request('/v1/models');
    invariant(Array.isArray(response.data), '平台模型列表格式异常。');
    const ids = response.data.map(item => item.id);
    return { models: [...ANALYSIS_MODELS, 'wan3.0-720p', 'wan3.0-480p'].filter(id => ids.includes(id)) };
  }
  async balance({signal}={}) {
    const options={signal,timeout:20000,retries:1};
    const site=await this.request('/api/status',options);
    const subscription=await this.request('/v1/dashboard/billing/subscription',options);
    const usage=await this.request('/v1/dashboard/billing/usage',options);
    const response=await this.request('/api/usage/token/',options),token=response.data;
    invariant(site.success===true && site.data && subscription.object==='billing_subscription' && usage.object==='list' && response.code===true && token?.object==='token_usage','暂时无法核对账户额度，未提交生成。',503);
    const cfg=site.data,currency=cfg.quota_display_type;
    invariant(['CNY','USD','TOKENS'].includes(currency)&&Number.isFinite(cfg.quota_per_unit)&&cfg.quota_per_unit>0,'额度计量规则暂不可用，未提交生成。',503);
    invariant(Number.isFinite(subscription.hard_limit_usd)&&Number.isFinite(usage.total_usage)&&typeof token.unlimited_quota==='boolean'&&Number.isFinite(token.total_available),'账户额度数据不完整，未提交生成。',503);
    if(cfg.display_token_stat_enabled!==false)throw new ProviderError('平台未明确提供账户钱包余额，不能把密钥额度当作钱包余额。尚未提交生成。',503,'funding_unavailable');
    invariant(!(token.unlimited_quota&&subscription.hard_limit_usd===100000000),'平台仅返回无限密钥额度，无法核实实际账户余额，未提交生成。',503);
    const factor=currency==='TOKENS'?1:currency==='CNY'?cfg.usd_exchange_rate/cfg.quota_per_unit:1/cfg.quota_per_unit;
    invariant(Number.isFinite(factor)&&factor>0,'额度换算规则无效，未提交生成。',503);
    const accountAvailable=subscription.hard_limit_usd-usage.total_usage/100;
    const tokenAvailable=token.unlimited_quota?null:token.total_available*factor;
    invariant(!token.expires_at||token.expires_at*1000>Date.now(),'访问密钥已过期，未提交生成。',409);
    return {available:Math.max(0,Math.min(accountAvailable,tokenAvailable??Infinity)),currency,accountAvailable,tokenAvailable,tokenUnlimited:token.unlimited_quota,
      usdExchangeRate:cfg.usd_exchange_rate,quotaPerUnit:cfg.quota_per_unit,modelLimitsEnabled:token.model_limits_enabled===true,modelLimits:token.model_limits||{},checkedAt:new Date().toISOString()};
  }
  async listVoices() {
    const response = await this.request('/v1/audio/voices');
    const voices = Array.isArray(response) ? response : response.data ?? response.voices;
    invariant(Array.isArray(voices) && voices.length <= 10000, '平台音色列表格式异常。', 502);
    return voices.filter(voice => voice && typeof voice.id === 'string' && /^voice_[a-zA-Z0-9_-]{1,200}$/.test(voice.id)).map(voice => ({
      id: voice.id, name: typeof voice.name === 'string' ? voice.name.slice(0, 160) : voice.id,
      status: typeof voice.status === 'string' ? voice.status.slice(0, 40) : 'unknown',
    }));
  }
  async synthesizeSpeech({ voiceId, input, speed = 1, idempotencyKey, signal }, destination) {
    invariant(typeof voiceId === 'string' && /^voice_[a-zA-Z0-9_-]{1,200}$/.test(voiceId), '请选择账户内已就绪的私有音色。');
    invariant(typeof input === 'string' && input.trim() && input.length <= 20000, '配音正文须为 1–20000 字符。');
    invariant(Number.isFinite(speed) && speed >= 0.5 && speed <= 2, '配音语速须在 0.5–2.0 之间。');
    invariant(typeof idempotencyKey === 'string' && /^[a-zA-Z0-9_-]{16,100}$/.test(idempotencyKey), '配音提交记录无效。');
    invariant(path.isAbsolute(destination), '配音保存路径无效。');
    for (const file of [destination, destination + '.partial']) {
      let present = false;
      try { await stat(file); present = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      invariant(!present, '已存在配音文件或部分响应，请核对保存记录；本次未提交配音。', 409);
    }
    let response;
    try {
      // A binary POST is submitted once. Idempotency is recorded by our caller;
      // this header does not imply that the provider permits paid POST retries.
      response = await this.fetch(this.origin + '/v1/audio/speech', {
        method: 'POST', redirect: 'manual', signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(3600000)]) : AbortSignal.timeout(3600000),
        headers: { Authorization: 'Bearer ' + this.key, 'Content-Type': 'application/json', Accept: 'audio/wav', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ model: 'openai-tts', voice: voiceId, input, speed, response_format: 'wav' }),
      });
    } catch { throw new ProviderError('配音提交结果未知，已保留提交记录；请核对平台记录，软件不会自动重复配音。', 502, 'speech_unknown'); }
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const length = Number(response.headers.get('content-length'));
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new ProviderError(`配音返回 HTTP ${response.status}，请核对平台记录；本次不会自动重发。`, 502, 'speech_http_' + response.status);
    }
    if (!['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'application/octet-stream'].includes(contentType) || length > 100 * 1024 * 1024) {
      await response.body.cancel();
      throw new ProviderError('配音响应不是 WAV 或超过 100 MiB，已保留提交记录；不会自动重发。', 502, 'speech_invalid');
    }
    const partial = destination + '.partial'; let bytes = 0, owned = false;
    try {
      const output = createWriteStream(partial, { flags: 'wx' });
      output.once('open', () => { owned = true; });
      const limit = new Transform({ transform(chunk, encoding, callback) {
        bytes += chunk.length;
        callback(bytes > 100 * 1024 * 1024 ? new ProviderError('配音超过 100 MiB，已停止保存；不会自动重发。', 502, 'speech_invalid') : null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), limit, output);
      invariant(bytes >= 44, '配音文件为空或不完整；不会自动重发。', 502);
      const handle = await open(partial, 'r');
      try {
        const header = Buffer.alloc(12); await handle.read(header, 0, 12, 0);
        invariant(['RIFF', 'RF64'].includes(header.toString('ascii', 0, 4)) && header.toString('ascii', 8, 12) === 'WAVE', '配音二进制不是 WAV；不会自动重发。', 502);
      } finally { await handle.close(); }
      await rename(partial, destination);
      return { bytes, contentType };
    } catch (error) {
      if (owned) await unlink(partial).catch(() => {});
      if (error instanceof AppError) throw error;
      throw new ProviderError('配音音频接收或保存中断，已保留提交记录；请核对平台记录，软件不会自动重复配音。', 502, 'speech_unknown');
    }
  }
  async upload(file, model, affinity, { signal } = {}) {
    const policy = await this.request('/v1/uploads?action=getPolicy&model=' + encodeURIComponent(model), { headers: affinity ? { 'X-Vocalign-Task-Affinity': affinity } : {}, signal });
    const required = ['policy', 'signature', 'upload_dir', 'upload_host', 'oss_access_key_id', 'x_oss_object_acl', 'x_oss_forbid_overwrite'];
    invariant(required.every(key => typeof policy[key] === 'string' && policy[key]), '平台返回的上传凭证不完整。');
    const limits = [policy.max_file_size_mb, policy.capacity_limit_mb];
    invariant(limits.every(n => Number.isFinite(n) && n > 0), '平台未返回有效的上传容量限制。');
    invariant((await stat(file)).size <= Math.min(...limits) * 1024 * 1024, '此分段或图片超过平台当前的上传容量限制。');
    const directory = policy.upload_dir.replace(/^\/+|\/+$/g, '');
    invariant(/^[a-zA-Z0-9._/-]+$/.test(directory) && !directory.split('/').includes('..'), '平台上传目录格式异常。');
    const suffix = path.extname(file).toLowerCase();
    invariant(/^\.[a-z0-9]{1,8}$/.test(suffix), '素材扩展名不正确。');
    const objectKey = directory + '/' + randomUUID() + suffix;
    const form = new FormData();
    const fields = {
      OSSAccessKeyId: policy.oss_access_key_id, Signature: policy.signature, policy: policy.policy,
      'x-oss-object-acl': policy.x_oss_object_acl, 'x-oss-forbid-overwrite': policy.x_oss_forbid_overwrite,
      key: objectKey, success_action_status: '200',
    };
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    form.append('file', await openAsBlob(file), 'input' + suffix);
    let response;
    try {
      // Never send the platform key to the temporary object storage host.
      response = await this.fetch(this.validateURL(policy.upload_host), { method: 'POST', body: form, redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(600000)]) : AbortSignal.timeout(600000) });
    } catch { throw new ProviderError('素材上传中断，尚未创建生成任务；可安全恢复上传。', 502, 'upload_network'); }
    await response.body?.cancel();
    invariant(response.ok, `素材直传失败（HTTP ${response.status}），尚未创建生成任务。`, 502);
    return 'oss://' + objectKey;
  }
  async create(body, segment, { signal } = {}) {
    const result = await this.request('/v1/videos', {
      method: 'POST', json: body, timeout: 3600000, signal,
      headers: { 'Idempotency-Key': segment.idempotencyKey, 'X-Vocalign-Task-Affinity': segment.affinity },
    });
    const taskId = result.id || result.task_id;
    invariant(typeof taskId === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(taskId), '平台未返回有效任务 ID，请核对平台记录，不能重复提交。', 502);
    return taskId;
  }
  async status(taskId, options = {}) { return this.request('/v1/videos/' + encodeURIComponent(taskId), options); }
  async analyzeVideo(videoURL, prompt, onText = async () => {}, { model = 'Omni-Analysis' } = {}) {
    invariant(model === ANALYSIS_MODEL, '当前唯一支持的视频分析模型为 Omni-Analysis。');
    const payload = {
      model, messages: [{ role: 'user', content: [{ type: 'video_url', video_url: { url: videoURL } }, { type: 'text', text: prompt }] }],
      modalities: ['text'], stream: true, stream_options: { include_usage: true },
    };
    let response;
    try {
      response = await this.fetch(this.origin + '/v1/chat/completions', {
        method: 'POST', headers: { Authorization: 'Bearer ' + this.key, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(payload), redirect: 'manual', signal: AbortSignal.timeout(3600000),
      });
    } catch { throw new ProviderError('Omni-Analysis 分析请求结果未知，已保留记录，不会自动重复调用。', 502, 'analysis_unknown'); }
    if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
      await response.body?.cancel();
      throw new ProviderError(`Omni-Analysis 返回异常（HTTP ${response.status}）。请检查 KEY 的 Omni-Analysis 权限或平台记录。`, 502, 'analysis_response');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '', text = '', usage = null, responseId = null, done = false;
    const handle = async event => {
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n').trim();
      if (!data) return;
      if (data === '[DONE]') { done = true; return; }
      let item;
      try { item = JSON.parse(data); } catch { throw new ProviderError('Omni-Analysis 流式数据格式异常，已保存部分结果。'); }
      invariant(!item.error, 'Omni-Analysis 在分析中返回错误，已保存部分结果。', 502);
      if (item.usage) usage = item.usage;
      if (typeof item.id === 'string') responseId = item.id.slice(0, 200);
      for (const choice of item.choices || []) {
        const value = choice?.delta?.content;
        const delta = typeof value === 'string' ? value : Array.isArray(value) ? value.map(v => v.text || '').join('') : '';
        if (delta) { text += delta; invariant(text.length <= 1000000, '分析结果过长，已停止接收并保存进度。', 502); await onText(delta); }
      }
    };
    try {
      while (!done) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        invariant(pending.length <= 1000000, 'Omni-Analysis 流式事件过长。', 502);
        let match;
        while (!done && (match = /\r?\n\r?\n/.exec(pending))) {
          const event = pending.slice(0, match.index); pending = pending.slice(match.index + match[0].length); await handle(event);
        }
      }
      pending += decoder.decode();
      if (!done && pending.trim()) await handle(pending);
      invariant(done, '分析连接在完成标记前断开，部分文字已保留；不会自动重发。', 502);
      invariant(text.trim(), 'Omni-Analysis 没有返回分析正文。', 502);
      return { text, usage, responseId, complete: true };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new ProviderError('Omni-Analysis 流式连接中断，已保留部分结果，不会自动重复调用。', 502, 'analysis_unknown');
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  async download(taskId, destination) {
    let target = this.origin + '/v1/videos/' + encodeURIComponent(taskId) + '/content';
    const partial = destination + '.partial';
    try {
      for (let step = 0; step < 6; step++) {
        const url = this.validateURL(target);
        const response = await this.fetch(url, {
          headers: step === 0 ? { Authorization: 'Bearer ' + this.key } : {},
          redirect: 'manual', signal: AbortSignal.timeout(3600000),
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          invariant(location, '下载重定向缺少地址。', 502);
          target = new URL(location, target).href;
          continue;
        }
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new ProviderError(`结果下载未完成（HTTP ${response.status}）。恢复时只下载原任务。`, 502, 'download_failed');
        }
        let bytes = 0;
        const limit = new Transform({ transform(chunk, encoding, callback) {
          bytes += chunk.length;
          callback(bytes > 1024 ** 3 ? new AppError('单段下载超过 1 GB，请核对平台产物。') : null, chunk);
        } });
        await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(partial));
        invariant(bytes > 0, '平台返回了空视频。', 502);
        await rename(partial, destination);
        return;
      }
      throw new ProviderError('结果下载重定向次数异常。');
    } catch (error) {
      await unlink(partial).catch(() => {});
      if (error instanceof AppError) throw error;
      throw new ProviderError('结果下载中断，保留原任务 ID，可恢复下载。', 502, 'download_network');
    }
  }
}
