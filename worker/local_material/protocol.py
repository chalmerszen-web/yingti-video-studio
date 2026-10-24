"""JSON protocol and atomic files. No network or provider dependencies."""
import hashlib
import json
import math
import os
from pathlib import Path

ALGORITHM_VERSION = "local-material-worker-1"

class CalibrationError(ValueError):
    def __init__(self, message, details=None):
        super().__init__(message)
        self.details = details or {}

class Cancelled(Exception):
    pass

def check_cancel(path):
    if path and Path(path).exists():
        raise Cancelled("Cancellation flag exists")

def sha_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def atomic_bytes(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".part-" + str(os.getpid()))
    try:
        temporary.write_bytes(data)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()

def atomic_json(path, value):
    atomic_bytes(path, json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8"))

def owned_path(path, directory):
    resolved, root = Path(path).resolve(), Path(directory).resolve()
    if not resolved.is_relative_to(root):
        raise CalibrationError("Output must remain inside outputDirectory")
    return resolved

def normalized_points(value, minimum=0, name="points"):
    if not isinstance(value, list) or len(value) < minimum:
        raise CalibrationError(f"{name} needs at least {minimum} points")
    for point in value:
        if not isinstance(point, dict):
            raise CalibrationError(f"{name} points must be objects")
        for axis in ("x", "y"):
            number = point.get(axis)
            if isinstance(number, bool) or not isinstance(number, (float, int)) or not math.isfinite(number) or not 0 <= number <= 1:
                raise CalibrationError(f"{name}.{axis} must be finite normalized coordinates")
    return value

def cache_key(request):
    content = {k: v for k, v in request.items() if k not in ("outputDirectory", "outputClipFile", "cancelFile", "jobId", "requestHash")}
    content["algorithmVersion"] = ALGORITHM_VERSION
    # Calibration/model hashes alone cannot resume outputs from older worker code.
    fingerprint = hashlib.sha256()
    for module in sorted(Path(__file__).parent.glob("*.py")):
        fingerprint.update(module.name.encode())
        fingerprint.update(module.read_bytes())
    content["workerCodeSHA256"] = fingerprint.hexdigest()
    return hashlib.sha256(json.dumps(content, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()

def validate_request(request, verify_files=True):
    if request.get("schemaVersion") != 1 or request.get("action") not in ("analyse", "render"):
        raise CalibrationError("Unsupported schemaVersion or action")
    for role in ("source", "base"):
        video = request.get(role + "Video", {})
        if not Path(video.get("file", "")).is_absolute():
            raise CalibrationError(role + "Video.file must be a server-owned absolute path")
        for field in ("width", "height", "frames"):
            if isinstance(video.get(field), bool) or not isinstance(video.get(field), int) or video[field] < 1:
                raise CalibrationError(role + "Video metadata is invalid")
        fps = video.get("fps")
        if not isinstance(fps, (int, float)) or not math.isfinite(fps) or fps <= 0:
            raise CalibrationError(role + "Video fps is invalid")
        limits = request.get("frameRanges", {}).get("source" if role == "source" else "target", {})
        if any(isinstance(limits.get(k), bool) or not isinstance(limits.get(k), int) for k in ("startFrame", "frames")) or limits["startFrame"] < 0 or limits["frames"] < 1 or limits["startFrame"] + limits["frames"] > video["frames"]:
            raise CalibrationError(role + " frame range exceeds actual video metadata")
        if verify_files and sha_file(video["file"]).lower() != str(video.get("sha256", "")).lower():
            raise CalibrationError(role + " video SHA256 changed")
    directory = request.get("outputDirectory", "")
    if not Path(directory).is_absolute():
        raise CalibrationError("outputDirectory must be absolute")
    if request.get("outputClipFile"):
        owned_path(request["outputClipFile"], directory)
    cal = request.get("calibration") or {}
    material_requested = any(s.get("mode", "material") == "material" for s in cal.get("shots", [])) or not cal.get("shots")
    cleanup_requested = bool(cal.get("postCutCleanup"))
    global_donor_required = material_requested or any(c.get("donorFrameIndex") is None for c in cal.get("postCutCleanup", []))
    for field, minimum in (("sourceRegion", 3), ("targetRegion", 3), ("sourceSkinPoints", 4)):
        if request["action"] == "render" and material_requested:
            normalized_points(cal.get(field), minimum, field)
        elif cal.get(field):
            normalized_points(cal[field], minimum, field)
    normalized_points(cal.get("targetSkinPoints", []), 0, "targetSkinPoints")
    if len(cal.get("handKeyframes", [])) > 120:
        raise CalibrationError("At most120 sparse hand calibration keyframes are supported per request")
    shots = cal.get("shots", [])
    for shot in shots:
        if shot.get("mode", "material") not in ("material", "preserve"):
            raise CalibrationError("Shot mode must be material or preserve")
        for field in ("sourceStartFrame", "sourceFrames", "targetStartFrame", "targetFrames"):
            if isinstance(shot.get(field), bool) or not isinstance(shot.get(field), int) or shot[field] < (0 if field.endswith("StartFrame") else 1):
                raise CalibrationError("Reviewed shot bounds are invalid")
        if shot["sourceStartFrame"] + shot["sourceFrames"] > request["sourceVideo"]["frames"] or shot["targetStartFrame"] + shot["targetFrames"] > request["baseVideo"]["frames"]:
            raise CalibrationError("Reviewed shot exceeds video")
    anchor = cal.get("anchorPair")
    if anchor:
        for field, range_name in (("sourceFrame", "source"), ("targetFrame", "target")):
            bounds = request["frameRanges"][range_name]
            if isinstance(anchor.get(field), bool) or not isinstance(anchor.get(field), int) or not bounds["startFrame"] <= anchor[field] < bounds["startFrame"] + bounds["frames"]:
                raise CalibrationError("Calibration anchorPair exceeds selected frame ranges")
    if request["action"] == "render" and (cal.get("reviewed") is not True or global_donor_required and cal.get("donorReviewed") is not True):
        raise CalibrationError("Render requires reviewed calibration and target-owned donor")
    for keyframe in cal.get("handKeyframes", []):
        if keyframe.get("side") not in ("source", "target") or not isinstance(keyframe.get("frameIndex"), int):
            raise CalibrationError("Hand keyframe side/index is invalid")
        metadata = request["sourceVideo" if keyframe["side"] == "source" else "baseVideo"]
        if not 0 <= keyframe["frameIndex"] < metadata["frames"]:
            raise CalibrationError("Hand keyframe exceeds video")
        for stroke in keyframe.get("strokes", []):
            radius = stroke.get("radius")
            if stroke.get("mode") not in ("protect", "erase") or not isinstance(radius, (float, int)) or not math.isfinite(radius) or not 0 < radius <= 1:
                raise CalibrationError("Hand stroke mode/radius is invalid")
            normalized_points(stroke.get("points"), 1, "hand stroke")
        if keyframe.get("mask"):
            mask = keyframe["mask"]
            if not Path(mask.get("file", "")).is_absolute() or (verify_files and sha_file(mask["file"]).lower() != str(mask.get("sha256", "")).lower()):
                raise CalibrationError("Hand mask path/SHA256 is invalid")
    for candidate in cal.get("targetMaterialKeyframes", []):
        normalized_points(candidate.get("region"), 3, "targetMaterialKeyframes.region")
        index = candidate.get("frameIndex")
        if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < request["baseVideo"]["frames"]:
            raise CalibrationError("Material candidate keyframe must be a real target frame")
        if request["action"] == "render" and candidate.get("reviewed") is not True:
            raise CalibrationError("Material candidate keyframe must be explicitly reviewed")
        if not any(s.get("mode", "material") == "material" and s["targetStartFrame"] <= index < s["targetStartFrame"] + s["targetFrames"] for s in shots):
            raise CalibrationError("Material candidate must belong to a target material shot")
    appearance = request.get("processing", {}).get("appearanceReconstruction")
    if appearance is not None:
        if not isinstance(appearance, dict) or not isinstance(appearance.get("enabled"), bool):
            raise CalibrationError("appearanceReconstruction.enabled must be an explicit boolean")
        if appearance.get("method") != "bounded-material-appearance-v1":
            raise CalibrationError("appearanceReconstruction.method must be bounded-material-appearance-v1")
    appearance_keyframes = cal.get("appearanceKeyframes", [])
    if not isinstance(appearance_keyframes, list) or len(appearance_keyframes) > 120:
        raise CalibrationError("At most120 exact-frame appearance keyframes are supported")
    for keyframe in appearance_keyframes:
        if not isinstance(keyframe, dict):
            raise CalibrationError("Appearance keyframe must be an object")
        normalized_points(keyframe.get("region"), 0, "appearanceKeyframes.region")
        index = keyframe.get("frameIndex")
        if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < request["baseVideo"]["frames"]:
            raise CalibrationError("Appearance keyframe must be a real target frame")
        if request["action"] == "render" and appearance and appearance["enabled"]:
            normalized_points(keyframe.get("region"), 3, "appearanceKeyframes.region")
            if keyframe.get("reviewed") is not True:
                raise CalibrationError("Appearance keyframe must be explicitly reviewed")
            # Shot review belongs to calibration.reviewed in the shared API
            # schema, not an undocumented per-shot reviewed field.
            if cal.get("reviewed") is not True or not any(s.get("mode", "material") == "material" and s["targetStartFrame"] <= index < s["targetStartFrame"] + s["targetFrames"] for s in shots):
                raise CalibrationError("Appearance keyframe must belong to a reviewed target material shot")
    for cleanup in cal.get("postCutCleanup", []):
        normalized_points(cleanup.get("region"), 3, "postCutCleanup.region")
        if request["action"] == "render" and cleanup.get("reviewed") is not True:
            raise CalibrationError("Post-cut cleanup must be explicitly reviewed")
        if not isinstance(cleanup.get("targetStartFrame"), int) or not isinstance(cleanup.get("targetFrames"), int) or cleanup["targetStartFrame"] < 0 or cleanup["targetFrames"] < 1 or cleanup["targetStartFrame"] + cleanup["targetFrames"] > request["baseVideo"]["frames"]:
            raise CalibrationError("Post-cut cleanup exceeds target video")
        if cleanup.get("donorFrameIndex") is not None:
            index = cleanup["donorFrameIndex"]
            if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < request["baseVideo"]["frames"]:
                raise CalibrationError("Post-cut donorFrameIndex must be a real target-video frame")
            shot = next((s for s in shots if s.get("mode", "material") == "preserve" and s["targetStartFrame"] <= index < s["targetStartFrame"] + s["targetFrames"]), None)
            if not shot or not shot["targetStartFrame"] <= cleanup["targetStartFrame"] < cleanup["targetStartFrame"] + cleanup["targetFrames"] <= shot["targetStartFrame"] + shot["targetFrames"]:
                raise CalibrationError("Post-cut donor and cleanup must share the reviewed target preserve shot")
    donor = request.get("targetSkin")
    if request["action"] == "render" and global_donor_required and not donor:
        raise CalibrationError("Render requires targetSkin from the target identity")
    if donor and verify_files and sha_file(donor["file"]).lower() != str(donor.get("sha256", "")).lower():
        raise CalibrationError("Target donor SHA256 changed")
    reference = request.get("sourceSkinReference")
    if reference and material_requested:
        if set(reference) - {"frameIndex", "reviewed"} or not isinstance(reference.get("frameIndex"), int):
            raise CalibrationError("Source skin reference must be an original-video frame, never another actor file")
        if not 0 <= reference["frameIndex"] < request["sourceVideo"]["frames"] or (request["action"] == "render" and reference.get("reviewed") is not True):
            raise CalibrationError("Source skin reference bounds/review invalid")
        if not any(s.get("mode", "material") == "material" and s["sourceStartFrame"] <= reference["frameIndex"] < s["sourceStartFrame"] + s["sourceFrames"] for s in cal.get("shots", [])):
            raise CalibrationError("Source skin reference must belong to a reviewed source shot")
    for name in ("face", "hand"):
        model = request.get("runtime", {}).get("models", {}).get(name, {})
        if not Path(model.get("file", "")).is_absolute() or (verify_files and sha_file(model["file"]).lower() != str(model.get("sha256", "")).lower()):
            raise CalibrationError("Local " + name + " model path/SHA256 is invalid")
    if request["action"] == "render":
        frame_mapping(request)
    return request

def frame_mapping(request):
    limits = request["frameRanges"]
    ss, sf = limits["source"]["startFrame"], limits["source"]["frames"]
    ts, tf = limits["target"]["startFrame"], limits["target"]["frames"]
    pairs = request.get("calibration", {}).get("framePairs", [])
    if not pairs:
        shots = request.get("calibration", {}).get("shots", [])
        cleanups = request.get("calibration", {}).get("postCutCleanup", [])
        if shots:
            pairs = []
            for frame in range(ts, ts + tf):
                shot = next((s for s in shots if s["targetStartFrame"] <= frame < s["targetStartFrame"] + s["targetFrames"]), None)
                if shot:
                    progress = (frame - shot["targetStartFrame"]) / max(1, shot["targetFrames"] - 1)
                    source_frame = shot["sourceStartFrame"] + int(math.floor(progress * (shot["sourceFrames"] - 1) + .5))
                    pairs.append({"sourceFrame": source_frame, "targetFrame": frame, "mappingRule": "reviewed-shot-nearest-progress-real-frame"})
                elif any(c["targetStartFrame"] <= frame < c["targetStartFrame"] + c["targetFrames"] for c in cleanups):
                    pairs.append({"sourceFrame": ss + sf - 1, "targetFrame": frame, "postCutCleanupOnly": True, "mappingRule": "no-source-material-post-cut"})
                else:
                    raise CalibrationError("Reviewed shots/cleanup do not cover selected target frame")
        else:
            if sf != tf:
                raise CalibrationError("Different frame lengths require explicit framePairs or reviewed shot spans")
            pairs = [{"sourceFrame": ss + i, "targetFrame": ts + i} for i in range(tf)]
    if any(not isinstance(p, dict) or any(isinstance(p.get(k), bool) or not isinstance(p.get(k), int) for k in ("sourceFrame", "targetFrame")) for p in pairs):
        raise CalibrationError("framePairs must contain real integer sourceFrame/targetFrame indices")
    ordered = sorted(pairs, key=lambda p: p["targetFrame"])
    if [p["targetFrame"] for p in ordered] != list(range(ts, ts + tf)):
        raise CalibrationError("framePairs must cover every selected target frame exactly once")
    previous = -1
    for pair in ordered:
        s = pair.get("sourceFrame")
        if not isinstance(s, int) or not ss <= s < ss + sf or s < previous:
            raise CalibrationError("Source framePairs must be real in-range nondecreasing indices")
        previous = s
        shot = next((q for q in request.get("calibration", {}).get("shots", []) if q["targetStartFrame"] <= pair["targetFrame"] < q["targetStartFrame"] + q["targetFrames"]), None)
        if shot and shot.get("mode", "material") == "material" and not shot["sourceStartFrame"] <= s < shot["sourceStartFrame"] + shot["sourceFrames"]:
            raise CalibrationError("Explicit framePair crosses source/target material shots")
    return ordered
