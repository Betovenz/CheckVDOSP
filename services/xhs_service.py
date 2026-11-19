"""
RedNote / Xiaohongshu (小红书): open shared note links and search notes, using the user's
OWN login cookie (RedNote shows notes and search results only to logged-in accounts and
blocks automated guest browsing).

- Note links: a plain HTTP fetch with the cookie (fast); if RedNote still refuses, the same
  page is read in headless Chrome with the cookie loaded.
- Search: always headless Chrome with the cookie (results are built by the page's own JS).
The cookie lives in config.json (git-ignored) and is never returned by the API.
"""
from __future__ import annotations

import asyncio
import json
import os
import random
import re
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, quote, unquote, urlparse

from services.net_guard import guarded_client
from services.xhs_browser import BrowserUnavailable, xhs_browser

from services.paths import CONFIG_PATH
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)
MOBILE_USER_AGENT = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1"
)
REFERER = "https://www.xiaohongshu.com/"
XHS_HOST_KEYWORDS = ("xiaohongshu.com", "xhslink.com", "rednote.com")
VIDEO_CDN_SUFFIXES = ("xhscdn.com", "xhscdn.net", "rednotecdn.com")

_NOTE_ID_RE = re.compile(
    r"/(?:explore|discovery/item|search_result|user/profile/[0-9a-f]{24}|board/[0-9a-f]{24}|item)/([0-9a-f]{24})",
    re.I,
)
_URL_RE = re.compile(r"https?://[^\s\"'<>，。\\]+")

NEED_COOKIE_MSG = 'ต้องตั้งค่า RedNote Cookie ก่อน (กดปุ่ม "📕 RedNote Cookie") เพราะ RedNote ให้ดูโน้ตและค้นหาได้เฉพาะบัญชีที่ล็อกอิน'
EXPIRED_MSG = "RedNote Cookie หมดอายุหรือไม่ถูกต้อง กรุณาวาง Cookie ใหม่จากเบราว์เซอร์ที่ล็อกอินอยู่"
LIMITED_MSG = (
    "RedNote ไม่ส่งผลค้นหามาเลย (บัญชีนี้น่าจะถูกจำกัดการค้นหาชั่วคราวเพราะค้นหาถี่เกินไป) "
    "กรุณาเว้นสักพักแล้วลองใหม่ หรือลองคำค้นอื่น"
)

# note_id -> parsed item (with video URL); note_id -> (xsec_token, xsec_source) from search
_NOTE_CACHE: Dict[str, Dict[str, Any]] = {}
_TOKEN_CACHE: Dict[str, Tuple[str, str]] = {}


class XhsError(Exception):
    """User-facing error (Thai message)."""


def is_xhs_text(text: str) -> bool:
    lower = (text or "").lower()
    return any(k in lower for k in XHS_HOST_KEYWORDS) or "小红书" in (text or "")


def is_video_cdn_url(url: str) -> bool:
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return False
    return any(host == s or host.endswith("." + s) for s in VIDEO_CDN_SUFFIXES)


# ---------------------------------------------------------------------------
# Cookie storage
# ---------------------------------------------------------------------------
def _read_config() -> Dict[str, Any]:
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def get_xhs_cookie() -> str:
    return (_read_config().get("xhs_cookie") or "").strip()


def get_xhs_proxy() -> str:
    return (_read_config().get("xhs_proxy") or os.environ.get("XHS_PROXY") or "").strip()


def set_xhs_proxy(proxy_str: str) -> None:
    data = _read_config()
    p = (proxy_str or "").strip()
    if p:
        data["xhs_proxy"] = p
    else:
        data.pop("xhs_proxy", None)
    CONFIG_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


_GUEST_COOKIE_STR: Optional[str] = None


def _get_guest_cookie() -> str:
    """
    Generate realistic RedNote guest session cookies (a1, webId, abRequestId, xsecappid)
    in the same format used by XHS-Downloader / RedNote web SDK so cookieless requests
    pass basic guest session validation without requiring user login.
    """
    global _GUEST_COOKIE_STR
    if not _GUEST_COOKIE_STR:
        ts_hex = hex(int(time.time() * 1000))[2:]
        rand_part = "".join(random.choices("0123456789abcdefghijklmnopqrstuvwxyz", k=30))
        a1 = (ts_hex + rand_part + "50000" + "".join(random.choices("0123456789", k=6)))[:52]
        web_id = "".join(random.choices("0123456789abcdef", k=32))
        ab_req = str(uuid.uuid4())
        _GUEST_COOKIE_STR = (
            f"a1={a1}; webId={web_id}; abRequestId={ab_req}; "
            f"xsecappid=xhs-pc-web; webBuild=7.0.0"
        )
    return _GUEST_COOKIE_STR


def set_xhs_cookie(cookie_str: str) -> None:
    global _working_site
    _working_site = None
    # Open search tabs were logged in with the old cookie: drop them (closed in the background)
    old_sessions = list(_SESSIONS.values())
    _SESSIONS.clear()
    try:
        loop = asyncio.get_running_loop()
        for sess in old_sessions:
            loop.create_task(sess.close())
    except RuntimeError:
        pass
    data = _read_config()
    cookie = re.sub(r"^\s*cookie\s*:\s*", "", (cookie_str or "").strip(), flags=re.I)
    if cookie:
        data["xhs_cookie"] = cookie
    else:
        data.pop("xhs_cookie", None)
    CONFIG_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    _NOTE_CACHE.clear()


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------
def _parse_note_url(url: str) -> Tuple[Optional[str], str, str]:
    clean_url = (url or "").strip().rstrip("\\/")
    # If redirected to /login?redirectPath=..., unwrap redirectPath first!
    if "redirectpath=" in clean_url.lower():
        rp_qs = parse_qs(urlparse(clean_url).query)
        rp = (rp_qs.get("redirectPath") or rp_qs.get("redirectpath") or [""])[0]
        if rp:
            clean_url = unquote(rp).strip().rstrip("\\/")
    m = _NOTE_ID_RE.search(clean_url)
    if not m:
        return None, "", ""
    # Preserve '+' inside base64 xsec_token (parse_qs turns '+' into space ' '!)
    raw_query = urlparse(clean_url).query.replace("+", "%2B")
    qs = parse_qs(raw_query)
    token = ((qs.get("xsec_token") or [""])[0]).strip().rstrip("\\")
    source = ((qs.get("xsec_source") or [""])[0]).strip().rstrip("\\")
    return m.group(1).lower(), token, source


