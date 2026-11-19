"""
Central path resolution that works both when running from source and when
frozen into a one-file PyInstaller .exe.

- BUNDLE_DIR : read-only resources shipped inside the build (the `static/`
  folder). When frozen this is the temp extraction dir (sys._MEIPASS).
- DATA_ROOT  : writable location for user data (config.json, data/). When
  frozen this sits NEXT TO the .exe so cookies/keys/cache survive restarts
  and are never baked into the distributed binary.

When running from source both point at the project root, so behaviour is
identical to before.
"""

from __future__ import annotations

import sys
from pathlib import Path

_FROZEN = bool(getattr(sys, "frozen", False))

if _FROZEN:
    # PyInstaller one-file: resources are unpacked to _MEIPASS; the .exe
    # itself lives in a stable, writable folder next to the user's data.
    BUNDLE_DIR = Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
    if sys.platform == "darwin":
        # macOS .app: the bundle is read-only (and may run from a translocated
        # copy), so user data lives in ~/Library/Application Support instead.
        DATA_ROOT = Path.home() / "Library" / "Application Support" / "DouyinBilibiliHub"
        DATA_ROOT.mkdir(parents=True, exist_ok=True)
    else:
        DATA_ROOT = Path(sys.executable).resolve().parent
else:
    _PROJECT_ROOT = Path(__file__).resolve().parent.parent
    BUNDLE_DIR = _PROJECT_ROOT
    DATA_ROOT = _PROJECT_ROOT

STATIC_DIR = BUNDLE_DIR / "static"
CONFIG_PATH = DATA_ROOT / "config.json"
CHANNELS_FILE = DATA_ROOT / "shopee_channels.json"
DATA_DIR = DATA_ROOT / "data"
