from __future__ import annotations

import asyncio
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import quote

import httpx
from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from services.bilibili_service import BilibiliService
from services.douyin_service import DouyinService
from services.shopee_service import (
    add_channel,
    fetch_shopee_product_info,
    get_shopee_cookie,
    list_channels,
    prepare_chinese_keywords,
    refresh_all_channels,
    refresh_channel,
    remove_channel,
    set_shopee_cookie,
    translate_thai_to_chinese,
    translate_to_chinese,
    update_channel_label,
)
from services.net_guard import guarded_client
from services import xhs_service
from services.xhs_browser import xhs_browser
from services.downloader import (
    USER_AGENT,
    download_with_ytdlp,
    get_referer_for_url,
    sanitize_filename,
)
from services.video_studio_service import (
    CLIP_CACHE_DIR,
    VOICE_CATALOG,
    convert_video_data_url_to_mp4,
    convert_video_file_to_mp4,
    generate_product_review_script,
    load_studio_config,
    save_studio_config,
    smart_split_scenes,
    synthesize_voiceover_and_timings,
    test_gemini_api_key,
)

app = FastAPI(
    title="Douyin & Bilibili Video Search & Downloader Hub",
    version="1.0.0",
)

# This app holds API keys and login cookies, so it only answers its own page on this machine.
# No CORS: other websites must not be able to read /api responses or drive the API.
# Extra hostnames (e.g. a LAN IP when running with --host 0.0.0.0) can be allowed with
# HUB_ALLOWED_HOSTS="192.168.1.20,mypc.local".
_ALLOWED_HOSTS = {"localhost", "127.0.0.1", "[::1]", "::1"} | {
    h.strip().lower() for h in os.environ.get("HUB_ALLOWED_HOSTS", "").split(",") if h.strip()
}


def _hostname(netloc: str) -> str:
    netloc = (netloc or "").strip().lower()
    if netloc.startswith("["):
        return netloc.split("]", 1)[0] + "]"
    return netloc.rsplit(":", 1)[0] if netloc.count(":") == 1 else netloc


@app.middleware("http")
async def same_origin_guard(request: Request, call_next):
    # Host check blocks DNS-rebinding (evil.com resolving to 127.0.0.1)
    host = request.headers.get("host", "")
    if _hostname(host) not in _ALLOWED_HOSTS:
        return JSONResponse(status_code=403, content={"detail": "Forbidden host"})
    # Origin check blocks cross-site fetch/form posts from other websites
    origin = request.headers.get("origin")
    if origin and origin != "null":
        origin_netloc = origin.split("://", 1)[-1].rstrip("/")
        if origin_netloc.lower() != host.lower():
            return JSONResponse(status_code=403, content={"detail": "Cross-origin request blocked"})
    elif request.url.path.startswith("/api/") and (
        origin == "null" or request.headers.get("sec-fetch-site") == "cross-site"
    ):
        # e.g. <img src="http://localhost:8000/api/..."> embedded in another website
        return JSONResponse(status_code=403, content={"detail": "Cross-origin request blocked"})
    return await call_next(request)


