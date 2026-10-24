# Local material worker (unpublished)

CPU-only Python3.12/3.13 worker using local MediaPipe/OpenCV/NumPy. It does not call
providers, download models, import project diagnostic folders, or use Torch.
Dependency/runtime/model licensing and installation are a separate packaging gate.
Development checks ran under Python3.12.14 and isolated official Python3.13.16,
with MediaPipe1.1.0, NumPy2.5.4 and OpenCV5.0.0.93. The direct dependency pins are
in requirements.lock.txt; the packaged runtime must also lock transitive wheels,
native binaries and model SHA/license provenance rather than copying a venv.

Invoke from repository root:

```
python -X utf8 -I -B worker/local_material/launch.py --request REQUEST.json --result RESULT.json --output-dir OWNED_CACHE --cancel-file CANCEL.flag
```

The CLI writes progress JSONL to stdout and an atomic result JSON. MediaPipe logs
may appear on stderr. Stdout is explicitly UTF-8; `-X utf8` also makes Windows
isolated-process defaults predictable for Chinese paths. Both inputs and model
bytes must match their SHA256 hashes.
`analyse` samples real frames and always returns `needs_calibration`; detected
landmarks are not skin visibility, hand segmentation, actor identity, or acceptance.

Request schemaVersion1 matches the Node local-material contract: sourceVideo and
baseVideo metadata/file/SHA, independent frameRanges, actors, runtime.models,
outputDirectory, outputClipFile, cancelFile, revision and requestHash. Calibration
contains normalized sourceRegion/targetRegion/sourceSkinPoints (at least4 bare
source samples), optional targetSkinPoints, complete real framePairs when range
lengths differ, reviewed shots, both sides' handKeyframes, reviewed/donorReviewed.
Brush radius is relative to the shorter image edge. Coordinates anchor to
calibration.anchorPair (actual canvas sourceFrame/targetFrame), or the first
material frame pair, and follow that side's dense face geometry. SourceRegion is
the corresponding skin surface, including genuinely visible bare skin; zero
material excess is still observed support. Explicitly reviewed source/target
bare-skin points may lie inside their surface ROI and are excluded only for hand,
features or image bounds. No automatic unknown point is accepted as bare skin.

Target donor colour matching has a different purpose from source material
estimation. It fits current reviewed bare-skin colour differences, then checks
the plane's leverage and prediction range across visible target skin. When the
geometry cannot support that spatial extrapolation, a reliable median RGB
offset from the same current bare samples replaces the plane. Sample dispersion
that cannot support this constant model remains `needs_calibration`. Diagnostics
record the chosen method, sample offsets, plane condition/leverage, unclipped
prediction range and constant-model residual. This does not clamp an impossible
plane at minus128, change source baselines, whiten the base globally or fade over
time; only the donor inside editable skin can be composited.

`targetSkin` is an explicitly reviewed image from the target identity. Optional
`sourceSkinReference:{frameIndex,reviewed:true}` is a real frame from the original
video in the same reviewed shot, representing the already spread state. It is
never an external actor photo. With it, the worker measures relative excess over
that observed state; without it, own-frame nearby bare skin forms a spatial plane.
Source and target skin references have distinct roles. Reviewed shots[].mode is
material (default) or preserve. Preserve frames do not use source materials or
require the source reference to share their shot. If framePairs are absent,
reviewed shot spans map nearest real frame progress while preserving both ends;
no image/motion interpolation or material-opacity objective is used.

The surface ROI is not a full-face donor replacement request. Optional reviewed
targetMaterialKeyframes[{frameIndex,region,reviewed}] describe the observed old
film's coarse region in a material shot; the nearest real calibration frame's
region follows that face geometry, without temporal opacity blending. Otherwise
the current base versus corrected own-target donor brightness/chroma difference
forms a fixed spatial diagnostic candidate. It is not ground truth. Editing is
limited to old candidate union mapped actually observed source excess-material
signal, with hands/features excluded. Already bare skin stays untouched and
does not create a false source-support requirement. Candidate pixels without
large enough genuine source support still block readiness; thresholds are not
relaxed. Candidate/editable/support PNGs are exported for calibration review.

