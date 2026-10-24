import copy
import tempfile
import unittest
from pathlib import Path
import cv2
import numpy as np
from worker.local_material.protocol import CalibrationError, cache_key, frame_mapping, normalized_points, owned_path, atomic_json
from worker.local_material.geometry import dense_warp, skin_plane, stroke_mask, material_residual, continuous_material_residual, observed_target_candidate, connected_material_rim, nose_core_mask
from worker.local_material.media import VideoReader, processing_size
from worker.local_material.engine import compose_local, run, templates_for_shot
from worker.local_material.hand import material_finger_guard
from worker.local_material.protocol import sha_file
from worker.local_material.occlusion import reconstruct
from worker.local_material.photometry import target_donor_correction

class ProtocolTests(unittest.TestCase):
    def test_material_or_output_changes_invalidate_or_preserve_cache_correctly(self):
        request = {"calibration": {"sourceSkinPoints": [{"x": .2, "y": .3}]}, "runtime": {"models": {"face": {"sha256": "a"}}}, "outputDirectory": "one"}
        other = copy.deepcopy(request); other["outputDirectory"] = "two"
        self.assertEqual(cache_key(request), cache_key(other))
        other["calibration"]["sourceSkinPoints"][0]["x"] = .4
        self.assertNotEqual(cache_key(request), cache_key(other))

    def test_real_frame_mapping_cannot_cross_bounds_or_reverse_action(self):
        r = {"frameRanges": {"source": {"startFrame": 9, "frames": 4}, "target": {"startFrame": 80, "frames": 3}}, "calibration": {"framePairs": [{"sourceFrame": 9, "targetFrame": 80}, {"sourceFrame": 11, "targetFrame": 81}, {"sourceFrame": 12, "targetFrame": 82}]}}
        self.assertEqual(frame_mapping(r)[-1]["sourceFrame"], 12)
        r["calibration"]["framePairs"][2]["sourceFrame"] = 10
        with self.assertRaises(CalibrationError): frame_mapping(r)

    def test_reviewed_shot_mapping_keeps_real_endpoints_without_white_objective(self):
        r = {"frameRanges": {"source": {"startFrame": 101, "frames": 11}, "target": {"startFrame": 4, "frames": 7}}, "calibration": {"shots": [{"sourceStartFrame":101,"sourceFrames":11,"targetStartFrame":4,"targetFrames":7}]}}
        mapping = frame_mapping(r)
        self.assertEqual(mapping[0]["sourceFrame"],101); self.assertEqual(mapping[-1]["sourceFrame"],111)
        self.assertTrue(all(a["sourceFrame"]<=b["sourceFrame"]for a,b in zip(mapping,mapping[1:])))

    def test_uncalibrated_nonfinite_normalized_points_are_rejected(self):
        with self.assertRaises(CalibrationError): normalized_points([{"x": float("nan"), "y": .5}], 1)
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(CalibrationError): owned_path(Path(folder).parent / "outside.png", folder)
            path = Path(folder) / "state.json"; atomic_json(path, {"ok": True})
            self.assertTrue(path.exists()); self.assertEqual(list(Path(folder).glob("*.part-*")), [])

