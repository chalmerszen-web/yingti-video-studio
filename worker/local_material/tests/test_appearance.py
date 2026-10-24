import tempfile
import unittest
import inspect
from unittest.mock import patch
from pathlib import Path
import cv2
import numpy as np
from worker.local_material import appearance
from worker.local_material.engine import run
from worker.local_material.protocol import CalibrationError, validate_request
import test_worker


class AppearanceTests(unittest.TestCase):
    def test_cleanup_border_removes_narrow_ridge_without_changing_hand_or_core(self):
        frame=np.full((100,120,3),120,np.uint8)
        roi=np.zeros((100,120),bool);roi[30:70,30:90]=True
        frame[30:32,30:90]=220
        hand=np.zeros_like(roi);hand[:,60:68]=True
        feature=np.zeros_like(roi);feature[28:34,35:42]=True
        output,mask,report=appearance.refine_cleanup_border(frame,roi,hand,feature)
        self.assertTrue(np.array_equal(output[~mask],frame[~mask]))
        self.assertTrue(np.array_equal(output[hand|feature],frame[hand|feature]))
        self.assertEqual(report['changedOutsideBand'],0)
        self.assertEqual(report['protectedPixelsChanged'],0)
        self.assertLess(float(output[30,48].mean()),float(frame[30,48].mean()))
        self.assertTrue(np.array_equal(output[50,50],frame[50,50]))

    def inputs(self):
        shape = (80, 100)
        visible = np.ones(shape, bool)
        visible[36:41, 46:51] = False
        yy, xx = np.mgrid[:80, :100]
        residual = np.repeat((10 + xx * .1)[:, :, None], 3, axis=2).astype(np.float32)
        residual[~visible] = 0
        return dict(current_frame=10, current_visible=visible, current_residual=residual,
                    existing_residual=residual.copy(), existing_support=visible.copy(),
                    editable=~visible, reviewed_region=np.zeros(shape, bool),
                    surface=np.ones(shape, bool), old_hand=np.zeros(shape, bool),
                    neighbours=[], eye_distance=30., whole_face_area=8000, source_shot=(0, 30))

    def test_small_hole_harmonic_and_observations_stay_separate(self):
        args = self.inputs()
        result = appearance.reconstruct(**args)
        self.assertEqual(result['summary']['acceptedPixels'], 25)
        self.assertEqual(result['summary']['harmonicInferredPixels'], 25)
        self.assertFalse(result['remainingUnknown'].any())
        self.assertFalse(result['currentMeasured'][38, 48])
        self.assertAlmostEqual(float(result['residual'][38, 48, 0]), 14.8, delta=.04)
        self.assertTrue(np.array_equal(result['residual'][args['current_visible']], args['current_residual'][args['current_visible']]))
        self.assertFalse(result['timeInferredBoundary'].any())

    def test_nearest_temporal_state_is_chosen_even_if_whiter_or_single_sided(self):
        args = self.inputs()
        shape = args['current_visible'].shape
        args['current_visible'][:] = False
        args['existing_support'][:] = False
        args['neighbours'] = [dict(frame=n, visible=np.ones(shape, bool), residual=np.full(shape+(3,), value, np.float32), credible=True)
                              for n, value in [(8, 2), (11, 38)]]
        result = appearance.reconstruct(**args)
        self.assertEqual(result['selectedSourceFrame'][34, 48], 11)
        self.assertEqual(result['selectedSourceFrame'][38, 48], -1)
        self.assertAlmostEqual(float(result['residual'][38, 48, 0]), 38, places=3)
        self.assertFalse(result['timeInferredPatch'][38, 48])
        self.assertFalse(result['currentMeasured'][38, 48])
        self.assertTrue(result['harmonicInferred'][38, 48])
        args['neighbours'] = args['neighbours'][1:]
        self.assertEqual(appearance.reconstruct(**args)['residual'][38, 48, 0], 38)

    def test_temporal_interior_colour_wedge_is_not_pasted_into_new_pose(self):
        args = self.inputs()
        shape = args['current_visible'].shape
        args['current_visible'][:] = False
        args['existing_support'][:] = False
        adjacent = np.full(shape+(3,), 10, np.float32)
        # Only the unavailable interior has the stale pattern; its observed
        # contour is still 10. The solver must not copy that interior pattern.
        adjacent[37:40,47:50] = [80,80,-12]
        args['neighbours'] = [dict(frame=11, visible=np.ones(shape,bool), residual=adjacent, credible=True)]
        result = appearance.reconstruct(**args)
        self.assertTrue(np.allclose(result['residual'][38,48],10,atol=.02))
        self.assertEqual(result['summary']['timeInferredPatchPixels'],16)
        self.assertEqual(result['summary']['harmonicInferredPixels'],9)
        self.assertFalse(result['summary']['temporalInteriorPaste'])

    def test_cross_shot_distant_or_absent_evidence_cannot_fill_unobserved_skin(self):
        args = self.inputs()
        args['current_visible'][:] = False
        args['existing_support'][:] = False
        shape = args['current_visible'].shape
        for frame in [9, 21]:
            args['source_shot'] = (10, 20)
            args['neighbours'] = [dict(frame=frame, visible=np.ones(shape, bool), residual=np.full(shape+(3,), 30, np.float32), credible=True)]
            result = appearance.reconstruct(**args)
            self.assertEqual(result['summary']['acceptedPixels'], 0)
            self.assertTrue(result['remainingUnknown'][38, 48])
            self.assertFalse(result['timeInferredBoundary'].any())

    def test_large_component_and_total_area_are_rejected(self):
        args = self.inputs()
        args['editable'][:] = False
        args['editable'][20:40, 20:40] = True
        args['current_visible'][args['editable']] = False
        args['existing_support'] = args['current_visible'].copy()
        result = appearance.reconstruct(**args)
        self.assertEqual(result['summary']['acceptedPixels'], 0)
        self.assertIn('component exceeds', result['summary']['components'][0]['reason'])
        args['whole_face_area'] = 100
        result = appearance.reconstruct(**args)
        self.assertIn('total repair exceeds', result['summary']['components'][0]['reason'])

    def test_reviewed_patch_overrides_old_hand_but_features_roi_and_other_hand_are_exact(self):
        args = self.inputs()
        args['editable'][:] = False
        args['reviewed_region'][34:44, 44:54] = True
        args['old_hand'][34:44, 44:59] = True
        args['surface'][:35] = False  # ROI exterior
        args['surface'][39:41, 49:51] = False  # protected eye/lip/nose core
        result = appearance.reconstruct(**args)
        self.assertGreater(result['summary']['oldHandAuthorizedOverridePixels'], 0)
        original = np.full((80, 100, 3), 100, np.uint8)
        clean = np.full_like(original, 150, dtype=np.float32)
        final = appearance.compose(original, clean, result['residual'], result['acceptedPatch'], result['spatialFeather'])
        protected = (~args['surface']) | (args['old_hand'] & ~args['reviewed_region'])
        self.assertTrue(np.array_equal(final[protected], original[protected]))
        self.assertTrue(np.array_equal(final[~result['acceptedPatch']], original[~result['acceptedPatch']]))
        self.assertTrue(np.any(final[result['oldHandOverride']] != original[result['oldHandOverride']]))

    def test_changing_only_clock_origin_has_no_material_transparency_curve(self):
        args = self.inputs()
        first = appearance.reconstruct(**args)
        args['current_frame'] += 100
        args['source_shot'] = (100, 30)
        second = appearance.reconstruct(**args)
        self.assertTrue(np.array_equal(first['residual'], second['residual']))
        self.assertTrue(np.array_equal(first['spatialFeather'], second['spatialFeather']))
        self.assertFalse(first['summary']['temporalFade'])

    def test_hidden_reference_or_no_trustworthy_controls_remain_explicitly_unknown(self):
        args = self.inputs()
        args['current_visible'][:] = False
        args['existing_support'][:] = False
        result = appearance.reconstruct(**args)
        self.assertEqual(result['summary']['acceptedPixels'], 0)
        self.assertTrue(result['remainingUnknown'][38, 48])
        self.assertIn('boundary points', result['summary']['components'][0]['reason'])


