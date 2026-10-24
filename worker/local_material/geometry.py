"""Aspect-independent geometry and own-frame colour residuals."""
import cv2
import numpy as np
from .protocol import CalibrationError

def pixels(points, size):
    return np.float32([[p["x"] * size[0], p["y"] * size[1]] for p in points])

def polygon_mask(points, size):
    mask = np.zeros((size[1], size[0]), np.uint8)
    cv2.fillPoly(mask, [np.int32(np.rint(points))], 255)
    return mask

def triangles(points, size):
    points = np.float32(points)
    sub = cv2.Subdiv2D((0, 0, *size))
    valid = [i for i, p in enumerate(points) if np.isfinite(p).all() and 0 <= p[0] < size[0] and 0 <= p[1] < size[1]]
    for i in valid:
        sub.insert(tuple(float(v) for v in points[i]))
    result = []
    valid_points = points[valid]
    for triangle in sub.getTriangleList().reshape(-1, 3, 2):
        ids = [valid[int(np.argmin(np.sum((valid_points - v) ** 2, axis=1)))] for v in triangle]
        if len(set(ids)) == 3 and all(np.linalg.norm(points[i] - v) < 1 for i, v in zip(ids, triangle)):
            result.append(ids)
    return result

def bind_points(reference_face, points, size):
    topology = triangles(reference_face, size)
    bindings = []
    for point in points:
        found = None
        for ids in topology:
            try:
                weights = np.linalg.solve(np.vstack([reference_face[ids].T, np.ones(3)]), np.r_[point, 1.0])
            except np.linalg.LinAlgError:
                continue
            if np.min(weights) >= -.01:
                found = (ids, weights)
                break
        if found is None:
            raise CalibrationError("ROI/skin sample lies outside reference face mesh")
        bindings.append(found)
    return bindings

def follow_points(bindings, current_face):
    return np.float32([weights @ current_face[ids] for ids, weights in bindings])

def dense_warp(image, source_face, target_face, target_size, nearest=False):
    source_size = (image.shape[1], image.shape[0])
    result = np.zeros((target_size[1], target_size[0]) + image.shape[2:], np.float32)
    coverage = np.zeros(result.shape[:2], np.uint8)
    source_face, target_face = np.float32(source_face), np.float32(target_face)
    # Convert once, rather than allocating an entire video frame per triangle.
    source_float = np.float32(image)
    if source_face.shape != target_face.shape:
        raise CalibrationError("Source/target face topology differs")
    for ids in triangles(source_face, source_size):
        source, target = source_face[ids], target_face[ids]
        a, b = source[1] - source[0], source[2] - source[0]
        c, d = target[1] - target[0], target[2] - target[0]
        sa, ta = a[0] * b[1] - a[1] * b[0], c[0] * d[1] - c[1] * d[0]
        if abs(sa) < .02 or abs(ta) < .02 or sa * ta < 0:
            continue
        x, y, w, h = cv2.boundingRect(target)
        x0, y0, x1, y1 = max(0, x), max(0, y), min(target_size[0], x + w), min(target_size[1], y + h)
        if x1 <= x0 or y1 <= y0:
            continue
        local = target - [x0, y0]
        matrix = cv2.getAffineTransform(source, np.float32(local))
        patch = cv2.warpAffine(source_float, matrix, (x1 - x0, y1 - y0), flags=cv2.INTER_NEAREST if nearest else cv2.INTER_LINEAR)
        mask = polygon_mask(local, (x1 - x0, y1 - y0)) > 0
        result[y0:y1, x0:x1][mask] = patch[mask]
        coverage[y0:y1, x0:x1][mask] = 255
    return result, coverage