Every hand mask is independently anchored from reviewed hand keyframes using
hand21 affine plus bounded local residual flow. Each side's current/reference
hand keyframes are strictly restricted to that reviewed shot's frame span;
a better pose-fit score never permits using a template across a cut.
Previous-frame masks and face
warps do not propagate current hand anatomy. Source hand/nail uncertainty bands
are exported under sourceSupport and excluded from both residuals and bare-skin
calibration, including the source reference's unavailable skin footprint.
`processing.handBoundaryMargin` is an optional normalized shorter-edge margin
(default0.008, allowed0..0.1); it is spatial and never a time fade.

For an explicitly authorized local action reconstruction, enable
`processing.sourceOcclusionReconstruction:{enabled:true}`. It reconstructs only
the current source-hand contact gap, keeping unavailable source-reference skin
separate. The nearest credible observations on each side must lie within the
same reviewed material shot and at most0.3 seconds (at most12 frames) away.
Their relative residual must agree within12 BGR-channel levels and8 luminance
levels. A bounded spatial residual field can fill a small remaining contact gap
using current-frame observed neighbours: radius0.12 eye distance, sample mass at
least0.15, and at most15% of editable pixels. These are explicit appearance
inferences, not current-frame measured skin, physical alpha or ground truth.

Current measured support, temporal inference, spatial inference and remaining
unknown support are exported separately. A per-pixel NPZ evidence record and
frame summary include real source frame/time pairs, agreement differences,
spatial radius and variability. The original8% final unknown threshold remains;
missing calibration or larger unknown regions still block technical readiness.
No opacity-versus-time curve, source actor RGB paste, cross-cut donor evidence or
motion-frame interpolation is used. This path still needs actual content review.

The separate artistic branch requires an explicit
`processing.appearanceReconstruction:{enabled:true,method:"bounded-material-appearance-v1"}`.
Omission or `enabled:false` keeps the strict renderer and its pixel output.
This branch uses the target's own corrected clean donor plus a material residual;
it never pastes source face or hand RGB. It is only active in material shots.

Optional `calibration.appearanceKeyframes:[{frameIndex,region,reviewed:true}]`
contains normalized target polygons for that exact frame only. These are explicit
face/hand membrane repaint authorizations, never tracking hints propagated to
adjacent frames. They can override the old target hand mask inside the polygon,
while ROI exterior, eye/lip/nose structure and other target hand pixels remain
protected. Automatic repair of remaining unknown editable components still
excludes all target hand pixels. The old-hand override mask, changed old-hand
pixel count and protected-hand count are recorded separately; full old-hand RGB
preservation is not claimed for this mode.

Each component must fit both 0.20 squared eye-distance and 5% of whole face hull
area; total requested repair must fit 10% of whole face hull. Trustworthy residual
boundary support must have at least 12 points and lie within 0.25 eye-distance.
Current-frame visible source residuals remain fixed. Missing controls can use the
nearest actually visible state within 9 source frames in the same shot; earlier
wins an equal-distance tie. Differing and single-sided states are explicitly
artistic inference, never a measurement of current hidden skin. Selection never
minimizes whiteness. A local four-neighbour harmonic solve uses those fixed
controls; unknown exterior neighbours are not fictitious zero material. Failed
bounds, insufficient support or nonconvergence retain unknown/audit evidence.
A failed explicitly reviewed repair remains an unresolved risk. Automatic
attempts that fail are assessed by the same original 8% remaining-unknown gate,
so optional repair cannot turn a formerly tolerated tiny unknown into a new
hard failure. `rejectedAutomaticPixels` and `rejectedReviewedPixels` distinguish
these outcomes; acceptance bounds and measured support are unchanged.
Spatial feather is 0.04 eye-distance with no time opacity curve.

