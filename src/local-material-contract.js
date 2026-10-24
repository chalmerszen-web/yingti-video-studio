import { invariant } from './errors.js';

export const LOCAL_MATERIAL_VERSION = 1;
export const LOCAL_MATERIAL_POLICY = 'source-material-local-v1';
export const LOCAL_FPS = 30;
export const LOCAL_OCCLUSION_METHOD = 'two-sided-observed-residual-and-bounded-spatial-v1';
export const LOCAL_APPEARANCE_METHOD = 'bounded-material-appearance-v1';
export const localUUID = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export function localObject(value, keys, label) {
  invariant(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key)), `${label}格式不正确或含未知字段。`);
  return value;
}
function integer(value, min, max, label) { invariant(Number.isInteger(value) && value >= min && value <= max, `${label}超出有效帧范围。`); return value; }
export function normalizeLocalOcclusionReconstruction(raw = { enabled: false }) {
  localObject(raw, ['enabled'], '局部遮挡材料重建');
  invariant(typeof raw.enabled === 'boolean', '局部遮挡重建须明确开启或关闭。');
  return { enabled: raw.enabled, method: LOCAL_OCCLUSION_METHOD, isGroundTruth: false };
}
export function normalizeLocalAppearanceReconstruction(raw = { enabled: false }) {
  localObject(raw, ['enabled'], '局部材质艺术重建');
  invariant(typeof raw.enabled === 'boolean', '局部材质艺术重建须明确开启或关闭。');
  return { enabled: raw.enabled, method: LOCAL_APPEARANCE_METHOD, isGroundTruth: false };
}
function points(raw, label, max = 256) {
  invariant(Array.isArray(raw) && raw.length <= max, `${label}数量无效。`);
  return raw.map(point => {
    localObject(point, ['x', 'y'], label);
    invariant(Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1, `${label}必须使用 0–1 的归一化坐标。`);
    return { x: point.x, y: point.y };
  });
}
export function normalizeLocalRanges(raw, source, base) {
  const fallback = { source: { startFrame: 0, frames: Math.min(150, source.frames, base.frames) }, target: { startFrame: 0, frames: Math.min(150, source.frames, base.frames) } };
  raw ??= fallback; localObject(raw, ['source', 'target'], '原片和目标范围');
  const range = (value, total, label) => {
    localObject(value, ['startFrame', 'frames'], label);
    const startFrame = integer(value.startFrame, 0, total - 1, label), frames = integer(value.frames, 1, Math.min(450, total - startFrame), label);
    return { startFrame, frames };
  };
  return { source: range(raw.source, source.frames, '原片范围'), target: range(raw.target, base.frames, '目标范围') };
}

/** Expand reviewed temporal anchors to real frame indices; never synthesize pixels. */
export function expandLocalFramePairAnchors(anchors, shots) {
  if (!anchors.length || !shots.length) return [];
  for (const anchor of anchors) invariant(shots.some(shot => anchor.targetFrame >= shot.targetStartFrame
    && anchor.targetFrame < shot.targetStartFrame + shot.targetFrames && anchor.sourceFrame >= shot.sourceStartFrame
    && anchor.sourceFrame < shot.sourceStartFrame + shot.sourceFrames), '画面对应锚点须位于同一组已标注镜头，不能跨镜头配对。');
  return shots.flatMap(shot => {
    const first = { targetFrame: shot.targetStartFrame, sourceFrame: shot.sourceStartFrame };
    const last = { targetFrame: shot.targetStartFrame + shot.targetFrames - 1,
      sourceFrame: shot.targetFrames === 1 ? shot.sourceStartFrame : shot.sourceStartFrame + shot.sourceFrames - 1 };
    const selected = anchors.filter(anchor => anchor.targetFrame >= first.targetFrame && anchor.targetFrame <= last.targetFrame);
    for (const anchor of selected) invariant((anchor.targetFrame !== first.targetFrame || anchor.sourceFrame === first.sourceFrame)
      && (anchor.targetFrame !== last.targetFrame || anchor.sourceFrame === last.sourceFrame), '镜头首尾对应帧须保留实际镜头端点，请在镜头内部添加配对或先修正镜头边界。');
    const byTarget = new Map([first, last, ...selected].map(pair => [pair.targetFrame, pair]));
    const knots = [...byTarget.values()].sort((a, b) => a.targetFrame - b.targetFrame);
    invariant(knots.every((pair, index) => !index || pair.sourceFrame >= knots[index - 1].sourceFrame), '画面对应锚点不能倒放原片动作。');
    let interval = 0;
    return Array.from({ length: shot.targetFrames }, (_, offset) => {
      const targetFrame = shot.targetStartFrame + offset;
      while (interval + 1 < knots.length && knots[interval + 1].targetFrame < targetFrame) interval++;
      const left = knots[interval], right = knots[Math.min(interval + 1, knots.length - 1)];
      const progress = right.targetFrame === left.targetFrame ? 0 : (targetFrame - left.targetFrame) / (right.targetFrame - left.targetFrame);
      return { targetFrame, sourceFrame: Math.round(left.sourceFrame + progress * (right.sourceFrame - left.sourceFrame)) };
    });
  });
}