def nose_core_mask(face, size):
    """Protect nostril/base, tip and bridge; nasal flank skin is not a feature."""
    mask = np.zeros((size[1], size[0]), np.uint8)
    # These are anatomical topology IDs, not image positions or case anchors.
    base_ids = [19, 94, 2, 97, 98, 64, 48, 326, 327, 294, 278]
    bridge_ids = [168, 6, 197, 195, 5, 4]
    if max(base_ids + bridge_ids + [1]) >= len(face):
        raise CalibrationError("Face topology does not support protected nasal anatomy")
    cv2.fillConvexPoly(mask, cv2.convexHull(np.int32(np.rint(face[base_ids]))), 255)
    short_edge = min(size)
    radius = max(1, round(short_edge * .0042))
    mask = cv2.dilate(mask, np.ones((radius * 2 + 1, radius * 2 + 1), np.uint8))
    cv2.circle(mask, tuple(np.rint(face[1]).astype(int)), max(1, round(short_edge * .0167)), 255, -1)
    cv2.polylines(mask, [np.int32(np.rint(face[bridge_ids]))], False, 255, max(1, round(short_edge * .0097)))
    return mask

def feature_mask(face, components, size):
    mask = np.zeros((size[1], size[0]), np.uint8)
    for name in ("left_eye", "right_eye", "lips"):
        ids = sorted(set(i for e in components.get(name, []) for i in e))
        if ids and max(ids) < len(face):
            cv2.fillConvexPoly(mask, cv2.convexHull(np.int32(face[ids])), 255)
    radius = max(1, round(min(size) * .004))
    mask = cv2.dilate(mask, np.ones((2 * radius + 1, 2 * radius + 1), np.uint8))
    if components.get("nose"):
        mask = cv2.bitwise_or(mask, nose_core_mask(face, size))
    return mask

def skin_plane(image, sample_points, exclusion):
    height, width = image.shape[:2]
    radius = max(1, round(min(width, height) * .005))
    points, colours, rejected = [], [], []
    for point in sample_points:
        x, y = np.rint(point).astype(int)
        if x - radius < 0 or y - radius < 0 or x + radius >= width or y + radius >= height:
            rejected.append({"pixel": [int(x), int(y)], "reason": "sample_patch_outside_image"})
            continue
        if np.any(exclusion[y - radius:y + radius + 1, x - radius:x + radius + 1]):
            rejected.append({"pixel": [int(x), int(y)], "reason": "sample_patch_touches_protected_or_excluded_region"})
            continue
        points.append((x / width, y / height))
        colours.append(np.median(image[y - radius:y + radius + 1, x - radius:x + radius + 1].reshape(-1, 3), axis=0))
    if len(points) < 4:
        raise CalibrationError("Fewer than4 visible bare-skin samples", {"acceptedSamplesNormalized": points, "acceptedColoursBGR": [p.tolist() for p in colours], "rejectedSamples": rejected, "sampleRadiusPixels": radius, "coordinateSpace": {"width": width, "height": height}})
    design = np.c_[np.ones(len(points)), np.float64(points)]
    values, weights = np.float64(colours), np.ones(len(points))
    if np.linalg.matrix_rank(design) < 3:
        raise CalibrationError("Bare-skin samples are geometrically degenerate")
    for _ in range(5):
        coefficients = np.linalg.lstsq(design * weights[:, None], values * weights[:, None], rcond=None)[0]
        residual = np.linalg.norm(design @ coefficients - values, axis=1)
        weights = np.minimum(1, 10 / (residual + 1e-5))
    yy, xx = np.mgrid[:height, :width]
    baseline = np.clip(np.stack([np.ones_like(xx), xx / width, yy / height], axis=2) @ coefficients, 0, 255).astype(np.float32)
    rmse = np.sqrt(np.mean((design @ coefficients - values) ** 2, axis=0))
    return baseline, {"controls": len(points), "coefficientsBGR": coefficients.tolist(), "basis": ["1", "x/width", "y/height"], "rmseBGR": rmse.tolist(), "acceptedSamplesNormalized": points, "rejectedSamples": rejected}