@app.middleware("http")
async def disable_static_cache(request: Request, call_next):
    response = await call_next(request)
    if request.url.path in ("/", "/index.html", "/app.js", "/studio.js", "/styles.css"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return response

bilibili_service = BilibiliService()
douyin_service = DouyinService()

from services.paths import STATIC_DIR


class ResolveRequest(BaseModel):
    url: str


class ShopeeAnalyzeRequest(BaseModel):
    url: str
    custom_keyword: str = ""
    platform: str = "all"
    limit: int = 75
    skip_search: bool = False


class SettingsRequest(BaseModel):
    douyin_cookie: str = ""
    shopee_cookie: str = ""


class AddChannelRequest(BaseModel):
    cookie: str
    label: str = ""


class UpdateChannelLabelRequest(BaseModel):
    label: str


@app.on_event("startup")
async def startup_event():
    # Pre-warm guest cookies in background so first Douyin download/preview is instant
    asyncio.create_task(douyin_service.ensure_signing_cookies())


@app.on_event("shutdown")
async def shutdown_event():
    xhs_browser.shutdown()


MAX_KEYWORD_GROUPS = 3
ALL_PLATFORMS = ("douyin", "bilibili", "xhs")


def _split_keyword_groups(keyword: str) -> List[str]:
    """'A | B | C' or 'A, B, C' -> ['A', 'B', 'C'] (max 3). Drops junk groups like '100%' that have no letters."""
    groups: List[str] = []
    for g in re.split(r"[,，|｜]+", keyword or ""):
        g = g.strip()
        if g and re.search(r"[A-Za-z一-鿿฀-๿]", g) and g not in groups:
            groups.append(g)
    return groups[:MAX_KEYWORD_GROUPS] or [(keyword or "").strip()]


def _interleave_unique(lists: List[List[Dict[str, Any]]], limit: int) -> List[Dict[str, Any]]:
    seen: set = set()
    out: List[Dict[str, Any]] = []
    for idx in range(max((len(lst) for lst in lists), default=0)):
        for lst in lists:
            if idx < len(lst):
                item = lst[idx]
                key = (item.get("platform"), item.get("id"))
                if key not in seen:
                    seen.add(key)
                    out.append(item)
                    if len(out) >= limit:
                        return out
    return out


@app.get("/api/prepare-search")
async def prepare_search_endpoint(
    q: str = Query(..., min_length=1, description="Raw single or multi-keyword query"),
):
    raw_query = q.strip()
    zh_keywords = await prepare_chinese_keywords(raw_query, max_keywords=3)
    return {
        "query": raw_query,
        "zh_keywords": zh_keywords,
        "has_xhs_cookie": bool(xhs_service.get_xhs_cookie()),
    }


@app.get("/api/search")
async def search_videos(
    q: str = Query(..., min_length=1, description="Keyword to search (Thai, English, or Chinese)"),
    platform: str = Query("all", description="all, or a comma list of: douyin, bilibili, xhs"),
    page: int = Query(1, ge=1),
    limit: int = Query(75, ge=4, le=150),
    single: bool = Query(False, description="True when called for one Chinese keyword at a time"),
    xhs_mode: str = Query("default", description="default or har"),
):
    raw_query = q.strip()
    platform_norm = platform.lower().strip()
    # "all" = every platform (RedNote only when a cookie is saved); otherwise only the ones listed
    chosen = {p.strip() for p in platform_norm.split(",") if p.strip()} & {"all", *ALL_PLATFORMS}
    if not chosen:
        chosen = {"all"}

    # Always ensure keywords are translated into Chinese (even if mixed Thai/English/Chinese)
    if single:
        if re.search(r"[\u4e00-\u9fff]", raw_query) and not re.search(r"[\u0e00-\u0e7f]", raw_query):
            groups = [raw_query]
            search_keyword = raw_query
        else:
            zh_list = await prepare_chinese_keywords(raw_query, max_keywords=1)
            groups = [zh_list[0]] if zh_list else [raw_query]
            search_keyword = groups[0]
    else:
        zh_list = await prepare_chinese_keywords(raw_query, max_keywords=3)
        groups = zh_list if zh_list else _split_keyword_groups(raw_query)
        search_keyword = " | ".join(groups)

    xhs_notice = ""

    async def _platform_search(search_fn, enabled: bool) -> List[Dict[str, Any]]:
        nonlocal xhs_notice
        if not enabled:
            return []
        # Search each Chinese keyword sequentially with full quota so platforms never rate-limit or drop results!
        lists: List[List[Dict[str, Any]]] = []
        for g in groups:
            try:
                r = await search_fn(g, page=page, limit=limit)
                if isinstance(r, list) and r:
                    lists.append(r)
            except xhs_service.XhsError as err:
                xhs_notice = str(err)
            except Exception:
                continue
        return _interleave_unique(lists, limit)

    # RedNote search needs the user's login cookie; without one, skip it quietly in "all" mode
    want_xhs = "xhs" in chosen or ("all" in chosen and bool(xhs_service.get_xhs_cookie()))
    xhs_limit = min(limit, 30) if "all" in chosen else min(limit, 60)

    async def _safe_xhs_search() -> List[Dict[str, Any]]:
        nonlocal xhs_notice
        if not want_xhs:
            return []
        # RedNote searches keyword 1 first. If video(s) are found, return immediately!
        # Only if keyword 1 returns no videos (0 results), fall back to keyword 2, then keyword 3 in order.
        for g in groups:
            kw = g.strip()
            if not kw:
                continue
            try:
                res = await asyncio.wait_for(
                    xhs_service.search_notes(kw, page=page, limit=xhs_limit, mode=xhs_mode),
                    timeout=40.0,
                )
                if res and len(res) > 0:
                    return res
            except xhs_service.XhsError as err:
                xhs_notice = str(err)
                print(f"[RedNote] XhsError for keyword '{kw}': {err}")
                if "Cookie" in str(err):
                    break
            except Exception as exc:
                print(f"[RedNote] Search error/timeout for keyword '{kw}': {exc!r}")
                continue
        return []

    dy_results, bili_results, xhs_results = await asyncio.gather(
        _platform_search(douyin_service.search_videos, bool(chosen & {"all", "douyin"})),
        _platform_search(bilibili_service.search_videos, bool(chosen & {"all", "bilibili"})),
        _safe_xhs_search(),
        return_exceptions=True,
    )

    if isinstance(dy_results, Exception):
        dy_results = []
    if isinstance(bili_results, Exception):
        bili_results = []
    if isinstance(xhs_results, Exception):
        xhs_results = []

    # Interleave results so every platform appears prominently in "all" mode
    combined: List[Dict[str, Any]] = []
    platform_lists = [dy_results, bili_results, xhs_results]
    for i in range(max((len(lst) for lst in platform_lists), default=0)):
        for lst in platform_lists:
            if i < len(lst):
                combined.append(lst[i])

    return {
        "query": raw_query,
        "keyword": search_keyword,
        "zh_keywords": groups,
        "platform": platform_norm,
        "page": page,
        "douyin_count": len(dy_results),
        "bilibili_count": len(bili_results),
        "xhs_count": len(xhs_results),
        "xhs_notice": xhs_notice,
        "has_xhs_cookie": bool(xhs_service.get_xhs_cookie()),
        "total_count": len(combined),
        "items": combined,
    }


@app.post("/api/shopee-analyze")
async def analyze_shopee_and_search(payload: ShopeeAnalyzeRequest):
    raw_url = (payload.url or "").strip()
    if not raw_url:
        raise HTTPException(
            status_code=400,
            detail="กรุณาวางลิงก์สินค้า Shopee (รองรับทั้งลิงก์เต็ม ลิงก์หน้าเว็บ และลิงก์ย่อ s.shopee.co.th)",
        )
    try:
        product = await fetch_shopee_product_info(
            raw_input=raw_url,
            custom_keyword=payload.custom_keyword or "",
        )
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"ไม่สามารถอ่านข้อมูลลิงก์ Shopee ได้: {exc}")

    if payload.skip_search:
        return {
            "product": product,
            "search": {
                "keyword": product.get("zh_keyword") or "",
                "zh_keywords": product.get("zh_keywords") or [],
                "items": [],
            },
        }

    zh_keyword = (product.get("zh_keyword") or product.get("thai_keyword") or "").strip()
    search_data = await search_videos(
        q=zh_keyword,
        platform=payload.platform or "all",
        page=1,
        limit=payload.limit or 45,
        single=True,
    )
    return {
        "product": product,
        "search": search_data,
    }


