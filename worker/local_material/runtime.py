"""CPU model loading from verified local bytes; no download or Torch."""
import cv2
import numpy as np

class Detector:
    def __init__(self, runtime):
        import mediapipe as mp
        from mediapipe.tasks.python import vision
        self.mp, self.vision = mp, vision
        from pathlib import Path
        options = dict(running_mode=vision.RunningMode.IMAGE, min_face_detection_confidence=.5, min_face_presence_confidence=.5)
        self.face = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(base_options=mp.tasks.BaseOptions(model_asset_buffer=Path(runtime["models"]["face"]["file"]).read_bytes()), num_faces=2, **options))
        self.hand = vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(base_options=mp.tasks.BaseOptions(model_asset_buffer=Path(runtime["models"]["hand"]["file"]).read_bytes()), running_mode=vision.RunningMode.IMAGE, num_hands=2, min_hand_detection_confidence=.5, min_hand_presence_confidence=.5))
        self.components = {name.removeprefix("FACE_LANDMARKS_").lower(): [[int(e.start), int(e.end)] for e in getattr(vision.FaceLandmarksConnections, name)] for name in dir(vision.FaceLandmarksConnections) if name.startswith("FACE_LANDMARKS_")}
        self.hand_edges = [[int(e.start), int(e.end)] for e in vision.HandLandmarksConnections.HAND_CONNECTIONS]

    def detect(self, image):
        height, width = image.shape[:2]
        frame = self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=np.ascontiguousarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB)))
        face, hand = self.face.detect(frame), self.hand.detect(frame)
        convert = lambda points: np.float32([[p.x * width, p.y * height] for p in points])
        return {"faces": [convert(p) for p in face.face_landmarks], "hands": [convert(p) for p in hand.hand_landmarks], "pointVisibility": None, "pointPresence": None, "detectedIsVisible": False}

    def close(self):
        self.face.close()
        self.hand.close()
