"""
Automatic cache cleanup for downloaded clips and temp downloads.

Rules (agreed with the user):
- A clip used by a page-3 project is never removed (incl. PC uploads, and its
  censored copy while that project has censor on).
- Anything else is removed once it has not been used for GRACE_DAYS.
  "Used" = the app served the file (we bump its mtime each time).
- If the clip cache grows past CAP_BYTES, unused clips go oldest-first even
  inside the grace period.
- Deleting a project / removing a clip / turning censor off drops the files
  right away when no other project needs them (PC uploads still get the grace
  period, since page 2 may hold one and it can't be downloaded again).
- Page-1 MP4/MP3 downloads are deleted as soon as they are sent; leftovers in
  the temp folder are swept on every run.
"""

from __future__ import annotations

import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set

from services.paths import DATA_DIR

CLIP_CACHE_DIR = DATA_DIR / "clip_cache"
GRACE_DAYS = 3
CAP_BYTES = 5 * 1024**3
INTERVAL_SECONDS = 6 * 3600
TEMP_DOWNLOAD_MAX_AGE = 3600  # a download still being written is never this old

_lock = threading.Lock()
_last: Dict[str, Any] = {"at": 0.0, "freed": 0, "files": 0}


def clip_stem(platform: str, item_id: str) -> str:
    plat = (platform or "").lower().strip()
    safe_id = re.sub(r"[^a-zA-Z0-9_\-]", "", str(item_id or ""))[:60] or "clip"
    return f"{plat}_{safe_id}"


def touch(path: Path) -> None:
    """Mark a cache file as just used."""
    try:
        os.utime(path, None)
    except OSError:
        pass


def _stem_of(f: Path) -> str:
    name = f.name
    for suf in (".censored.mp4", ".censor.json", ".tmp.jpg", ".mp4", ".jpg", ".part"):
        if name.endswith(suf):
            return name[: -len(suf)]
    return f.stem


def _project_refs(projects: Iterable[Dict[str, Any]]) -> tuple[Set[str], Set[str]]:
    """(stems used by projects, stems whose censored copy is still wanted)."""
    used: Set[str] = set()
    censored: Set[str] = set()
    for p in projects or []:
        for c in p.get("clips") or []:
            if not c.get("itemId") or not c.get("platform"):
                continue
            stem = clip_stem(c["platform"], c["itemId"])
            used.add(stem)
            if p.get("censorOn"):
                censored.add(stem)
    return used, censored


def _load_projects() -> List[Dict[str, Any]]:
    from services import batch_service

    try:
        return batch_service.load_projects().get("projects") or []
    except Exception:
        return []


def _unlink(f: Path) -> int:
    try:
        size = f.stat().st_size
        f.unlink()
        return size
    except OSError:
        return 0


def _sweep_temp_downloads() -> tuple[int, int]:
    try:
        from services.downloader import DOWNLOAD_CACHE_DIR
    except Exception:
        return 0, 0
    freed = files = 0
    now = time.time()
    for f in DOWNLOAD_CACHE_DIR.glob("*"):
        try:
            if f.is_file() and now - f.stat().st_mtime > TEMP_DOWNLOAD_MAX_AGE:
                got = _unlink(f)
                if got or not f.exists():
                    freed += got
                    files += 1
        except OSError:
            pass
    return freed, files


def run_cleanup(projects: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """Full pass: temp downloads + clip cache (grace period, then size cap)."""
    with _lock:
        if projects is None:
            projects = _load_projects()
        used, censored = _project_refs(projects)
        now = time.time()
        grace = GRACE_DAYS * 86400
        freed, files = _sweep_temp_downloads()

        candidates = []  # (mtime, path, size) of removable-but-recent files
        total = 0
        if CLIP_CACHE_DIR.exists():
            for f in CLIP_CACHE_DIR.iterdir():
                if not f.is_file():
                    continue
                try:
                    st = f.stat()
                except OSError:
                    continue
                stem = _stem_of(f)
                is_censored = f.name.endswith(".censored.mp4")
                is_part = f.name.endswith(".part")
                if is_part:
                    keep = now - st.st_mtime < TEMP_DOWNLOAD_MAX_AGE
                elif is_censored:
                    keep = stem in censored
                else:
                    keep = stem in used
                if keep:
                    total += st.st_size
                    continue
                if now - st.st_mtime > grace:
                    freed += _unlink(f)
                    files += 1
                else:
                    total += st.st_size
                    candidates.append((st.st_mtime, f, st.st_size))

        if total > CAP_BYTES:
            for _mt, f, size in sorted(candidates, key=lambda x: x[0]):
                if total <= CAP_BYTES:
                    break
                freed += _unlink(f)
                files += 1
                total -= size

        _last.update({"at": now, "freed": freed, "files": files})
        return dict(_last)


def drop_after_project_change(old: List[Dict[str, Any]], new: List[Dict[str, Any]]) -> int:
    """Remove files that a project save just stopped needing. Returns bytes freed."""
    old_used, old_cz = _project_refs(old)
    new_used, new_cz = _project_refs(new)
    freed = 0
    grace = GRACE_DAYS * 86400
    now = time.time()
    with _lock:
        for stem in old_used - new_used:
            f = CLIP_CACHE_DIR / f"{stem}.mp4"
            if stem.startswith("pc_"):
                # page 2 may still hold this upload and it can't be re-downloaded
                try:
                    if now - f.stat().st_mtime < grace:
                        continue
                except OSError:
                    pass
            freed += _unlink(f)
            freed += _unlink(CLIP_CACHE_DIR / f"{stem}.censored.mp4")
            freed += _unlink(CLIP_CACHE_DIR / f"{stem}.jpg")
            freed += _unlink(CLIP_CACHE_DIR / f"{stem}.censor.json")
        for stem in old_cz - new_cz:
            if stem in new_used:  # clip still used, but no project wants it censored now
                freed += _unlink(CLIP_CACHE_DIR / f"{stem}.censored.mp4")
    return freed


def status() -> Dict[str, Any]:
    projects = _load_projects()
    used, _cz = _project_refs(projects)
    total = in_use = 0
    count = 0
    if CLIP_CACHE_DIR.exists():
        for f in CLIP_CACHE_DIR.iterdir():
            try:
                if f.is_file():
                    size = f.stat().st_size
                    total += size
                    count += 1
                    if _stem_of(f) in used:
                        in_use += size
            except OSError:
                pass
    return {
        "total_bytes": total,
        "in_use_bytes": in_use,
        "files": count,
        "last_run_at": _last["at"],
        "last_freed_bytes": _last["freed"],
        "last_freed_files": _last["files"],
        "grace_days": GRACE_DAYS,
        "cap_bytes": CAP_BYTES,
    }