@app.post("/api/resolve")
async def resolve_direct_url(payload: ResolveRequest):
    raw_text = (payload.url or "").strip()
    if not raw_text:
        raise HTTPException(status_code=400, detail="กรุณาวางลิงก์ URL หรือข้อความแชร์จากแอป")

    lower = raw_text.lower()
    if "shopee" in lower or "shp.ee" in lower:
        res = await analyze_shopee_and_search(ShopeeAnalyzeRequest(url=raw_text))
        return {**res, "is_shopee": True}

    if xhs_service.is_xhs_text(raw_text):
        try:
            return {"item": await xhs_service.resolve_note(raw_text)}
        except xhs_service.XhsError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    is_bilibili = any(k in lower for k in ["bilibili.com", "b23.tv", "bv1"])
    is_douyin = any(k in lower for k in ["douyin.com", "iesdouyin.com", "抖音"]) or bool(
        re.search(r"\b7\d{18}\b", raw_text)
    )

    if is_bilibili and not is_douyin:
        url_match = re.search(r"https?://[^\s\"'<>]+", raw_text)
        target = url_match.group(0) if url_match else raw_text
        item = await bilibili_service.resolve_url(target)
        if not item:
            raise HTTPException(status_code=404, detail="ไม่พบข้อมูลวิดีโอ Bilibili จากลิงก์ที่ระบุ")
        return {"item": item}

    if is_douyin:
        item = await douyin_service.resolve_url(raw_text)
        if not item:
            raise HTTPException(
                status_code=404,
                detail="ไม่สามารถดึงข้อมูลคลิป Douyin นี้ได้ (ลิงก์อาจไม่ถูกต้องหรือคลิปถูกลบ)",
            )
        return {"item": item}

    # Try both if ambiguous
    dy_item = await douyin_service.resolve_url(raw_text)
    if dy_item:
        return {"item": dy_item}

    bili_item = await bilibili_service.resolve_url(raw_text)
    if bili_item:
        return {"item": bili_item}

    raise HTTPException(
        status_code=400,
        detail="ไม่รองรับลิงก์นี้ กรุณาวางลิงก์จาก Douyin (v.douyin.com / douyin.com) หรือ Bilibili (bilibili.com / b23.tv)",
    )


@app.get("/api/proxy-image")
async def proxy_image(url: str = Query(...)):
    url = (url or "").strip()
    if url.startswith("//"):
        url = "https:" + url
    if not url or not url.startswith("http"):
        raise HTTPException(status_code=400, detail="Invalid image URL")

    headers = {
        "User-Agent": USER_AGENT,
        "Referer": get_referer_for_url(url),
    }
    try:
        async with guarded_client(headers=headers, follow_redirects=True, timeout=12.0) as client:
            resp = await client.get(url)
            if resp.status_code != 200:
                raise HTTPException(status_code=resp.status_code, detail="Image fetch failed")
            content_type = resp.headers.get("content-type", "image/jpeg")
            return Response(
                content=resp.content,
                media_type=content_type,
                headers={"Cache-Control": "public, max-age=86400"},
            )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))


async def _get_bilibili_preview_url(bvid: str) -> Optional[str]:
    headers = {
        "User-Agent": USER_AGENT,
        "Referer": f"https://www.bilibili.com/video/{bvid}",
    }
    async with httpx.AsyncClient(headers=headers, follow_redirects=True, timeout=12.0) as client:
        r_view = await client.get(
            "https://api.bilibili.com/x/web-interface/view", params={"bvid": bvid}
        )
        if r_view.status_code != 200:
            return None
        vdata = r_view.json().get("data") or {}
        cid = vdata.get("cid")
        if not cid:
            return None

        r_play = await client.get(
            "https://api.bilibili.com/x/player/playurl",
            params={
                "bvid": bvid,
                "cid": cid,
                "qn": 64,
                "fnval": 1,
                "platform": "html5",
                "high_quality": 1,
            },
        )
        if r_play.status_code != 200:
            return None
        durl = (r_play.json().get("data") or {}).get("durl") or []
        if durl and durl[0].get("url"):
            return durl[0]["url"]
    return None


async def _xhs_video_url(note_id: str, hint_url: str = "") -> str:
    """RedNote video file URL (hint = CDN URL or the note page URL with its xsec_token)."""
    try:
        return await xhs_service.get_video_url(note_id, hint_url)
    except xhs_service.XhsError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.get("/api/stream")
