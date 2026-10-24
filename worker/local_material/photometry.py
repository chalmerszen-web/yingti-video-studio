"""Target-owned donor colour matching with an explicit safe extrapolation model.

This is separate from source material/baseline estimation. It never changes the
base globally: callers use the corrected donor only inside editable skin.
"""
import cv2
import numpy as np
from .geometry import skin_plane
from .protocol import CalibrationError

def target_donor_correction(reference, current, sample_points, exclusion, domain):
    height, width = current.shape[:2]
    offset_image = np.float32(current) - np.float32(reference) + 128
    _, fit = skin_plane(offset_image, sample_points, exclusion)
    radius = max(1, round(min(width, height) * .005))
    offsets = []
    for point in fit["acceptedSamplesNormalized"]:
        x, y = np.rint(np.float64(point) * [width, height]).astype(int)
        patch = offset_image[y-radius:y+radius+1, x-radius:x+radius+1]
        offsets.append(np.median(patch.reshape(-1, 3), axis=0) - 128)
    offsets = np.float64(offsets)
    points = np.float64(fit["acceptedSamplesNormalized"])
    design = np.c_[np.ones(len(points)), points]
    coefficients = np.float64(fit["coefficientsBGR"])
    yy, xx = np.mgrid[:height, :width]
    grid = np.stack([np.ones_like(xx), xx / width, yy / height], axis=2)
    unbounded = grid @ coefficients - 128
    domain = np.bool_(domain)
    if not np.any(domain):
        raise CalibrationError("Target donor colour correction has no visible skin domain")

    # A fitted plane can have a tiny training error yet make impossible hidden
    # skin predictions when only a thin diagonal of samples survives the hand.
    normal_inverse = np.linalg.pinv(design.T @ design)
    selected_design = grid[domain]
    leverage = np.sum((selected_design @ normal_inverse) * selected_design, axis=1)
    sample_low, sample_high = np.min(offsets, axis=0), np.max(offsets, axis=0)
    field_low, field_high = np.min(unbounded[domain], axis=0), np.max(unbounded[domain], axis=0)
    beyond_samples = np.maximum(sample_low - field_low, field_high - sample_high)
    condition = float(np.linalg.cond(design))
    unsafe = bool(np.quantile(leverage, .95) > 1 or np.max(beyond_samples) > 20)
    constant = np.median(offsets, axis=0)
    constant_error = np.sqrt(np.mean((offsets - constant) ** 2, axis=0))
    statistics = {**fit, "side": "target", "purpose": "own_target_donor_colour",
                  "sampleOffsetsBGR": offsets.tolist(), "sampleOffsetMinimumBGR": sample_low.tolist(),
                  "sampleOffsetMaximumBGR": sample_high.tolist(), "designCondition": condition,
                  "domainLeverageP95": float(np.quantile(leverage, .95)),
                  "domainLeverageMaximum": float(np.max(leverage)),
                  "unboundedDomainMinimumBGR": field_low.tolist(), "unboundedDomainMaximumBGR": field_high.tolist(),
                  "extrapolationBeyondObservedOffsetsBGR": beyond_samples.tolist(),
                  "constantMedianOffsetBGR": constant.tolist(), "constantResidualRMSBGR": constant_error.tolist(),
                  "timeDependentBlend": False, "baseGlobalCorrection": False}
    if unsafe:
        statistics["method"] = "robust_constant_bare_offset"
        statistics["fallbackReason"] = "Plane extrapolation is unsupported by the current bare-skin sample geometry"
        if np.max(constant_error) > 24:
            raise CalibrationError("Target bare-skin samples do not support a reliable constant colour correction", {"stage": "target_donor_photometry", "fit": statistics})
        offset = constant
    else:
        statistics["method"] = "robust_spatial_bare_offset_plane"
        offset = unbounded
    return np.clip(np.float32(reference) + offset, 0, 255).astype(np.float32), statistics
