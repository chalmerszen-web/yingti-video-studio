"""Opt-in bounded artistic material reconstruction; inferred pixels are not GT.

Inputs are material residuals in target UV, never source face/hand RGB. Current
observations are fixed Dirichlet controls. Missing controls may use the nearest
real visible state in the same shot, then a local four-neighbour harmonic solve.
"""
import cv2
import numpy as np

METHOD = "bounded-material-appearance-v1"
WINDOW_FRAMES = 9
MAX_COMPONENT_EYE_AREA = .20
MAX_COMPONENT_FACE_FRACTION = .05
MAX_TOTAL_FACE_FRACTION = .10
MAX_DISTANCE_EYE = .25
FEATHER_EYE = .04
MIN_BOUNDARY_POINTS = 12
_CROSS = np.float32([[0, 1, 0], [1, 0, 1], [0, 1, 0]])


def harmonic(field, known, domain, patch):
    """Solve only the connected local domain; unknown exterior is Neumann."""
    ys, xs = np.where(domain)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    dm = domain[y0:y1, x0:x1]
    k = known[y0:y1, x0:x1]
    unknown = dm & ~k
    values = field[y0:y1, x0:x1].copy()
    values[unknown] = np.mean(values[k], axis=0)
    degree = cv2.filter2D(np.float32(dm), -1, _CROSS, borderType=cv2.BORDER_CONSTANT)
    step = 0.
    for iteration in range(1600):
        sums = cv2.filter2D(values * dm[:, :, None], -1, _CROSS, borderType=cv2.BORDER_CONSTANT)
        average = sums / np.maximum(degree[:, :, None], 1)
        step = float(np.max(np.abs(average[unknown] - values[unknown]))) if unknown.any() else 0.
        values[unknown] = average[unknown]
        if step < .004:
            break
    output = field.copy()
    output[y0:y1, x0:x1][patch[y0:y1, x0:x1] & ~k] = values[patch[y0:y1, x0:x1] & ~k]
    return output, {"iterations": iteration + 1, "lastUpdateBGR": step,
                    "converged": step < .004, "exteriorBoundary": "unknown exterior has Neumann conditions, never zero material"}


