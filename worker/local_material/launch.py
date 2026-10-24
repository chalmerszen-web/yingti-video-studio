"""Bootstrap using only this deployed worker's trusted package directory."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from local_material.cli import main

if __name__ == "__main__":
    main()
