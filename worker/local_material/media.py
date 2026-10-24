"""Bounded-memory video access and explicit aspect-preserving processing."""
from pathlib import Path
import cv2
import numpy as np
from .protocol import CalibrationError, atomic_bytes, check_cancel

def processing_size(width, height, max_side):
    if max_side < 64:
        raise CalibrationError("processing.maxSide must be at least64")
    scale = min(1.0, max_side / max(width, height))
    return max(1, round(width * scale)), max(1, round(height * scale))

def read_image(path):
    image = cv2.imdecode(np.fromfile(str(path), np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise CalibrationError("Unable to decode local image")
    return image

def save_png(path, image):
    ok, encoded = cv2.imencode(".png", image)
    if not ok:
        raise CalibrationError("Unable to encode diagnostic frame")
    atomic_bytes(path, encoded.tobytes())

class VideoReader:
    """Keeps one decoded frame; monotonic requests stream rather than load video."""
    def __init__(self, metadata, max_side, cancel_file=None):
        self.metadata = metadata
        self.cancel_file = cancel_file
        self.cap = cv2.VideoCapture(str(metadata["file"]))
        if not self.cap.isOpened():
            raise CalibrationError("Cannot open video")
        self.native_size = (int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT)))
        self.fps = float(self.cap.get(cv2.CAP_PROP_FPS))
        decoded_count = int(self.cap.get(cv2.CAP_PROP_FRAME_COUNT))
        if self.native_size != (metadata["width"], metadata["height"]) or abs(self.fps - metadata["fps"]) > .01 or decoded_count > 0 and decoded_count != metadata["frames"]:
            self.cap.release()
            raise CalibrationError("Decoded video dimensions/fps differ from request")
        self.size = processing_size(*self.native_size, max_side)
        self.index = -1
        self.current = None

    def get(self, index):
        check_cancel(self.cancel_file)
        if index < self.index or self.index == -1 and index > 0:
            self.cap.set(cv2.CAP_PROP_POS_FRAMES, index)
            self.index = index - 1
        while self.index < index:
            check_cancel(self.cancel_file)
            ok, image = self.cap.read()
            if not ok:
                raise CalibrationError("Video decode ended before requested real frame")
            self.index += 1
            self.current = image
        image = self.current
        if (image.shape[1], image.shape[0]) != self.size:
            image = cv2.resize(image, self.size, interpolation=cv2.INTER_AREA)
        return image.copy()

    def close(self):
        self.cap.release()
