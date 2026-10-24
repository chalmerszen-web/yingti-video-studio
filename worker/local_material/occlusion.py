"""Generic bounded appearance reconstruction, separate from current observation.

Every input residual and mask is already in target UV. No source RGB is accepted.
Neighbours must already have passed same-shot visibility/calibration checks.
"""
import cv2
import numpy as np

METHOD = "two-sided-observed-residual-and-bounded-spatial-v1"

def reconstruct(current_frame, current_visible, current_residual, current_hand,
                reference_hand, editable, neighbouring_observations,
                eye_distance, window_frames):
    shape = current_visible.shape
    gap = editable & ~current_visible & current_hand & ~reference_hand
    previous_index = np.full(shape, -1, np.int32)
    next_index = previous_index.copy()
    previous = np.zeros(shape + (3,), np.float32)
    following = previous.copy()
    valid = [o for o in neighbouring_observations if 0 < abs(o["frame"] - current_frame) <= window_frames and o.get("credible", False)]
    for before, destination, indices in ((True, previous, previous_index), (False, following, next_index)):
        observations = sorted((o for o in valid if (o["frame"] < current_frame) == before), key=lambda o: abs(o["frame"] - current_frame))
        for observation in observations:
            available = gap & (indices < 0) & observation["visible"]
            indices[available] = observation["frame"]
            destination[available] = observation["residual"][available]
    difference = np.max(np.abs(previous - following), axis=2)
    luminance_difference = np.abs((previous - following) @ np.float32([.114, .587, .299]))
    temporal = gap & (previous_index >= 0) & (next_index >= 0) & (difference <= 12) & (luminance_difference <= 8)
    temporal_delta = (previous + following) * .5

    radius = max(1, round(eye_distance * .12))
    kernel = radius * 2 + 1
    weights = np.float32(current_visible)
    mass = cv2.GaussianBlur(weights, (kernel, kernel), radius * .5)
    delta = np.float32(current_residual)
    local = cv2.GaussianBlur(delta * weights[:, :, None], (kernel, kernel), radius * .5) / (mass[:, :, None] + 1e-8)
    second = cv2.GaussianBlur(delta ** 2 * weights[:, :, None], (kernel, kernel), radius * .5) / (mass[:, :, None] + 1e-8)
    variability = np.sqrt(np.maximum(0, second - local ** 2))
    depth = cv2.distanceTransform(np.uint8(~current_visible), cv2.DIST_L2, 5)
    spatial = gap & ~temporal & (depth <= radius) & (mass >= .15)
    # Reconstruct only a small contact gap, never a large unobserved surface.
    too_broad = np.count_nonzero(spatial) > .15 * max(1, np.count_nonzero(editable))
    if too_broad:
        spatial[:] = False
    inferred = temporal | spatial
    result = delta.copy()
    result[temporal] = temporal_delta[temporal]
    result[spatial] = local[spatial]
    remaining = editable & ~current_visible & ~inferred
    return {"residual": result, "effectiveSupport": current_visible | inferred,
            "currentMeasuredSupport": current_visible.copy(), "inferredTemporal": temporal,
            "inferredSpatial": spatial, "remainingUnknown": remaining,
            "previousSourceFrame": previous_index, "nextSourceFrame": next_index,
            "twoSidedDifferenceBGR": difference, "spatialVariabilityBGR": variability,
            "summary": {"method": METHOD, "isGroundTruth": False,
                        "currentMeasuredPixels": int(np.count_nonzero(editable & current_visible)),
                        "temporalInferredPixels": int(np.count_nonzero(temporal)),
                        "spatialInferredPixels": int(np.count_nonzero(spatial)),
                        "remainingUnknownPixels": int(np.count_nonzero(remaining)),
                        "windowFrames": window_frames, "spatialRadiusPixels": radius,
                        "spatialRadiusEyeFraction": .12, "spatialMinSampleMass": .15,
                        "spatialTooBroad": bool(too_broad),
                        "maxSpatialDistancePixels": float(depth[spatial].max()) if spatial.any() else 0,
                        "maxSpatialVariabilityBGR": float(variability[spatial].max()) if spatial.any() else 0,
                        "agreementMaxChannelDifference": 12,
                        "agreementMaxLuminanceDifference": 8}}