class GeometryTests(unittest.TestCase):
    def test_manual_shadowed_material_stays_and_only_connected_rim_is_added(self):
        manual=np.zeros((40,50),bool);manual[10:30,10:25]=True
        observed=np.zeros_like(manual);observed[10:30,20:28]=True;observed[2:5,35:38]=True
        surface=np.ones_like(manual);surface[15:20,24:30]=False
        result,stats=connected_material_rim(manual,observed,surface)
        self.assertTrue(result[20,12])  # shadowed centre has no whitening signal
        self.assertTrue(result[12,27])
        self.assertFalse(result[3,36])  # unrelated bright skin is not film
        self.assertFalse(result[17,25])  # hand / feature hole
        self.assertEqual(stats['outsideReviewedSurface'],0)

    def test_distance_feather_preserves_thick_material_core_and_protected_pixels(self):
        base=np.full((480,480,3),100,np.uint8);clean=np.full_like(base,130,dtype=np.float32)
        residual=np.full_like(clean,60);mask=np.zeros((480,480),bool);mask[100:200,100:200]=True;mask[140:150,140:150]=False
        result=compose_local(base,clean,residual,mask,distance_feather=True)
        self.assertTrue(np.array_equal(result[~mask],base[~mask]))
        self.assertTrue(np.all(result[120,120]==190))
        self.assertTrue(np.all(result[100,120]<result[102,120]))
        self.assertTrue(np.all(result[102,120]<result[110,120]))

    def test_material_confidence_is_continuous_without_blurring_raw_evidence(self):
        baseline=np.tile(np.float32([100,140,180]),(2,601,1))
        ramp=np.linspace(0,30,601,dtype=np.float32)[None,:,None]
        source=baseline+ramp
        visible=np.ones((2,601),bool);visible[1]=False
        hard,raw=material_residual(source,baseline,visible)
        soft,weight=continuous_material_residual(source,baseline,visible)
        self.assertGreater(float(np.max(np.abs(np.diff(hard[0,:,0])))),6)
        self.assertLess(float(np.max(np.abs(np.diff(soft[0,:,0])))),.5)
        self.assertTrue(np.all(weight[1]==0));self.assertTrue(np.all(soft[1]==0))
        self.assertTrue(np.all((weight>=0)&(weight<=1)))
        self.assertTrue(np.array_equal(material_residual(source,baseline,visible)[1],raw))
        thick,confidence=continuous_material_residual(baseline+80,baseline,visible)
        self.assertTrue(np.allclose(confidence[0],1))
        self.assertTrue(np.allclose(thick[0],80))

    def test_target_colour_correction_keeps_supported_spatial_lighting(self):
        ref=np.full((100,120,3),170,np.float32);yy,xx=np.mgrid[:100,:120]
        current=ref+(-20+xx/120*8-yy/100*5)[:,:,None]
        points=np.float32([[8,8],[110,8],[8,90],[110,90],[60,45]])
        domain=np.zeros((100,120),bool);domain[15:85,15:105]=True
        corrected,fit=target_donor_correction(ref,current,points,np.zeros((100,120),np.uint8),domain)
        self.assertEqual(fit['method'],'robust_spatial_bare_offset_plane')
        self.assertLess(float(np.max(np.abs(corrected[domain]-current[domain]))),.01)

    def test_target_diagonal_samples_fall_back_to_true_constant_without_dark_extrapolation(self):
        ref=np.full((100,100,3),170,np.float32);current=ref-20
        points=np.float32([[20,20],[40,39],[60,61],[80,82]])
        for i,(x,y)in enumerate(points.astype(int)):
            current[y-1:y+2,x-1:x+2]+=i%2
        corrected,fit=target_donor_correction(ref,current,points,np.zeros((100,100),np.uint8),np.ones((100,100),bool))
        self.assertEqual(fit['method'],'robust_constant_bare_offset')
        self.assertLess(float(np.max(np.abs(corrected-150))),1)
        self.assertTrue(np.all(np.std(corrected,axis=(0,1))<.01))

    def test_target_inconsistent_constant_or_missing_bare_samples_remain_risk(self):
        ref=np.full((100,100,3),170,np.float32);current=ref.copy();points=np.float32([[20,20],[40,39],[60,61],[80,82]])
        for i,(x,y)in enumerate(points.astype(int)):
            current[y-1:y+2,x-1:x+2]=120 if i%2 else 220
        with self.assertRaises(CalibrationError):target_donor_correction(ref,current,points,np.zeros((100,100),np.uint8),np.ones((100,100),bool))
        with self.assertRaises(CalibrationError):target_donor_correction(ref,current,points,np.full((100,100),255,np.uint8),np.ones((100,100),bool))

    def test_short_occlusion_records_two_sided_evidence_without_relabelling_measurement(self):
        shape=(40,40);visible=np.ones(shape,bool);visible[19:22,19:22]=False
        editable=~visible;hand=editable.copy();ref=np.zeros(shape,bool);delta=np.zeros(shape+(3,),np.float32)
        before={"frame":9,"visible":np.ones(shape,bool),"residual":np.full_like(delta,20),"credible":True}
        after={"frame":11,"visible":np.ones(shape,bool),"residual":np.full_like(delta,22),"credible":True}
        output=reconstruct(10,visible,delta,hand,ref,editable,[before,after],50,3)
        self.assertTrue(output['inferredTemporal'][20,20])
        self.assertFalse(output['currentMeasuredSupport'][20,20])
        self.assertTrue(np.array_equal(output['currentMeasuredSupport'],visible))
        self.assertEqual(output['previousSourceFrame'][20,20],9)
        self.assertEqual(output['nextSourceFrame'][20,20],11)
        self.assertEqual(output['residual'][20,20,0],21)

    def test_unavailable_reference_skin_never_becomes_contact_reconstruction(self):
        shape=(32,32);visible=np.ones(shape,bool);visible[15,15]=False
        edit=~visible;delta=np.zeros(shape+(3,),np.float32)
        neighbours=[{"frame":n,"visible":np.ones(shape,bool),"residual":delta,"credible":True}for n in[9,11]]
        output=reconstruct(10,visible,delta,edit,edit,edit,neighbours,50,3)
        self.assertFalse(output['inferredTemporal'].any())
        self.assertFalse(output['inferredSpatial'].any())
        self.assertTrue(output['remainingUnknown'][15,15])

    def test_unilateral_distant_or_changing_evidence_cannot_clear_large_hidden_material(self):
        shape=(64,64);visible=np.ones(shape,bool);visible[12:52,12:52]=False
        edit=~visible;delta=np.zeros(shape+(3,),np.float32)
        past={"frame":9,"visible":np.ones(shape,bool),"residual":np.full_like(delta,50),"credible":True}
        future={"frame":11,"visible":np.ones(shape,bool),"residual":delta,"credible":True}
        distant={"frame":20,"visible":np.ones(shape,bool),"residual":np.full_like(delta,50),"credible":True}
        output=reconstruct(10,visible,delta,edit,np.zeros(shape,bool),edit,[past,future,distant],50,3)
        self.assertFalse(output['inferredTemporal'].any())
        self.assertTrue(output['remainingUnknown'][32,32])
        output=reconstruct(10,visible,delta,edit,np.zeros(shape,bool),edit,[past,distant],50,3)
        self.assertFalse(output['inferredTemporal'].any())

    def test_nasal_structure_is_protected_without_freezing_flank_skin(self):
        face = np.tile(np.float32([100, 150]), (478, 1))
        for i, point in zip([168,6,197,195,5,4], [[100,95],[100,103],[100,111],[100,119],[100,127],[100,135]]):
            face[i] = point
        face[1] = [100,139]
        for i, point in zip([19,94,2,97,98,326,327,294,278], [[100,146],[100,149],[100,153],[91,152],[88,146],[109,152],[112,146],[116,147],[118,151]]):
            face[i] = point
        face[64] = [84,148]; face[48] = [83,152]
        mask = nose_core_mask(face, (200,280))
        self.assertGreater(mask[146,90],0)  # nostril/base
        self.assertGreater(mask[150,86],0)  # left nostril is symmetric to right
        self.assertGreater(mask[139,100],0) # tip
        self.assertGreater(mask[110,100],0) # bridge line
        self.assertEqual(mask[120,87],0)    # nasal flank skin
        doubled = nose_core_mask(face*2, (400,560))
        self.assertGreater(doubled[278,200],0)
        self.assertEqual(doubled[240,174],0)

    def test_hand_templates_cannot_cross_reviewed_cut_even_when_nearer_in_time(self):
        templates = [{"frameIndex": 9}, {"frameIndex": 30}, {"frameIndex": 60}]
        shot = {"sourceStartFrame": 10, "sourceFrames": 31, "targetStartFrame": 40, "targetFrames": 31}
        self.assertEqual([p["frameIndex"] for p in templates_for_shot(templates, shot, "source")], [30])
        self.assertEqual([p["frameIndex"] for p in templates_for_shot(templates, shot, "target")], [60])
        self.assertEqual(templates_for_shot(templates, None, "target"), [])

    def test_dense_correspondence_preserves_scalar_range_and_real_triangle_support(self):
        points = np.float32([[3, 3], [28, 3], [3, 28], [28, 28]])
        image = np.full((32, 32), 63, np.uint8)
        output, coverage = dense_warp(image, points, points + [4, 0], (40, 32), nearest=True)
        self.assertEqual(float(output[10, 10]), 63)
        self.assertEqual(float(output[0, 0]), 0)
        self.assertEqual(int(coverage[10, 10]), 255)

    def test_hidden_skin_controls_are_not_invented_from_another_frame(self):
        image = np.full((90, 120, 3), [120, 145, 180], np.uint8)
        points = np.float32([[20, 20], [80, 20], [20, 70], [80, 70]])
        baseline, meta = skin_plane(image, points, np.zeros((90, 120), np.uint8))
        self.assertLess(np.max(np.abs(baseline - image)), .01)
        with self.assertRaises(CalibrationError): skin_plane(image, points, np.full((90, 120), 255, np.uint8))

    def test_shadow_is_not_transferred_as_cream_and_protection_is_exact(self):
        base = np.full((64, 80, 3), [90, 120, 170], np.uint8)
        baseline = np.float32(base)
        source = base.copy(); source[10:30, 10:30] = [170, 175, 195]; source[35:50, 10:30] = [45, 65, 90]
        visible = np.ones((64, 80), bool)
        residual, supported = material_residual(source, baseline, visible)
        self.assertGreater(np.linalg.norm(residual[20, 20]), 0)
        self.assertEqual(float(np.linalg.norm(residual[40, 20])), 0)
        editable = np.zeros((64, 80), bool); editable[10:30, 10:30] = True
        result = compose_local(base, baseline, residual, editable)
        self.assertTrue(np.array_equal(result[~editable], base[~editable]))

    def test_brush_radius_uses_short_edge_and_erases_are_explicit(self):
        strokes = [{"mode": "protect", "radius": .05, "points": [{"x": .5, "y": .5}]}, {"mode": "erase", "radius": .01, "points": [{"x": .5, "y": .5}]}]
        mask = stroke_mask(strokes, (200, 100))
        self.assertEqual(int(mask[50, 100]), 0)
        self.assertEqual(int(mask[50, 104]), 255)
        self.assertEqual(int(mask[50, 107]), 0)

    def test_long_nail_exclusion_is_material_only_and_tracks_current_finger(self):
        points=np.tile(np.float32([64,100]),(21,1))
        points[10]=[64,75];points[11]=[64,50];points[12]=[64,40]
        guard=material_finger_guard(points,[[10,11],[11,12]],(128,192),.02)
        self.assertGreater(int(guard[36,64]),0)
        self.assertEqual(int(guard[36,90]),0)

    def test_surface_bare_pixels_are_not_automatic_material_candidates(self):
        clean=np.full((70,90,3),[120,145,180],np.uint8)
        base=clean.copy();base[20:35,30:45]=[215,220,240]
        mask=observed_target_candidate(base,clean,np.ones((70,90),bool))
        self.assertTrue(mask[25,35]);self.assertFalse(mask[60,80])

    def test_streamed_repeat_frame_stays_in_processing_aspect(self):
        with tempfile.TemporaryDirectory() as folder:
            path = str(Path(folder) / "sample.avi")
            writer = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"MJPG"), 24, (160, 96))
            for i in range(3): writer.write(np.full((96, 160, 3), 40 + i * 30, np.uint8))
            writer.release()
            reader = VideoReader({"file": path, "width": 160, "height": 96, "frames": 3, "fps": 24}, 80)
            try:
                one, repeat = reader.get(1), reader.get(1)
                self.assertEqual(one.shape, (48, 80, 3)); self.assertTrue(np.array_equal(one, repeat))
                self.assertEqual(reader.get(2).shape, one.shape)
            finally: reader.close()

