import os
import re
import uuid
import asyncio
import tempfile
import subprocess
from pathlib import Path
from typing import Optional, Dict, Tuple
import httpx

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

DOWNLOAD_CACHE_DIR = Path(tempfile.gettempdir()) / "douyin_bilibili_hub_downloads"
DOWNLOAD_CACHE_DIR.mkdir(parents=True, exist_ok=True)


def get_referer_for_url(url: str) -> str:
    lower = url.lower()
    if any(k in lower for k in ["bilibili.com", "hdslb.com", "bilivideo.com", "b23.tv"]):
        return "https://www.bilibili.com/"
    if any(k in lower for k in ["toutiao", "byteimg.com", "pstatp.com"]):
        return "https://so.toutiao.com/"
    if any(k in lower for k in ["susercontent.com", "shopee"]):
        return "https://shopee.co.th/"
    return "https://www.douyin.com/"


def sanitize_filename(name: str, default: str = "video") -> str:
    cleaned = re.sub(r'[\\/*?:"<>|\r\n\t]+', "_", name or "").strip(" ._")
    if not cleaned:
        cleaned = default
    return cleaned[:90]


async def download_with_ytdlp(
    url: str,
    title: str = "video",
    cookie_str: Optional[str] = None,
    audio_only: bool = False,
) -> Tuple[Optional[Path], Optional[str]]:
    """
    Uses yt-dlp + ffmpeg to download a video (Bilibili or Douyin) into a local temp MP4/MP3 file.
    Returns (file_path, error_message).
    """
    safe_name = sanitize_filename(title)
    unique_id = uuid.uuid4().hex[:8]
    ext = "mp3" if audio_only else "mp4"
    output_template = str(DOWNLOAD_CACHE_DIR / f"{safe_name}_{unique_id}.%(ext)s")
    final_expected = DOWNLOAD_CACHE_DIR / f"{safe_name}_{unique_id}.{ext}"

    cmd = [
        "yt-dlp",
        "--no-playlist",
        "--no-warnings",
        "--user-agent",
        USER_AGENT,
        "--referer",
        get_referer_for_url(url),
        "-o",
        output_template,
    ]

    if audio_only:
        cmd.extend(["-x", "--audio-format", "mp3"])
    else:
        cmd.extend([
            "-f",
            "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
            "--merge-output-format",
            "mp4",
        ])

    cookie_file: Optional[Path] = None
    if cookie_str and ("douyin" in url.lower()):
        cmd.extend(["--add-header", f"Cookie: {cookie_str}"])

    cmd.append(url)

    def _run():
        return subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180,
        )

    try:
        proc = await asyncio.to_thread(_run)
        if final_expected.exists() and final_expected.stat().st_size > 0:
            return final_expected, None

        # Find any matching file with unique_id
        matches = list(DOWNLOAD_CACHE_DIR.glob(f"*_{unique_id}.*"))
        if matches:
            return matches[0], None

        err = (proc.stderr or proc.stdout or "yt-dlp failed").strip()
        return None, err
    except Exception as exc:
        return None, str(exc)
    finally:
        if cookie_file and cookie_file.exists():
            try:
                cookie_file.unlink()
            except Exception:
                pass
