"""Streaming analyse/render loop; diagnostic preview is never final acceptance."""
import json
import io
from collections import OrderedDict
from pathlib import Path
import cv2
import numpy as np
from .protocol import CalibrationError, Cancelled, cache_key, check_cancel, atomic_json, atomic_bytes, frame_mapping, sha_file, owned_path
from .media import VideoReader, processing_size, read_image, save_png
from .geometry import pixels, polygon_mask, bind_points, follow_points, dense_warp, feature_mask, skin_plane, material_residual, continuous_material_residual, stroke_mask, observed_target_candidate, connected_material_rim
from .hand import independent_mask, material_finger_guard
from .runtime import Detector
from .occlusion import reconstruct, METHOD as OCCLUSION_METHOD
from .photometry import target_donor_correction
from . import appearance

class _PreserveFrame(Exception):
    """Internal branch for explicitly reviewed unchanged output frames."""
    pass

def detect(detector, image, frame_index):
    result = detector.detect(image)
    result["frameIndex"] = frame_index
    if len(result["faces"]) != 1:
        raise CalibrationError("Exactly one tracked face is required")
    if any(not np.isfinite(points).all() for points in result["faces"] + result["hands"]):
        raise CalibrationError("Non-finite tracked face/hand geometry")
    return result

def prepare_templates(request, side, reader, detector):
    templates = []
    for item in request.get("calibration", {}).get("handKeyframes", []):
        if item["side"] != side:
            continue
        image = reader.get(item["frameIndex"])
        detection = detect(detector, image, item["frameIndex"])
        if len(detection["hands"]) != 1:
            raise CalibrationError("Hand calibration keyframe has no single detectable hand")
        initial = None
        if item.get("mask"):
            initial = cv2.imdecode(np.fromfile(item["mask"]["file"], np.uint8), cv2.IMREAD_GRAYSCALE)
            if initial is None:
                raise CalibrationError("Hand mask cannot be decoded")
            initial = cv2.resize(initial, reader.size, interpolation=cv2.INTER_NEAREST)
        mask = stroke_mask(item.get("strokes", []), reader.size, initial)
        if not np.any(mask):
            raise CalibrationError("Hand calibration is empty")
        templates.append({"frameIndex": item["frameIndex"], "points": detection["hands"][0], "image": image, "mask": mask})
    return templates

def correction_plane(reference, current, points, exclusion):
    # Fit a signed photometric correction using normalized spatial coordinates.
    offset_image = np.float32(current) - reference + 128
    plane, fit = skin_plane(offset_image, points, exclusion)
    return np.clip(reference + plane - 128, 0, 255), fit

def compose_local(base, clean, residual, editable, distance_feather=False):
    """All operations are spatial; restore every pixel outside editable exactly."""
    if distance_feather:
        radius = max(1, round(min(base.shape[:2]) * .0125))
        alpha = np.minimum(cv2.distanceTransform(np.uint8(editable), cv2.DIST_L2, cv2.DIST_MASK_PRECISE) / radius, 1)
    else:
        radius = max(1, round(min(base.shape[:2]) * .005))
        alpha = cv2.GaussianBlur(np.float32(editable), (radius * 2 + 1, radius * 2 + 1), max(.7, radius / 2))
    alpha[~editable] = 0
    candidate = np.clip(clean + residual, 0, 255)
    result = np.uint8(np.clip(np.float32(base) * (1 - alpha[:, :, None]) + candidate * alpha[:, :, None], 0, 255))
    result[~editable] = base[~editable]
    return result

def shot_for_target(calibration, frame):
    return next((s for s in calibration.get("shots", []) if s["targetStartFrame"] <= frame < s["targetStartFrame"] + s["targetFrames"]), None)

def templates_for_shot(templates, shot, side):
    """A pose-fit score cannot authorize carrying hand anatomy across a cut."""
    if shot is None:
        return []
    start = shot[side + "StartFrame"]
    end = start + shot[side + "Frames"]
    return [template for template in templates if start <= template["frameIndex"] < end]