# RedNote runs two sites with SEPARATE login sessions: rednote.com (international) and
# xiaohongshu.com (China). A cookie only works on the site it was copied from.
SITES = ("www.rednote.com", "www.xiaohongshu.com")
_working_site: Optional[str] = None


def _sites_for(cookie: str, pref_site: str = "") -> List[str]:
    """Sites to try, best guess first (preferred site from input URL first, then last worked, else guessed from cookie names)."""
    if pref_site:
        first = pref_site if pref_site.startswith("www.") else f"www.{pref_site}"
    elif _working_site:
        first = _working_site
    elif cookie:
        first = SITES[0] if re.search(r"(^|;)\s*x-rednote-", cookie or "") else SITES[1]
    else:
        # For cookieless international users, www.rednote.com has much gentler WAF rules
        first = SITES[0]
    return [first] + [s for s in SITES if s != first]


def _remember_site(site: str) -> None:
    global _working_site
    _working_site = site


def note_page_url(note_id: str, token: str = "", source: str = "", site: str = "", mobile_path: bool = False) -> str:
    host = site or _working_site or SITES[0]
    path = "discovery/item" if (mobile_path or "rednote.com" in host) else "explore"
    url = f"https://{host}/{path}/{note_id}"
    if token:
        url += f"?xsec_token={quote(token, safe='')}&xsec_source={source or 'pc_share'}"
    return url


def _extract_initial_state(html_text: str) -> Optional[Dict[str, Any]]:
    marker = "window.__INITIAL_STATE__="
    start = html_text.find(marker)
    if start == -1:
        return None
    end = html_text.find("</script>", start)
    raw = html_text[start + len(marker) : end].strip().rstrip(";")
    raw = re.sub(r"(?<=[:\[,])\s*undefined\b", "null", raw)
    try:
        return json.loads(raw)
    except ValueError:
        return None


def _extract_note_from_html(html_text: str, note_id: str) -> Optional[Dict[str, Any]]:
    """
    Extract note dict from:
    1. Desktop SSR: window.__INITIAL_STATE__.note.noteDetailMap[note_id].note
    2. Mobile H5 SSR: window.__INITIAL_STATE__.noteData.data.noteData
    3. OpenGraph <meta name="og:video"> fallback when SSR JSON is stripped
    """
    if not html_text:
        return None
    state = _extract_initial_state(html_text) or {}
    # 1. Desktop noteDetailMap
    detail_map = (state.get("note") or {}).get("noteDetailMap") or {}
    if isinstance(detail_map, dict):
        entry = detail_map.get(note_id)
        if not entry and detail_map:
            entry = next((v for k, v in detail_map.items() if k != "undefined" and isinstance(v, dict)), None)
        if isinstance(entry, dict) and entry.get("note"):
            return entry["note"]

    # 2. Mobile H5 noteData
    note_data = ((state.get("noteData") or {}).get("data") or {}).get("noteData")
    if isinstance(note_data, dict) and (note_data.get("video") or note_data.get("title") or note_data.get("desc")):
        return note_data

    # 3. OpenGraph <meta name="og:video"> / direct CDN stream regex fallback
    og_video_m = re.search(
        r'<meta[^>]+(?:name|property)=["\']og:video["\'][^>]+content=["\']([^"\']+)["\']',
        html_text,
        re.I,
    )
    video_url = og_video_m.group(1).strip() if og_video_m else ""
    if not video_url:
        cdn_m = re.search(
            r'https?://(?:sns-v[0-9a-z\-]+\.rednotecdn\.com|sns-video-[0-9a-z\-]+\.xhscdn\.com)/[^\s"\'<>\\]+\.mp4',
            html_text,
            re.I,
        )
        if cdn_m:
            video_url = cdn_m.group(0)
    if video_url:
        og_title_m = re.search(
            r'<meta[^>]+(?:name|property)=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']',
            html_text,
            re.I,
        )
        og_img_m = re.search(
            r'<meta[^>]+(?:name|property)=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']',
            html_text,
            re.I,
        )
        title = (og_title_m.group(1) if og_title_m else "").replace(" - 小红书", "").replace(" - rednote", "").strip()
        img = og_img_m.group(1).strip() if og_img_m else ""
        return {
            "noteId": note_id,
            "title": title or f"RedNote {note_id}",
            "desc": title,
            "imageList": [{"urlDefault": img}] if img else [],
            "video": {"media": {"stream": {"h264": [{"masterUrl": video_url, "videoCodec": "h264"}]}}},
        }
    return None


def _parse_count(value: Any) -> int:
    """'1.2万' -> 12000, '3456' -> 3456."""
    s = str(value or "").strip()
    if not s:
        return 0
    try:
        if s.endswith(("万", "w", "W")):
            return int(float(s[:-1]) * 10000)
        if s.endswith("亿"):
            return int(float(s[:-1]) * 100000000)
        return int(float(s.replace(",", "")))
    except ValueError:
        return 0


def _format_duration(seconds: float) -> str:
    sec = int(round(seconds or 0))
    return f"{sec // 60}:{sec % 60:02d}" if sec > 0 else ""


def _https(url: str) -> str:
    url = (url or "").strip()
    if url.startswith("//"):
        return "https:" + url
    return "https://" + url[len("http://") :] if url.startswith("http://") else url