async def stream_video(
    request: Request,
    platform: str = Query(...),
    id: str = Query(...),
    direct_url: str = Query(""),
):
    plat = platform.lower().strip()
    stream_target = direct_url.strip()

    if plat == "douyin":
        if not stream_target or "douyin.com/video/" in stream_target:
            detail = await douyin_service.get_video_detail(id)
            if not detail or not detail.get("direct_video_url"):
                raise HTTPException(status_code=404, detail="ไม่พบลิงก์สตรีมของวิดีโอ Douyin นี้")
            stream_target = detail["direct_video_url"]
        referer = "https://www.douyin.com/"
    elif plat == "xhs":
        stream_target = await _xhs_video_url(id, stream_target)
        referer = "" if xhs_service.is_video_cdn_url(stream_target) else xhs_service.REFERER
    elif plat == "bilibili":
        bili_mp4 = await bilibili_service.get_preview_mp4_url(id)
        if not bili_mp4:
            raise HTTPException(status_code=404, detail="ไม่พบลิงก์สตรีมของวิดีโอ Bilibili นี้")
        stream_target = bili_mp4
        referer = f"https://www.bilibili.com/video/{id}"
    else:
        raise HTTPException(status_code=400, detail="Unsupported platform")

    req_headers = {
        "User-Agent": USER_AGENT,
    }
    if referer:
        req_headers["Referer"] = referer
    if "range" in request.headers:
        req_headers["Range"] = request.headers["range"]

    client = guarded_client(follow_redirects=True, timeout=30.0)
    req = client.build_request("GET", stream_target, headers=req_headers)
    try:
        resp = await client.send(req, stream=True)
    except Exception as exc:
        await client.aclose()
        raise HTTPException(status_code=502, detail=f"Stream fetch failed: {exc}")

    response_headers = {
        "Accept-Ranges": "bytes",
    }
    for h in ["content-length", "content-range", "content-type"]:
        if h in resp.headers:
            response_headers[h] = resp.headers[h]

    async def _iter_stream():
        try:
            async for chunk in resp.aiter_bytes(chunk_size=65536):
                yield chunk
        finally:
            await resp.aclose()
            await client.aclose()

    return StreamingResponse(
        _iter_stream(),
        status_code=resp.status_code,
        media_type=resp.headers.get("content-type", "video/mp4"),
        headers=response_headers,
    )


@app.get("/api/download")
async def download_video(
    platform: str = Query(...),
    id: str = Query(...),
    title: str = Query("video"),
    audio_only: bool = Query(False),
    direct_url: str = Query(""),
):
    plat = platform.lower().strip()
    safe_title = sanitize_filename(f"[{plat.upper()}] {title}_{id}")
    ext = "mp3" if audio_only else "mp4"
    encoded_filename = quote(f"{safe_title}.{ext}")

    xhs_video = await _xhs_video_url(id, direct_url) if plat == "xhs" else ""
    if plat == "xhs" and not audio_only:
        client = guarded_client(follow_redirects=True, timeout=60.0)
        xhs_req_headers = {"User-Agent": USER_AGENT}
        if not xhs_service.is_video_cdn_url(xhs_video):
            xhs_req_headers["Referer"] = xhs_service.REFERER
        req = client.build_request("GET", xhs_video, headers=xhs_req_headers)
        try:
            resp = await client.send(req, stream=True)
        except Exception as exc:
            await client.aclose()
            raise HTTPException(status_code=502, detail=f"ดาวน์โหลดไม่สำเร็จ: {exc}")
        if resp.status_code >= 400:
            await resp.aclose()
            await client.aclose()
            raise HTTPException(status_code=502, detail=f"ดาวน์โหลดไม่สำเร็จ (HTTP {resp.status_code})")

        async def _iter_xhs():
            try:
                async for chunk in resp.aiter_bytes(chunk_size=65536):
                    yield chunk
            finally:
                await resp.aclose()
                await client.aclose()

        xhs_headers = {"Content-Disposition": "attachment; filename*=UTF-8''" + encoded_filename}
        if "content-length" in resp.headers:
            xhs_headers["Content-Length"] = resp.headers["content-length"]
        return StreamingResponse(_iter_xhs(), media_type="video/mp4", headers=xhs_headers)

    if plat == "douyin" and not audio_only:
        detail = await douyin_service.get_video_detail(id)
        if detail and detail.get("direct_video_url"):
            stream_target = detail["direct_video_url"]
            client = httpx.AsyncClient(follow_redirects=True, timeout=60.0)
            req = client.build_request(
                "GET",
                stream_target,
                headers={"User-Agent": USER_AGENT, "Referer": "https://www.douyin.com/"},
            )
            resp = await client.send(req, stream=True)
            headers = {
                "Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}",
            }
            if "content-length" in resp.headers:
                headers["Content-Length"] = resp.headers["content-length"]

            async def _iter_dl():
                try:
                    async for chunk in resp.aiter_bytes(chunk_size=65536):
                        yield chunk
                finally:
                    await resp.aclose()
                    await client.aclose()

            return StreamingResponse(
                _iter_dl(),
                media_type="video/mp4",
                headers=headers,
            )

    # For Bilibili (or Douyin / RedNote audio extraction), use yt-dlp + ffmpeg
    if plat == "bilibili":
        target_url = f"https://www.bilibili.com/video/{id}"
    elif plat == "xhs":
        target_url = xhs_video
    else:
        detail = await douyin_service.get_video_detail(id)
        target_url = (
            detail.get("direct_video_url")
            if detail and detail.get("direct_video_url")
            else f"https://www.douyin.com/video/{id}"
        )

    file_path, err = await download_with_ytdlp(
        url=target_url,
        title=safe_title,
        cookie_str=douyin_service.get_user_cookie(),
        audio_only=audio_only,
    )
    if not file_path or not file_path.exists():
        raise HTTPException(
            status_code=500,
            detail=f"ดาวน์โหลดไม่สำเร็จ: {err or 'Unknown error'}",
        )

    return FileResponse(
        path=str(file_path),
        filename=f"{safe_title}.{file_path.suffix.lstrip('.')}",
        media_type="audio/mpeg" if audio_only else "video/mp4",
    )