class StreamingEngineTests(unittest.TestCase):
    class FakeDetector:
        components = {"left_eye": [], "right_eye": [], "nose": [], "lips": []}
        hand_edges = []
        def __init__(self, runtime): pass
        def detect(self, image):
            h, w = image.shape[:2]
            return {"faces": [np.float32([[.05*w,.05*h],[.95*w,.05*h],[.05*w,.95*h],[.95*w,.95*h]])], "hands": []}
        def close(self): pass

    def fixture(self, folder, source_region=None):
        folder = Path(folder)
        metadata = []
        for name, tone in [("source", 150), ("base", 110)]:
            path = folder / (name + ".avi")
            writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), 24, (160, 96))
            for i in range(3):
                frame = np.full((96,160,3), [tone-30,tone-10,tone+30], np.uint8)
                if name == "source": frame[35:65,55:105] = [215,220,240]
                writer.write(frame)
            writer.release()
            metadata.append({"file":str(path),"sha256":sha_file(path),"width":160,"height":96,"frames":3,"fps":24})
        donor = folder / "donor.png"; cv2.imwrite(str(donor), np.full((96,160,3),[80,100,140],np.uint8))
        region = [{"x":.3,"y":.3},{"x":.7,"y":.3},{"x":.7,"y":.7},{"x":.3,"y":.7}]
        return {"schemaVersion":1,"action":"render","requestHash":"fixture","revision":1,"sourceVideo":metadata[0],"baseVideo":metadata[1],"frameRanges":{"source":{"startFrame":0,"frames":3},"target":{"startFrame":0,"frames":3}},"calibration":{"sourceRegion":source_region or region,"targetRegion":region,"sourceSkinPoints":[{"x":.15,"y":.15},{"x":.85,"y":.15},{"x":.15,"y":.85},{"x":.85,"y":.85}],"targetSkinPoints":[],"handKeyframes":[],"reviewed":True,"donorReviewed":True,"shots":[{"sourceStartFrame":0,"sourceFrames":3,"targetStartFrame":0,"targetFrames":3}]},"runtime":{},"targetSkin":{"file":str(donor)},"outputDirectory":str(folder/"output"),"processing":{"maxSide":80}}

    def test_streaming_render_preserves_native_dimensions_and_resume_hashes(self):
        with tempfile.TemporaryDirectory() as folder:
            request = self.fixture(folder)
            result = run(request, detector_factory=self.FakeDetector)
            self.assertEqual(result["status"], "preview_ready")
            self.assertEqual(result["checks"]["changedOutsideEditablePixels"],0)
            self.assertEqual(len(result["frames"]),3)
            image = cv2.imread(result["frames"][0]["file"])
            self.assertEqual(image.shape,(96,160,3))
            resumed = run(request, detector_factory=self.FakeDetector)
            self.assertEqual([x["sha256"]for x in resumed["frames"]],[x["sha256"]for x in result["frames"]])

    def test_large_unsupported_visible_region_never_becomes_ready(self):
        with tempfile.TemporaryDirectory() as folder:
            source_region=[{"x":.1,"y":.1},{"x":.2,"y":.1},{"x":.2,"y":.2},{"x":.1,"y":.2}]
            request=self.fixture(folder,source_region)
            request['calibration']['targetMaterialKeyframes']=[{'frameIndex':0,'region':request['calibration']['targetRegion'],'reviewed':True}]
            result=run(request,detector_factory=self.FakeDetector)
            self.assertEqual(result["status"],"needs_calibration")
            self.assertGreater(result["checks"]["lowSupportCount"],0)
            self.assertTrue(any("unsupported source"in x["reason"]for x in result["riskFrames"]))

    def test_cancel_does_not_claim_ready_or_modify_inputs(self):
        with tempfile.TemporaryDirectory() as folder:
            request=self.fixture(folder); flag=Path(folder)/"cancel.flag";flag.write_text("cancel")
            request["cancelFile"]=str(flag)
            result=run(request,detector_factory=self.FakeDetector)
            self.assertEqual(result["status"],"needs_calibration");self.assertTrue(result["cancelled"])
            self.assertEqual(sha_file(request["sourceVideo"]["file"]),request["sourceVideo"]["sha256"])

    def test_preserved_shot_does_not_need_source_skin_or_leak_material(self):
        with tempfile.TemporaryDirectory() as folder:
            request=self.fixture(folder)
            request['calibration']['shots']=[{'sourceStartFrame':0,'sourceFrames':1,'targetStartFrame':0,'targetFrames':1,'mode':'preserve'},{'sourceStartFrame':1,'sourceFrames':2,'targetStartFrame':1,'targetFrames':2,'mode':'material'}]
            result=run(request,detector_factory=self.FakeDetector)
            first=cv2.imread(result['frames'][0]['file'])
            reader=VideoReader(request['baseVideo'],max(request['baseVideo']['width'],request['baseVideo']['height']))
            try:original=reader.get(0)
            finally:reader.close()
            self.assertTrue(np.array_equal(first,original))
            self.assertEqual(result['frames'][0]['editablePixels'],0)

    def test_own_postcut_donor_works_without_global_or_source_skin(self):
        with tempfile.TemporaryDirectory() as folder:
            request=self.fixture(folder)
            request['targetSkin']=None
            for key in ['sourceRegion','targetRegion','sourceSkinPoints']:
                request['calibration'].pop(key)
            request['calibration']['shots']=[{'sourceStartFrame':0,'sourceFrames':3,'targetStartFrame':0,'targetFrames':3,'mode':'preserve'}]
            request['calibration']['postCutCleanup']=[{'targetStartFrame':0,'targetFrames':3,'region':[{'x':.3,'y':.3},{'x':.7,'y':.3},{'x':.7,'y':.7},{'x':.3,'y':.7}],'donorFrameIndex':0,'reviewed':True}]
            result=run(request,detector_factory=self.FakeDetector)
            self.assertEqual(result['status'],'preview_ready')
            self.assertEqual(len(result['frames']),3)
            self.assertEqual(result['checks']['changedOutsideEditablePixels'],0)

if __name__ == "__main__":
    unittest.main()
