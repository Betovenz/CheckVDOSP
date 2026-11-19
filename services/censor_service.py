"""
Lightweight CPU Chinese-text detection & video censoring service for Studio.
1. Scans frames sequentially with RapidOCR (ONNXRuntime, no PyTorch) + frame-diff skipping.
2. Renders a censored H.264 MP4 (with original audio preserved) via FFmpeg so the
   preview, clip modal, and exported video all use the actual censored clip.
"""
from __future__ import annotations

import bisect
import json
import re
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import cv2
import imageio_ffmpeg
import numpy as np

_ZH_RE = re.compile(r"[\u4e00-\u9fff]")
_OCR_LOCK = threading.Lock()
_OCR_INSTANCE = None
_CENSOR_PROGRESS: Dict[str, Dict[str, Any]] = {}


def _get_ocr():
    global _OCR_INSTANCE
    if _OCR_INSTANCE is None:
        with _OCR_LOCK:
            if _OCR_INSTANCE is None:
                from rapidocr_onnxruntime import RapidOCR

                _OCR_INSTANCE = RapidOCR(use_cls=False)
    return _OCR_INSTANCE


def get_censor_progress(cache_key: str) -> Dict[str, Any]:
    return _CENSOR_PROGRESS.get(cache_key) or {"status": "idle", "pct": 0}


def scan_video_chinese_boxes(
    video_path: str,
    cache_key: str = "",
    json_cache_path: Optional[Path] = None,
    force: bool = False,
    progress_range: Tuple[int, int] = (1, 99),
) -> Dict[str, Any]:
    p_start, p_end = progress_range
    if not force and json_cache_path and json_cache_path.exists():
        try:
            cached = json.loads(json_cache_path.read_text(encoding="utf-8"))
            if isinstance(cached, dict) and "timeline" in cached:
                if cache_key:
                    _CENSOR_PROGRESS[cache_key] = {"status": "scanning", "pct": p_end}
                return cached
        except Exception:
            pass

    if cache_key:
        _CENSOR_PROGRESS[cache_key] = {"status": "scanning", "pct": p_start}

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        if cache_key:
            _CENSOR_PROGRESS[cache_key] = {"status": "error", "pct": 0}
        raise RuntimeError("ไม่สามารถเปิดไฟล์วิดีโอเพื่อสแกนได้")

    try:
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 30.0)
        if fps <= 1.0 or fps > 120.0:
            fps = 30.0
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        dur = total_frames / fps if total_frames > 0 else 0.0

        step_sec = 0.6 if dur <= 20.0 else (1.0 if dur <= 60.0 else 1.5)
        step_frames = max(1, int(round(fps * step_sec)))

        ocr = _get_ocr()
        timeline: List[Dict[str, Any]] = []
        prev_tiny = None
        prev_boxes: List[List[float]] = []

        frame_idx = 0
        while True:
            ok = cap.grab()
            if not ok:
                break

            if frame_idx % step_frames == 0:
                ret, frame = cap.retrieve()
                if not ret or frame is None:
                    frame_idx += 1
                    continue

                h, w = frame.shape[:2]
                max_dim = max(w, h)
                if max_dim > 448:
                    scale = 448.0 / max_dim
                    small = cv2.resize(frame, (max(1, int(w * scale)), max(1, int(h * scale))))
                else:
                    small = frame
                sh, sw = small.shape[:2]

                tiny = cv2.resize(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), (96, 96))
                if prev_tiny is not None and float(np.mean(cv2.absdiff(tiny, prev_tiny))) < 2.2:
                    boxes = prev_boxes
                else:
                    res, _ = ocr(small)
                    boxes = []
                    for item in res or []:
                        poly, text, score = item[0], item[1], item[2]
                        if not _ZH_RE.search(text or ""):
                            continue
                        if float(score or 0) < 0.40:
                            continue
                        xs = [float(p[0]) for p in poly]
                        ys = [float(p[1]) for p in poly]
                        nx1 = max(0.0, min(xs) / sw - 0.015)
                        ny1 = max(0.0, min(ys) / sh - 0.012)
                        nx2 = min(1.0, max(xs) / sw + 0.015)
                        ny2 = min(1.0, max(ys) / sh + 0.012)
                        boxes.append([
                            round(nx1, 4),
                            round(ny1, 4),
                            round(max(0.01, nx2 - nx1), 4),
                            round(max(0.01, ny2 - ny1), 4),
                        ])
                    prev_tiny = tiny
                    prev_boxes = boxes

                t = round(frame_idx / fps, 2)
                timeline.append({"t": t, "boxes": boxes})
                if cache_key and total_frames > 0:
                    ratio = min(1.0, frame_idx / total_frames)
                    pct = int(p_start + ratio * (p_end - p_start))
                    _CENSOR_PROGRESS[cache_key] = {
                        "status": "scanning",
                        "pct": min(p_end, max(p_start, pct)),
                        "t": t,
                        "dur": round(dur, 1),
                    }

            frame_idx += 1

        result = {
            "duration": round(dur, 2),
            "step": step_sec,
            "timeline": timeline,
            "hits": sum(1 for entry in timeline if entry["boxes"]),
        }
        if json_cache_path:
            try:
                json_cache_path.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
            except Exception:
                pass
        return result
    finally:
        cap.release()


def _box_iou(a: List[float], b: List[float]) -> float:
    ax1, ay1, aw, ah = a
    bx1, by1, bw, bh = b
    ax2, ay2 = ax1 + aw, ay1 + ah
    bx2, by2 = bx1 + bw, by1 + bh
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    if inter <= 0.0:
        return 0.0
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0.0 else 0.0