@app.get("/api/channels")
async def api_list_channels(check: bool = Query(False)):
    if check:
        return await refresh_all_channels()
    return list_channels()


@app.post("/api/channels")
async def api_add_channel(payload: AddChannelRequest):
    cookie = (payload.cookie or "").strip()
    if not cookie:
        return JSONResponse(status_code=400, content={"error": "ต้องแนบค่า cookie"})
    try:
        channel = await add_channel(cookie=cookie, label=payload.label or "")
        return channel
    except Exception as exc:
        return JSONResponse(
            status_code=502,
            content={"error": f"เพิ่มช่องทางไม่สำเร็จ ตรวจสอบว่า cookie ยังไม่หมดอายุ: {exc}"},
        )


@app.post("/api/channels/{channel_id}/refresh")
async def api_refresh_channel(channel_id: str):
    updated, err = await refresh_channel(channel_id)
    if not updated and err == "ไม่พบช่องทางนี้":
        return JSONResponse(status_code=404, content={"error": err})
    if err:
        return JSONResponse(
            status_code=502,
            content={"error": err, "channel": updated},
        )
    return updated


@app.patch("/api/channels/{channel_id}")
async def api_patch_channel(channel_id: str, payload: UpdateChannelLabelRequest):
    label = (payload.label or "").strip()
    if not label:
        return JSONResponse(status_code=400, content={"error": "ชื่อเรียกห้ามว่าง"})
    updated = update_channel_label(channel_id, label)
    if not updated:
        return JSONResponse(status_code=404, content={"error": "ไม่พบช่องทางนี้"})
    return updated


@app.delete("/api/channels/{channel_id}")
async def api_delete_channel(channel_id: str):
    ok = remove_channel(channel_id)
    if not ok:
        return JSONResponse(status_code=404, content={"error": "ไม่พบช่องทางนี้"})
    return {"ok": True}


@app.get("/api/settings")
async def get_settings():
    cookies = douyin_service._active_cookies()
    has_guest = bool(cookies.get("UIFID_TEMP") or cookies.get("uifid"))
    user_cookie = douyin_service.get_user_cookie()
    sh_cookie = get_shopee_cookie()
    return {
        "has_guest_session": has_guest,
        "has_user_cookie": bool(user_cookie),
        "has_shopee_cookie": bool(sh_cookie),
    }


@app.post("/api/settings")
async def save_settings(payload: SettingsRequest):
    douyin_service.set_user_cookie(payload.douyin_cookie)
    set_shopee_cookie(payload.shopee_cookie)
    return {
        "status": "ok",
        "has_user_cookie": bool(payload.douyin_cookie.strip()),
        "has_shopee_cookie": bool(payload.shopee_cookie.strip()),
    }


class XhsCookieRequest(BaseModel):
    cookie: Optional[str] = None
    proxy: Optional[str] = None


@app.get("/api/xhs/cookie")
async def api_xhs_cookie_status():
    # Never return the cookie itself — only whether one is saved
    return {
        "has_cookie": bool(xhs_service.get_xhs_cookie()),
        "proxy": xhs_service.get_xhs_proxy(),
    }


@app.post("/api/xhs/cookie")
async def api_save_xhs_cookie(payload: XhsCookieRequest):
    if payload.cookie is not None:
        xhs_service.set_xhs_cookie(payload.cookie)
    if payload.proxy is not None:
        xhs_service.set_xhs_proxy(payload.proxy)
    return {
        "has_cookie": bool(xhs_service.get_xhs_cookie()),
        "proxy": xhs_service.get_xhs_proxy(),
    }


@app.post("/api/mint-guest")
async def refresh_guest_session():
    cookies = await douyin_service.ensure_signing_cookies(force_refresh=True)
    has_guest = bool(cookies.get("UIFID_TEMP") or cookies.get("uifid"))
    return {"status": "ok", "has_guest_session": has_guest}


# ============================================================================
# PAGE 2: AI VIDEO MAKER STUDIO API ROUTES
# ============================================================================
class StudioConfigSaveRequest(BaseModel):
    gemini_api_keys: Optional[str | List[str]] = None
    openrouter_api_keys: Optional[str | List[str]] = None
    default_voice: Optional[str] = None
    preferences: Optional[Dict[str, Any]] = None


class StudioTestKeyRequest(BaseModel):
    api_key: str = ""
    openrouter_api_key: str = ""


class StudioShopeeInfoRequest(BaseModel):
    url: str


class StudioGenerateRequest(BaseModel):
    product_title: str = ""
    product_description: str = ""
    target_duration: int = 20
    sales_angle: str = "podcast_ad"
    custom_header: str = ""
    custom_script: str = ""
    voice_name: str = "Puck"
    voice_gender: str = "Male"
    speed_rate: str = "+15%"
    api_key: str = ""
    openrouter_api_key: str = ""
    rewrite_script: bool = True


class StudioConvertMp4Request(BaseModel):
    video_data_url: str
    fps: int = 30