export function normalizeLocalCalibration(raw = {}, ranges) {
  localObject(raw, ['sourceRegion', 'targetRegion', 'sourceSkinPoints', 'targetSkinPoints', 'anchorPair', 'framePairs', 'framePairAnchors', 'shots', 'handKeyframes', 'targetMaterialKeyframes', 'appearanceKeyframes', 'postCutCleanup', 'reviewed', 'donorReviewed'], '本地校准');
  const result = { sourceRegion: points(raw.sourceRegion || [], '原片材料区域'), targetRegion: points(raw.targetRegion || [], '目标编辑区域'),
    sourceSkinPoints: points(raw.sourceSkinPoints || [], '原片裸肤采样点', 64), targetSkinPoints: points(raw.targetSkinPoints || [], '目标裸肤采样点', 64), reviewed: raw.reviewed ?? false, donorReviewed: raw.donorReviewed ?? false };
  invariant(typeof result.reviewed === 'boolean' && typeof result.donorReviewed === 'boolean', '校准确认选项无效。');
  const inRange = (value, side, label) => integer(value, ranges[side].startFrame, ranges[side].startFrame + ranges[side].frames - 1, label);
  if (raw.anchorPair !== undefined && raw.anchorPair !== null) {
    localObject(raw.anchorPair, ['sourceFrame', 'targetFrame'], '区域绘制对应帧');
    result.anchorPair = { sourceFrame: inRange(raw.anchorPair.sourceFrame, 'source', '原片区域绘制帧'), targetFrame: inRange(raw.anchorPair.targetFrame, 'target', '目标区域绘制帧') };
  }
  const frameCorrespondences = (pairs, label) => {
    invariant(Array.isArray(pairs || []) && (pairs || []).length <= ranges.target.frames, `${label}数量无效。`);
    const normalized = (pairs || []).map(pair => {
      localObject(pair, ['sourceFrame', 'targetFrame'], label);
      return { sourceFrame: inRange(pair.sourceFrame, 'source', '原片对应帧'), targetFrame: inRange(pair.targetFrame, 'target', '目标对应帧') };
    }).sort((a, b) => a.targetFrame - b.targetFrame);
    invariant(normalized.every((pair, index, all) => !index || pair.targetFrame > all[index - 1].targetFrame && pair.sourceFrame >= all[index - 1].sourceFrame), '源/目标对应帧必须单调，不能倒放材料过程或重复目标帧。');
    return normalized;
  };
  result.framePairs = frameCorrespondences(raw.framePairs, '帧对应');
  result.framePairAnchors = frameCorrespondences(raw.framePairAnchors, '画面对应锚点');
  invariant(Array.isArray(raw.shots || []) && (raw.shots || []).length <= 60, '镜头校准数量无效。');
  result.shots = (raw.shots || []).map(shot => {
    localObject(shot, ['sourceStartFrame', 'sourceFrames', 'targetStartFrame', 'targetFrames', 'mode'], '镜头对应');
    const mode = shot.mode ?? 'material';
    invariant(['material', 'preserve'].includes(mode), '镜头处理方式只能是材料转移或保留原画面。');
    const sourceStartFrame = inRange(shot.sourceStartFrame, 'source', '原片镜头起点'), targetStartFrame = inRange(shot.targetStartFrame, 'target', '目标镜头起点');
    return { sourceStartFrame, sourceFrames: integer(shot.sourceFrames, 1, ranges.source.startFrame + ranges.source.frames - sourceStartFrame, '原片镜头长度'),
      targetStartFrame, targetFrames: integer(shot.targetFrames, 1, ranges.target.startFrame + ranges.target.frames - targetStartFrame, '目标镜头长度'), mode };
  }).sort((a, b) => a.targetStartFrame - b.targetStartFrame);
  if (result.shots.length) {
    let target = ranges.target.startFrame, sourceEnd = ranges.source.startFrame;
    for (const shot of result.shots) {
      invariant(shot.targetStartFrame === target && shot.sourceStartFrame >= sourceEnd, '镜头须完整覆盖目标范围，不能跨镜头倒序或重复源区间。');
      target += shot.targetFrames; sourceEnd = shot.sourceStartFrame + shot.sourceFrames;
    }
    invariant(target === ranges.target.startFrame + ranges.target.frames, '镜头校准尚未覆盖完整目标范围。');
  }
  if (result.framePairAnchors.length) result.framePairs = expandLocalFramePairAnchors(result.framePairAnchors, result.shots);
  invariant(Array.isArray(raw.handKeyframes || []) && (raw.handKeyframes || []).length <= 120, '手部校准关键帧数量无效。');
  result.handKeyframes = (raw.handKeyframes || []).map(frame => {
    localObject(frame, ['side', 'frameIndex', 'strokes', 'uploadId'], '手部关键帧');
    invariant(['source', 'target'].includes(frame.side), '手部关键帧必须明确原片或目标。');
    const frameIndex = inRange(frame.frameIndex, frame.side, '手部关键帧');
    invariant(Array.isArray(frame.strokes || []) && (frame.strokes || []).length <= 64, '手部笔划数量无效。');
    const strokes = (frame.strokes || []).map(stroke => {
      localObject(stroke, ['mode', 'radius', 'points'], '手部笔划');
      invariant(['protect', 'erase'].includes(stroke.mode) && Number.isFinite(stroke.radius) && stroke.radius > 0 && stroke.radius <= 0.25, '手部笔划类型或半径无效。');
      const line = points(stroke.points, '笔划坐标', 512); invariant(line.length, '笔划不能为空。');
      return { mode: stroke.mode, radius: stroke.radius, points: line };
    });
    invariant(frame.uploadId === undefined || localUUID(frame.uploadId), '手部mask上传编号无效，不能直接提交本地路径。');
    return { side: frame.side, frameIndex, strokes, ...(frame.uploadId ? { uploadId: frame.uploadId } : {}) };
  });
  invariant(Array.isArray(raw.targetMaterialKeyframes || []) && (raw.targetMaterialKeyframes || []).length <= 120, '目标旧膜校准关键帧数量无效。');
  result.targetMaterialKeyframes = (raw.targetMaterialKeyframes || []).map(frame => {
    localObject(frame, ['frameIndex', 'region', 'reviewed'], '目标旧膜关键帧');
    invariant(typeof frame.reviewed === 'boolean', '目标旧膜区域须明确人工核对状态。');
    return { frameIndex: inRange(frame.frameIndex, 'target', '目标旧膜关键帧'), region: points(frame.region, '目标已观察旧膜区域'), reviewed: frame.reviewed };
  });
  invariant(raw.appearanceKeyframes === undefined || Array.isArray(raw.appearanceKeyframes) && raw.appearanceKeyframes.length <= 120, '艺术重建区域关键帧数量无效。');
  // Multiple windows on the same exact target frame remain separate authorizations.
  // Keep incomplete/off-mode annotations editable; rendering checks them only when enabled.
  result.appearanceKeyframes = (raw.appearanceKeyframes ?? []).map(frame => {
    localObject(frame, ['frameIndex', 'region', 'reviewed'], '艺术重建区域关键帧');
    invariant(typeof frame.reviewed === 'boolean', '艺术重建区域须明确人工核对状态。');
    return { frameIndex: inRange(frame.frameIndex, 'target', '艺术重建区域关键帧'),
      region: points(frame.region, '艺术重建授权区域'), reviewed: frame.reviewed };
  });
  invariant(Array.isArray(raw.postCutCleanup || []) && (raw.postCutCleanup || []).length <= 60, '切镜后局部清理数量无效。');
  result.postCutCleanup = (raw.postCutCleanup || []).map(item => {
    localObject(item, ['targetStartFrame', 'targetFrames', 'region', 'reviewed', 'donorFrameIndex'], '切镜后局部清理');
    const targetStartFrame = inRange(item.targetStartFrame, 'target', '局部清理起点');
    invariant(typeof item.reviewed === 'boolean', '局部清理须明确人工核对状态。');
    return { targetStartFrame, targetFrames: integer(item.targetFrames, 1, ranges.target.startFrame + ranges.target.frames - targetStartFrame, '局部清理长度'), region: points(item.region, '局部清理区域'), reviewed: item.reviewed,
      ...(item.donorFrameIndex === undefined ? {} : { donorFrameIndex: inRange(item.donorFrameIndex, 'target', '同镜头目标自身清肤帧') }) };
  });
  return result;
}

