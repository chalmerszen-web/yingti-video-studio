"""Per-frame independent anatomical mask anchoring, never chain face flow."""
import cv2
import numpy as np
from .protocol import CalibrationError

def support_mask(points, edges, size):
    mask = np.zeros((size[1], size[0]), np.uint8)
    width = float(np.linalg.norm(points[5] - points[17]))
    radius = max(2, round(width * .18))
    cv2.fillConvexPoly(mask, cv2.convexHull(np.int32(points[[0, 1, 2, 5, 9, 13, 17]])), 255)
    mask = cv2.dilate(mask, np.ones((radius * 2 + 1, radius * 2 + 1), np.uint8))
    for a, b in edges:
        cv2.line(mask, tuple(np.rint(points[a]).astype(int)), tuple(np.rint(points[b]).astype(int)), 255, radius * 2)
    for tip in (4, 8, 12, 16, 20):
        extension = points[tip] + (points[tip] - points[tip - 1]) * .9
        cv2.line(mask, tuple(np.rint(points[tip]).astype(int)), tuple(np.rint(extension).astype(int)), 255, radius * 2)
    wrist_extension = points[0] + (points[0] - points[[5, 9, 13, 17]].mean(axis=0)) * .85
    cv2.line(mask, tuple(np.rint(points[0]).astype(int)), tuple(np.rint(wrist_extension).astype(int)), 255, max(4, round(width * .85)))
    return mask

def material_finger_guard(points, edges, size, normalized_margin):
    """Conservative source material exclusion, NOT target hand segmentation."""
    mask = np.zeros((size[1], size[0]), np.uint8)
    radius = max(1, round(min(size) * normalized_margin))
    for a, b in edges:
        cv2.line(mask, tuple(np.rint(points[a]).astype(int)), tuple(np.rint(points[b]).astype(int)), 255, radius * 2)
    for tip in (4, 8, 12, 16, 20):
        extension = points[tip] + (points[tip] - points[tip - 1]) * .4
        cv2.line(mask, tuple(np.rint(points[tip]).astype(int)), tuple(np.rint(extension).astype(int)), 255, radius * 2)
    return mask

def independent_mask(current, detection, templates, edges, fps):
    height, width = current.shape[:2]
    empty = np.zeros((height, width), np.uint8)
    if not detection["hands"]:
        return empty, {"status": "NO_HAND_DETECTED", "uncertain": True}
    if len(detection["hands"]) != 1 or not templates:
        raise CalibrationError("Visible hand needs a reviewed hand keyframe; multiple hands unsupported")
    points = detection["hands"][0]
    trials = []
    for template in templates:
        matrix, _ = cv2.estimateAffine2D(template["points"], points, method=cv2.RANSAC, ransacReprojThreshold=max(2, min(width, height) * .016), maxIters=2000, confidence=.99, refineIters=10)
        if matrix is None or not .25 < np.linalg.det(matrix[:, :2]) < 4:
            continue
        predicted = cv2.transform(template["points"][None], matrix)[0]
        error = float(np.median(np.linalg.norm(predicted - points, axis=1)))
        score = error + min(width, height) * .011 * abs(template["frameIndex"] - detection["frameIndex"]) / fps
        trials.append((score, error, template, matrix))
    if not trials:
        raise CalibrationError("No credible current-hand alignment")
    _, error, template, matrix = min(trials, key=lambda x: x[0])
    aligned = cv2.warpAffine(template["mask"], matrix, (width, height), flags=cv2.INTER_NEAREST)
    reference = cv2.warpAffine(template["image"], matrix, (width, height))
    margin = max(3, round(min(width, height) * .04))
    local = cv2.dilate(aligned, np.ones((margin * 2 + 1, margin * 2 + 1), np.uint8)) > 0
    reference[~local] = current[~local]
    flow_size = (max(32, width // 2), max(32, height // 2))
    a = cv2.resize(cv2.cvtColor(current, cv2.COLOR_BGR2GRAY), flow_size, interpolation=cv2.INTER_AREA)
    b = cv2.resize(cv2.cvtColor(reference, cv2.COLOR_BGR2GRAY), flow_size, interpolation=cv2.INTER_AREA)
    flow = cv2.calcOpticalFlowFarneback(a, b, None, .5, 4, 25, 4, 7, 1.5, 0)
    flow = cv2.resize(flow, (width, height)) * [width / flow_size[0], height / flow_size[1]]
    limit = max(2, min(width, height) * .017)
    flow *= np.minimum(1, limit / (np.linalg.norm(flow, axis=2) + 1e-5))[:, :, None]
    yy, xx = np.mgrid[:height, :width].astype(np.float32)
    refined = cv2.remap(aligned, xx + np.float32(flow[:, :, 0]), yy + np.float32(flow[:, :, 1]), cv2.INTER_NEAREST)
    refined[support_mask(points, edges, (width, height)) == 0] = 0
    count, labels, stats, _ = cv2.connectedComponentsWithStats(np.uint8(refined > 0), 8)
    bones = np.zeros_like(refined)
    for a, b in edges:
        cv2.line(bones, tuple(np.rint(points[a]).astype(int)), tuple(np.rint(points[b]).astype(int)), 255, max(3, round(min(width, height) * .024)))
    for i in range(1, count):
        region = labels == i
        if not np.any(bones[region]):
            refined[region] = 0
    protection = max(1, round(min(width, height) * .004))
    refined = cv2.dilate(refined, np.ones((protection * 2 + 1, protection * 2 + 1), np.uint8))
    return refined, {"status": "INDEPENDENT_HAND21_LOCAL_FLOW_UNCERTAIN", "templateFrame": template["frameIndex"], "medianJointErrorPx": error, "maxResidualFlowPx": limit, "noChainedMask": True, "longNailsAndBlurUncertain": True}