@app.get("/api/studio/config")
async def api_get_studio_config():
    cfg = load_studio_config()
    keys = cfg.get("gemini_api_keys") or []
    or_keys = cfg.get("openrouter_api_keys") or []
    return {
        "status": "ok",
        "gemini_api_keys": keys,
        "gemini_api_keys_text": "\n".join(keys),
        "key_count": len(keys),
        "openrouter_api_keys": or_keys,
        "openrouter_api_keys_text": "\n".join(or_keys),
        "openrouter_key_count": len(or_keys),
        "default_voice": cfg.get("default_voice", "Puck"),
        "preferences": cfg.get("preferences") or {},
        "voices": VOICE_CATALOG,
    }


@app.post("/api/studio/config")
async def api_save_studio_config(payload: StudioConfigSaveRequest):
    cfg = save_studio_config(
        gemini_keys_raw=payload.gemini_api_keys,
        default_voice=payload.default_voice,
        openrouter_keys_raw=payload.openrouter_api_keys,
        preferences=payload.preferences,
    )
    keys = cfg.get("gemini_api_keys") or []
    or_keys = cfg.get("openrouter_api_keys") or []
    return {
        "status": "ok",
        "gemini_api_keys": keys,
        "gemini_api_keys_text": "\n".join(keys),
        "key_count": len(keys),
        "openrouter_api_keys": or_keys,
        "openrouter_api_keys_text": "\n".join(or_keys),
        "openrouter_key_count": len(or_keys),
        "default_voice": cfg.get("default_voice", "Puck"),
        "preferences": cfg.get("preferences") or {},
    }


@app.post("/api/studio/test-key")
async def api_test_studio_key(payload: StudioTestKeyRequest):
    from services.video_studio_service import test_openrouter_api_key

    results: List[str] = []
    any_ok = False
    has_or = bool((payload.openrouter_api_key or "").strip())
    has_gem = bool((payload.api_key or "").strip())

    if has_or:
        or_ok, or_msg = await test_openrouter_api_key(payload.openrouter_api_key)
        any_ok = any_ok or or_ok
        results.append(or_msg)
    if has_gem or not has_or:
        gem_ok, gem_msg = await test_gemini_api_key(payload.api_key)
        any_ok = any_ok or gem_ok
        results.append(gem_msg)

    return {
        "status": "ok" if any_ok else "error",
        "valid": any_ok,
        "message": " | ".join(results),
    }


@app.post("/api/studio/shopee-info")
async def api_studio_shopee_info(payload: StudioShopeeInfoRequest):
    raw_url = (payload.url or "").strip()
    if not raw_url:
        raise HTTPException(status_code=400, detail="กรุณาวางลิงก์สินค้า Shopee")
    try:
        product = await fetch_shopee_product_info(raw_input=raw_url)
        return {"status": "ok", "product": product}
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"ไม่สามารถดึงข้อมูลสินค้า Shopee ได้: {exc}")


@app.post("/api/studio/generate-script")
async def api_studio_generate_script(payload: StudioGenerateRequest):
    try:
        v_gender = payload.voice_gender
        for v in VOICE_CATALOG:
            if v["id"] == payload.voice_name:
                v_gender = v.get("gender", v_gender)
                break
        script_res = await generate_product_review_script(
            product_title=payload.product_title,
            product_description=payload.product_description,
            target_duration=payload.target_duration,
            sales_angle=payload.sales_angle,
            custom_header=payload.custom_header,
            voice_gender=v_gender,
            api_key=payload.api_key,
            openrouter_api_key=payload.openrouter_api_key,
        )
        return {"status": "ok", **script_res}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"คิดบทพูดไม่สำเร็จ: {exc}")


@app.post("/api/studio/generate-all")
async def api_studio_generate_all(payload: StudioGenerateRequest):
    try:
        # Resolve voice gender from catalog if not specified or to ensure exact match
        v_gender = payload.voice_gender
        for v in VOICE_CATALOG:
            if v["id"] == payload.voice_name:
                v_gender = v.get("gender", v_gender)
                break

        if payload.rewrite_script or not (payload.custom_script or "").strip():
            script_res = await generate_product_review_script(
                product_title=payload.product_title,
                product_description=payload.product_description,
                target_duration=payload.target_duration,
                sales_angle=payload.sales_angle,
                custom_header=payload.custom_header,
                voice_gender=v_gender,
                api_key=payload.api_key,
                openrouter_api_key=payload.openrouter_api_key,
            )
            short_headline = script_res["short_headline"]
            spoken_script = script_res["spoken_script"]
            scenes = script_res["scenes"]
            model_used = script_res["model_used"]
        else:
            spoken_script = payload.custom_script.strip()
            scenes = smart_split_scenes(spoken_script, target_sec=payload.target_duration)
            short_headline = (payload.custom_header or payload.product_title[:20] or "รีวิวของเด็ดต้องมี!").strip()
            model_used = "manual-script"

        voice_res = await synthesize_voiceover_and_timings(
            scenes=scenes,
            spoken_script=spoken_script,
            voice_name=payload.voice_name,
            speed_rate=payload.speed_rate,
            sales_angle=payload.sales_angle,
            api_key=payload.api_key,
            openrouter_api_key=payload.openrouter_api_key,
        )

        return {
            "status": "ok",
            "short_headline": short_headline,
            "spoken_script": voice_res["spoken_script"],
            "scenes": voice_res["scenes"],
            "audio_base64": voice_res["audio_base64"],
            "mime_type": voice_res["mime_type"],
            "audio_duration": voice_res["audio_duration"],
            "engine": voice_res["engine"],
            "fallback_notice": voice_res["fallback_notice"],
            "model_used": model_used,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"สร้างบทและเสียงพากย์ไม่สำเร็จ: {exc}")