def run(request, progress=lambda value: None, detector_factory=Detector):
    directory = Path(request["outputDirectory"])
    directory.mkdir(parents=True, exist_ok=True)
    key = cache_key(request)
    if request["action"] == "render":
        pairs = frame_mapping(request)
    else:
        source_range, target_range = request["frameRanges"]["source"], request["frameRanges"]["target"]
        count = min(source_range["frames"], target_range["frames"], max(1, int(request.get("analysisSampleLimit", 120))))
        source_indices = np.linspace(source_range["startFrame"], source_range["startFrame"] + source_range["frames"] - 1, count, dtype=int)
        target_indices = np.linspace(target_range["startFrame"], target_range["startFrame"] + target_range["frames"] - 1, count, dtype=int)
        pairs = [{"sourceFrame": int(s), "targetFrame": int(t), "observationOnlyNotCorrespondence": True} for s, t in zip(source_indices, target_indices)]
    calibration = request.get("calibration", {})
    cancel = request.get("cancelFile")
    maximum = int(request.get("processing", {}).get("maxSide", 1280))
    hand_margin = float(request.get("processing", {}).get("handBoundaryMargin", .008))
    if not np.isfinite(hand_margin) or not 0 <= hand_margin <= .1:
        raise CalibrationError("processing.handBoundaryMargin must be normalized short-edge fraction0..0.1")
    result = {"schemaVersion": 1, "action": request["action"], "requestHash": request.get("requestHash"), "revision": request.get("revision"), "cacheKey": key, "status": "needs_calibration", "riskFrames": [], "checks": {"calibrated": False, "lowSupportCount": 0, "changedOutsideEditablePixels": 0, "editablePixels": 0}, "artifacts": {"frames": [], "limitations": ["Landmarks are estimates, not observed skin or perfect hand/nail segmentation.", "Material is relative colour/brightness excess, not unique physical alpha.", "Preview readiness is technical only; final content requires human review."]}}
    def risk(reason, pair=None, details=None):
        frame = pair["targetFrame"] if pair else None
        details = details or {}
        stage = details.get("stage", "")
        codes = [("Fewer than4", "SKIN_SAMPLES_INSUFFICIENT"), ("reliable constant colour correction", "TARGET_SKIN_SAMPLES_INCONSISTENT"), ("unsupported source", "SOURCE_SURFACE_SUPPORT_LOW"), ("no donor support", "TARGET_DONOR_SUPPORT_LOW"), ("hand detection lost", "HAND_TRACKING_LOST"), ("hand geometry", "HAND_GEOMETRY_UNCERTAIN"), ("Exactly one tracked face", "FACE_TRACKING_UNCERTAIN"), ("reviewed hand keyframe", "HAND_CALIBRATION_REQUIRED"), ("different shot", "REFERENCE_SHOT_MISMATCH"), ("unreviewed shot", "SHOT_ALIGNMENT_UNREVIEWED"), ("Cancelled", "WORKER_CANCELLED"), ("no observable editable", "NO_EDITABLE_SKIN")]
        code = next((code for needle, code in codes if needle in reason), "CALIBRATION_REQUIRED")
        side = "target" if stage.startswith("target") else "source" if stage.startswith("source") else None
        if reason.startswith("Target"):
            side = "target"
        elif reason.startswith("Source"):
            side = "source"
        result["riskFrames"].append({"id": str(frame) + ":" + reason, "targetFrame": frame, "sourceFrame": pair.get("sourceFrame") if pair else None, "reason": reason, "code": code, "side": side, "resolved": False, "details": details})
    source_reader = base_reader = detector = None
    try:
        check_cancel(cancel)
        source_reader = VideoReader(request["sourceVideo"], maximum, cancel)
        base_reader = VideoReader(request["baseVideo"], maximum, cancel)
        detector = detector_factory(request["runtime"])
        if request["action"] == "analyse":
            # Samples, rather than claiming exhaustive long-video visibility review.
            sample_count = min(len(pairs), int(request.get("analysisSampleLimit", 120)))
            indices = sorted(set(np.linspace(0, len(pairs) - 1, sample_count, dtype=int).tolist()))
            records = []
            for processed, index in enumerate(indices):
                check_cancel(cancel)
                pair = pairs[index]
                row = {**pair, "coordinateSpaces": {"source": list(source_reader.size), "target": list(base_reader.size)}, "landmarksAreNotVisibility": True}
                for side, reader, field in (("source", source_reader, "sourceFrame"), ("target", base_reader, "targetFrame")):
                    try:
                        image = reader.get(pair[field])
                        found = detect(detector, image, pair[field])
                        row[side] = {"faces": [p.tolist() for p in found["faces"]], "hands": [p.tolist() for p in found["hands"]], "pointVisibility": None}
                        output = directory / "analysis" / (side + "_%08d.png" % pair[field])
                        save_png(output, image)
                        row[side]["image"] = str(output)
                    except CalibrationError as error:
                        risk(str(error), pair)
                path = directory / "analysis" / ("frame_%08d.json" % pair["targetFrame"])
                atomic_json(path, row)
                records.append({"targetFrame": pair["targetFrame"], "file": str(path)})
                progress({"phase": "analyse", "processedFrames": processed + 1, "totalFrames": len(indices)})
            result["artifacts"]["analysis"] = records
            result["checks"]["sampledFrames"] = len(indices)
            result["artifacts"]["requiredCalibration"] = ["sourceRegion", "targetRegion", "sourceSkinPoints", "reviewed handKeyframes for both sides", "reviewed shot coverage", "reviewed targetSkin donor"]
            return result

        material_pairs = [p for p in pairs if (shot_for_target(calibration, p["targetFrame"]) or {}).get("mode", "material") == "material"]
        anchor = calibration.get("anchorPair") or (material_pairs[0] if material_pairs else pairs[0])
        source_region = source_samples = target_region = target_samples = []
        source_templates = []
        if material_pairs:
            anchor_shot = shot_for_target(calibration, anchor["targetFrame"])
            if anchor_shot and (anchor_shot.get("mode", "material") != "material" or not anchor_shot["sourceStartFrame"] <= anchor["sourceFrame"] < anchor_shot["sourceStartFrame"] + anchor_shot["sourceFrames"]):
                raise CalibrationError("Calibration anchorPair must lie within the same material shot")
            source_ref = source_reader.get(anchor["sourceFrame"])
            source_geometry = detect(detector, source_ref, anchor["sourceFrame"])["faces"][0]
            source_region = bind_points(source_geometry, pixels(calibration["sourceRegion"], source_reader.size), source_reader.size)
            source_samples = bind_points(source_geometry, pixels(calibration["sourceSkinPoints"], source_reader.size), source_reader.size)
            source_templates = prepare_templates(request, "source", source_reader, detector)
        donor = donor_geometry = None
        if material_pairs or calibration.get("postCutCleanup"):
            target_ref = base_reader.get(anchor["targetFrame"])
            target_geometry = detect(detector, target_ref, anchor["targetFrame"])["faces"][0]
            if material_pairs:
                target_region = bind_points(target_geometry, pixels(calibration["targetRegion"], base_reader.size), base_reader.size)
            target_samples = bind_points(target_geometry, pixels(calibration.get("targetSkinPoints", []), base_reader.size), base_reader.size)
            target_templates = prepare_templates(request, "target", base_reader, detector)
            if request.get("targetSkin"):
                donor = read_image(request["targetSkin"]["file"])
                ds = processing_size(donor.shape[1], donor.shape[0], maximum)
                if ds != (donor.shape[1], donor.shape[0]):
                    donor = cv2.resize(donor, ds, interpolation=cv2.INTER_AREA)
                donor_geometry = detect(detector, donor, -1)["faces"][0]
        else:
            target_templates = []
        cleanup_bindings, cleanup_donors = {}, {}
        for i, cleanup in enumerate(calibration.get("postCutCleanup", [])):
            frame = cleanup.get("anchorFrame", cleanup["targetStartFrame"])
            image = base_reader.get(frame)
            face = detect(detector, image, frame)["faces"][0]
            cleanup_bindings[i] = bind_points(face, pixels(cleanup["region"], base_reader.size), base_reader.size)
            if cleanup.get("donorFrameIndex") is not None:
                reference = base_reader.get(cleanup["donorFrameIndex"])
                reference_face = detect(detector, reference, cleanup["donorFrameIndex"])["faces"][0]
                cleanup_donors[i] = (reference, reference_face)
        material_candidate_bindings = []
        for keyframe in calibration.get("targetMaterialKeyframes", []):
            image = base_reader.get(keyframe["frameIndex"])
            face = detect(detector, image, keyframe["frameIndex"])["faces"][0]
            bindings = bind_points(face, pixels(keyframe["region"], base_reader.size), base_reader.size)
            material_candidate_bindings.append((keyframe["frameIndex"], shot_for_target(calibration, keyframe["frameIndex"]), bindings))
        thin_ref = thin_geometry = thin_hand = None
        if material_pairs and request.get("sourceSkinReference"):
            n = request["sourceSkinReference"]["frameIndex"]
            thin_ref = source_reader.get(n)
            td = detect(detector, thin_ref, n)
            thin_geometry = td["faces"][0]
            thin_shot = next((s for s in calibration.get("shots", []) if s.get("mode", "material") == "material" and s["sourceStartFrame"] <= n < s["sourceStartFrame"] + s["sourceFrames"]), None)
            thin_hand, _ = independent_mask(thin_ref, td, templates_for_shot(source_templates, thin_shot, "source"), detector.hand_edges, source_reader.fps)
            margin = max(1, round(min(source_reader.size) * hand_margin))
            thin_hand = cv2.dilate(thin_hand, np.ones((margin * 2 + 1, margin * 2 + 1), np.uint8))
            if td["hands"]:
                thin_hand = cv2.bitwise_or(thin_hand, material_finger_guard(td["hands"][0], detector.hand_edges, source_reader.size, hand_margin))

        reconstruction_config = request.get("processing", {}).get("sourceOcclusionReconstruction") or {}
        occlusion_enabled = isinstance(reconstruction_config, dict) and reconstruction_config.get("enabled") is True
        appearance_config = request.get("processing", {}).get("appearanceReconstruction") or {}
        appearance_enabled = isinstance(appearance_config, dict) and appearance_config.get("enabled") is True
        if appearance_enabled and appearance_config.get("method") != appearance.METHOD:
            raise CalibrationError("appearanceReconstruction.method must be " + appearance.METHOD)
        # CPU memory and the evidence window are bounded independently of video length.
        window_frames = min(12, max(1, int(np.floor(source_reader.fps * .3))))
        observation_cache = OrderedDict()
        def source_observation(frame, shot):
            observation_key = (shot["sourceStartFrame"], shot["sourceFrames"], frame)
            if observation_key in observation_cache:
                observation_cache.move_to_end(observation_key)
                entry = observation_cache[observation_key]
                if "error" in entry:
                    raise entry["error"]
                return entry
            try:
                check_cancel(cancel)
                image = source_reader.get(frame)
                detection = detect(detector, image, frame)
                face = detection["faces"][0]
                hand, hand_stats = independent_mask(image, detection, templates_for_shot(source_templates, shot, "source"), detector.hand_edges, source_reader.fps)
                if source_templates and not detection["hands"]:
                    raise CalibrationError("Source hand detection lost in calibrated action")
                margin = max(1, round(min(source_reader.size) * hand_margin))
                kernel = np.ones((margin * 2 + 1, margin * 2 + 1), np.uint8)
                uncertainty = cv2.dilate(hand, kernel)
                if detection["hands"]:
                    uncertainty = cv2.bitwise_or(uncertainty, material_finger_guard(detection["hands"][0], detector.hand_edges, source_reader.size, hand_margin))
                uncertainty_band = uncertainty - cv2.erode(hand, kernel)
                features = feature_mask(face, detector.components, source_reader.size)
                roi = polygon_mask(follow_points(source_region, face), source_reader.size) > 0
                visible = roi & (uncertainty == 0) & (features == 0)
                exclusion = np.uint8((uncertainty > 0) | (features > 0)) * 255
                points = follow_points(source_samples, face)
                reference_hand = np.zeros(image.shape[:2], np.uint8)
                stage = "source_current_bare_skin_plane"
                if thin_ref is not None:
                    stage = "source_current_vs_thin_reference_photometry"
                    if not shot["sourceStartFrame"] <= request["sourceSkinReference"]["frameIndex"] < shot["sourceStartFrame"] + shot["sourceFrames"]:
                        raise CalibrationError("Thin source reference belongs to a different shot")
                    baseline, baseline_valid = dense_warp(thin_ref, thin_geometry, face, source_reader.size)
                    reference_hand, _ = dense_warp(thin_hand, thin_geometry, face, source_reader.size, nearest=True)
                    visible &= (baseline_valid > 0) & (reference_hand < 1)
                    exclusion[reference_hand > 0] = 255
                    baseline, skin_stats = correction_plane(baseline, image, points, exclusion)
                else:
                    baseline, skin_stats = skin_plane(image, points, exclusion)
                if np.mean(skin_stats["rmseBGR"]) > 24:
                    raise CalibrationError("Bare-skin baseline has excessive same-frame colour error")
                residual, signal = material_residual(image, baseline, visible)
                entry = {"frame": frame, "face": face, "hand": hand, "uncertainty": uncertainty,
                         "uncertaintyBand": uncertainty_band, "referenceHand": reference_hand > 0,
                         "visible": visible, "residual": residual, "signal": signal,
                         "skinStats": skin_stats, "handStats": hand_stats,
                         "credible": hand_stats.get("medianJointErrorPx", 0) <= min(source_reader.size) * .045}
                if appearance_enabled:
                    entry["appearanceResidual"], entry["appearanceConfidence"] = continuous_material_residual(image, baseline, visible)
            except CalibrationError as error:
                error.details = {"stage": locals().get("stage", "source_current_geometry"), **error.details}
                entry = {"frame": frame, "error": error}
            observation_cache[observation_key] = entry
            while len(observation_cache) > (2 * max(window_frames if occlusion_enabled else 0, appearance.WINDOW_FRAMES if appearance_enabled else 0) + 1):
                observation_cache.popitem(last=False)
            if "error" in entry:
                raise entry["error"]
            return entry

        checkpoint_path = directory / "checkpoint.json"
        # Only server-hash-bound, atomically committed frame records can resume.
        completed = []
        if checkpoint_path.exists():
            checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
            if checkpoint.get("cacheKey") == key:
                for record in checkpoint.get("frames", []):
                    path = owned_path(record["file"], directory)
                    if path.exists() and sha_file(path) == record.get("sha256"):
                        completed.append(record)
                    else:
                        break
        result["checks"]["calibrated"] = True
        by_frame = {f["targetFrame"]: f for f in completed}
        for processed, pair in enumerate(pairs):
            check_cancel(cancel)
            if pair["targetFrame"] in by_frame:
                record = by_frame[pair["targetFrame"]]
                result["artifacts"]["frames"].append(record)
                result["checks"]["editablePixels"] += record.get("editablePixels", 0)
                for item in record.get("risks", []):
                    result["riskFrames"].append(item)
                progress({"phase": "resume", "processedFrames": processed + 1, "totalFrames": len(pairs)})
                continue
            frame_risk_start = len(result["riskFrames"])
            hand_file = uncertainty_file = None
            candidate_file = support_path = editable_file = None
            measured_file = temporal_file = spatial_file = remaining_file = evidence_file = None
            reconstruction_summary = None
            target_colour_stats = None
            appearance_result = None
            appearance_files = {}
            footprint_stats = None
            cleanup_boundary_file = None
            cleanup_boundary_summary = None
            processing_stage = "target_geometry"
            base = base_reader.get(pair["targetFrame"])
            final = base.copy()
            editable = np.zeros(base.shape[:2], bool)
            native_editable = np.zeros((request["baseVideo"]["height"], request["baseVideo"]["width"]), bool)
            try:
                shot = shot_for_target(calibration, pair["targetFrame"])
                cleanup_index = next((i for i, c in enumerate(calibration.get("postCutCleanup", [])) if c["targetStartFrame"] <= pair["targetFrame"] < c["targetStartFrame"] + c["targetFrames"]), None)
                cleanup = calibration.get("postCutCleanup", [])[cleanup_index] if cleanup_index is not None else None
                if shot and shot.get("mode", "material") == "preserve" and not cleanup:
                    # Explicitly reviewed preservation is intentional, never unknown fallback.
                    final = base.copy()
                    raise _PreserveFrame()
                target_detection = detect(detector, base, pair["targetFrame"])
                target_face = target_detection["faces"][0]
                shot_target_templates = templates_for_shot(target_templates, shot, "target")
                target_hand, th_stats = independent_mask(base, target_detection, shot_target_templates, detector.hand_edges, base_reader.fps)
                if target_templates and not target_detection["hands"]:
                    raise CalibrationError("Target hand detection lost in calibrated action")
                target_features = feature_mask(target_face, detector.components, base_reader.size)
                target_roi = polygon_mask(follow_points(target_region, target_face), base_reader.size) > 0 if target_region else np.zeros(base.shape[:2], bool)
                if cleanup:
                    target_roi = polygon_mask(follow_points(cleanup_bindings[cleanup_index], target_face), base_reader.size) > 0
                if not cleanup and (not shot or not shot["sourceStartFrame"] <= pair["sourceFrame"] < shot["sourceStartFrame"] + shot["sourceFrames"]):
                    raise CalibrationError("Frame correspondence crosses an unreviewed shot/cut")
                selected_donor, selected_geometry = cleanup_donors.get(cleanup_index, (donor, donor_geometry))
                clean, donor_valid = dense_warp(selected_donor, selected_geometry, target_face, base_reader.size)
                surface = target_roi & (target_hand == 0) & (target_features == 0)
                points = follow_points(target_samples, target_face)
                if len(points) >= 4:
                    processing_stage = "target_donor_photometry"
                    # These are explicitly reviewed bare-skin samples. A surface
                    # ROI can contain bare skin, so it is not itself an exclusion.
                    exclusion = np.uint8((target_hand > 0) | (target_features > 0)) * 255
                    clean, target_colour_stats = target_donor_correction(clean, base, points, exclusion, surface & (donor_valid > 0))
                if cleanup:
                    old_candidate = surface.copy()
                else:
                    manual_candidates = [entry for entry in material_candidate_bindings if entry[1] is shot]
                    if manual_candidates:
                        _, _, bindings = min(manual_candidates, key=lambda entry: abs(entry[0] - pair["targetFrame"]))
                        old_candidate = (polygon_mask(follow_points(bindings, target_face), base_reader.size) > 0) & surface
                        if appearance_enabled:
                            cue = observed_target_candidate(base, clean, surface & (donor_valid > 0))
                            old_candidate, footprint_stats = connected_material_rim(old_candidate, cue, surface)
                    else:
                        old_candidate = observed_target_candidate(base, clean, surface & (donor_valid > 0))
                editable = old_candidate & (donor_valid > 0)
                if np.any(old_candidate & (donor_valid == 0)):
                    raise CalibrationError("Target visible material candidate has no donor support")
                candidate_file = directory / "materialMasks" / ("old_candidate_%08d.png" % pair["targetFrame"])
                save_png(candidate_file, np.uint8(old_candidate) * 255)
                delta_target = np.zeros_like(clean)
                if not cleanup:
                    processing_stage = "source_current_geometry"
                    observation = source_observation(pair["sourceFrame"], shot)
                    source_face, source_hand = observation["face"], observation["hand"]
                    source_uncertainty_band = observation["uncertaintyBand"]
                    sh_stats = observation["handStats"]
                    hand_file = directory / "sourceSupport" / ("hand_%08d.png" % pair["sourceFrame"])
                    uncertainty_file = directory / "sourceSupport" / ("hand_uncertainty_%08d.png" % pair["sourceFrame"])
                    save_png(hand_file, source_hand)
                    save_png(uncertainty_file, source_uncertainty_band)
                    mapped_visible, _ = dense_warp(np.uint8(observation["visible"]) * 255, source_face, target_face, base_reader.size, nearest=True)
                    mapped_signal, _ = dense_warp(np.uint8(observation["signal"]) * 255, source_face, target_face, base_reader.size, nearest=True)
                    delta_target, _ = dense_warp(observation["residual"], source_face, target_face, base_reader.size)
                    raw_current_residual = delta_target.copy() if appearance_enabled else None
                    current_residual = current_confidence = None
                    if appearance_enabled:
                        current_residual, _ = dense_warp(observation["appearanceResidual"], source_face, target_face, base_reader.size)
                        current_confidence, _ = dense_warp(observation["appearanceConfidence"], source_face, target_face, base_reader.size)
                    # Surface is tracking/calibration, not a request to replace bare skin.
                    editable = (old_candidate | (mapped_signal > 250)) & surface & (donor_valid > 0)
                    measured_visible = mapped_visible > 250
                    effective_visible = measured_visible.copy()
                    measured_file = directory / "sourceSupport" / ("current_measured_%08d.png" % pair["targetFrame"])
                    save_png(measured_file, np.uint8(measured_visible) * 255)
                    neighbours, appearance_neighbours, skipped_evidence = [], [], []
                    if (occlusion_enabled or appearance_enabled) and observation["credible"]:
                        neighbour_window = max(window_frames if occlusion_enabled else 0, appearance.WINDOW_FRAMES if appearance_enabled else 0)
                        start = max(shot["sourceStartFrame"], pair["sourceFrame"] - neighbour_window)
                        end = min(shot["sourceStartFrame"] + shot["sourceFrames"] - 1, pair["sourceFrame"] + neighbour_window)
                        for evidence_frame in range(start, end + 1):
                            if evidence_frame == pair["sourceFrame"]:
                                continue
                            check_cancel(cancel)
                            try:
                                adjacent = source_observation(evidence_frame, shot)
                                if not adjacent["credible"]:
                                    skipped_evidence.append({"sourceFrame": evidence_frame, "reason": "Hand geometry is not credible evidence"})
                                    continue
                                seen, _ = dense_warp(np.uint8(adjacent["visible"]) * 255, adjacent["face"], target_face, base_reader.size, nearest=True)
                                residual, _ = dense_warp(adjacent["residual"], adjacent["face"], target_face, base_reader.size)
                                neighbours.append({"frame": evidence_frame, "visible": seen > 250, "residual": residual, "credible": True})
                                if appearance_enabled:
                                    material, _ = dense_warp(adjacent["appearanceResidual"], adjacent["face"], target_face, base_reader.size)
                                    appearance_neighbours.append({"frame": evidence_frame, "visible": seen > 250, "residual": material, "credible": True})
                            except CalibrationError as error:
                                skipped_evidence.append({"sourceFrame": evidence_frame, "reason": str(error), "details": error.details})
                        eye_centres = []
                        for name in ("left_eye", "right_eye"):
                            ids = sorted(set(i for edge in detector.components.get(name, []) for i in edge))
                            if ids:
                                eye_centres.append(target_face[ids].mean(axis=0))
                        if len(eye_centres) != 2:
                            raise CalibrationError("Tracked eyes are required for bounded contact reconstruction")
                        eye_distance = float(np.linalg.norm(eye_centres[0] - eye_centres[1]))
                    if occlusion_enabled and observation["credible"]:
                        processing_stage = "source_short_occlusion_reconstruction"
                        mapped_hand, _ = dense_warp(observation["uncertainty"], source_face, target_face, base_reader.size, nearest=True)
                        mapped_reference_hand, _ = dense_warp(np.uint8(observation["referenceHand"]) * 255, source_face, target_face, base_reader.size, nearest=True)
                        reconstructed = reconstruct(pair["sourceFrame"], measured_visible, delta_target, mapped_hand > 0, mapped_reference_hand > 0, editable, neighbours, float(np.linalg.norm(eye_centres[0] - eye_centres[1])), window_frames)
                        delta_target, effective_visible = reconstructed["residual"], reconstructed["effectiveSupport"]
                        reconstruction_summary = {**reconstructed["summary"], "windowSeconds": window_frames / source_reader.fps, "skippedEvidenceFrames": skipped_evidence, "sourceShot": {"startFrame": shot["sourceStartFrame"], "frames": shot["sourceFrames"]}}
                        evidence_pairs = []
                        infer_mask = reconstructed["inferredTemporal"]
                        if np.any(infer_mask):
                            pair_values = np.stack([reconstructed["previousSourceFrame"][infer_mask], reconstructed["nextSourceFrame"][infer_mask]], axis=1)
                            unique_pairs, counts = np.unique(pair_values, axis=0, return_counts=True)
                            for (previous_frame, next_frame), count in zip(unique_pairs, counts):
                                mask = infer_mask & (reconstructed["previousSourceFrame"] == previous_frame) & (reconstructed["nextSourceFrame"] == next_frame)
                                evidence_pairs.append({"previousSourceFrame": int(previous_frame), "nextSourceFrame": int(next_frame), "sourceSeconds": [float(previous_frame / source_reader.fps), float(next_frame / source_reader.fps)], "pixels": int(count), "meanDifferenceBGR": float(np.mean(reconstructed["twoSidedDifferenceBGR"][mask]))})
                        reconstruction_summary["evidenceFramePairs"] = evidence_pairs
                        prefix = directory / "sourceSupport"
                        support_path = measured_file
                        temporal_file = prefix / ("inferred_temporal_%08d.png" % pair["targetFrame"])
                        spatial_file = prefix / ("inferred_spatial_%08d.png" % pair["targetFrame"])
                        remaining_file = prefix / ("remaining_unknown_%08d.png" % pair["targetFrame"])
                        for file, mask in ((support_path, measured_visible), (temporal_file, reconstructed["inferredTemporal"]), (spatial_file, reconstructed["inferredSpatial"]), (remaining_file, reconstructed["remainingUnknown"])):
                            save_png(file, np.uint8(mask) * 255)
                        evidence_file = prefix / ("inference_evidence_%08d.npz" % pair["targetFrame"])
                        buffer = io.BytesIO()
                        np.savez_compressed(buffer, previousSourceFrame=reconstructed["previousSourceFrame"], nextSourceFrame=reconstructed["nextSourceFrame"], twoSidedDifferenceBGR=reconstructed["twoSidedDifferenceBGR"], inferredTemporal=reconstructed["inferredTemporal"], inferredSpatial=reconstructed["inferredSpatial"], currentMeasured=measured_visible, spatialVariabilityBGR=reconstructed["spatialVariabilityBGR"])
                        atomic_bytes(evidence_file, buffer.getvalue())
                    if appearance_enabled and shot.get("mode", "material") == "material":
                        processing_stage = "source_artistic_appearance_reconstruction"
                        if not observation["credible"]:
                            raise CalibrationError("Source hand geometry is not credible for artistic appearance reconstruction")
                        reviewed_region = np.zeros(base.shape[:2], bool)
                        for keyframe in calibration.get("appearanceKeyframes", []):
                            if keyframe["frameIndex"] == pair["targetFrame"]:
                                if keyframe.get("reviewed") is not True:
                                    raise CalibrationError("Appearance keyframe must be explicitly reviewed")
                                reviewed_region |= polygon_mask(pixels(keyframe["region"], base_reader.size), base_reader.size) > 0
                        reconstruction_surface = target_roi & (target_features == 0) & (donor_valid > 0)
                        whole_face_area = np.count_nonzero(polygon_mask(cv2.convexHull(target_face).reshape(-1, 2), base_reader.size))
                        # Only the opt-in appearance branch renders continuous
                        # same-frame material confidence. Raw observations and
                        # strict occlusion evidence above stay separately saved.
                        delta_target[measured_visible] = current_residual[measured_visible]
                        appearance_result = appearance.reconstruct(pair["sourceFrame"], measured_visible, current_residual,
                            delta_target, effective_visible, editable, reviewed_region, reconstruction_surface,
                            target_hand > 0, appearance_neighbours, eye_distance, whole_face_area,
                            (shot["sourceStartFrame"], shot["sourceFrames"]))
                        appearance_result["summary"]["skippedEvidenceFrames"] = skipped_evidence
                        appearance_result["summary"]["materialFootprint"] = footprint_stats
                        appearance_result["summary"]["spatialCompositor"] = {"method": "interior-distance-feather", "radiusShortEdgeFraction": .0125, "timeFade": False}
                        appearance_result["summary"]["materialConfidence"] = {"method": "continuous-whitening-confidence-v1", "rawLuminanceCriterion": 6, "rawChromaCriterion": .018, "fullConfidenceLuminance": 12, "fullConfidenceChroma": .036, "rawBinaryEvidenceRetained": True, "sourceVisiblePixels": int(observation["visible"].sum()), "sourceRawSignalPixels": int(observation["signal"].sum()), "timeFade": False, "outputBlur": False}
                        # Compose the original strict result first; artistic patches
                        # are applied later with their own fixed spatial feather.
                        strict_delta = delta_target.copy()
                        strict_delta[~effective_visible] = 0
                        strict_final = compose_local(base, clean, strict_delta, editable, distance_feather=True)
                        delta_target = appearance_result["residual"]
                        effective_visible = appearance_result["effectiveSupport"]
                        editable = appearance_result["editable"]
                        prefix = directory / "appearanceReconstruction"
                        for field in ("requestedPatch", "acceptedPatch", "reviewedRegion", "currentMeasured", "timeInferredBoundary", "timeInferredPatch", "harmonicInferred", "remainingUnknown", "rejectedPatch", "oldHandOverride"):
                            path = prefix / (field + "_%08d.png" % pair["targetFrame"])
                            save_png(path, np.uint8(appearance_result[field]) * 255)
                            appearance_files[field + "File"] = str(path)
                        path = prefix / ("evidence_%08d.npz" % pair["targetFrame"])
                        buffer = io.BytesIO()
                        np.savez_compressed(buffer, **{name: value for name, value in appearance_result.items() if isinstance(value, np.ndarray)}, currentObservedResidualBGR=raw_current_residual, currentAppearanceResidualBGR=current_residual, targetMaterialConfidence=current_confidence, sourceRawBinarySignal=observation["signal"], oldTargetHand=target_hand > 0, protectedFeatures=target_features > 0, targetROI=target_roi)
                        atomic_bytes(path, buffer.getvalue())
                        appearance_files["evidenceFile"] = str(path)
                        # A failed optional automatic attempt remains unknown
                        # and is judged by the original 8% support gate. A
                        # specifically reviewed repair that failed is unmet work.
                        if appearance_result["summary"]["rejectedReviewedPixels"]:
                            risk("Artistic appearance component exceeds bounds or lacks trustworthy residual evidence", pair, {"stage": processing_stage, "appearanceReconstruction": appearance_result["summary"]})
                        if remaining_file:
                            save_png(remaining_file, np.uint8(appearance_result["remainingUnknown"]) * 255)
                    unsupported = editable & ~effective_visible
                    unsupported_count = int(np.count_nonzero(unsupported))
                    if unsupported_count > max(4, .08 * np.count_nonzero(editable)):
                        result["checks"]["lowSupportCount"] += 1
                        support_path = directory / "sourceSupport" / ("mapped_visible_%08d.png" % pair["targetFrame"])
                        unsupported_path = directory / "sourceSupport" / ("unsupported_target_%08d.png" % pair["targetFrame"])
                        save_png(support_path, np.uint8(mapped_visible))
                        save_png(unsupported_path, np.uint8(unsupported) * 255)
                        risk("Visible target region has unsupported source skin/material; diagnostic clean preview is unknown", pair, {"stage": "source_surface_support", "unsupportedPixels": unsupported_count, "editablePixels": int(np.count_nonzero(editable)), "unsupportedFraction": float(unsupported_count / max(1, np.count_nonzero(editable))), "currentMeasuredUnsupportedPixels": int(np.count_nonzero(editable & ~measured_visible)), "reconstruction": reconstruction_summary, "mappedSourceVisibilityFile": str(support_path), "unsupportedTargetFile": str(unsupported_path)})
                    delta_target[~effective_visible] = 0
                    if sh_stats.get("medianJointErrorPx", 0) > min(source_reader.size) * .045:
                        risk("Source hand geometry requires boundary calibration", pair)
                if th_stats.get("medianJointErrorPx", 0) > min(base_reader.size) * .045:
                    risk("Target hand geometry requires boundary calibration", pair)
                final = appearance.compose(strict_final, clean, delta_target, appearance_result["acceptedPatch"], appearance_result["spatialFeather"]) if appearance_result is not None else compose_local(base, clean, delta_target, editable)
                if cleanup and appearance_enabled and cleanup.get("donorFrameIndex") is not None:
                    final, border_mask, cleanup_boundary_summary = appearance.refine_cleanup_border(final, target_roi, target_hand > 0, target_features > 0)
                    editable |= border_mask
                    cleanup_boundary_file = directory / "cleanupBoundary" / ("inferred_border_%08d.png" % pair["targetFrame"])
                    save_png(cleanup_boundary_file, np.uint8(border_mask) * 255)
                if appearance_result is not None:
                    appearance_result["summary"]["oldHandChangedPixels"] = int(np.count_nonzero(np.any(final != base, axis=2) & (target_hand > 0)))
                    appearance_result["summary"]["protectedOldHandChangedPixels"] = int(np.count_nonzero(np.any(final != base, axis=2) & (target_hand > 0) & ~appearance_result["oldHandOverride"]))
                    appearance_result["summary"]["featureChangedPixels"] = int(np.count_nonzero(np.any(final != base, axis=2) & (target_features > 0)))
                editable_file = directory / "materialMasks" / ("editable_%08d.png" % pair["targetFrame"])
                save_png(editable_file, np.uint8(editable) * 255)
            except _PreserveFrame:
                pass
            except CalibrationError as error:
                result["checks"]["lowSupportCount"] += 1
                risk(str(error), pair, {"stage": processing_stage, **error.details})
                # This retained base is diagnostic failure evidence, never ready.
                final = base.copy()
            if base_reader.size != base_reader.native_size:
                native_reader = VideoReader(request["baseVideo"], max(base_reader.native_size), cancel)
                try:
                    native = native_reader.get(pair["targetFrame"])
                finally:
                    native_reader.close()
                changed = cv2.resize(final, base_reader.native_size, interpolation=cv2.INTER_CUBIC)
                native_editable = cv2.resize(np.uint8(editable), base_reader.native_size, interpolation=cv2.INTER_NEAREST) > 0
                final = native.copy()
                final[native_editable] = changed[native_editable]
            else:
                native, native_editable = base, editable
            changed_outside = int(np.count_nonzero(np.any(final != native, axis=2) & ~native_editable))
            result["checks"]["changedOutsideEditablePixels"] += changed_outside
            file = directory / "frames" / ("frame_%08d.png" % pair["targetFrame"])
            save_png(file, final)
            editable_count = int(np.count_nonzero(native_editable))
            result["checks"]["editablePixels"] += editable_count
            record = {"targetFrame": pair["targetFrame"], "sourceFrame": pair["sourceFrame"], "file": str(file), "sha256": sha_file(file), "risks": result["riskFrames"][frame_risk_start:], "editablePixels": editable_count, "oldMaterialCandidateFile": str(candidate_file) if candidate_file else None, "editableMaskFile": str(editable_file) if editable_file else None, "targetMaterialCandidateIsGroundTruth": False, "sourceHandBoundaryMarginNormalized": hand_margin, "sourceHandFile": str(hand_file) if hand_file else None, "sourceHandUncertaintyFile": str(uncertainty_file) if uncertainty_file else None, "sourceMeasuredSupportFile": str(measured_file) if measured_file else None, "inferredTemporalFile": str(temporal_file) if temporal_file else None, "inferredSpatialFile": str(spatial_file) if spatial_file else None, "remainingUnknownFile": str(remaining_file) if remaining_file else None, "reconstructionEvidenceFile": str(evidence_file) if evidence_file else None, "reconstruction": reconstruction_summary, "targetColourCorrection": target_colour_stats}
            if appearance_result is not None:
                record["appearanceReconstruction"] = appearance_result["summary"]
                record["appearanceArtifacts"] = appearance_files
            if cleanup_boundary_summary is not None:
                record["cleanupBoundaryReconstruction"] = cleanup_boundary_summary
                record["cleanupBoundaryFile"] = str(cleanup_boundary_file)
            result["artifacts"]["frames"].append(record)
            atomic_json(checkpoint_path, {"cacheKey": key, "frames": result["artifacts"]["frames"], "resumeRecommendation": "Re-run exact immutable request after reviewing risks; never reuse across calibration/model/input hash changes."})
            progress({"phase": "render", "processedFrames": processed + 1, "totalFrames": len(pairs), "targetFrame": pair["targetFrame"], "riskCount": len(result["riskFrames"])})
        result["frames"] = result["artifacts"]["frames"]
        diagnostics = []
        for record in result["frames"]:
            for field, kind, side, label in [("oldMaterialCandidateFile", "target_material_candidate", "target", "Old material candidate, diagnostic"), ("editableMaskFile", "target_editable", "target", "Local editable mask"), ("sourceHandFile", "source_hand_exclusion", "source", "Source hand anatomy exclusion"), ("sourceHandUncertaintyFile", "source_hand_uncertainty", "source", "Source hand/nail uncertainty exclusion"), ("sourceMeasuredSupportFile", "source_measured_support", "target", "Current source observation in target UV"), ("inferredTemporalFile", "material_inferred_temporal", "target", "Inferred from two-sided observed evidence"), ("inferredSpatialFile", "material_inferred_spatial", "target", "Bounded spatial material reconstruction"), ("remainingUnknownFile", "material_remaining_unknown", "target", "Material appearance still unknown")]:
                file = record.get(field)
                if file and Path(file).exists():
                    diagnostics.append({"kind": kind, "name": label, "frameIndex": record["sourceFrame" if side == "source" else "targetFrame"], "side": side, "file": file, "sha256": sha_file(file), "isGroundTruth": False})
        result["artifacts"]["diagnostics"] = diagnostics
        for record in result["frames"]:
            if record.get("cleanupBoundaryFile"):
                file = record["cleanupBoundaryFile"]
                diagnostics.append({"kind": "cleanup_boundary_inference", "name": "Same-frame cleanup border inference", "frameIndex": record["targetFrame"], "side": "target", "file": file, "sha256": sha_file(file), "isGroundTruth": False})
        if appearance_enabled:
            result["artifacts"]["appearanceReconstruction"] = {"enabled": True, "method": appearance.METHOD, "isGroundTruth": False, "windowFrames": appearance.WINDOW_FRAMES, "currentMeasuredSupportUnchanged": True, "temporalFade": False, "sourceActorRGBPaste": False, "unknownGateFraction": .08, "oldHandMaskMayBeOverriddenOnlyInsideExactFrameReviewedRegions": True}
            for record in result["frames"]:
                for field, file in record.get("appearanceArtifacts", {}).items():
                    if field.endswith("File") and field != "evidenceFile" and Path(file).exists():
                        diagnostics.append({"kind": "appearance_" + field[:-4], "name": "Artistic appearance " + field[:-4], "frameIndex": record["targetFrame"], "side": "target", "file": file, "sha256": sha_file(file), "isGroundTruth": False})
        result["artifacts"]["sourceOcclusionReconstruction"] = {"enabled": occlusion_enabled, "method": OCCLUSION_METHOD, "isGroundTruth": False, "windowSecondsMaximum": .3, "currentMeasuredSupportUnchanged": True, "temporalFade": False, "sourceActorRGBPaste": False, "unknownGateFraction": .08}
        result["artifacts"]["frameSequence"] = {"directory": str(directory / "frames"), "startFrame": pairs[0]["targetFrame"], "frames": len(pairs), "width": request["baseVideo"]["width"], "height": request["baseVideo"]["height"], "fps": request["baseVideo"]["fps"], "audio": "none; Node must reuse base audio and outer picture"}
        if result["checks"]["editablePixels"] == 0:
            risk("Selected region has no observable editable skin; no repair can be assessed")
        if not result["riskFrames"] and result["checks"]["lowSupportCount"] == 0 and result["checks"]["changedOutsideEditablePixels"] == 0:
            result["status"] = "preview_ready"
        atomic_json(directory / "manifest.json", result)
        return result
    except Cancelled:
        result["cancelled"] = True
        risk("Cancelled; atomic checkpoint may resume only with the same immutable cache key")
        return result
    finally:
        for obj in (source_reader, base_reader, detector):
            if obj is not None:
                obj.close()
