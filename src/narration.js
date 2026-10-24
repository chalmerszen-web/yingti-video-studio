import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename, stat, copyFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { AppError, invariant, safeError } from './errors.js';
import { parseFullDialogue } from './full-dialogue.js';
import { ffmpeg, runTool } from './media.js';

const VERSION = 1, SAMPLE_RATE = 48000;
const active = new Map();
const hash = value => createHash('sha256').update(value).digest('hex');
const available = async file => { try { return (await stat(file)).isFile(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
async function readState(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new AppError('配音提交记录无法读取，请核对本地记录；不会自动重复配音。', 409, 'narration_record'); }
}
async function atomicJSON(file, data) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(data, null, 2), { flag: 'wx' });
  await rename(temporary, file);
}
export async function inspectNarrationAudio(file) {
  const bundled = path.resolve(import.meta.dirname, '..', 'runtime', 'ffprobe' + (process.platform === 'win32' ? '.exe' : ''));
  const binary = existsSync(bundled) ? bundled : process.env.FFPROBE_PATH || 'ffprobe';
  let data;
  try { data = JSON.parse(await runTool(binary, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_format', '-show_streams', '-of', 'json', file], 60000)); }
  catch (error) { if (error instanceof AppError) throw error; throw new AppError('配音媒体信息无效，请核对已保存录音。', 422, 'narration_audio'); }
  const audio = data.streams?.find(stream => stream.codec_type === 'audio');
  const duration = Number(audio?.duration || data.format?.duration);
  invariant(audio && !data.streams.some(stream => stream.codec_type === 'video') && Number.isFinite(duration) && duration > 0, '配音文件没有有效的独立音轨。', 422);
  return { duration, codec: audio.codec_name, sampleRate: Number(audio.sample_rate), channels: Number(audio.channels) };
}
const defaultTools = {
  inspect: inspectNarrationAudio,
  normalize: async (source, destination) => ffmpeg(['-xerror', '-protocol_whitelist', 'file,pipe', '-i', source, '-map', '0:a:0', '-vn', '-af', 'asetpts=PTS-STARTPTS', '-ar', String(SAMPLE_RATE), '-ac', '2', '-c:a', 'pcm_s16le', destination]),
  // whole_len pads to a sample count and cannot trim or accelerate existing speech.
  pad: async (source, destination, samples) => ffmpeg(['-xerror', '-protocol_whitelist', 'file,pipe', '-i', source, '-map', '0:a:0', '-vn', '-af', `asetpts=PTS-STARTPTS,apad=whole_len=${samples}`, '-ar', String(SAMPLE_RATE), '-ac', '2', '-c:a', 'pcm_s16le', destination]),
};
export function narrationRequest(job) {
  const full = job.recipe?.edits?.fullDialogue;
  if (!full?.enabled || full.delivery !== 'voiceover') return null;
  invariant(full.speakerId === 'narrator', '独立口播须选择画外旁白，人物对话不能伪装成同步口型。');
  invariant(typeof full.voiceId === 'string' && /^voice_[a-zA-Z0-9_-]{1,200}$/.test(full.voiceId), '请选择账户内已就绪的私有音色。');
  const speed = full.speed ?? 1;
  invariant(Number.isFinite(speed) && speed >= 0.5 && speed <= 2, '配音语速须在 0.5–2.0 之间。');
  const parsed = parseFullDialogue(full.text, job.recipe.story.assets || []);
  invariant(parsed.blocks.every(block => block.characterId == null), '独立画外口播不能包含人物发言标签，请改为旁白正文或使用人物对话模式。');
  const input = parsed.spokenText;
  invariant(input.trim() && input.length <= 20000, '配音正文须为 1–20000 字符。');
  const targetFrames = job.segments?.reduce((total, segment) => total + segment.frames, 0);
  invariant(Number.isInteger(targetFrames) && targetFrames > 0 && targetFrames <= 18000, '无法确定配音对应的成片时长。');
  return { input, voiceId: full.voiceId, speed, textHash: hash(input),
    requestHash: hash(JSON.stringify({ version: VERSION, input, voiceId: full.voiceId, speed })),
    targetFrames, targetDuration: targetFrames / 30, targetSamples: targetFrames * (SAMPLE_RATE / 30) };
}

export async function prepareNarration(directory, job, provider, onUpdate = async () => {}, options = {}) {
  const request = narrationRequest(job);
  if (!request) return null;
  invariant(path.isAbsolute(directory) && (!options.cacheDirectory || path.isAbsolute(options.cacheDirectory)), '配音保存目录无效。');
  const cacheRoot = options.cacheDirectory || path.join(directory, 'narration');
  const folder = path.join(cacheRoot, request.requestHash);
  const previous = active.get(folder);
  if (previous) { await previous.catch(() => {}); return prepareNarration(directory, job, provider, onUpdate, options); }
  const promise = prepare(directory, folder, job, provider, onUpdate, options, request);
  active.set(folder, promise);
  try { return await promise; } finally { if (active.get(folder) === promise) active.delete(folder); }
}

async function prepare(directory, folder, job, provider, onUpdate, options, request) {
  const relative = 'narration/' + request.requestHash;
  const localFolder = path.join(directory, relative), stateFile = path.join(folder, 'state.json');
  await mkdir(folder, { recursive: true }); await mkdir(localFolder, { recursive: true });
  const raw = path.join(folder, 'original.wav'), marker = path.join(folder, 'submitted.json');
  const localRaw = path.join(localFolder, 'original.wav'), normalized = path.join(localFolder, 'full.wav'), timeline = path.join(localFolder, 'audio.wav');
  let state = await readState(stateFile);
  if (state) invariant(state.accountHash === (job.keyHash || ''), '配音缓存属于其他账户，不能跨 KEY 复用录音或提交记录。', 409);
  if (!state && job.narration?.requestHash === request.requestHash) state = { ...job.narration, accountHash: job.keyHash || '' };
  if (state) invariant(state.requestHash === request.requestHash && state.textHash === request.textHash && state.voiceId === request.voiceId && state.speed === request.speed, '配音缓存与冻结稿件不一致，请核对记录；不会重新提交。', 409);
  state ||= { version: VERSION, accountHash: job.keyHash || '', requestHash: request.requestHash, textHash: request.textHash, voiceId: request.voiceId, speed: request.speed, idempotencyKey: randomUUID(), state: 'pending', created: new Date().toISOString() };
  const update = async fields => {
    state = { ...state, ...fields, updated: new Date().toISOString(), sourceFile: `${relative}/original.wav`, file: `${relative}/audio.wav`, targetDuration: request.targetDuration };
    await atomicJSON(stateFile, state);
    if (folder !== localFolder) await atomicJSON(path.join(localFolder, 'state.json'), state);
    const { accountHash, ...publicState } = state;
    await onUpdate(publicState);
  };
  const unknown = () => new AppError('上次配音结果未知或提交记录已存在，请核对平台记录；软件不会自动重复配音，也尚未提交视频生成。', 409, 'narration_unknown');
  if (!await available(raw)) {
    if (await available(marker) || ['submitting', 'unknown', 'saved', 'ready', 'too_long', 'invalid_audio'].includes(state.state)) throw unknown();
    const voices = await provider.listVoices();
    invariant(voices.some(voice => voice.id === request.voiceId && voice.status === 'ready'), '所选音色不属于当前账户或尚未就绪，请刷新音色列表；尚未提交配音或视频生成。', 422);
    // Stop/key changes during the read-only voice query are known local
    // cancellations. Check before a marker could turn them into unknown POSTs.
    await options.beforeSubmit?.();
    // The exclusive marker survives process crashes and protects a shared cache
    // even when more than one process reaches this request at the same time.
    try { await writeFile(marker, JSON.stringify({ requestHash: request.requestHash, textHash: request.textHash, idempotencyKey: state.idempotencyKey, created: new Date().toISOString() }), { flag: 'wx' }); }
    catch (error) { if (error.code === 'EEXIST') throw unknown(); throw error; }
    await atomicJSON(path.join(folder, 'request.json'), { model: 'openai-tts', voice: request.voiceId, input: request.input, speed: request.speed, response_format: 'wav', idempotencyKey: state.idempotencyKey });
    await writeFile(path.join(folder, 'script.txt'), request.input, 'utf8');
    await update({ state: 'submitting', error: null });
    try {
      const result = await provider.synthesizeSpeech({ voiceId: request.voiceId, input: request.input, speed: request.speed, idempotencyKey: state.idempotencyKey, signal:options.signal }, raw);
      await update({ state: 'saved', bytes: result.bytes, contentType: result.contentType, error: null });
    } catch (error) {
      await update({ state: 'unknown', error: safeError(error) });
      throw error;
    }
  }
  const tools = { ...defaultTools, ...options.mediaTools };
  let info;
  try {
    info = await tools.inspect(raw);
    invariant(Number.isFinite(info.duration) && info.duration > 0, '已保存的完整配音时长无效。', 422);
    if (folder !== localFolder) await copyFile(raw, localRaw);
    await update({ state: 'saved', duration: info.duration, error: null });
  } catch (error) { await update({ state: 'invalid_audio', error: safeError(error) }); throw error; }
  const tooLong = async duration => {
    const error = new AppError(`完整配音 ${duration.toFixed(2)} 秒，超过成片 ${request.targetDuration.toFixed(2)} 秒。完整录音已保存，可延长视频后免费重新配合；或调整稿件 / 所选语速后创建新版本。不会截断台词或提交视频生成。`, 422, 'narration_too_long');
    error.details = { duration, targetDuration: request.targetDuration, sourceFile: `${relative}/original.wav`, textHash: request.textHash, requestHash: request.requestHash };
    await update({ state: 'too_long', duration, error: error.message }); throw error;
  };
  if (info.duration > request.targetDuration + 1 / SAMPLE_RATE) await tooLong(info.duration);
  await tools.normalize(localRaw, normalized);
  const decoded = await tools.inspect(normalized);
  if (decoded.duration > request.targetDuration + 1 / SAMPLE_RATE) await tooLong(decoded.duration);
  invariant(Math.abs(decoded.duration - info.duration) <= 0.03, '配音规范化前后时长不一致，已保留完整录音，请核对。', 422);
  await tools.pad(normalized, timeline, request.targetSamples);
  const padded = await tools.inspect(timeline);
  invariant(Math.abs(padded.duration - request.targetDuration) <= 1 / SAMPLE_RATE + 1e-6, '配音补齐后的时长异常，已保留完整录音，请核对。', 422);
  await update({ state: 'ready', duration: decoded.duration, audioDuration: padded.duration, sampleRate: SAMPLE_RATE, error: null });
  return { file: `${relative}/audio.wav`, sourceFile: `${relative}/original.wav`, duration: decoded.duration, targetDuration: request.targetDuration,
    textHash: request.textHash, requestHash: request.requestHash, voiceId: request.voiceId, speed: request.speed };
}