_CLIP_LOCKS: Dict[str, asyncio.Lock] = {}
_CLIP_PROGRESS: Dict[str, Dict[str, Any]] = {}


def _clip_cache_key_and_path(platform: str, id: str) -> tuple[str, Path]:
    plat = platform.lower().strip()
    safe_id = re.sub(r"[^a-zA-Z0-9_\-]", "", id)[:60] or "clip"
    return f"{plat}_{safe_id}", CLIP_CACHE_DIR / f"{plat}_{safe_id}.mp4"


@app.get("/api/studio/clip-progress")
async def api_studio_clip_progress(
    platform: str = Query(...),
    id: str = Query(...),
):
    lock_key, cached_path = _clip_cache_key_and_path(platform, id)
    if cached_path.exists() and cached_path.stat().st_size > 10000:
        sz = cached_path.stat().st_size
        return {"status": "done", "loaded": sz, "total": sz, "pct": 100}
    prog = _CLIP_PROGRESS.get(lock_key)
    if prog:
        return prog
    return {"status": "pending", "loaded": 0, "total": 0, "pct": 0}


@app.get("/api/studio/clip-file")
async def api_studio_clip_file(
    platform: str = Query(...),
    id: str = Query(...),
    direct_url: str = Query(""),
):
    plat = platform.lower().strip()
    lock_key, cached_path = _clip_cache_key_and_path(plat, id)

    if cached_path.exists() and cached_path.stat().st_size > 10000:
        sz = cached_path.stat().st_size
        _CLIP_PROGRESS[lock_key] = {"status": "done", "loaded": sz, "total": sz, "pct": 100}
        return FileResponse(
            path=str(cached_path),
            media_type="video/mp4",
            headers={"Cache-Control": "public, max-age=3600"},
        )

    if lock_key not in _CLIP_LOCKS:
        _CLIP_LOCKS[lock_key] = asyncio.Lock()

    async with _CLIP_LOCKS[lock_key]:
        if cached_path.exists() and cached_path.stat().st_size > 10000:
            sz = cached_path.stat().st_size
            _CLIP_PROGRESS[lock_key] = {"status": "done", "loaded": sz, "total": sz, "pct": 100}
            return FileResponse(
                path=str(cached_path),
                media_type="video/mp4",
                headers={"Cache-Control": "public, max-age=3600"},
            )

        stream_target = direct_url.strip()
        if plat == "douyin":
            if not stream_target or "douyin.com/video/" in stream_target:
                detail = await douyin_service.get_video_detail(id)
                if not detail or not detail.get("direct_video_url"):
                    raise HTTPException(status_code=404, detail="ไม่พบลิงก์วิดีโอ Douyin นี้")
                stream_target = detail["direct_video_url"]
            referer = "https://www.douyin.com/"
        elif plat == "xhs":
            stream_target = await _xhs_video_url(id, stream_target)
            referer = "" if xhs_service.is_video_cdn_url(stream_target) else xhs_service.REFERER
        elif plat == "bilibili":
            bili_mp4 = await bilibili_service.get_preview_mp4_url(id)
            if not bili_mp4:
                raise HTTPException(status_code=404, detail="ไม่พบลิงก์วิดีโอ Bilibili นี้")
            stream_target = bili_mp4
            referer = f"https://www.bilibili.com/video/{id}"
        else:
            raise HTTPException(status_code=400, detail="Unsupported platform")

        req_headers = {
            "User-Agent": USER_AGENT,
        }
        if referer:
            req_headers["Referer"] = referer
        tmp_path = cached_path.with_suffix(".part")
        _CLIP_PROGRESS[lock_key] = {"status": "downloading", "loaded": 0, "total": 0, "pct": 0}
        try:
            async with guarded_client(follow_redirects=True, timeout=45.0) as client:
                async with client.stream("GET", stream_target, headers=req_headers) as resp:
                    if resp.status_code >= 400:
                        raise HTTPException(status_code=502, detail="ดาวน์โหลดไฟล์คลิปต้นฉบับไม่สำเร็จ")
                    total_bytes = int(resp.headers.get("content-length") or 0)
                    loaded_bytes = 0
                    _CLIP_PROGRESS[lock_key] = {
                        "status": "downloading",
                        "loaded": 0,
                        "total": total_bytes,
                        "pct": 0,
                    }
                    with open(tmp_path, "wb") as f:
                        async for chunk in resp.aiter_bytes(chunk_size=131072):
                            f.write(chunk)
                            loaded_bytes += len(chunk)
                            pct = min(99, int(loaded_bytes * 100 / total_bytes)) if total_bytes > 0 else 0
                            _CLIP_PROGRESS[lock_key] = {
                                "status": "downloading",
                                "loaded": loaded_bytes,
                                "total": total_bytes,
                                "pct": pct,
                            }
            if tmp_path.exists() and tmp_path.stat().st_size > 10000:
                tmp_path.replace(cached_path)
                sz = cached_path.stat().st_size
                _CLIP_PROGRESS[lock_key] = {"status": "done", "loaded": sz, "total": sz, "pct": 100}
        except Exception as exc:
            _CLIP_PROGRESS[lock_key] = {"status": "error", "loaded": 0, "total": 0, "pct": 0, "detail": str(exc)}
            try:
                if tmp_path.exists():
                    tmp_path.unlink()
            except OSError:
                pass
            raise HTTPException(status_code=502, detail=str(exc))

        return FileResponse(
            path=str(cached_path),
            media_type="video/mp4",
            headers={"Cache-Control": "public, max-age=3600"},
        )


