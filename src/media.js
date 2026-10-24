import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError, invariant } from './errors.js';
import { FPS } from './plan.js';
import { captionEvents, captionASS } from './captions.js';
import { isProductProp } from './product-scope.js';
import { fileSHA256 } from './file-hash.js';
export { fileSHA256 };

const root = path.resolve(import.meta.dirname, '..');
function binary(name) {
  const bundled = path.join(root, 'runtime', name + (process.platform === 'win32' ? '.exe' : ''));
  return existsSync(bundled) ? bundled : process.env[name.toUpperCase() + '_PATH'] || name;
}

export async function runTool(command, args, timeout = 1800000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    const timer = setTimeout(() => { child.kill(); reject(new AppError('媒体处理超时，任务已保留，可恢复。', 500)); }, timeout);
    child.stdout.on('data', data => { output = (output + data).slice(-200000); });
    child.stderr.on('data', data => { errors = (errors + data).slice(-8000); });
    child.on('error', () => { clearTimeout(timer); reject(new AppError('找不到 FFmpeg / FFprobe，请使用一键启动器检查运行环境。', 503)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new AppError('媒体读取或编码失败，请检查文件是否完整、磁盘空间是否足够。' + (errors.includes('No space left') ? ' 磁盘空间不足。' : ''), 422, 'media_error'));
    });
  });
}