class AppearanceEngineTests(unittest.TestCase):
    class Detector(test_worker.StreamingEngineTests.FakeDetector):
        components = {"left_eye": [(0, 0)], "right_eye": [(1, 1)], "nose": [], "lips": []}

    def fixture(self, folder):
        result = test_worker.StreamingEngineTests().fixture(folder)
        result['processing']['maxSide'] = 160
        result['calibration']['appearanceKeyframes'] = [{'frameIndex': 1, 'reviewed': True, 'region': [
            {'x': .47, 'y': .44}, {'x': .49, 'y': .44}, {'x': .49, 'y': .49}, {'x': .47, 'y': .49}]}]
        return result

    def protocol_fixture(self, folder):
        request = self.fixture(folder)
        for name in ['face', 'hand']:
            request['runtime'].setdefault('models', {})[name] = {'file': str(Path(folder) / (name + '.task'))}
        request['processing']['appearanceReconstruction'] = {'enabled': True, 'method': appearance.METHOD}
        return request

    def test_omitted_and_disabled_branch_produce_identical_frame_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            request = self.fixture(folder)
            before = run(request, detector_factory=self.Detector)
            request['processing']['appearanceReconstruction'] = {'enabled': False, 'method': appearance.METHOD}
            request['outputDirectory'] = str(Path(folder) / 'disabled')
            after = run(request, detector_factory=self.Detector)
            self.assertEqual([r['sha256'] for r in before['frames']], [r['sha256'] for r in after['frames']])
            self.assertFalse(any('appearanceReconstruction' in r for r in after['frames']))

    def test_enabled_artifacts_are_exact_frame_and_preserve_shot_stays_unmodified(self):
        with tempfile.TemporaryDirectory() as folder:
            request = self.fixture(folder)
            request['processing']['appearanceReconstruction'] = {'enabled': True, 'method': appearance.METHOD}
            request['calibration']['shots'] = [
                {'sourceStartFrame': 0, 'sourceFrames': 2, 'targetStartFrame': 0, 'targetFrames': 2, 'mode': 'material', 'reviewed': True},
                {'sourceStartFrame': 2, 'sourceFrames': 1, 'targetStartFrame': 2, 'targetFrames': 1, 'mode': 'preserve', 'reviewed': True}]
            result = run(request, detector_factory=self.Detector)
            self.assertEqual(result['status'], 'preview_ready', result['riskFrames'])
            rows = result['frames']
            self.assertEqual(rows[0]['appearanceReconstruction']['requestedPixels'], 0)
            self.assertGreater(rows[1]['appearanceReconstruction']['sameFrameMeasuredPatchPixels'], 0)
            self.assertNotIn('appearanceReconstruction', rows[2])
            self.assertEqual(rows[2]['editablePixels'], 0)
            self.assertEqual(result['checks']['changedOutsideEditablePixels'], 0)
            with np.load(rows[1]['appearanceArtifacts']['evidenceFile']) as evidence:
                measured = evidence['acceptedPatch'] & evidence['currentMeasured']
                self.assertTrue(np.array_equal(evidence['residual'][measured], evidence['currentAppearanceResidualBGR'][measured]))
                self.assertIn('currentObservedResidualBGR', evidence.files)
                self.assertIn('sourceRawBinarySignal', evidence.files)
                self.assertTrue(rows[1]['appearanceReconstruction']['materialConfidence']['rawBinaryEvidenceRetained'])

    def test_protocol_refuses_unreviewed_regions_and_preserve_shot_authorization(self):
        with tempfile.TemporaryDirectory() as folder:
            request = self.fixture(folder)
            for name in ['face', 'hand']:
                request['runtime'].setdefault('models', {})[name] = {'file': str(Path(folder) / (name + '.task'))}
            request['processing']['appearanceReconstruction'] = {'enabled': True, 'method': appearance.METHOD}
            validate_request(request, verify_files=False)
            request['calibration']['appearanceKeyframes'][0]['reviewed'] = False
            with self.assertRaisesRegex(CalibrationError, 'explicitly reviewed'):
                validate_request(request, verify_files=False)
            request['calibration']['appearanceKeyframes'][0]['reviewed'] = True
            request['calibration']['shots'][0]['mode'] = 'preserve'
            with self.assertRaisesRegex(CalibrationError, 'reviewed target material shot'):
                validate_request(request, verify_files=False)

    def test_actual_api_schema_uses_global_calibration_review_not_per_shot_field(self):
        with tempfile.TemporaryDirectory() as folder:
            request = self.fixture(folder)
            for name in ['face', 'hand']:
                request['runtime'].setdefault('models', {})[name] = {'file': str(Path(folder) / (name + '.task'))}
            request['processing']['appearanceReconstruction'] = {'enabled': True, 'method': appearance.METHOD, 'isGroundTruth': False}
            self.assertTrue(request['calibration']['reviewed'])
            self.assertNotIn('reviewed', request['calibration']['shots'][0])
            validate_request(request, verify_files=False)
            request['calibration']['reviewed'] = False
            with self.assertRaisesRegex(CalibrationError, 'reviewed calibration'):
                validate_request(request, verify_files=False)

    def test_disabled_or_analyse_can_keep_unfinished_appearance_drafts(self):
        with tempfile.TemporaryDirectory() as folder:
            request = self.protocol_fixture(folder)
            request['calibration']['appearanceKeyframes'][0].update(region=[{'x': .3, 'y': .4}], reviewed=False)
            request['processing']['appearanceReconstruction']['enabled'] = False
            validate_request(request, verify_files=False)
            request['processing']['appearanceReconstruction']['enabled'] = True
            with self.assertRaisesRegex(CalibrationError, 'at least 3'):
                validate_request(request, verify_files=False)
            request['action'] = 'analyse'
            request['calibration']['reviewed'] = False
            validate_request(request, verify_files=False)
            request['calibration']['appearanceKeyframes'][0]['region'][0]['x'] = 2.
            with self.assertRaisesRegex(CalibrationError, 'normalized coordinates'):
                validate_request(request, verify_files=False)

    def test_hand_calibration_limit_matches_api_120_then_rejects_121(self):
        with tempfile.TemporaryDirectory() as folder:
            request = self.protocol_fixture(folder)
            keyframe = {'side': 'target', 'frameIndex': 1, 'strokes': []}
            request['calibration']['handKeyframes'] = [keyframe.copy() for _ in range(120)]
            validate_request(request, verify_files=False)
            request['calibration']['handKeyframes'].append(keyframe.copy())
            with self.assertRaisesRegex(CalibrationError, 'At most120'):
                validate_request(request, verify_files=False)

    def test_same_shot_cleanup_donor_needs_no_global_donor_review(self):
        with tempfile.TemporaryDirectory() as folder:
            request = self.protocol_fixture(folder)
            request['calibration']['appearanceKeyframes'] = []
            request['calibration']['shots'][0]['mode'] = 'preserve'
            request['calibration']['donorReviewed'] = False
            request['targetSkin'] = None
            request['calibration']['postCutCleanup'] = [{'targetStartFrame': 0, 'targetFrames': 3,
                'region': request['calibration']['targetRegion'], 'donorFrameIndex': 0, 'reviewed': True}]
            validate_request(request, verify_files=False)
            del request['calibration']['postCutCleanup'][0]['donorFrameIndex']
            with self.assertRaisesRegex(CalibrationError, 'target-owned donor'):
                validate_request(request, verify_files=False)

    def test_failed_automatic_tiny_repair_uses_original_gate_but_reviewed_failure_blocks(self):
        real_reconstruct = appearance.reconstruct
        def missing_boundary(*args):
            bound = inspect.signature(real_reconstruct).bind(*args).arguments
            # Two lost support pixels with no trustworthy appearance controls.
            bound['current_visible'] = np.zeros_like(bound['current_visible'])
            bound['neighbours'] = []
            bound['existing_support'] = bound['existing_support'].copy()
            for y, x in np.argwhere(bound['editable'])[:2]:
                bound['existing_support'][y, x] = False
            return real_reconstruct(**bound)
        with tempfile.TemporaryDirectory() as folder:
            request = self.fixture(folder)
            reviewed = request['calibration'].pop('appearanceKeyframes')
            request['processing']['appearanceReconstruction'] = {'enabled': True, 'method': appearance.METHOD}
            with patch('worker.local_material.appearance.reconstruct', side_effect=missing_boundary):
                result = run(request, detector_factory=self.Detector)
            self.assertEqual(result['status'], 'preview_ready', result['riskFrames'])
            self.assertEqual(result['frames'][1]['appearanceReconstruction']['rejectedAutomaticPixels'], 2)
            self.assertEqual(result['frames'][1]['appearanceReconstruction']['remainingUnknownPixels'], 2)
            request['calibration']['appearanceKeyframes'] = reviewed
            request['outputDirectory'] = str(Path(folder) / 'reviewed_failure')
            with patch('worker.local_material.appearance.reconstruct', side_effect=missing_boundary):
                result = run(request, detector_factory=self.Detector)
            self.assertEqual(result['status'], 'needs_calibration')
            self.assertGreater(result['frames'][1]['appearanceReconstruction']['rejectedReviewedPixels'], 0)
            self.assertTrue(any('Artistic appearance component' in r['reason'] for r in result['riskFrames']))


if __name__ == '__main__':
    unittest.main()