def reconstruct(current_frame, current_visible, current_residual, existing_residual,
                existing_support, editable, reviewed_region, surface, old_hand,
                neighbours, eye_distance, whole_face_area, source_shot):
    """Return accepted local patches and separate observation/inference evidence.

    surface already excludes ROI exterior, facial features and absent own-donor
    coverage. Only an exact-frame reviewed polygon can override old target H.
    """
    shape = current_visible.shape
    reviewed = np.bool_(reviewed_region) & surface
    allowed = surface & (~old_hand | reviewed)
    patch = ((editable & ~existing_support) | reviewed) & allowed
    measured = np.bool_(current_visible) & allowed
    delta = np.float32(current_residual).copy()
    temporal = np.zeros(shape, bool)
    selected_frame = np.full(shape, -1, np.int32)
    previous_frame = selected_frame.copy()
    next_frame = selected_frame.copy()
    accepted = np.zeros(shape, bool)
    all_domain = accepted.copy()
    harmonic_inferred = accepted.copy()
    output = np.float32(existing_residual).copy()
    maximum_area = min(MAX_COMPONENT_EYE_AREA * eye_distance ** 2, MAX_COMPONENT_FACE_FRACTION * whole_face_area)
    maximum_distance = MAX_DISTANCE_EYE * eye_distance
    radius = max(1, int(np.ceil(maximum_distance)))
    components, labels, stats, _ = cv2.connectedComponentsWithStats(np.uint8(patch), connectivity=8)
    records = []
    total_too_large = patch.sum() > MAX_TOTAL_FACE_FRACTION * whole_face_area
    shot_start, shot_frames = source_shot
    valid = sorted((n for n in neighbours if n.get("credible") is True
                    and shot_start <= n["frame"] < shot_start + shot_frames
                    and 0 < abs(n["frame"] - current_frame) <= WINDOW_FRAMES),
                   key=lambda n: (abs(n["frame"] - current_frame), n["frame"]))
    for label in range(1, components):
        component = labels == label
        row = {"component": label, "pixels": int(stats[label, cv2.CC_STAT_AREA]), "accepted": False}
        records.append(row)
        if total_too_large or row["pixels"] > maximum_area:
            row["reason"] = "total repair exceeds fixed face area bound" if total_too_large else "component exceeds fixed face/eye area bound"
            continue
        domain = (cv2.dilate(np.uint8(component), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1))) > 0) & allowed
        # Keep only domain components touching this patch, avoiding disconnected
        # controls on the far side of protected eyes, lips, nose or target hands.
        _, domain_labels = cv2.connectedComponents(np.uint8(domain), connectivity=4)
        domain &= np.isin(domain_labels, np.unique(domain_labels[component]))
        field = delta.copy()
        component_boundary = component & (cv2.erode(np.uint8(component), np.ones((3, 3), np.uint8)) == 0)
        inferred_boundary = np.zeros(shape, bool)
        chosen = np.full(shape, -1, np.int32)
        before = chosen.copy()
        after = chosen.copy()
        for neighbour in valid:
            # Adjacent frames constrain the boundary, not the unknown interior.
            # Pasting their interior residual carries stale film/colour wedges
            # into a different hand pose; solve those unknown pixels spatially.
            # A one-pixel contour may also carry temporal boundary evidence
            # when the reviewed face window is surrounded by protected hands.
            # Exclude every patch interior, including neighbouring components.
            seen = domain & (~patch | component_boundary) & ~measured & neighbour["visible"]
            direction = before if neighbour["frame"] < current_frame else after
            direction[seen & (direction < 0)] = neighbour["frame"]
            take = seen & (chosen < 0)
            field[take] = neighbour["residual"][take]
            chosen[take] = neighbour["frame"]
            inferred_boundary |= take
        known = domain & (measured | inferred_boundary)
        boundary = known & (cv2.dilate(np.uint8(component), np.ones((7, 7), np.uint8)) > 0)
        row["trustedBoundaryPoints"] = int(boundary.sum())
        row["sameFrameBoundaryPoints"] = int((boundary & measured).sum())
        row["timeInferredBoundaryPoints"] = int((boundary & inferred_boundary).sum())
        if boundary.sum() < MIN_BOUNDARY_POINTS:
            row["reason"] = "too few trusted residual boundary points"
            continue
        depth = cv2.distanceTransform(np.uint8(~known), cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
        max_depth = float(depth[component & ~known].max()) if (component & ~known).any() else 0.
        row["maximumBoundaryDistancePixels"] = max_depth
        if max_depth > maximum_distance:
            row["reason"] = "trusted residual boundary is too far away"
            continue
        solved, fit = harmonic(field, known, domain, component)
        row.update(fit)
        if not fit["converged"]:
            row["reason"] = "harmonic solve did not converge within fixed iteration budget"
            continue
        output[component] = solved[component]
        accepted |= component
        all_domain |= domain
        temporal |= inferred_boundary
        selected_frame[inferred_boundary] = chosen[inferred_boundary]
        previous_frame[inferred_boundary] = before[inferred_boundary]
        next_frame[inferred_boundary] = after[inferred_boundary]
        harmonic_inferred |= component & ~known
        row.update({"accepted": True, "residualMinimumBGR": solved[component].min(axis=0).tolist(),
                    "residualMaximumBGR": solved[component].max(axis=0).tolist()})
    # Measured residual values never change, including when the supplied old
    # strict branch already had inference elsewhere in the frame.
    output[accepted & measured] = current_residual[accepted & measured]
    effective_editable = editable | (accepted & reviewed)
    effective_support = existing_support | accepted
    remaining = effective_editable & ~effective_support
    rejected = patch & ~accepted
    alpha = np.minimum(cv2.distanceTransform(np.uint8(accepted), cv2.DIST_L2, cv2.DIST_MASK_PRECISE) / max(1., FEATHER_EYE * eye_distance), 1.)
    alpha[~accepted] = 0
    return {"residual": output, "effectiveSupport": effective_support, "editable": effective_editable,
            "acceptedPatch": accepted, "requestedPatch": patch, "reviewedRegion": reviewed,
            "currentMeasured": measured, "timeInferredBoundary": temporal,
            "timeInferredPatch": accepted & temporal, "harmonicInferred": harmonic_inferred,
            "remainingUnknown": remaining, "rejectedPatch": rejected,
            "domain": all_domain, "selectedSourceFrame": selected_frame,
            "previousSourceFrame": previous_frame, "nextSourceFrame": next_frame,
            "spatialFeather": alpha, "oldHandOverride": accepted & reviewed & old_hand,
            "summary": {"method": METHOD, "isGroundTruth": False, "temporalFade": False,
                        "windowFrames": WINDOW_FRAMES, "sourceShot": {"startFrame": shot_start, "frames": shot_frames},
                        "eyeDistancePixels": float(eye_distance), "wholeFacePixels": int(whole_face_area),
                        "maximumComponentPixels": float(maximum_area), "maximumComponentEyeArea": MAX_COMPONENT_EYE_AREA,
                        "maximumComponentFaceFraction": MAX_COMPONENT_FACE_FRACTION, "maximumTotalFaceFraction": MAX_TOTAL_FACE_FRACTION,
                        "maximumBoundaryDistanceEyeFraction": MAX_DISTANCE_EYE, "minimumTrustedBoundaryPoints": MIN_BOUNDARY_POINTS,
                        "featherEyeFraction": FEATHER_EYE, "requestedPixels": int(patch.sum()), "acceptedPixels": int(accepted.sum()),
                        "sameFrameMeasuredPatchPixels": int((accepted & measured).sum()),
                        "timeInferredPatchPixels": int((accepted & temporal).sum()),
                        "timeInferredBoundaryPixels": int(temporal.sum()), "harmonicInferredPixels": int(harmonic_inferred.sum()),
                        "remainingUnknownPixels": int(remaining.sum()), "rejectedPixels": int(rejected.sum()),
                        "rejectedAutomaticPixels": int((rejected & ~reviewed).sum()),
                        "rejectedReviewedPixels": int((rejected & reviewed).sum()),
                        "oldHandAuthorizedOverridePixels": int((accepted & reviewed & old_hand).sum()),
                        "selectionRule": "nearest actually visible same-shot boundary; earlier wins equal temporal distance; unknown patch interior is harmonic, never pasted",
                        "temporalInteriorPaste": False,
                        "temporalBoundaryRingPixels": 1,
                        "components": records}}


def compose(original, clean, residual, patch, spatial_feather):
    """Apply a spatial-only local blend to own-target clean + material residual."""
    result = original.copy()
    alpha = spatial_feather[patch, None]
    result[patch] = np.uint8(np.clip(np.float32(original[patch]) * (1 - alpha) +
                                   (clean[patch] + residual[patch]) * alpha, 0, 255))
    return result


def refine_cleanup_border(frame, reviewed_roi, hand, features):
    """Remove matte contamination in a tiny same-frame cleanup boundary band.

    This is an explicitly inferred seam blend, not a new skin/face warp. Extra
    hand protection excludes nail edges. Every other pixel is restored exactly.
    """
    radius = max(1, min(2, round(min(frame.shape[:2]) * .004)))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1))
    roi = np.uint8(reviewed_roi)
    band = (cv2.dilate(roi, kernel) > 0) & (cv2.erode(roi, kernel) == 0)
    hand_guard = cv2.dilate(np.uint8(hand), np.ones((3, 3), np.uint8)) > 0
    mask = band & ~hand_guard & ~np.bool_(features)
    result = frame.copy()
    if mask.any():
        inferred = cv2.inpaint(frame, np.uint8(mask) * 255, radius, cv2.INPAINT_TELEA)
        result[mask] = inferred[mask]
    changed = np.any(result != frame, axis=2)
    return result, mask, {"method": "same-frame-cleanup-matte-border-v1", "isGroundTruth": False,
        "radiusPixels": radius, "inferredPixels": int(mask.sum()), "changedPixels": int(changed.sum()),
        "changedOutsideBand": int((changed & ~band).sum()),
        "protectedPixelsChanged": int((changed & (hand_guard | np.bool_(features))).sum()),
        "timeFade": False, "referenceFaceGeometryChanged": False}
