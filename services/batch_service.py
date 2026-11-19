"""
Page 3 (ทำหลายคลิป) storage + the shared "save rendered clips to a folder" helpers.

- Projects are kept in data/batch/projects.json so a 10-clip batch survives a refresh
  or an app restart. Voice-over audio is large, so it lives next to it as one file per
  project (data/batch/audio/<id>.<ext>) instead of inside the JSON.
- The output folder (where finished MP4s are written) is shared by page 2 and page 3
  and stored in data/studio_config.json as "output_dir".
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from services.paths import DATA_DIR
from services.video_studio_service import STUDIO_CONFIG_PATH, load_studio_config

BATCH_DIR = DATA_DIR / "batch"
BATCH_AUDIO_DIR = BATCH_DIR / "audio"
PROJECTS_PATH = BATCH_DIR / "projects.json"
BATCH_AUDIO_DIR.mkdir(parents=True, exist_ok=True)

_SAFE_ID_RE = re.compile(r"[^a-zA-Z0-9_\-]")
_AUDIO_EXT = {"audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav",
              "audio/ogg": "ogg", "audio/webm": "webm", "audio/aac": "aac", "audio/mp4": "m4a"}


def safe_id(raw: str) -> str:
    return _SAFE_ID_RE.sub("", raw or "")[:60]


# --------------------------------------------------------------------------- projects
def load_projects() -> Dict[str, Any]:
    if PROJECTS_PATH.exists():
        try:
            data = json.loads(PROJECTS_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                data.setdefault("projects", [])
                data.setdefault("defaults", {})
                return data
        except Exception:
            pass
    return {"projects": [], "defaults": {}}


def save_projects(projects: List[Dict[str, Any]], defaults: Dict[str, Any]) -> None:
    BATCH_DIR.mkdir(parents=True, exist_ok=True)
    payload = {"projects": projects, "defaults": defaults}
    tmp = PROJECTS_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    tmp.replace(PROJECTS_PATH)
    # Drop voice files of projects that were deleted
    keep = {safe_id(str(p.get("id", ""))) for p in projects}
    for f in BATCH_AUDIO_DIR.glob("*"):
        if f.stem not in keep:
            try:
                f.unlink()
            except OSError:
                pass


def audio_path(project_id: str) -> Optional[Path]:
    pid = safe_id(project_id)
    if not pid:
        return None
    for f in BATCH_AUDIO_DIR.glob(f"{pid}.*"):
        return f
    return None


def save_audio(project_id: str, mime: str, audio_base64: str) -> Path:
    pid = safe_id(project_id)
    if not pid:
        raise ValueError("Invalid project id")
    raw = base64.b64decode(audio_base64 or "", validate=False)
    if len(raw) < 100:
        raise ValueError("ไฟล์เสียงว่างเปล่า")
    for old in BATCH_AUDIO_DIR.glob(f"{pid}.*"):
        try:
            old.unlink()
        except OSError:
            pass
    ext = _AUDIO_EXT.get((mime or "").split(";")[0].strip().lower(), "mp3")
    out = BATCH_AUDIO_DIR / f"{pid}.{ext}"
    out.write_bytes(raw)
    return out


# --------------------------------------------------------------------------- output folder
def default_output_dir() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Movies" / "AI Clips"
    return Path.home() / "Videos" / "AI Clips"


def get_output_dir() -> Path:
    cfg = load_studio_config()
    raw = (cfg.get("output_dir") or "").strip()
    return Path(raw) if raw else default_output_dir()


def set_output_dir(path_str: str) -> Path:
    path = Path(os.path.expandvars(os.path.expanduser((path_str or "").strip().strip('"'))))
    if not str(path_str or "").strip():
        raise ValueError("กรุณาระบุโฟลเดอร์")
    if not path.is_absolute():
        raise ValueError("กรุณาระบุตำแหน่งโฟลเดอร์แบบเต็ม เช่น D:\\คลิปขาย")
    path.mkdir(parents=True, exist_ok=True)
    cfg = load_studio_config()
    cfg["output_dir"] = str(path)
    STUDIO_CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


_BAD_NAME_RE = re.compile(r'[\\/:*?"<>|\r\n\t]+')


def clean_file_stem(name: str, fallback: str = "ai-review-video") -> str:
    stem = _BAD_NAME_RE.sub(" ", name or "").strip().strip(".")
    stem = re.sub(r"\s+", " ", stem)[:80].strip()
    return stem or fallback


def save_to_output(src_file: str, name: str, ext: str = "mp4") -> Path:
    """Copy a finished file into the output folder, never overwriting an existing clip."""
    out_dir = get_output_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = clean_file_stem(name)
    target = out_dir / f"{stem}.{ext}"
    n = 2
    while target.exists():
        target = out_dir / f"{stem} ({n}).{ext}"
        n += 1
    shutil.copyfile(src_file, target)
    return target


def pick_folder_dialog(initial: str = "") -> str:
    """Open the native folder picker (Windows: PowerShell, macOS: AppleScript; no tkinter)."""
    if sys.platform == "darwin":
        return _pick_folder_mac(initial)
    if sys.platform != "win32":
        raise RuntimeError("หน้าต่างเลือกโฟลเดอร์รองรับเฉพาะ Windows/Mac — พิมพ์ตำแหน่งโฟลเดอร์แทนได้")
    init = (initial or "").replace("'", "''")
    script = (
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8;"
        "Add-Type -AssemblyName System.Windows.Forms;"
        "$d=New-Object System.Windows.Forms.FolderBrowserDialog;"
        "$d.Description='เลือกโฟลเดอร์สำหรับเซฟคลิปที่เรนเดอร์เสร็จ';"
        "$d.ShowNewFolderButton=$true;"
        f"if('{init}' -ne '' -and (Test-Path -LiteralPath '{init}')){{$d.SelectedPath='{init}'}};"
        "$f=New-Object System.Windows.Forms.Form -Property @{TopMost=$true;ShowInTaskbar=$false};"
        "if($d.ShowDialog($f) -eq [System.Windows.Forms.DialogResult]::OK){$d.SelectedPath}"
    )
    proc = subprocess.run(
        ["powershell", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=600,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    return proc.stdout.decode("utf-8", errors="ignore").strip()


def _pick_folder_mac(initial: str = "") -> str:
    def q(text: str) -> str:
        return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'

    prompt = "เลือกโฟลเดอร์สำหรับเซฟคลิปที่เรนเดอร์เสร็จ"
    default = f" default location (POSIX file {q(initial)})" if initial and Path(initial).is_dir() else ""
    script = "\n".join([
        "try",
        "  activate",
        f"  set f to choose folder with prompt {q(prompt)}{default}",
        "  return POSIX path of f",
        "on error number -128",
        '  return ""',
        "end try",
    ])
    proc = subprocess.run(["osascript", "-e", script], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=600)
    return proc.stdout.decode("utf-8", errors="ignore").strip().rstrip("/") or ""


def open_in_explorer(path: Path) -> None:
    if sys.platform == "darwin":
        if path.is_file():
            subprocess.Popen(["open", "-R", str(path)])
        else:
            path.mkdir(parents=True, exist_ok=True)
            subprocess.Popen(["open", str(path)])
        return
    if sys.platform != "win32":
        raise RuntimeError("เปิดโฟลเดอร์ได้เฉพาะบน Windows/Mac")
    if path.is_file():
        subprocess.Popen(["explorer", "/select,", str(path)])
    else:
        path.mkdir(parents=True, exist_ok=True)
        os.startfile(str(path))  # type: ignore[attr-defined]