def material_residual(source, baseline, visible):
    source = np.float32(source)
    delta = source - baseline
    luminance = delta @ np.float32([.114, .587, .299])
    original_chroma = (source[:, :, 2] - source[:, :, 0]) / (source[:, :, 2] + source[:, :, 0] + 1e-5)
    skin_chroma = (baseline[:, :, 2] - baseline[:, :, 0]) / (baseline[:, :, 2] + baseline[:, :, 0] + 1e-5)
    support = visible & (luminance > 6) & (skin_chroma - original_chroma > .018)
    result = np.clip(delta, -12, 80) * support[:, :, None]
    return result, support


def continuous_material_residual(source, baseline, visible):
    """Appearance-only confidence; retain the separate raw binary evidence.

    A hard chroma cutoff gives adjacent thin-film pixels unrelated colours.
    These fixed smooth weights use the same frame's whitening evidence. They
    neither blur pixels nor use elapsed time, and never cross visibility masks.
    """
    source = np.float32(source)
    delta = source - baseline
    luminance = delta @ np.float32([.114, .587, .299])
    chroma = (baseline[:, :, 2] - baseline[:, :, 0]) / (baseline[:, :, 2] + baseline[:, :, 0] + 1e-5)
    chroma -= (source[:, :, 2] - source[:, :, 0]) / (source[:, :, 2] + source[:, :, 0] + 1e-5)
    def smooth(value):
        weight = np.clip(value, 0, 1)
        return weight * weight * (3 - 2 * weight)
    confidence = smooth(luminance / 12) * smooth(chroma / .036) * visible
    return np.clip(delta, -12, 80) * confidence[:, :, None], confidence

def observed_target_candidate(base, expected_skin, surface):
    """Own-target relative whitening cue; diagnostic, not ground truth."""
    base, expected_skin = np.float32(base), np.float32(expected_skin)
    luminance = (base - expected_skin) @ np.float32([.114, .587, .299])
    observed_chroma = (base[:, :, 2] - base[:, :, 0]) / (base[:, :, 2] + base[:, :, 0] + 1e-5)
    skin_chroma = (expected_skin[:, :, 2] - expected_skin[:, :, 0]) / (expected_skin[:, :, 2] + expected_skin[:, :, 0] + 1e-5)
    candidate = surface & (luminance > 10) & (skin_chroma - observed_chroma > .018)
    radius = max(1, round(min(surface.shape) * .003))
    mask = cv2.dilate(np.uint8(candidate) * 255, np.ones((2 * radius + 1, 2 * radius + 1), np.uint8))
    return (mask > 0) & surface


def connected_material_rim(manual, observed, surface):
    """Keep reviewed shadowed material and add only its connected visible rim.

    Whitening alone misses film in shadow; replacing the manual footprint with
    that cue leaves grey islands. Disconnected highlights are not additions.
    The caller's reviewed surface and hand/features remain hard boundaries.
    """
    seed, cue = np.bool_(manual) & surface, np.bool_(observed) & surface
    _, labels = cv2.connectedComponents(np.uint8(cue), connectivity=8)
    connected = np.unique(labels[seed & cue])
    connected = connected[connected != 0]
    rim = cue & np.isin(labels, connected)
    return seed | rim, {"method": "reviewed-seed-connected-whitening-rim", "manualPixels": int(seed.sum()), "addedRimPixels": int((rim & ~seed).sum()), "discardedUnlinkedWhiteningPixels": int((cue & ~rim).sum()), "outsideReviewedSurface": 0}

def stroke_mask(strokes, size, initial=None):
    mask = np.zeros((size[1], size[0]), np.uint8) if initial is None else initial.copy()
    for stroke in strokes:
        radius = max(1, round(stroke["radius"] * min(size)))
        points = pixels(stroke["points"], size)
        value = 255 if stroke["mode"] == "protect" else 0
        for point in points:
            cv2.circle(mask, tuple(np.rint(point).astype(int)), radius, value, -1)
        for a, b in zip(points[:-1], points[1:]):
            cv2.line(mask, tuple(np.rint(a).astype(int)), tuple(np.rint(b).astype(int)), value, radius * 2)
    return mask