def _pick_video_url(video: Dict[str, Any]) -> str:
    """
    Best ready-made stream: H.264 (/258/ or codec avc/h264) first so it plays natively in every
    browser and Studio without HEVC issues, then up to 1080p, then smallest size.
    """
    candidates = []
    for group, lst in ((video.get("media") or {}).get("stream") or {}).items():
        for s in lst or []:
            url = next((u for u in [s.get("masterUrl"), *(s.get("backupUrls") or [])] if u), "")
            if not url:
                continue
            codec = f"{s.get('videoCodec') or ''} {group}".lower()
            is_hevc_url = "/259/" in url or "_259." in url or "265" in codec or "hevc" in codec or "av1" in codec
            is_h264 = ("/258/" in url or "_258." in url or "264" in codec or "avc" in codec) and not is_hevc_url
            too_big = int(s.get("height") or 0) > 1080 and int(s.get("width") or 0) > 1080
            candidates.append(((0 if is_h264 else 1), (1 if too_big else 0), int(s.get("size") or 0), url))
    if candidates:
        return _https(min(candidates)[3])
    origin_key = (video.get("consumer") or {}).get("originVideoKey")
    return f"https://sns-video-bd.xhscdn.com/{origin_key}" if origin_key else ""


def _clean_desc(desc: str) -> str:
    return re.sub(r"#([^#\[]+)\[话题\]#", r"#\1", desc or "").strip()


def _extract_cover_from_note(note: Dict[str, Any]) -> str:
    images = note.get("imageList") or []
    if images and isinstance(images[0], dict):
        img0 = images[0]
        c = img0.get("urlDefault") or img0.get("urlPre") or img0.get("url") or ""
        if not c and isinstance(img0.get("infoList"), list) and img0["infoList"]:
            c = img0["infoList"][0].get("url") or ""
        if c:
            return _https(c)
    if isinstance(note.get("cover"), dict):
        c = note["cover"].get("urlDefault") or note["cover"].get("urlPre") or note["cover"].get("url") or ""
        if c:
            return _https(c)
    video_img = ((note.get("video") or {}).get("image") or {}).get("thumbnailFileid")
    if video_img and str(video_img).startswith("http"):
        return _https(str(video_img))
    return ""


def parse_note(note: Dict[str, Any], note_id: str, page_url: str) -> Dict[str, Any]:
    video = note.get("video") or {}
    user = note.get("user") or {}
    interact = note.get("interactInfo") or {}
    cover = _extract_cover_from_note(note)

    duration = float((video.get("capa") or {}).get("duration") or 0)
    if not duration:
        for s in ((video.get("media") or {}).get("stream") or {}).get("h264") or []:
            duration = float(s.get("duration") or 0) / 1000.0
            break

    desc = _clean_desc(note.get("desc") or "")
    video_url = _pick_video_url(video)
    return {
        "id": note_id,
        "platform": "xhs",
        "platform_label": "RedNote 小红书",
        "title": (note.get("title") or "").strip() or desc[:60] or f"RedNote {note_id}",
        "author": user.get("nickname") or user.get("nickName") or "RedNote Creator",
        "author_avatar": _https(user.get("avatar") or ""),
        "cover": cover,
        "duration": _format_duration(duration),
        "views": 0,
        "likes": _parse_count(interact.get("likedCount")),
        "url": page_url,
        "download_url": video_url,
        "direct_video_url": video_url,
        "description": desc,
    }


# ---------------------------------------------------------------------------
# Note lookup (5-Layer Cookieless + Cookie Pipeline)
# ---------------------------------------------------------------------------
async def _expand_short_link(url: str) -> str:
    """xhslink.com/xxx -> full note URL (reads redirect headers only)."""
    current = url
    nav_headers = {
        "User-Agent": MOBILE_USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Sec-Fetch-Mode": "navigate",
    }
    async with guarded_client(headers=nav_headers, timeout=10.0) as client:
        for _ in range(6):
            resp = await client.get(current, follow_redirects=False)
            loc = resp.headers.get("location")
            if not loc:
                break
            current = str(resp.url.join(loc))
            if _NOTE_ID_RE.search(current) and "redirectpath=" not in current.lower():
                break
    return current


async def _fetch_note_http(
    note_id: str, page_url: str, cookie: str = "", mobile: bool = False
) -> Tuple[Optional[Dict[str, Any]], str]:
    """
    Primary fast HTTP fetcher using httpx (native OS DNS, ~1.2s) with full browser navigation headers.
    Note: Only sends Cookie header when the user has configured a real login cookie (sending an
    unsigned synthetic 'a1' cookie causes RedNote Desktop WAF to redirect to /login).
    """
    headers = {
        "User-Agent": MOBILE_USER_AGENT if mobile else USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
    }
    if cookie:
        headers["Cookie"] = cookie
    async with guarded_client(headers=headers, timeout=10.0, follow_redirects=True) as client:
        resp = await client.get(page_url)
    note = _extract_note_from_html(resp.text, note_id)
    return note, str(resp.url).lower()


async def _fetch_note_cffi(
    note_id: str, page_url: str, cookie: str = "", mobile: bool = False
) -> Tuple[Optional[Dict[str, Any]], str]:
    """
    Secondary fallback using curl_cffi to impersonate real Chrome / iOS Safari BoringSSL TLS (JA3/JA4).
    """
    try:
        from curl_cffi.requests import AsyncSession
    except ImportError:
        return None, ""

    headers = {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
    }
    if cookie:
        headers["Cookie"] = cookie
    if mobile:
        headers["User-Agent"] = MOBILE_USER_AGENT
        impersonate_target = "safari_ios"
    else:
        headers["User-Agent"] = USER_AGENT
        impersonate_target = "chrome"

    proxy = get_xhs_proxy() or None
    async with AsyncSession(impersonate=impersonate_target, timeout=5, proxy=proxy) as session:
        resp = await session.get(page_url, headers=headers, allow_redirects=True)
        final_url = str(resp.url).lower()
        note = _extract_note_from_html(resp.text, note_id)
        return note, final_url