def _boxes_at_time(
    times: List[float],
    timeline: List[Dict[str, Any]],
    t: float,
    lead_sec: float = 3.0,
) -> List[List[float]]:
    if not timeline:
        return []

    # 1. Nearest sample at current time t
    idx = bisect.bisect_left(times, t)
    if idx == 0:
        nearest_idx = 0
    elif idx >= len(times):
        nearest_idx = len(times) - 1
    else:
        nearest_idx = idx if (times[idx] - t) < (t - times[idx - 1]) else idx - 1

    collected: List[List[float]] = list(timeline[nearest_idx]["boxes"])

    # 2. Extend each detected box backward by `lead_sec` (e.g. 2.0s before first detection)
    if lead_sec > 0:
        start_i = bisect.bisect_left(times, t)
        end_i = bisect.bisect_right(times, t + lead_sec)
        for j in range(start_i, min(end_i, len(timeline))):
            for box in timeline[j]["boxes"]:
                if not any(_box_iou(box, existing) > 0.50 for existing in collected):
                    collected.append(box)

    return collected


def censor_and_render_video(
    video_path: str,
    out_mp4_path: Path,
    cache_key: str = "",
    json_cache_path: Optional[Path] = None,
    force: bool = False,
) -> Dict[str, Any]:
    scan_res = scan_video_chinese_boxes(
        video_path,
        cache_key=cache_key,
        json_cache_path=json_cache_path,
        force=force,
        progress_range=(1, 60),
    )

    timeline = scan_res.get("timeline") or []
    hits = int(scan_res.get("hits") or 0)
    out_mp4_path = Path(out_mp4_path)
    out_mp4_path.parent.mkdir(parents=True, exist_ok=True)

    if hits == 0 or not timeline:
        shutil.copy2(str(video_path), str(out_mp4_path))
        if cache_key:
            _CENSOR_PROGRESS[cache_key] = {"status": "done", "pct": 100}
        return scan_res

    if cache_key:
        _CENSOR_PROGRESS[cache_key] = {"status": "rendering", "pct": 62}

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError("ไม่สามารถเปิดไฟล์วิดีโอเพื่อเรนเดอร์เซนเซอร์ได้")

    tmp_out = out_mp4_path.with_suffix(".tmp.mp4")
    proc = None
    try:
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 30.0)
        if fps <= 1.0 or fps > 120.0:
            fps = 30.0
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        if w <= 0 or h <= 0:
            raise RuntimeError("ขนาดวิดีโอไม่ถูกต้อง")

        ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
        cmd = [
            ffmpeg_exe,
            "-y",
            "-loglevel",
            "error",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "bgr24",
            "-s",
            f"{w}x{h}",
            "-r",
            f"{fps:.3f}",
            "-i",
            "pipe:0",
            "-i",
            str(video_path),
            "-map",
            "0:v:0",
            "-map",
            "1:a?",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "copy",
            "-movflags",
            "+faststart",
            str(tmp_out),
        ]
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            creationflags=creationflags,
        )

        times = [float(entry["t"]) for entry in timeline]
        frame_idx = 0
        while True:
            ret, frame = cap.read()
            if not ret or frame is None:
                break

            t = frame_idx / fps
            boxes = _boxes_at_time(times, timeline, t)
            for b in boxes:
                rx1 = max(0, int(b[0] * w) - 10)
                ry1 = max(0, int(b[1] * h) - 6)
                rx2 = min(w, int((b[0] + b[2]) * w) + 10)
                ry2 = min(h, int((b[1] + b[3]) * h) + 6)
                rw = rx2 - rx1
                rh = ry2 - ry1
                if rw > 4 and rh > 4:
                    roi = frame[ry1:ry2, rx1:rx2]
                    tiny_w = max(4, min(10, round(rw / 36)))
                    tiny_h = max(3, min(6, round(rh / 28)))
                    tiny = cv2.resize(roi, (tiny_w, tiny_h), interpolation=cv2.INTER_AREA)
                    blurred = cv2.resize(tiny, (rw, rh), interpolation=cv2.INTER_LINEAR)
                    overlay = np.full_like(blurred, (42, 23, 15))
                    frame[ry1:ry2, rx1:rx2] = cv2.addWeighted(blurred, 0.84, overlay, 0.16, 0)

            assert proc.stdin is not None
            proc.stdin.write(frame.tobytes())
            frame_idx += 1

            if cache_key and total_frames > 0 and frame_idx % 15 == 0:
                pct = 62 + int((frame_idx / total_frames) * 37)
                _CENSOR_PROGRESS[cache_key] = {"status": "rendering", "pct": min(99, pct)}

        if proc.stdin:
            proc.stdin.close()
        stderr_bytes = proc.stderr.read() if proc.stderr else b""
        rc = proc.wait()
        if rc != 0 or not tmp_out.exists() or tmp_out.stat().st_size <= 10000:
            err_msg = stderr_bytes.decode("utf-8", errors="ignore").strip()
            raise RuntimeError(f"FFmpeg render failed: {err_msg or rc}")

        tmp_out.replace(out_mp4_path)
        if cache_key:
            _CENSOR_PROGRESS[cache_key] = {"status": "done", "pct": 100}
        return scan_res
    except Exception:
        if cache_key:
            _CENSOR_PROGRESS[cache_key] = {"status": "error", "pct": 0}
        if proc and proc.poll() is None:
            proc.kill()
        if tmp_out.exists():
            try:
                tmp_out.unlink()
            except OSError:
                pass
        raise
    finally:
        cap.release()