class StudioCensorRequest(BaseModel):
    platform: str
    id: str
    direct_url: str = ""
    force: bool = True


@app.get("/api/studio/censor-progress")
async def api_studio_censor_progress(
    platform: str = Query(...),
    id: str = Query(...),
):
    from services.censor_service import get_censor_progress

    lock_key, _ = _clip_cache_key_and_path(platform, id)
    return get_censor_progress(lock_key)


@app.get("/api/studio/censored-file")
async def api_studio_censored_file(key: str = Query(...)):
    safe_key = re.sub(r"[^a-zA-Z0-9_\-]", "", key)[:80]
    if not safe_key:
        raise HTTPException(status_code=400, detail="Invalid clip key")
    censored_path = CLIP_CACHE_DIR / f"{safe_key}.censored.mp4"
    if not censored_path.exists() or censored_path.stat().st_size <= 10000:
        raise HTTPException(status_code=404, detail="ไม่พบไฟล์คลิปที่เซนเซอร์แล้ว")
    return FileResponse(
        path=str(censored_path),
        media_type="video/mp4",
        headers={"Cache-Control": "no-store"},
    )


@app.post("/api/studio/censor-chinese")
async def api_studio_censor_chinese(payload: StudioCensorRequest):
    import time
    from services.censor_service import censor_and_render_video

    lock_key, cached_path = _clip_cache_key_and_path(payload.platform, payload.id)
    if not cached_path.exists() or cached_path.stat().st_size <= 10000:
        await api_studio_clip_file(platform=payload.platform, id=payload.id, direct_url=payload.direct_url)
    if not cached_path.exists():
        raise HTTPException(status_code=404, detail="ไม่พบไฟล์คลิปสำหรับสแกนภาษาจีน")

    json_cache_path = cached_path.with_suffix(".censor.json")
    censored_path = CLIP_CACHE_DIR / f"{lock_key}.censored.mp4"
    try:
        result = await asyncio.to_thread(
            censor_and_render_video,
            str(cached_path),
            censored_path,
            lock_key,
            json_cache_path,
            payload.force,
        )
        return {
            **result,
            "censored_url": f"/api/studio/censored-file?key={quote(lock_key)}&v={int(time.time())}",
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"เซนเซอร์ภาษาจีนไม่สำเร็จ: {exc}")


@app.post("/api/studio/censor-chinese-upload")
async def api_studio_censor_chinese_upload(
    file: UploadFile = File(...),
    clip_key: str = Form(""),
):
    import time, uuid
    from services.censor_service import censor_and_render_video

    safe_key = re.sub(r"[^a-zA-Z0-9_\-]", "", clip_key)[:60] or f"pc_{uuid.uuid4().hex[:12]}"
    censored_path = CLIP_CACHE_DIR / f"{safe_key}.censored.mp4"
    with tempfile.TemporaryDirectory(prefix="censor_upload_") as tmpdir:
        in_path = os.path.join(tmpdir, "clip.mp4")
        with open(in_path, "wb") as f:
            while chunk := await file.read(1024 * 1024):
                f.write(chunk)
        try:
            result = await asyncio.to_thread(
                censor_and_render_video,
                in_path,
                censored_path,
                safe_key,
                None,
                True,
            )
            return {
                **result,
                "censored_url": f"/api/studio/censored-file?key={quote(safe_key)}&v={int(time.time())}",
            }
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"เซนเซอร์ภาษาจีนไม่สำเร็จ: {exc}")


@app.post("/api/studio/convert-mp4")
async def api_studio_convert_mp4(payload: StudioConvertMp4Request):
    try:
        mp4_bytes = await asyncio.to_thread(
            convert_video_data_url_to_mp4,
            payload.video_data_url,
            payload.fps,
        )
        return Response(
            content=mp4_bytes,
            media_type="video/mp4",
            headers={
                "Content-Disposition": 'attachment; filename="ai-review-video.mp4"',
            },
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/studio/convert-mp4-file")
async def api_studio_convert_mp4_file(
    file: UploadFile = File(...),
    fps: int = Form(30),
):
    """
    Accepts multipart/form-data upload of recorded WebM/MP4 blob directly.
    Streams directly to disk in chunks to avoid memory spikes, then converts via FFmpeg.
    """
    with tempfile.TemporaryDirectory(prefix="studio_upload_") as tmpdir:
        in_path = os.path.join(tmpdir, "in_recording.webm")
        out_path = os.path.join(tmpdir, "out_final.mp4")
        try:
            with open(in_path, "wb") as f:
                while chunk := await file.read(1024 * 1024):
                    f.write(chunk)

            await asyncio.to_thread(convert_video_file_to_mp4, in_path, out_path, fps)

            with open(out_path, "rb") as f:
                mp4_bytes = f.read()

            return Response(
                content=mp4_bytes,
                media_type="video/mp4",
                headers={
                    "Content-Disposition": 'attachment; filename="ai-review-video.mp4"',
                },
            )
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"แปลงไฟล์ MP4 ไม่สำเร็จ: {exc}")


# Mount static frontend
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