async def _fetch_note_browser(note_id: str, page_url: str, cookie: str) -> Tuple[Optional[Dict[str, Any]], str]:
    detail = (
        f"(un(window.__INITIAL_STATE__?.note?.noteDetailMap)?.['{note_id}']?.note"
        f" || un(window.__INITIAL_STATE__?.noteData?.data?.noteData))"
    )
    og_js = "document.querySelector('meta[name=\"og:video\"], meta[property=\"og:video\"]')?.content || document.querySelector('video')?.src || ''"
    res = await xhs_browser.read_page(
        page_url,
        ready_js=f"location.protocol === 'chrome-error:' || /\\/(login|404)/.test(location.pathname) || !!({detail}?.title || {detail}?.noteId || ({og_js}))",
        result_js=f"{{path: location.protocol === 'chrome-error:' ? '/login' : location.pathname, note: {detail} || null, ogVideo: {og_js}, title: document.title}}",
        cookie=cookie,
    ) or {}
    note = res.get("note")
    if not note and res.get("ogVideo") and str(res["ogVideo"]).startswith("http"):
        note = {
            "noteId": note_id,
            "title": (res.get("title") or "").replace(" - 小红书", "").replace(" - rednote", "").strip() or f"RedNote {note_id}",
            "video": {"media": {"stream": {"h264": [{"masterUrl": res["ogVideo"], "videoCodec": "h264"}]}}},
        }
    return note, (res.get("path") or "").lower()


def _fetch_note_ytdlp_sync(note_id: str, token: str = "", source: str = "", cookie: str = "") -> Optional[Dict[str, Any]]:
    import yt_dlp

    page_url = f"https://www.xiaohongshu.com/explore/{note_id}"
    if token:
        page_url += f"?xsec_token={quote(token, safe='')}&xsec_source={source or 'pc_share'}"

    active_cookie = cookie or get_xhs_cookie()
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
        "Sec-Fetch-Mode": "navigate",
    }
    if active_cookie:
        headers["Cookie"] = active_cookie

    ydl_opts: Dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "simulate": True,
        "skip_download": True,
        "http_headers": headers,
    }
    proxy = get_xhs_proxy()
    if proxy:
        ydl_opts["proxy"] = proxy

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        try:
            info = ydl.extract_info(page_url, download=False)
        except Exception as exc:
            print(f"[RedNote] yt-dlp extraction failed: {exc!r}")
            return None

        formats = info.get("formats") or []
        direct_url = ""
        # Prefer fast, web-optimized H.264 streams (e.g. 720p/1080p, format_id "0", "1")
        # Avoid the huge uncompressed origin "direct" master file which is 5x-10x larger and slow
        web_streams = [
            f for f in formats 
            if f.get("url") and f.get("format_id") != "direct" and "264" in (f.get("vcodec") or "").lower()
        ]
        if not web_streams:
            web_streams = [f for f in formats if f.get("url") and f.get("format_id") != "direct"]
        
        if web_streams:
            # Sort by resolution/height so we get crisp 720p/1080p HD
            web_streams.sort(key=lambda x: (x.get("height") or 0, x.get("tbr") or 0), reverse=True)
            direct_url = web_streams[0].get("url")
        elif formats:
            direct_url = formats[0].get("url")

        dur_sec = float(info.get("duration") or 0)
        if not dur_sec:
            for f in formats:
                if f.get("duration"):
                    dur_sec = float(f["duration"])
                    break
        dur_str = _format_duration(dur_sec)

        return {
            "id": note_id,
            "platform": "xhs",
            "platform_label": "RedNote 小红书",
            "title": (info.get("title") or "").strip() or f"RedNote {note_id}",
            "author": info.get("uploader") or info.get("uploader_id") or "RedNote Creator",
            "author_avatar": "",
            "cover": info.get("thumbnail") or "",
            "duration": dur_str,
            "views": 0,
            "likes": int(info.get("like_count") or 0),
            "url": page_url,
            "download_url": direct_url,
            "direct_video_url": direct_url,
            "description": _clean_desc(info.get("description") or ""),
        }


async def _fetch_note_ytdlp(note_id: str, token: str = "", source: str = "", cookie: str = "") -> Optional[Dict[str, Any]]:
    return await asyncio.to_thread(_fetch_note_ytdlp_sync, note_id, token, source, cookie)


async def resolve_note(raw_input: str) -> Dict[str, Any]:
    url_match = _URL_RE.search(raw_input or "")
    if not url_match:
        raise XhsError("ไม่พบลิงก์ RedNote กรุณาวางลิงก์ เช่น https://www.xiaohongshu.com/explore/... หรือ http://xhslink.com/...")
    url = url_match.group(0).strip().rstrip("\\/")
    if "xhslink.com" in url.lower():
        url = await _expand_short_link(url)

    note_id, token, source = _parse_note_url(url)
    if not note_id:
        raise XhsError("ลิงก์นี้ไม่ใช่ลิงก์โน้ต RedNote (ต้องมี /explore/<id>, /discovery/item/<id> หรือ /search_result/<id>)")
    if not token and note_id in _TOKEN_CACHE:
        token, source = _TOKEN_CACHE[note_id]

    pref_site = ""
    if "rednote.com" in url.lower():
        pref_site = "www.rednote.com"
    elif "xiaohongshu.com" in url.lower():
        pref_site = "www.xiaohongshu.com"

    return await get_note(note_id, token, source, pref_site=pref_site)