Per-frame `appearanceReconstruction` summaries and `appearanceArtifacts` PNG/NPZ
evidence separate current measured residual, time-inferred boundary/patch,
harmonic-inferred patch, rejected patch and remaining unknown. NPZ includes the
actual chosen source frame per pixel, current observed and completed residuals,
domain, protected structures, old hand mask and spatial feather. Only accepted
patches leave remaining unknown; the original 8% unknown gate is unchanged.
All inferred evidence and technical preview readiness still require human review.

In the opt-in appearance branch, same-frame whitening uses continuous luminance
and chroma confidence instead of multiplying colour by a binary threshold. Raw
6/.018 signal and raw mapped residual remain in the evidence NPZ; rendered
appearance residual and confidence are separate fields. Full confidence is at
12/.036 using fixed smoothstep weights, without output blur or a time curve.
Neighbouring observations constrain only the outside boundary of each unknown
patch. The unknown interior is solved harmonically, so a different hand pose's
colour wedge cannot be copied into it. Current observed appearance controls,
feature/hand protection, area/distance limits and the 8% unknown gate remain.

Appearance mode keeps the complete reviewed material footprint, including its
shadowed portions, and adds only whitening-cue components connected to it inside
the reviewed skin surface. Unconnected skin highlights are discarded. A fixed
interior-distance feather (0.0125 of the shorter image edge) removes the abrupt
binary-mask edge; it does not blend over time or diffuse old film across the face.
The strict/default compositor and cleanup retain their old paths.

For an opted-in cleanup using the target video's own reviewed donor frame, a
1–2px same-frame inpainting band removes remaining matte-edge contamination.
It follows the reviewed cleanup contour, adds one pixel of hand/nail protection,
and leaves the mouth, hand and all pixels outside that band unchanged. Its mask
and inference summary are retained separately. It never extends donor geometry
or copies a different-frame neck/background beyond the face mesh.

Eye/lip shapes and nasal anatomy are protected. The nose guard preserves both
nostrils/base, the tip and bridge structure lines, with radii relative to the
shorter image edge. It permits nasal flank skin cleanup only where the user
already selected a skin surface; it does not expand that surface or alter shape.

Optional explicitly reviewed postCutCleanup regions clean only selected erroneous
target residues using targetSkin. Each may instead select donorFrameIndex from
the base video's same reviewed preserve shot, allowing an appropriate target
camera/pose rather than sharing the front-facing donor across cuts. No source
actor donor or automatic forehead/chin cleanup is inferred.

Render produces native-base-size PNG frames (top-level `frames` and
`artifacts.frameSequence`). The Node caller must encode a compatible local visual
clip, reuse base audio and preserve outer pictures. The Python worker intentionally
does not emit a lossy OpenCV MP4 as a final artifact. `outputClipFile` is reserved
for caller encoding. No input or output frame is synthesized/interpolated in time.

Unsupported geometry, lost detection, missing bare-skin controls, different shots,
or a large visible target region unsupported by source observations returns
`needs_calibration` with unresolved riskFrames. A diagnostic PNG may retain the
base as failure evidence; it cannot become `preview_ready`. Technical readiness
requires calibrated inputs, zero lowSupportCount, unchanged pixels outside editable
regions, and no unresolved risks. It is never final material or film acceptance.

Inputs/calibration/model/version/worker-code hashes form cacheKey. Atomic PNGs and
checkpoint records may resume only under the same key and verified output SHA.
Cancel is checked between stream reads and each frame. Readers keep one decoded
frame rather than loading a long video. Processing downscales preserve aspect;
changes map back to native base dimensions, restoring protected pixels exactly.

Meaningful focused checks:

```
python -m unittest discover -s worker/local_material/tests -v
```