export function localCalibrationReady(spec) {
  const c = spec.calibration;
  if (!c?.reviewed || !c.shots?.length
    || !c.postCutCleanup.every(item => item.reviewed && item.region.length >= 3)) return false;
  if (c.framePairs.length && (c.framePairs.length !== c.shots.reduce((sum, shot) => sum + shot.targetFrames, 0)
    || !c.framePairs.every((pair, index) => pair.targetFrame === c.shots[0].targetStartFrame + index
      && c.shots.some(shot => pair.targetFrame >= shot.targetStartFrame && pair.targetFrame < shot.targetStartFrame + shot.targetFrames
        && pair.sourceFrame >= shot.sourceStartFrame && pair.sourceFrame < shot.sourceStartFrame + shot.sourceFrames)))) return false;
  const materialShots = c.shots.filter(shot => (shot.mode ?? 'material') === 'material');
  if (spec.processing?.appearanceReconstruction?.enabled === true && !(c.appearanceKeyframes || []).every(frame =>
    frame.reviewed && frame.region.length >= 3 && materialShots.some(shot => frame.frameIndex >= shot.targetStartFrame
      && frame.frameIndex < shot.targetStartFrame + shot.targetFrames))) return false;
  if (!(c.targetMaterialKeyframes || []).every(frame => frame.reviewed && frame.region.length >= 3 && materialShots.some(shot =>
    frame.frameIndex >= shot.targetStartFrame && frame.frameIndex < shot.targetStartFrame + shot.targetFrames))) return false;
  if (materialShots.length && (!spec.donor?.file || !c.donorReviewed)) return false;
  for (const cleanup of c.postCutCleanup) {
    if (cleanup.donorFrameIndex === undefined) { if (!spec.donor?.file || !c.donorReviewed) return false; }
    else if (!c.shots.some(shot => shot.mode === 'preserve' && cleanup.targetStartFrame >= shot.targetStartFrame
      && cleanup.targetStartFrame + cleanup.targetFrames <= shot.targetStartFrame + shot.targetFrames
      && cleanup.donorFrameIndex >= shot.targetStartFrame && cleanup.donorFrameIndex < shot.targetStartFrame + shot.targetFrames)) return false;
  }
  if (c.framePairs.some(pair => materialShots.some(shot => pair.targetFrame >= shot.targetStartFrame && pair.targetFrame < shot.targetStartFrame + shot.targetFrames
    && !(pair.sourceFrame >= shot.sourceStartFrame && pair.sourceFrame < shot.sourceStartFrame + shot.sourceFrames)))) return false;
  // A reference from a different/preserved shot is never evidence for the
  // material shot. The worker applies it only inside its owning source shot.
  if (spec.sourceSkinReference && !(spec.sourceSkinReference.reviewed === true && materialShots.some(shot =>
    spec.sourceSkinReference.frameIndex >= shot.sourceStartFrame && spec.sourceSkinReference.frameIndex < shot.sourceStartFrame + shot.sourceFrames))) return false;
  if (c.anchorPair && !materialShots.some(shot => ['source', 'target'].every(side =>
    c.anchorPair[`${side}Frame`] >= shot[`${side}StartFrame`] && c.anchorPair[`${side}Frame`] < shot[`${side}StartFrame`] + shot[`${side}Frames`]))) return false;
  if (!materialShots.length) return c.postCutCleanup.length > 0 && c.handKeyframes.some(frame => frame.side === 'target'
    && (frame.strokes.some(stroke => stroke.mode === 'protect') || frame.mask?.file));
  return c.sourceRegion.length >= 3 && c.targetRegion.length >= 3 && c.sourceSkinPoints.length >= 4
    && materialShots.every(shot => ['source', 'target'].every(side => c.handKeyframes.some(frame => frame.side === side
      && frame.frameIndex >= shot[`${side}StartFrame`] && frame.frameIndex < shot[`${side}StartFrame`] + shot[`${side}Frames`]
      && (frame.strokes.some(stroke => stroke.mode === 'protect') || frame.mask?.file))));
}