def _find_chrome_exe() -> Optional[str]:
    import httpx
    import shutil
    candidates = [
        shutil.which("chrome"),
        shutil.which("msedge"),
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        os.path.expanduser("~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ]
    for p in candidates:
        if p and os.path.exists(p):
            return p
    return None


async def _fetch_note_kukutool(note_id: str, page_url: str) -> Optional[Dict[str, Any]]:
    """
    Fallback 2 (from Download Red.har): uses dy.kukutool.com/rednote-downloader
    via headless Chrome CDP to extract the signed RedNote MP4 URL & cover when
    direct RedNote fetching fails or is IP-blocked.
    """
    import httpx
    import shutil
    import socket
    import subprocess
    import tempfile
    import websockets

    chrome = _find_chrome_exe()
    if not chrome:
        return None

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]

    td = tempfile.mkdtemp(prefix="xhs_kuku_")
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    proc = subprocess.Popen(
        [
            chrome,
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            f"--remote-debugging-port={port}",
            f"--user-data-dir={td}",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creationflags,
    )
    try:
        ws_url = None
        async with httpx.AsyncClient(timeout=2.0) as c:
            for _ in range(25):
                try:
                    tabs = (await c.get(f"http://127.0.0.1:{port}/json")).json()
                    if tabs and tabs[0].get("webSocketDebuggerUrl"):
                        ws_url = tabs[0]["webSocketDebuggerUrl"]
                        break
                except Exception:
                    await asyncio.sleep(0.2)
        if not ws_url:
            return None

        async with websockets.connect(ws_url, max_size=20 * 1024 * 1024) as ws:
            await ws.send(
                json.dumps(
                    {
                        "id": 1,
                        "method": "Page.navigate",
                        "params": {"url": "https://dy.kukutool.com/rednote-downloader"},
                    }
                )
            )
            # Wait until the React/Next input element is hydrated
            for w_step in range(20):
                await asyncio.sleep(0.4)
                await ws.send(
                    json.dumps(
                        {
                            "id": 100 + w_step,
                            "method": "Runtime.evaluate",
                            "params": {
                                "expression": "Boolean(document.querySelector('input[type=\"text\"], input[type=\"url\"], input:not([type]), textarea'))",
                                "returnByValue": True,
                            },
                        }
                    )
                )
                ready = False
                while True:
                    msg = json.loads(await ws.recv())
                    if msg.get("id") == 100 + w_step:
                        ready = bool(msg.get("result", {}).get("result", {}).get("value"))
                        break
                if ready:
                    await asyncio.sleep(2.5)
                    break

            js_fill = f"""
            (() => {{
                const inp = document.querySelector('input[type="text"], input[type="url"], input:not([type]), textarea');
                if (!inp) return 'no-input';
                const proto = inp.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                if (setter) setter.call(inp, {json.dumps(page_url)});
                else inp.value = {json.dumps(page_url)};
                inp.dispatchEvent(new Event('input', {{ bubbles: true }}));
                inp.dispatchEvent(new Event('change', {{ bubbles: true }}));
                const scope = inp.closest('form') || inp.parentElement?.parentElement || document;
                const btn = Array.from(scope.querySelectorAll('button')).find(
                    b => !/paste|clear|วาง|ล้าง/i.test(b.textContent || '') && (b.textContent || '').trim().length > 0
                );
                if (btn) btn.click();
                return btn ? btn.textContent.trim() : 'no-btn';
            }})()
            """
            await ws.send(
                json.dumps(
                    {"id": 2, "method": "Runtime.evaluate", "params": {"expression": js_fill, "returnByValue": True}}
                )
            )
            while True:
                msg = json.loads(await ws.recv())
                if msg.get("id") == 2:
                    break

            for step in range(12):
                await asyncio.sleep(1.0)
                js_poll = """
                JSON.stringify({
                    links: Array.from(document.querySelectorAll('a,video,source')).map(e => e.href || e.src || '').filter(Boolean),
                    imgs: Array.from(document.querySelectorAll('img')).map(e => e.src || '').filter(Boolean),
                    title: (document.querySelector('h1,h2,h3,.title,[class*="title"]')?.textContent || '').trim()
                })
                """
                await ws.send(
                    json.dumps(
                        {"id": 10 + step, "method": "Runtime.evaluate", "params": {"expression": js_poll, "returnByValue": True}}
                    )
                )
                while True:
                    msg = json.loads(await ws.recv())
                    if msg.get("id") == 10 + step:
                        res = json.loads(msg["result"]["result"]["value"])
                        vids = [
                            u
                            for u in res.get("links", [])
                            if ".mp4" in u or "xhscdn.com/stream" in u or "rednotecdn.com/stream" in u
                        ]
                        if vids:
                            imgs = [
                                u
                                for u in res.get("imgs", [])
                                if "xhscdn" in u or "rednotecdn" in u
                            ]
                            cover = _https(imgs[0]) if imgs else ""
                            title = (res.get("title") or "").strip()
                            if not title or "RedNote" in title:
                                title = f"RedNote {note_id}"
                            return {
                                "id": note_id,
                                "platform": "xhs",
                                "platform_label": "RedNote",
                                "title": title,
                                "description": "",
                                "author": "RedNote Creator",
                                "cover": cover,
                                "url": page_url,
                                "direct_video_url": _https(vids[0]),
                                "duration": "",
                                "likes": 0,
                                "views": 0,
                            }
                        break
    except Exception as exc:
        print(f"[RedNote] kukutool fallback failed: {exc!r}")
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=2)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        shutil.rmtree(td, ignore_errors=True)
    return None


async def get_note(note_id: str, token: str = "", source: str = "", pref_site: str = "") -> Dict[str, Any]:
    note_id = note_id.lower()
    if note_id in _NOTE_CACHE:
        return _NOTE_CACHE[note_id]

    cookie = get_xhs_cookie()
    sites = _sites_for(cookie, pref_site)
    note, final_url, page_url = None, "", ""

    # Layer 1 & 2: Fast Cookieless / Cookie HTTP Fetch (httpx native DNS first, then curl_cffi fallback)
    # Tries Desktop SSR first (full cover + H.264 _258 stream), then Mobile H5 Share Page.
    for site in sites:
        for mobile_mode in (False, True):
            page_url = note_page_url(note_id, token, source, site=site, mobile_path=mobile_mode)
            try:
                note, final_url = await _fetch_note_http(note_id, page_url, cookie, mobile=mobile_mode)
                if not note and "/404" not in final_url:
                    note_cffi, final_cffi = await _fetch_note_cffi(note_id, page_url, cookie, mobile=mobile_mode)
                    if note_cffi:
                        note, final_url = note_cffi, final_cffi
            except Exception as exc:
                print(f"[RedNote] fast fetch failed ({site}, mobile={mobile_mode}): {exc!r}")
            if note:
                item = parse_note(note, note_id, page_url)
                if item.get("direct_video_url"):
                    _remember_site(site)
                    _NOTE_CACHE[note_id] = item
                    return item
            if "/404" in final_url:
                break
        if "/404" in final_url:
            break

    # Layer 3: Kukutool fallback (dy.kukutool.com/rednote-downloader) when direct HTTP fetch fails
    if "/404" not in final_url:
        kuku_url = note_page_url(note_id, token, source, site=sites[0], mobile_path=False)
        item = await _fetch_note_kukutool(note_id, kuku_url)
        if item and item.get("direct_video_url"):
            _NOTE_CACHE[note_id] = item
            return item

    # Layer 4: Try yt-dlp with navigation headers & guest cookies
    if "/404" not in final_url:
        item = await _fetch_note_ytdlp(note_id, token, source, cookie=cookie)
        if item and item.get("direct_video_url"):
            _NOTE_CACHE[note_id] = item
            return item

    # Layer 4: Headless Chrome Browser (executes JS anti-bot challenges, extracts SSR or <meta name="og:video">)
    if "/404" not in final_url:
        for site in sites:
            page_url = note_page_url(note_id, token, source, site=site)
            try:
                note, final_url = await _fetch_note_browser(note_id, page_url, cookie)
                if note:
                    _remember_site(site)
                    item = parse_note(note, note_id, page_url)
                    if item.get("direct_video_url"):
                        _NOTE_CACHE[note_id] = item
                        return item
            except Exception as exc:
                print(f"[RedNote] browser note fetch failed ({site}): {exc!r}")

    if "/404" in final_url or not token:
        raise XhsError("เปิดโน้ตนี้ไม่ได้ (ลิงก์ไม่มี xsec_token หรือโน้ตถูกลบ — กรุณาคัดลอกลิงก์เต็มที่มี ?xsec_token=... หรือกดแชร์ลิงก์จากแอป)")
    if "/login" in final_url or not cookie:
        raise XhsError(
            "IP เน็ตนี้ถูก RedNote บล็อกระดับเครือข่าย (บังคับ Login) — กรุณาใส่ Cookie RedNote หรือตั้งค่า Proxy"
        )
    raise XhsError("อ่านข้อมูลโน้ต RedNote ไม่สำเร็จ (Cookie อาจหมดอายุ หรือติดหน้า Login — กรุณาอัปเดต Cookie RedNote ใหม่)")


async def get_video_url(note_id: str, hint_url: str = "") -> str:
    """
    Video file URL for a note. `hint_url` may be the CDN video URL (used as-is), or the note's
    page URL carrying its xsec_token (from a search result card).
    """
    hint_url = (hint_url or "").strip()
    if hint_url and is_video_cdn_url(hint_url):
        return hint_url
    note_id = (note_id or "").lower()
    if note_id in _NOTE_CACHE:
        return _NOTE_CACHE[note_id]["direct_video_url"]
    token, source = "", ""
    if hint_url and is_xhs_text(hint_url):
        hid, token, source = _parse_note_url(hint_url)
        if hid and hid != note_id:
            token, source = "", ""
    if not token and note_id in _TOKEN_CACHE:
        token, source = _TOKEN_CACHE[note_id]
    pref = "rednote.com" if "rednote.com" in (hint_url or "").lower() else ""
    return (await get_note(note_id, token, source, pref_site=pref))["direct_video_url"]


# ---------------------------------------------------------------------------
# Search — endless: one RedNote search tab stays open per keyword and keeps scrolling
# ---------------------------------------------------------------------------
_FEEDS_JS = "(un(window.__INITIAL_STATE__?.search?.feeds) || [])"
_LOGIN_WALL_JS = (
    "location.protocol === 'chrome-error:' || /\\/login/.test(location.pathname)"
    " || (document.body?.innerText || '').includes('登录后查看搜索结果')"
)
# Search finished with nothing ("No results found" / 没有找到) -> RedNote sets state "error"
_SEARCH_EMPTY_JS = "un(window.__INITIAL_STATE__?.search?.state) === 'error'"
_SEARCH_STATUS_JS = f"""{{
  loggedOut: {_LOGIN_WALL_JS} || ({_FEEDS_JS}.length === 0 && un(window.__INITIAL_STATE__?.user?.loggedIn) === false),
  count: {_FEEDS_JS}.length,
  hasMore: un(window.__INITIAL_STATE__?.search?.hasMore) !== false,
  type: un(window.__INITIAL_STATE__?.search?.currentSearchType) || "",
}}"""
# RedNote's own "related searches" chips — used as the next keywords when one runs dry
_RELATED_JS = "[...document.querySelectorAll('button.tab')].map((b) => b.innerText.trim()).filter((t) => t && !/^(General|综合|全部)$/.test(t))"


def _feeds_from_js(offset: int) -> str:
    return f"""{{
  // rednote.com cards carry no title in the state, only in the rendered card
  domTitles: Object.fromEntries([...document.querySelectorAll("section.note-item")].map((el) => {{
    const m = (el.querySelector("a[href*='/']")?.getAttribute("href") || "").match(/[0-9a-f]{{24}}/);
    return [m ? m[0] : "", (el.querySelector(".title")?.innerText || "").trim()];
  }})),
  feeds: {_FEEDS_JS}.slice({offset}).map((f) => ({{
    id: f.id,
    token: f.xsecToken || f.xsec_token || "",
    type: f.noteCard?.type || f.model_type || "",
    title: f.noteCard?.displayTitle || f.noteCard?.display_title || "",
    nickname: f.noteCard?.user?.nickname || f.noteCard?.user?.nickName || "",
    avatar: f.noteCard?.user?.avatar || "",
    liked: f.noteCard?.interactInfo?.likedCount || "",
    cover: f.noteCard?.cover?.urlDefault || f.noteCard?.cover?.urlPre || f.noteCard?.cover?.url || "",
  }})),
}}"""


class _SearchSession:
    """An open RedNote search tab for one keyword, plus what we've already handed out."""

    def __init__(self, keyword: str) -> None:
        self.keyword = keyword
        self.tab = None
        self.site = ""
        self.queue: List[str] = [keyword]  # keywords still to search (related ones get appended)
        self.fallbacks = _broader_keywords(keyword)
        self.used: set = set()
        self.current = ""
        self.offset = 0  # feeds of the current keyword already read
        self.seen: set = set()  # note ids already returned
        self.har_started: bool = False
        self.lock = asyncio.Lock()
        self.last_used = time.monotonic()

    async def close(self) -> None:
        if self.tab:
            await self.tab.close()
            self.tab = None

    async def _open_keyword(
        self, kw: str, cookie: str, source_tag: str = "web_search_result_notes", collect_all_first: bool = False
    ) -> bool:
        """Load the search page for `kw` with the Videos filter. False = nothing usable."""
        self.current, self.offset = kw, 0
        self.used.add(kw)
        sites = [self.site] if self.site else _sites_for(cookie)
        for site in sites:
            url = f"https://{site}/search_result?keyword={quote(kw)}&source={source_tag}"
            if self.tab is None:
                self.tab = await xhs_browser.open_tab(url, cookie)
            else:
                await self.tab.call("Page.navigate", {"url": url})
                await asyncio.sleep(0.8)
            await self.tab.wait_for(f"{_LOGIN_WALL_JS} || {_FEEDS_JS}.length > 0 || {_SEARCH_EMPTY_JS}", 18)
            status = await self.tab.eval(_SEARCH_STATUS_JS) or {}
            if status.get("loggedOut"):
                continue  # this site doesn't know the cookie; try the other one
            self.site = site
            _remember_site(site)
            if status.get("count", 0) == 0:
                # "error" without a "no results" message = RedNote is throttling this account
                no_results = await self.tab.eval(
                    "/No results|没有找到|暂无|未找到/i.test(document.body?.innerText || '')"
                )
                if not no_results and not self.seen:
                    raise XhsError(LIMITED_MSG)
                return False
            self._add_related(await self.tab.eval(_RELATED_JS) or [])
            if collect_all_first:
                # HAR Method 2 (web_explore_feed / note_type=0): harvest video cards from the All tab first
                self._pre_collected = getattr(self, "_pre_collected", [])
                self._pre_collected.extend(await self._read_new())
                self.offset = 0
            # Switch to the "Videos" channel so (almost) every result is a video
            await self.tab.eval("document.querySelector('.channel#video')?.click() || 1")
            await self.tab.wait_for(
                f"un(window.__INITIAL_STATE__?.search?.currentSearchType) === 'video' && {_FEEDS_JS}.length > 0"
                f" && {_FEEDS_JS}.filter((f) => f.noteCard?.type === 'video').length >= {_FEEDS_JS}.length * 0.7",
                12,
            )
            self._add_related(await self.tab.eval(_RELATED_JS) or [])
            return True
        if not self.site:
            raise XhsError(EXPIRED_MSG)
        return False

    def _add_related(self, related: List[str]) -> None:
        for kw in related:
            if kw not in self.used and kw not in self.queue:
                self.queue.append(kw)

    def _next_keyword(self) -> Optional[str]:
        """RedNote's related searches first, then shorter/broader versions of the keyword."""
        while self.queue:
            kw = self.queue.pop(0)
            if kw not in self.used:
                return kw
        for kw in self.fallbacks:
            if kw not in self.used:
                return kw
        return None

    async def _read_new(self) -> List[Dict[str, Any]]:
        res = await self.tab.eval(_feeds_from_js(self.offset)) or {}
        feeds = res.get("feeds") or []
        self.offset += len(feeds)
        titles = res.get("domTitles") or {}
        out = []
        for f in feeds:
            note_id = str(f.get("id") or "").lower()
            if not re.fullmatch(r"[0-9a-f]{24}", note_id) or f.get("type") != "video" or note_id in self.seen:
                continue
            self.seen.add(note_id)
            out.append(_search_item(f, note_id, titles.get(note_id) or ""))
        return out

    async def next_batch(
        self, limit: int, cookie: str, time_budget: float = 45.0, mode: str = "default"
    ) -> List[Dict[str, Any]]:
        self.last_used = time.monotonic()
        loop_end = time.monotonic() + time_budget
        items: List[Dict[str, Any]] = []
        if getattr(self, "_pre_collected", None):
            items.extend(self._pre_collected)
            self._pre_collected = []
        idle_scrolls = 0
        empty_streak = 0  # keywords in a row that returned nothing
        is_har = mode == "har"
        src_tag = "web_explore_feed" if is_har else "web_search_result_notes"
        if is_har and not self.har_started:
            self.har_started = True
            if not await self._open_keyword(self.keyword, cookie, source_tag=src_tag, collect_all_first=True):
                self.current = ""
                empty_streak = 1
            elif getattr(self, "_pre_collected", None):
                items.extend(self._pre_collected)
                self._pre_collected = []
        elif not self.current:
            if not await self._open_keyword(self._next_keyword() or self.keyword, cookie, source_tag=src_tag, collect_all_first=is_har):
                self.current = ""
                empty_streak = 1
            elif getattr(self, "_pre_collected", None):
                items.extend(self._pre_collected)
                self._pre_collected = []
        while len(items) < limit and time.monotonic() < loop_end:
            # Several keywords in a row with zero results: RedNote is most likely throttling this
            # account. Stop instead of firing more searches (that only makes the limit last longer).
            if empty_streak >= 2 and not self.seen:
                raise XhsError(LIMITED_MSG)
            if empty_streak >= 3:
                break
            if self.current:
                items += await self._read_new()
                if len(items) >= limit:
                    break
                status = await self.tab.eval(_SEARCH_STATUS_JS) or {}
                if status.get("hasMore") and idle_scrolls < 4:
                    before = status.get("count", 0)
                    await self.tab.eval("window.scrollTo(0, document.body.scrollHeight) || 1")
                    grew = await self.tab.wait_for(
                        f"{_FEEDS_JS}.length > {before} || un(window.__INITIAL_STATE__?.search?.hasMore) === false", 4.5, 0.3
                    )
                    idle_scrolls = 0 if grew else idle_scrolls + 1
                    continue
            # This keyword ran dry -> move on to the next related keyword
            kw = self._next_keyword()
            if not kw:
                break
            idle_scrolls = 0
            if await self._open_keyword(kw, cookie, source_tag=src_tag, collect_all_first=is_har):
                empty_streak = 0
            else:
                self.current = ""
                empty_streak += 1
        self.last_used = time.monotonic()
        return items[:limit] if len(items) > limit else items


def _broader_keywords(keyword: str) -> List[str]:
    """
    '大疆 Osmo Mobile 8P 开箱' -> '大疆 Osmo Mobile 8P', '大疆 Osmo Mobile', '大疆 Osmo', '大疆',
    then the core words + common video angles ('大疆 Osmo 测评', '大疆 Osmo 推荐', ...).
    Only leading words are kept, so the product/brand stays in every query.
    """
    angles = ("测评", "推荐", "开箱", "教程", "好物", "使用", "分享", "实拍", "vlog", "合集")
    tokens = keyword.split()
    out: List[str] = []

    def add(kw: str) -> None:
        kw = kw.strip()
        # skip bare angle words and 1-2 character codes ('8P') that would match random videos
        if kw and kw != keyword and kw not in out and kw not in angles and not re.fullmatch(r"[A-Za-z0-9]{1,2}", kw):
            out.append(kw)

    for n in range(len(tokens) - 1, 0, -1):
        add(" ".join(tokens[:n]))
    core = " ".join(tokens[:2]) if len(tokens) > 2 else keyword
    for angle in angles:
        if angle not in core:
            add(f"{core} {angle}")
    return out


def _search_item(f: Dict[str, Any], note_id: str, dom_title: str) -> Dict[str, Any]:
    token = f.get("token") or ""
    if token:
        _TOKEN_CACHE[note_id] = (token, "pc_search")
    cached = _NOTE_CACHE.get(note_id) or {}
    title = (f.get("title") or dom_title or "").strip()
    return {
        "id": note_id,
        "platform": "xhs",
        "platform_label": "RedNote 小红书",
        "title": title or f"RedNote · {f.get('nickname') or note_id}",
        "author": f.get("nickname") or "RedNote Creator",
        "author_avatar": _https(f.get("avatar") or ""),
        "cover": _https(f.get("cover") or ""),
        "duration": cached.get("duration", ""),
        "views": 0,
        "likes": _parse_count(f.get("liked")),
        "url": note_page_url(note_id, token, "pc_search"),
        "download_url": "",
        "direct_video_url": cached.get("direct_video_url", ""),
        "description": title,
    }


_SESSIONS: Dict[str, _SearchSession] = {}
_SESSION_IDLE_SEC = 15 * 60
_MAX_SESSIONS = 6


async def _drop_idle_sessions() -> None:
    now = time.monotonic()
    by_age = sorted(_SESSIONS.items(), key=lambda kv: kv[1].last_used)
    for i, (key, sess) in enumerate(by_age):
        too_many = len(by_age) - i > _MAX_SESSIONS
        if (too_many or now - sess.last_used > _SESSION_IDLE_SEC) and not sess.lock.locked():
            _SESSIONS.pop(key, None)
            await sess.close()


async def search_notes(
    keyword: str, page: int = 1, limit: int = 40, mode: str = "default"
) -> List[Dict[str, Any]]:
    """
    Video notes for a keyword. page=1 starts a fresh search; each later page (or mode="har")
    continues the open search (scrolling deeper through webapi.rednote.com/api/sns/web/v1/search/notes
    and web_explore_feed) so results keep growing without duplicates.
    Raises XhsError when there is no cookie / the cookie is expired.
    """
    cookie = get_xhs_cookie()
    if not cookie:
        raise XhsError(NEED_COOKIE_MSG)
    await _drop_idle_sessions()

    key = keyword.strip()
    sess = _SESSIONS.get(key)
    if page <= 1 and mode != "har" and sess:
        _SESSIONS.pop(key, None)
        await sess.close()
        sess = None
    if sess is None:
        sess = _SESSIONS[key] = _SearchSession(key)

    async with sess.lock:
        try:
            return await sess.next_batch(limit, cookie, mode=mode)
        except BrowserUnavailable as exc:
            raise XhsError(str(exc)) from exc
        except XhsError:
            _SESSIONS.pop(key, None)
            await sess.close()
            raise
        except Exception as exc:  # tab crashed / browser restarted: start over next time
            print(f"[RedNote] search session failed: {exc!r}")
            _SESSIONS.pop(key, None)
            await sess.close()
            return []


async def close_all_sessions() -> None:
    for sess in list(_SESSIONS.values()):
        await sess.close()
    _SESSIONS.clear()
