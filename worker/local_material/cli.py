import argparse
import json
import sys
from pathlib import Path
from .protocol import CalibrationError, atomic_json, validate_request
from .engine import run

def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    parser = argparse.ArgumentParser(description="Offline material worker; no provider requests")
    parser.add_argument("--request", required=True)
    parser.add_argument("--result", required=True)
    parser.add_argument("--output-dir")
    parser.add_argument("--cancel-file")
    args = parser.parse_args()
    request = json.loads(Path(args.request).read_text(encoding="utf-8-sig"))
    if args.output_dir:
        request["outputDirectory"] = str(Path(args.output_dir).resolve())
    if args.cancel_file:
        request["cancelFile"] = str(Path(args.cancel_file).resolve())
    def progress(value):
        print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)
    try:
        validate_request(request)
        result = run(request, progress)
    except (CalibrationError, OSError, ValueError, RuntimeError, ImportError) as error:
        result = {"schemaVersion": 1, "action": request.get("action"), "requestHash": request.get("requestHash"), "revision": request.get("revision"), "status": "needs_calibration", "riskFrames": [{"id": "worker-input", "targetFrame": None, "reason": str(error), "code": "INPUT_CALIBRATION_REQUIRED", "side": None, "resolved": False, "details": getattr(error, "details", {})}], "checks": {"calibrated": False, "lowSupportCount": 1, "changedOutsideEditablePixels": 0}}
    atomic_json(args.result, result)
    progress({"phase": "finished", "status": result["status"], "resultFile": str(Path(args.result).resolve())})

if __name__ == "__main__":
    main()
