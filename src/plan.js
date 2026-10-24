import { randomUUID } from 'node:crypto';
import { invariant } from './errors.js';

export const FPS = 30;
export const MAX_SECONDS = 600;
export const MAX_SEGMENT_FRAMES = 15 * FPS;

export function planSegments(duration) {
  invariant(Number.isFinite(duration) && duration > 0 && duration <= MAX_SECONDS, '视频时长须大于 0 且不超过 10 分钟。');
  const total = Math.max(1, Math.round(duration * FPS));
  const lengths = [];
  let left = total;
  for (let i = 0; i < Math.ceil(duration / 15); i++) {
    const frames = Math.min(left, MAX_SEGMENT_FRAMES);
    lengths.push(frames); left -= frames;
  }
  // A short tail borrows frames from its neighbour so WAN always sees at least 2 seconds.
  if (lengths.length > 1 && lengths.at(-1) < 2 * FPS) {
    const borrow = 2 * FPS - lengths.at(-1);
    lengths[lengths.length - 2] -= borrow;
    lengths[lengths.length - 1] += borrow;
  }
  let startFrame = 0;
  return lengths.map((frames, index) => {
    const part = {
      index, startFrame, frames, start: startFrame / FPS, duration: frames / FPS,
      requestDuration: Math.max(2, Math.ceil(frames / FPS)), state: 'pending', taskId: null,
      idempotencyKey: 'wan-editor-' + randomUUID(), affinity: randomUUID(), attempts: 0, error: null,
    };
    startFrame += frames;
    return part;
  });
}

export function editPrompt(mode, target, segment) {
  const scope = target.trim();
  const main = mode === 'face'
    ? `编辑视频1。将${scope || '视频中主要人物'}的人脸替换为图片1中的人脸身份。仅改变面部身份特征；保持原人物身体、服装、发型、头部朝向、视线、表情变化、嘴型、动作与原视频逐时刻对应。不要改变其他人的脸。`
    : `编辑视频1。将${scope || '视频中主要展示的产品'}替换为图片1中的产品。准确保持图片1产品的外形、颜色、材质、包装、品牌标识和可见文字；让替换产品跟随原产品的位置、大小、透视、运动、受光、阴影、反射与遮挡。保留人物的手部动作和接触关系。`;
  const padding = segment.requestDuration - segment.duration;
  return `【总体描述】\n${main}\n【全局锁定】\n图片1是全片同一个对象的替换参考，不提供背景。场景、光照、镜头顺序、构图、运镜和动作时间线与视频1保持一致；各段保持同一人物身份和造型、同一空间轴线与道具持有关系。\n【固定台词】\n完整保留视频1原对白、说话人、发声时机和音色；不添加台词，背景音乐及环境音保持原样。提示词扩写不改动对白或剧情。\n【分镜】\n沿用视频1的全部原镜头与切换时机，人物动作、表情、视线和遮挡按原片连续变化，不新增机位。输出与视频1相同的画幅、相同的播放速度和${segment.requestDuration}秒时长。${padding > 0.001 ? `输入末尾的${padding.toFixed(3)}秒是为时长对齐补入的静帧，输出末尾也保持同样静帧，不延长动作。` : ''}\n【禁止项】\n没有目标的画面保持原样，不添加人物、产品或场景，禁止角色分身、左右翻转、背景重置、道具瞬移、新增字幕、转场、黑屏或无关剧情。`;
}

export function requestBody(job, segment, media) {
  const keyframes = segment.generationMode === 'keyframe_rebuild';
  if (keyframes) {
    invariant(Array.isArray(media) && media.length === 2 && media[0].type === 'first_frame' && media[1].type === 'last_frame', '动作重建只能提交首帧和尾帧，不能混入视频、图片或声音参考。');
    invariant(Number.isInteger(segment.requestDuration) && segment.requestDuration >= 2 && segment.requestDuration <= 15, '动作重建请求时长须为 2–15 秒整数。');
  }
  return {
    model: job.model,
    prompt: job.workflow === 'studio' ? segment.prompt : editPrompt(job.mode, job.target, segment),
    duration: segment.requestDuration,
    prompt_extend: !keyframes,
    size: job.model.endsWith('720p') ? '720P' : '480P',
    metadata: { input: { media }, parameters: { ratio: 'adaptive' } },
  };
}