export function normalizeSourceSkinReference(raw, source) {
  if (raw === undefined || raw === null) return null;
  localObject(raw, ['frameIndex', 'reviewed'], '原片同镜头薄匀参考');
  invariant(typeof raw.reviewed === 'boolean', '原片薄匀参考须明确人工核对状态。');
  return { frameIndex: integer(raw.frameIndex, 0, source.frames - 1, '原片薄匀参考帧'), reviewed: raw.reviewed };
}

export function validateLocalWorkerResult(raw, request) {
  invariant(raw && raw.schemaVersion === LOCAL_MATERIAL_VERSION && raw.requestHash === request.requestHash && raw.revision === request.revision
    && raw.action === request.action && ['needs_calibration', 'preview_ready'].includes(raw.status), '本地运行器结果与冻结任务不一致。', 422);
  invariant(Array.isArray(raw.riskFrames) && raw.riskFrames.length <= 1000, '本地风险帧记录不完整。', 422);
  for (const risk of raw.riskFrames) invariant(typeof risk.id === 'string' && typeof risk.reason === 'string' && (risk.targetFrame === null || Number.isInteger(risk.targetFrame)
    && risk.targetFrame >= request.frameRanges.target.startFrame && risk.targetFrame < request.frameRanges.target.startFrame + request.frameRanges.target.frames), '本地风险帧超出修复范围。', 422);
  const records = Array.isArray(raw.artifacts) ? raw.artifacts : raw.artifacts?.frames || raw.frames || [];
  const appearanceRecords = records.filter(record => record.appearanceReconstruction);
  const cleanupBorderRecords = records.filter(record => record.cleanupBoundaryReconstruction);
  invariant(!(appearanceRecords.length || cleanupBorderRecords.length) || request.processing?.appearanceReconstruction?.enabled === true,
    '运行器返回了未经开启的艺术重建结果。', 422);
  const appearanceUnsafe = appearanceRecords.some(record => record.appearanceReconstruction.featureChangedPixels > 0
    || record.appearanceReconstruction.protectedOldHandChangedPixels > 0);
  const cleanupBorderUnsafe = cleanupBorderRecords.some(record => {
    const evidence = record.cleanupBoundaryReconstruction;
    return evidence.protectedPixelsChanged !== 0 || evidence.changedOutsideBand !== 0 || evidence.radiusPixels < 1 || evidence.radiusPixels > 2
      || !request.calibration?.postCutCleanup?.some(plan => Number.isInteger(plan.donorFrameIndex)
        && plan.targetStartFrame <= record.targetFrame && record.targetFrame < plan.targetStartFrame + plan.targetFrames);
  });
  const unsafe = raw.riskFrames.some(risk => risk.resolved !== true) || !localCalibrationReady({ donor: request.targetSkin, calibration: request.calibration, sourceSkinReference: request.sourceSkinReference, processing: request.processing })
    || appearanceUnsafe || cleanupBorderUnsafe || raw.checks?.calibrated !== true || raw.checks?.lowSupportCount !== 0 || raw.checks?.changedOutsideEditablePixels !== 0;
  return { ...raw, status: request.action === 'analyse' || unsafe ? 'needs_calibration' : raw.status };
}