export function ffmpeg(args, timeout) {
  return runTool(binary('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], timeout);
}

export async function probe(file) {
  let data;
  try {
    data = JSON.parse(await runTool(binary('ffprobe'), ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_format', '-show_streams', '-of', 'json', file], 60000));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('无法读取媒体信息，请重新选择文件。');
  }
  const video = data.streams?.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  invariant(video && video.width > 0 && video.height > 0, '文件中没有可读取的画面。');
  const rotation = Number(video.side_data_list?.find(d => d.rotation !== undefined)?.rotation || video.tags?.rotate || 0);
  const rotated = Math.abs(rotation) % 180 === 90;
  const streamDuration = Number(video.duration);
  const audio = data.streams.find(s => s.codec_type === 'audio');
  const videoStart = Number(video.start_time) || 0;
  const audioStart = Number(audio?.start_time) || 0;
  return {
    width: rotated ? video.height : video.width, height: rotated ? video.width : video.height,
    duration: Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : Number(data.format?.duration),
    frames: Number(video.nb_frames) || null, codec: video.codec_name,
    hasAudio: !!audio, videoStart, audioStart, audioOffset: audioStart - videoStart,
    format: data.format?.format_name || '',
  };
}

export async function checkTools() {
  try {
    await Promise.all([runTool(binary('ffmpeg'), ['-version'], 10000), runTool(binary('ffprobe'), ['-version'], 10000)]);
    return { ffmpeg: true, ffprobe: true };
  } catch { return { ffmpeg: false, ffprobe: false }; }
}

export async function prepareVoice(source, output, shortOutput) {
  const data = JSON.parse(await runTool(binary('ffprobe'), ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_format', '-show_streams', '-of', 'json', source], 60000));
  const audio = data.streams?.find(s => s.codec_type === 'audio');
  const duration = Number(audio?.duration || data.format?.duration);
  invariant(audio && Number.isFinite(duration) && duration >= 2.95 && duration <= 5.05, '人物参考音频需要 3–5 秒，请裁好后重新导入。');
  const length = Math.max(3, Math.min(5, duration));
  await ffmpeg(['-xerror', '-protocol_whitelist', 'file,pipe', '-i', source, '-map', '0:a:0', '-vn', '-af', 'asetpts=PTS-STARTPTS,apad', '-t', length.toFixed(6), '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', output]);
  await ffmpeg(['-i', output, '-t', '3', '-c:a', 'pcm_s16le', shortOutput]);
  return { duration: length };
}

export async function prepareViews(files, output) {
  invariant(files.length === 1 || files.length === 3, '三视图请上传一张合图，或按正面、侧面、背面顺序上传三张图。');
  if (files.length === 1) return prepareImage(files[0], output);
  const normalized = [];
  for (let i = 0; i < files.length; i++) {
    const file = output + `.view-${i}.png`; await prepareImage(files[i], file); normalized.push(file);
  }
  const inputs = normalized.flatMap(file => ['-i', file]);
  const filters = normalized.map((_, i) => `[${i}:v]scale=600:900:force_original_aspect_ratio=decrease,pad=600:900:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1[v${i}]`).join(';');
  await ffmpeg([...inputs, '-filter_complex', filters + ';[v0][v1][v2]hstack=inputs=3[out]', '-map', '[out]', '-frames:v', '1', '-update', '1', output]);
  return { width: 1800, height: 900 };
}

export async function prepareAnalysisVideo(directory, project, window) {
  const folder = path.join(directory, 'analysis'); await mkdir(folder, { recursive: true });
  const output = path.join(folder, `input-${window.index}.mp4`);
  if (existsSync(output)) return output;
  const temp = output + '.partial.mp4';
  const ratio = Math.min(1, 960 / Math.max(project.source.width, project.source.height));
  const width = Math.max(2, Math.round(project.source.width * ratio / 2) * 2), height = Math.max(2, Math.round(project.source.height * ratio / 2) * 2);
  await ffmpeg(['-ss', String(window.start), '-protocol_whitelist', 'file,pipe', '-i', path.join(directory, project.sourceFile), '-t', String(window.duration), '-map', '0:v:0', '-map', '0:a:0?', '-vf', `fps=15,scale=${width}:${height},setsar=1`, '-c:v', 'libx264', '-preset', 'fast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', temp]);
  await probe(temp); await rename(temp, output); return output;
}

export async function detectSourceCuts(source) {
  return (await detectSourceMotion(source)).cuts;
}
export async function detectSourceMotion(source) {
  const output = await ffmpeg(['-protocol_whitelist', 'file,pipe', '-i', source, '-an', '-vf', "setpts=PTS-STARTPTS,fps=30,scale=160:-2,select='gt(scene,0.32)+lt(scene,0.002)*(isnan(prev_selected_t)+gte(t-prev_selected_t,1))',metadata=mode=print:file=-", '-f', 'null', '-']);
  const samples = [...output.matchAll(/pts_time:([\d.]+)[^\n]*\r?\n(?:[^\n]*\r?\n)*?lavfi\.scene_score=([\d.]+)/g)].map(m => ({ time: Number(m[1]), score: Number(m[2]) })).filter(s => s.time > 0);
  return { cuts: samples.filter(s => s.score > 0.32).map(s => s.time), quietPoints: samples.filter(s => s.score < 0.002).map(s => s.time) };
}

const comparisonTasks = new Map();
export async function prepareComparisonVideo(directory, job, window) {
  const key = path.join(directory, 'quality', `compare-v3-${window.index}.mp4`);
  if (!comparisonTasks.has(key)) comparisonTasks.set(key, writeComparisonVideo(directory, job, window).finally(() => comparisonTasks.delete(key)));
  return comparisonTasks.get(key);
}
async function writeComparisonVideo(directory, job, window) {
  const folder = path.join(directory, 'quality'); await mkdir(folder, { recursive: true });
  const output = path.join(folder, `compare-v3-${window.index}.mp4`);
  if (existsSync(output)) return output;
  const temp = output + '.partial.mp4';
  const scale = 'setpts=PTS-STARTPTS,fps=15,scale=360:640:force_original_aspect_ratio=decrease,pad=360:640:(ow-iw)/2:(oh-ih)/2,setsar=1';
  const refs = (job.recipe?.story?.assets || []).filter(a => isProductProp(a, job.recipe.edits?.assets?.[a.id]) && job.recipe.edits?.assets?.[a.id]?.main?.file);
  const referenceSheet = path.join(folder, 'targets-v3.png');
  if (refs.length && !existsSync(referenceSheet)) {
    const columns = Math.min(3, refs.length), tileWidth = 720 / columns;
    const inputs = refs.flatMap(a => ['-i', path.join(directory, job.recipe.edits.assets[a.id].main.file)]);
    const cells = refs.map((a,index) => `[${index}:v]scale=${tileWidth}:240:force_original_aspect_ratio=decrease,pad=${tileWidth}:270:(ow-iw)/2:30:white,drawtext=fontfile='${filterFile(path.join(process.env.WINDIR || 'C:/Windows', 'Fonts/arial.ttf'))}':text='${a.id.replace(/[^A-Za-z0-9_-]/g,'')}':x=10:y=7:fontsize=20:fontcolor=black[r${index}]`).join(';');
    const layout = refs.map((_,index) => `${(index%columns)*tileWidth}_${Math.floor(index/columns)*270}`).join('|');
    const grid = refs.length === 1 ? '[r0]null[refs]' : `${refs.map((_,index)=>`[r${index}]`).join('')}xstack=inputs=${refs.length}:layout=${layout}:fill=white[refs]`;
    await ffmpeg([...inputs, '-filter_complex', cells+';'+grid, '-map','[refs]','-frames:v','1','-update','1',referenceSheet]);
  }
  const args = ['-ss', window.start.toFixed(6), '-protocol_whitelist', 'file,pipe', '-i', path.join(directory, job.sourceFile), '-ss', window.start.toFixed(6), '-i', path.join(directory, 'result.mp4')];
  if (refs.length) args.push('-loop','1','-i',referenceSheet);
  const compare = `[0:v:0]${scale}[original];[1:v:0]${scale}[edited];[original][edited]hstack=inputs=2:shortest=1[compare];${refs.length ? '[compare][2:v:0]vstack=inputs=2:shortest=1[out]' : '[compare]null[out]'}`;
  // The reviewer must hear the final edited track, never both tracks at once.
  args.push('-filter_complex',compare,'-map','[out]','-map','1:a:0?','-t',window.duration.toFixed(6),'-c:v','libx264','-preset','fast','-crf','23','-pix_fmt','yuv420p','-c:a','aac','-ar','48000','-b:a','128k','-movflags','+faststart',temp);
  await ffmpeg(args);
  await probe(temp); await rename(temp, output); return output;
}
function filterFile(file) { return path.resolve(file).replace(/\\/g,'/').replace(/:/g,'\\:').replace(/'/g,"\\'"); }

export async function previewFrame(source, time, output) {
  if (existsSync(output)) return output;
  const temp = output + '.partial' + path.extname(output);
  await ffmpeg(['-ss', String(time), '-protocol_whitelist', 'file,pipe', '-i', source, '-frames:v', '1', '-vf', 'scale=480:480:force_original_aspect_ratio=decrease', '-q:v', '3', '-update', '1', temp]);
  await rename(temp, output); return output;
}

function alignAudio(offset = 0) {
  return `aresample=48000,asetpts=PTS-STARTPTS${offset > 0 ? `,adelay=${Math.round(offset * 48000)}S:all=1` : offset < 0 ? `,atrim=start=${(-offset).toFixed(9)},asetpts=PTS-STARTPTS` : ''},apad`;
}

export function outputDimensions(info, model) {
  const longest = model.endsWith('720p') ? 1280 : 854;
  const ratio = longest / Math.max(info.width, info.height);
  return { width: Math.max(2, Math.round(info.width * ratio / 2) * 2), height: Math.max(2, Math.round(info.height * ratio / 2) * 2) };
}

export async function prepareImage(source, target) {
  const info = await probe(source);
  invariant(['png', 'mjpeg', 'webp', 'bmp'].includes(info.codec), '替换图请使用 PNG、JPG、WebP 或 BMP 图片。');
  invariant(Math.max(info.width / info.height, info.height / info.width) <= 8 && info.width <= 16000 && info.height <= 16000, '图片宽高比须在 1:8 到 8:1 之间，单边不超过 16000 像素。');
  const scale = Math.max(240 / Math.min(info.width, info.height), Math.min(1, 2048 / Math.max(info.width, info.height)));
  const width = Math.round(info.width * scale), height = Math.round(info.height * scale);
  await ffmpeg(['-protocol_whitelist', 'file,pipe', '-i', source, '-vf', `scale=${width}:${height}`, '-frames:v', '1', '-update', '1', target]);
  return { width, height };
}

export async function prepareSegments(directory, job, onPart, shouldStop = () => false) {
  if (job.recipe?.actionRebuild) {
    await mkdir(path.join(directory, 'segments'), { recursive: true });
    for (const segment of job.segments) {
      if (shouldStop()) return;
      if (segment.generationMode === 'base_copy') await prepareBaseCopy(directory, job, segment);
      await onPart(segment.index);
    }
    return;
  }
  const source = path.join(directory, job.sourceFile);
  const canonical = path.join(directory, 'canonical.mp4');
  const { width, height } = job.output;
  const totalFrames = job.segments.reduce((n, s) => n + s.frames, 0);
  const originalAudio = path.join(directory, 'original-audio.wav');
  if (job.workflow === 'studio' && job.source.hasAudio && !existsSync(originalAudio)) {
    const tempAudio = originalAudio + '.partial.wav';
    await ffmpeg(['-protocol_whitelist', 'file,pipe', '-i', source, '-map', '0:a:0', '-vn', '-af', alignAudio(job.source.audioOffset), '-t', (totalFrames / FPS).toFixed(6), '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', tempAudio]);
    await rename(tempAudio, originalAudio);
  }
  if (!existsSync(canonical)) {
    const temp = path.join(directory, 'canonical.partial.mp4');
    await ffmpeg(['-xerror', '-protocol_whitelist', 'file,pipe', '-i', source, '-map', '0:v:0', '-an', '-vf', `setpts=PTS-STARTPTS,fps=${FPS},scale=${width}:${height},setsar=1,tpad=stop_mode=clone:stop_duration=0.1`, '-frames:v', String(totalFrames), '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', temp]);
    const info = await probe(temp);
    invariant(info.frames === totalFrames, '原视频解码帧数与时间轴不一致，已停止提交，请检查素材。');
    await rename(temp, canonical);
  }
  await mkdir(path.join(directory, 'segments'), { recursive: true });
  for (const part of job.segments) {
    if (shouldStop()) return;
    const file = path.join(directory, 'segments', `input-${part.index}.mp4`);
    if (!existsSync(file)) {
      const temp = file + '.partial.mp4';
      // Re-encode frame-accurate boundaries; stream-copy cuts may spill past 15 seconds.
      const seekSecond = Math.floor(part.startFrame / FPS);
      const localStart = part.startFrame - seekSecond * FPS;
      const args = ['-ss', String(seekSecond), '-i', canonical];
      const withSound = job.workflow === 'studio' && job.source.hasAudio && !job.recipe?.edits?.fullDialogue?.enabled;
      if (withSound) args.push('-ss', part.start.toFixed(9), '-i', originalAudio);
      args.push('-map', '0:v:0', '-vf', `trim=start_frame=${localStart}:end_frame=${localStart + part.frames},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=2`, '-frames:v', String(part.requestDuration * FPS));
      if (withSound) args.push('-map', '1:a:0', '-af', `atrim=duration=${part.duration.toFixed(9)},asetpts=PTS-STARTPTS,apad`, '-c:a', 'aac', '-b:a', '128k', '-t', String(part.requestDuration));
      else args.push('-an');
      args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', temp);
      await ffmpeg(args);
      const info = await probe(temp);
      invariant(info.frames === part.requestDuration * FPS && info.duration <= 15.001, '分段校验失败，未提交平台。');
      await rename(temp, file);
    }
    await onPart(part.index);
  }
}

// Lossless intermediates keep every decoded pixel outside the authorised range.
export async function prepareBaseCopy(directory, job, segment) {
  invariant(segment.generationMode === 'base_copy' && segment.frames > 0, '本地复用片段无效。');
  await mkdir(path.join(directory, 'segments'), { recursive: true });
  const output = path.join(directory, 'segments', `output-${segment.index}.mp4`);
  if (existsSync(output)) {
    invariant((await probe(output)).frames === segment.frames, '本地复用片段帧数不正确。', 422);
    return output;
  }
  const temp = output + '.partial.mp4';
  await ffmpeg(['-xerror', '-protocol_whitelist', 'file,pipe', '-i', path.join(directory, job.sourceFile), '-map', '0:v:0', '-an',
    '-vf', `trim=start_frame=${segment.startFrame}:end_frame=${segment.startFrame + segment.frames},setpts=N/(${FPS}*TB),setsar=1`,
    '-frames:v', String(segment.frames), '-c:v', 'libx264', '-preset', 'fast', '-crf', '0', '-pix_fmt', 'yuv420p', '-video_track_timescale', '15360', temp]);
  invariant((await probe(temp)).frames === segment.frames, '本地复用片段缺少帧，未提交生成任务。', 422);
  await rename(temp, output); return output;
}

/** The next phase starts from the previous returned image, not a wished-for pose. */
export async function prepareReconstructionBridge(directory, job, segment) {
  const previous = job.segments[segment.bridgeFromIndex];
  invariant(Number.isInteger(segment.bridgeFromIndex) && segment.bridgeFromIndex < segment.index && previous?.state === 'completed'
    && previous.generationMode === 'keyframe_rebuild', '前一涂抹阶段尚未完成，不能提交下一阶段。', 409);
  const sourceFile = `segments/output-${previous.index}.mp4`, source = path.join(directory, sourceFile);
  const info = await probe(source), sourceOutputSHA256 = await fileSHA256(source);
  invariant(info.frames === previous.frames && (!previous.outputSHA256 || previous.outputSHA256 === sourceOutputSHA256), '前一阶段的实际生成文件已改变或缺少帧，不能续接。', 409);
  const file = `bridges/first-stage-${segment.reconstructionStageIndex}.png`;
  if (segment.bridge) {
    invariant(segment.bridge.file === file && segment.bridge.sourceOutputSHA256 === sourceOutputSHA256
      && await fileSHA256(path.join(directory, file)) === segment.bridge.sha256, '已冻结的阶段衔接帧不一致，不能重新提交。', 409);
    return segment.bridge;
  }
  await mkdir(path.join(directory, 'bridges'), { recursive: true });
  const output = path.join(directory, file), temp = output + '.partial.png';
  await ffmpeg(['-xerror', '-protocol_whitelist', 'file,pipe', '-i', source, '-map', '0:v:0', '-an',
    '-vf', `select=eq(n\\,${previous.frames - 1})`, '-frames:v', '1', '-pix_fmt', 'rgb24', '-update', '1', temp]);
  invariant((await probe(temp)).codec === 'png', '阶段衔接帧提取失败，尚未提交下一阶段。', 422);
  await rename(temp, output);
  return { file, sha256: await fileSHA256(output), fromSegmentIndex: previous.index, fromTaskId: previous.taskId,
    sourceFile, sourceOutputSHA256, sourceFrameIndex: previous.frames - 1, created: new Date().toISOString(), policy: 'actual_previous_final_frame' };
}

export async function normalizeResult(directory, job, segment) {
  const source = path.join(directory, 'segments', `generated-${segment.index}.mp4`);
  const info = await probe(source);
  invariant(Math.abs(info.duration - segment.requestDuration) <= 0.25, `第 ${segment.index + 1} 段返回 ${info.duration.toFixed(3)} 秒，预期 ${segment.requestDuration} 秒；请核对平台结果后恢复。`, 422);
  const { width, height } = job.output;
  const output = path.join(directory, 'segments', `output-${segment.index}.mp4`);
  const temp = output + '.partial.mp4';
  if (segment.generationMode === 'keyframe_rebuild') {
    let frames = info.frames;
    if (!Number.isInteger(frames) || frames < 2) {
      const counted = JSON.parse(await runTool(binary('ffprobe'), ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'json', source], 60000));
      frames = Number(counted.streams?.[0]?.nb_read_frames);
    }
    invariant(Number.isInteger(frames) && frames >= 2 && segment.frames >= 2, '动作重建返回画面不足，不能用补帧代替真实动作。', 422);
    // Use every returned frame, including the hard end-state, rather than
    // trimming the leading target-duration seconds from an integer request.
    await ffmpeg(['-xerror', '-protocol_whitelist', 'file,pipe', '-i', source, '-map', '0:v:0', '-an',
      '-vf', `settb=AVTB,setpts=N*${segment.frames - 1}/(${FPS}*${frames - 1}*TB),fps=${FPS}:start_time=0:round=near,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,tpad=stop_mode=clone:stop_duration=0.034`,
      '-frames:v', String(segment.frames), '-c:v', 'libx264', '-preset', 'fast', '-crf', '0', '-pix_fmt', 'yuv420p', '-video_track_timescale', '15360', temp]);
    invariant((await probe(temp)).frames === segment.frames, '动作重建完整时间映射帧数不正确。', 422);
    await rename(temp, output);
    return { timeMapping: { policy: 'whole-return-endpoints-v1', generatedFrames: frames, targetFrames: segment.frames } };
  }
  const silentFullScriptGap = job.audioMode === 'mixed' && job.recipe?.edits?.fullDialogue?.enabled && segment.audioChanged && !segment.dialogueIds?.length && !info.hasAudio;
  const args = ['-xerror', '-protocol_whitelist', 'file,pipe', '-i', source];
  if (job.audioMode === 'mixed' && (!segment.audioChanged || silentFullScriptGap)) {
    if (job.source.hasAudio && !silentFullScriptGap) args.push('-ss', segment.start.toFixed(9), '-i', path.join(directory, 'original-audio.wav'));
    else args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
  }
  args.push('-map', '0:v:0');
  if (job.audioMode === 'mixed') {
    invariant(!segment.audioChanged || info.hasAudio || silentFullScriptGap, `第 ${segment.index + 1} 段没有返回声音，不能交付台词或音色修改结果。`, 422);
    args.push('-map', segment.audioChanged && !silentFullScriptGap ? '0:a:0' : '1:a:0', '-af', alignAudio(segment.audioChanged && !silentFullScriptGap ? info.audioOffset : 0), '-ar', '48000', '-ac', '2', '-c:a', 'aac', '-b:a', '192k', '-t', (segment.frames / FPS).toFixed(9));
  } else args.push('-an');
  args.push('-vf', `setpts=PTS-STARTPTS,fps=${FPS},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,tpad=stop_mode=clone:stop_duration=0.25`, '-frames:v', String(segment.frames), '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-video_track_timescale', '15360', temp);
  await ffmpeg(args);
  const normalized = await probe(temp);
  invariant(normalized.frames === segment.frames, '返回视频不足所需帧数，未跳过或掩盖缺失片段。', 422);
  await rename(temp, output);
  return { silentFullScriptGap };
}

export async function assemble(directory, job) {
  invariant(job.segments.every(s => s.state === 'completed'), '所有片段完成后才能拼接。', 409);
  const manifest = path.join(directory, 'concat.txt');
  await writeFile(manifest, job.segments.map(s => `file 'segments/output-${s.index}.mp4'${job.audioMode === 'mixed' ? `\nduration ${(s.frames / FPS).toFixed(9)}` : ''}`).join('\n') + '\n', 'utf8');
  const duration = job.segments.reduce((n, s) => n + s.frames, 0) / FPS;
  const temp = path.join(directory, 'result.partial.mp4');
  const args = ['-f', 'concat', '-safe', '1', '-i', manifest];
  if (job.audioMode === 'narration') {
    invariant(job.narration?.file && job.narration.duration <= duration + 0.001, '精确配音尚未就绪或超过视频长度，不能裁断后交付。', 422);
    args.push('-i', path.join(directory, job.narration.file));
  } else if (job.source.hasAudio && job.audioMode !== 'mixed') args.push('-protocol_whitelist', 'file,pipe', '-i', path.join(directory, job.sourceFile));
  args.push('-map', '0:v:0', '-c:v', 'copy');
  if (job.audioMode === 'mixed') {
    args.push('-map', '0:a:0', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k', '-af', 'aresample=async=1:first_pts=0,apad');
  } else if (job.audioMode === 'narration') {
    args.push('-map','1:a:0','-c:a','aac','-ar','48000','-ac','2','-b:a','192k','-af','asetpts=PTS-STARTPTS,apad');
  } else if (job.source.hasAudio) {
    if (job.recipe?.actionRebuild) {
      // This source is an already accepted edited movie, including any exact
      // narration. Copy its audio packets instead of charging or re-encoding.
      args.push('-map', '1:a:0', '-c:a', 'copy');
    } else {
    const offset = job.source.audioOffset || 0;
    const align = offset > 0 ? `,adelay=${Math.round(offset * 48000)}S:all=1` : offset < 0 ? `,atrim=start=${(-offset).toFixed(9)},asetpts=PTS-STARTPTS` : '';
    args.push('-map', '1:a:0', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-af', `aresample=48000,asetpts=PTS-STARTPTS${align},apad`);
    }
  }
  args.push('-t', duration.toFixed(6), '-movflags', '+faststart', temp);
  await ffmpeg(args);
  // The edited base already contains its accepted captions and audio. Do not
  // burn the full script into it for a second time during a local reconstruction.
  const events = job.recipe?.actionRebuild ? [] : captionEvents(job);
  if (events.length) {
    const ass = path.join(directory, 'captions.ass'), captioned = path.join(directory,'captioned.partial.mp4');
    await writeFile(ass, captionASS(events,job.output.width,job.output.height),'utf8');
    await ffmpeg(['-xerror','-i',temp,'-vf',`ass=filename='${filterFile(ass)}'`,'-map','0:v:0','-map','0:a:0?','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-c:a','copy','-movflags','+faststart',captioned]);
    await rename(captioned,temp);
  }
  const info = await probe(temp);
  invariant(info.frames === job.segments.reduce((n, s) => n + s.frames, 0) && Math.abs(info.duration - duration) < 0.06, '成片时间轴校验未通过。', 422);
  invariant(info.hasAudio === (['mixed','narration'].includes(job.audioMode) || job.source.hasAudio), '成片音轨校验未通过。', 422);
  await ffmpeg(['-xerror', '-i', temp, '-f', 'null', '-']);
  await rename(temp, path.join(directory, 'result.mp4'));
  return info;
}
