"""Installed-runtime smoke: no customer inputs, downloads, providers or writes."""
from pathlib import Path
import hashlib
import json
import sys
import cv2
import numpy as np
import mediapipe as mp
from mediapipe.tasks.python import vision

root = Path(sys.executable).resolve().parent
manifest = json.loads((root / 'runtime-manifest.json').read_text(encoding='utf-8'))
assert sys.flags.isolated and sys.flags.utf8_mode
assert sys.version.split()[0] == manifest['pythonVersion']
for module in (cv2, np, mp):
    assert Path(module.__file__).resolve().is_relative_to(root), module.__name__
image = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.zeros((256, 256, 3), np.uint8))
for kind, cls, options in (
    ('face', vision.FaceLandmarker, vision.FaceLandmarkerOptions),
    ('hand', vision.HandLandmarker, vision.HandLandmarkerOptions),
):
    model = manifest['models'][kind]
    contents = (root / model['file']).read_bytes()
    assert hashlib.sha256(contents).hexdigest() == model['sha256']
    with cls.create_from_options(options(base_options=mp.tasks.BaseOptions(model_asset_buffer=contents), running_mode=vision.RunningMode.IMAGE)) as detector:
        detector.detect(image)
print(json.dumps({'python': sys.version.split()[0], 'importsBundled': True, 'modelsLoaded': ['face', 'hand'], 'networkCalls': 0}))
