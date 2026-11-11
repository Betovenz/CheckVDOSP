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
from fastapi.middleware.cors import CORSMiddleware
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
    refresh_all_channels,
    refresh_channel,
    remove_channel,
    set_shopee_cookie,
    translate_thai_to_chinese,
    translate_to_chinese,
    update_channel_label,
)
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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def disable_static_cache(request: Request, call_next):
    response = await call_next(request)
    if request.url.path in ("/", "/index.html", "/app.js", "/studio.js", "/styles.css"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return response

bilibili_service = BilibiliService()
douyin_service = DouyinService()

STATIC_DIR = Path(__file__).resolve().parent / "static"
STATIC_DIR.mkdir(parents=True, exist_ok=True)


class ResolveRequest(BaseModel):
    url: str


class ShopeeAnalyzeRequest(BaseModel):
    url: str
    custom_keyword: str = ""
    platform: str = "all"
    limit: int = 75


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


MAX_KEYWORD_GROUPS = 3


def _split_keyword_groups(keyword: str) -> List[str]:
    """'A | B | C' -> ['A', 'B', 'C'] (max 3). Drops junk groups like '100%' that have no letters."""
    groups: List[str] = []
    for g in re.split(r"[|｜]+", keyword or ""):
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


@app.get("/api/search")
async def search_videos(
    q: str = Query(..., min_length=1, description="Keyword to search (Thai, English, or Chinese)"),
    platform: str = Query("all", description="all | douyin | bilibili"),
    page: int = Query(1, ge=1),
    limit: int = Query(75, ge=4, le=150),
):
    raw_query = q.strip()
    platform_norm = platform.lower().strip()

    # Automatically translate Thai or English into Chinese for Douyin & Bilibili search
    search_keyword = await translate_to_chinese(raw_query)
    if not search_keyword:
        search_keyword = raw_query

    # Multi-keyword ("A | B | C"): search each keyword (max 3) separately & concurrently,
    # then interleave so every keyword gets an equal share of the results.
    groups = _split_keyword_groups(search_keyword)
    per_group_limit = max(4, -(-limit // len(groups)))  # ceil

    async def _platform_search(service, enabled: bool) -> List[Dict[str, Any]]:
        if not enabled:
            return []
        group_results = await asyncio.gather(
            *[service.search_videos(g, page=page, limit=per_group_limit) for g in groups],
            return_exceptions=True,
        )
        lists = [r for r in group_results if isinstance(r, list)]
        return _interleave_unique(lists, limit)

    dy_results, bili_results = await asyncio.gather(
        _platform_search(douyin_service, platform_norm in ("all", "douyin")),
        _platform_search(bilibili_service, platform_norm in ("all", "bilibili")),
        return_exceptions=True,
    )

    if isinstance(dy_results, Exception):
        dy_results = []
    if isinstance(bili_results, Exception):
        bili_results = []

    # Interleave results so both platforms appear prominently in "all" mode
    combined: List[Dict[str, Any]] = []
    max_len = max(len(dy_results), len(bili_results))
    for i in range(max_len):
        if i < len(dy_results):
            combined.append(dy_results[i])
        if i < len(bili_results):
            combined.append(bili_results[i])

    return {
        "query": raw_query,
        "keyword": search_keyword,
        "platform": platform_norm,
        "page": page,
        "douyin_count": len(dy_results),
        "bilibili_count": len(bili_results),
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

    zh_keyword = (product.get("zh_keyword") or product.get("thai_keyword") or "").strip()
    search_data = await search_videos(
        q=zh_keyword,
        platform=payload.platform or "all",
        page=1,
        limit=payload.limit or 75,
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
    if not url or not url.startswith("http"):
        raise HTTPException(status_code=400, detail="Invalid image URL")

    headers = {
        "User-Agent": USER_AGENT,
        "Referer": get_referer_for_url(url),
    }
    try:
        async with httpx.AsyncClient(headers=headers, follow_redirects=True, timeout=12.0) as client:
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
        "Referer": referer,
    }
    if "range" in request.headers:
        req_headers["Range"] = request.headers["range"]

    client = httpx.AsyncClient(follow_redirects=True, timeout=30.0)
    req = client.build_request("GET", stream_target, headers=req_headers)
    resp = await client.send(req, stream=True)

    response_headers = {
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
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
):
    plat = platform.lower().strip()
    safe_title = sanitize_filename(f"[{plat.upper()}] {title}_{id}")
    ext = "mp3" if audio_only else "mp4"
    encoded_filename = quote(f"{safe_title}.{ext}")

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

    # For Bilibili (or Douyin audio extraction), use yt-dlp + ffmpeg
    if plat == "bilibili":
        target_url = f"https://www.bilibili.com/video/{id}"
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
        "douyin_cookie": user_cookie,
        "shopee_cookie": sh_cookie,
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


@app.post("/api/mint-guest")
async def refresh_guest_session():
    cookies = await douyin_service.ensure_signing_cookies(force_refresh=True)
    has_guest = bool(cookies.get("UIFID_TEMP") or cookies.get("uifid"))
    return {"status": "ok", "has_guest_session": has_guest}


# ============================================================================
# PAGE 2: AI VIDEO MAKER STUDIO API ROUTES
# ============================================================================
class StudioConfigSaveRequest(BaseModel):
    gemini_api_keys: str | List[str] = ""
    default_voice: str = "Puck"


class StudioTestKeyRequest(BaseModel):
    api_key: str = ""


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
    rewrite_script: bool = True


class StudioConvertMp4Request(BaseModel):
    video_data_url: str
    fps: int = 30


@app.get("/api/studio/config")
async def api_get_studio_config():
    cfg = load_studio_config()
    keys = cfg.get("gemini_api_keys") or []
    return {
        "status": "ok",
        "gemini_api_keys": keys,
        "gemini_api_keys_text": "\n".join(keys),
        "key_count": len(keys),
        "default_voice": cfg.get("default_voice", "Puck"),
        "voices": VOICE_CATALOG,
    }


@app.post("/api/studio/config")
async def api_save_studio_config(payload: StudioConfigSaveRequest):
    cfg = save_studio_config(
        gemini_keys_raw=payload.gemini_api_keys,
        default_voice=payload.default_voice,
    )
    keys = cfg.get("gemini_api_keys") or []
    return {
        "status": "ok",
        "gemini_api_keys": keys,
        "gemini_api_keys_text": "\n".join(keys),
        "key_count": len(keys),
        "default_voice": cfg.get("default_voice", "Puck"),
    }


@app.post("/api/studio/test-key")
async def api_test_studio_key(payload: StudioTestKeyRequest):
    ok, msg = await test_gemini_api_key(payload.api_key)
    return {
        "status": "ok" if ok else "error",
        "valid": ok,
        "message": msg,
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


@app.get("/api/studio/clip-file")
async def api_studio_clip_file(
    platform: str = Query(...),
    id: str = Query(...),
    direct_url: str = Query(""),
):
    plat = platform.lower().strip()
    safe_id = re.sub(r"[^a-zA-Z0-9_\-]", "", id)[:60] or "clip"
    cached_path = CLIP_CACHE_DIR / f"{plat}_{safe_id}.mp4"

    if cached_path.exists() and cached_path.stat().st_size > 10000:
        return FileResponse(
            path=str(cached_path),
            media_type="video/mp4",
            headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600"},
        )

    stream_target = direct_url.strip()
    if plat == "douyin":
        if not stream_target or "douyin.com/video/" in stream_target:
            detail = await douyin_service.get_video_detail(id)
            if not detail or not detail.get("direct_video_url"):
                raise HTTPException(status_code=404, detail="ไม่พบลิงก์วิดีโอ Douyin นี้")
            stream_target = detail["direct_video_url"]
        referer = "https://www.douyin.com/"
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
        "Referer": referer,
    }
    tmp_path = cached_path.with_suffix(".part")
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=45.0) as client:
            async with client.stream("GET", stream_target, headers=req_headers) as resp:
                if resp.status_code >= 400:
                    raise HTTPException(status_code=502, detail="ดาวน์โหลดไฟล์คลิปต้นฉบับไม่สำเร็จ")
                with open(tmp_path, "wb") as f:
                    async for chunk in resp.aiter_bytes(chunk_size=131072):
                        f.write(chunk)
        if tmp_path.exists() and tmp_path.stat().st_size > 10000:
            tmp_path.replace(cached_path)
    except Exception as exc:
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except OSError:
            pass
        raise HTTPException(status_code=502, detail=str(exc))

    return FileResponse(
        path=str(cached_path),
        media_type="video/mp4",
        headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600"},
    )


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
                "Access-Control-Allow-Origin": "*",
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
                    "Access-Control-Allow-Origin": "*",
                },
            )
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"แปลงไฟล์ MP4 ไม่สำเร็จ: {exc}")


# Mount static frontend
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
