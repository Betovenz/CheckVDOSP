from __future__ import annotations

import asyncio
import html
import json
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

from services.douyin_signer import (
    DEFAULT_UA,
    mint_guest_douyin_cookies,
    pick_uifid,
    sign_douyin_query,
)

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.json"


def _parse_cookie_string(cookie_str: str) -> Dict[str, str]:
    jar: Dict[str, str] = {}
    if not cookie_str:
        return jar
    for part in cookie_str.split(";"):
        part = part.strip()
        if "=" in part:
            k, _, v = part.partition("=")
            k = k.strip()
            v = v.strip()
            if k:
                jar[k] = v
    return jar


def _format_duration(seconds: int | float) -> str:
    sec = int(round(seconds or 0))
    if sec <= 0:
        return "0:00"
    mins, rem = divmod(sec, 60)
    return f"{mins}:{rem:02d}"


def _base_douyin_params() -> Dict[str, str]:
    return {
        "device_platform": "webapp",
        "aid": "6383",
        "channel": "channel_pc_web",
        "pc_client_type": "1",
        "version_code": "290100",
        "version_name": "29.1.0",
        "cookie_enabled": "true",
        "screen_width": "1920",
        "screen_height": "1080",
        "browser_language": "zh-CN",
        "browser_platform": "Win32",
        "browser_name": "Chrome",
        "browser_version": "130.0.0.0",
        "browser_online": "true",
        "engine_name": "Blink",
        "engine_version": "130.0.0.0",
        "os_name": "Windows",
        "os_version": "10",
        "cpu_core_num": "12",
        "device_memory": "8",
        "platform": "PC",
        "downlink": "10",
        "effective_type": "4g",
        "round_trip_time": "0",
        "update_version_code": "170400",
    }


class DouyinService:
    def __init__(self) -> None:
        self.user_agent = DEFAULT_UA
        self._mint_lock = asyncio.Lock()
        self._config = self._load_config()

    def _load_config(self) -> Dict[str, Any]:
        if CONFIG_PATH.exists():
            try:
                return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            except Exception:
                pass
        return {"user_cookie": "", "guest_cookies": {}, "guest_minted_at": 0}

    def _save_config(self) -> None:
        try:
            CONFIG_PATH.write_text(
                json.dumps(self._config, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception:
            pass

    def get_user_cookie(self) -> str:
        self._config = self._load_config()
        return self._config.get("user_cookie", "")

    def set_user_cookie(self, cookie_str: str) -> None:
        self._config = self._load_config()
        self._config["user_cookie"] = (cookie_str or "").strip()
        self._save_config()

    def _active_cookies(self) -> Dict[str, str]:
        self._config = self._load_config()
        guest = dict(self._config.get("guest_cookies") or {})
        user = _parse_cookie_string(self._config.get("user_cookie", ""))
        return {**guest, **user}

    async def ensure_signing_cookies(self, force_refresh: bool = False) -> Dict[str, str]:
        cookies = self._active_cookies()
        if not force_refresh and pick_uifid(cookies) and cookies.get("ttwid"):
            return cookies

        async with self._mint_lock:
            cookies = self._active_cookies()
            if not force_refresh and pick_uifid(cookies) and cookies.get("ttwid"):
                return cookies

            minted = await mint_guest_douyin_cookies(self.user_agent)
            if minted:
                self._config["guest_cookies"] = minted
                self._config["guest_minted_at"] = int(time.time())
                self._save_config()
            return self._active_cookies()

    @staticmethod
    def extract_aweme_id_from_text_or_url(text: str) -> Optional[str]:
        if not text:
            return None
        for pattern in [
            r"/video/(\d{18,20})",
            r"/note/(\d{18,20})",
            r"/share/video/(\d{18,20})",
            r"/share/slides/(\d{18,20})",
            r"modal_id=(\d{18,20})",
            r"\b(7\d{18})\b",
        ]:
            m = re.search(pattern, text)
            if m:
                return m.group(1)
        return None

    async def resolve_aweme_id(self, raw_input: str) -> Optional[str]:
        direct = self.extract_aweme_id_from_text_or_url(raw_input)
        if direct:
            return direct

        url_match = re.search(r"https?://[^\s\"'<>]+", raw_input)
        target_url = url_match.group(0) if url_match else raw_input.strip()
        if not target_url.startswith("http"):
            return None

        async with httpx.AsyncClient(
            headers={"User-Agent": self.user_agent},
            follow_redirects=True,
            timeout=12.0,
        ) as client:
            resp = await client.get(target_url)
            resolved = str(resp.url)
            aweme_id = self.extract_aweme_id_from_text_or_url(resolved)
            if aweme_id:
                return aweme_id
            return self.extract_aweme_id_from_text_or_url(resp.text)

    @staticmethod
    def _parse_aweme_detail(detail: Dict[str, Any]) -> Dict[str, Any]:
        aweme_id = str(detail.get("aweme_id", ""))
        desc = (detail.get("desc") or "").strip() or f"Douyin Video {aweme_id}"
        author_info = detail.get("author") or {}
        author_name = author_info.get("nickname") or "Douyin Creator"
        avatar_list = (author_info.get("avatar_thumb") or {}).get("url_list") or []
        avatar_url = avatar_list[0] if avatar_list else ""

        video_info = detail.get("video") or {}
        cover_list = (
            (video_info.get("origin_cover") or {}).get("url_list")
            or (video_info.get("cover") or {}).get("url_list")
            or []
        )
        cover_url = cover_list[0] if cover_list else ""

        # Extract watermark-free play URL
        play_urls: List[str] = []
        bit_rates = video_info.get("bit_rate") or []
        for br in bit_rates:
            u_list = (br.get("play_addr") or {}).get("url_list") or []
            for u in u_list:
                if u and "playwm" not in u:
                    play_urls.append(u)

        raw_play_list = (video_info.get("play_addr") or {}).get("url_list") or []
        for u in raw_play_list:
            if u:
                clean_u = u.replace("/playwm/", "/play/")
                if clean_u not in play_urls:
                    play_urls.append(clean_u)

        direct_video_url = play_urls[0] if play_urls else ""
        duration_ms = video_info.get("duration") or 0
        duration_sec = duration_ms / 1000.0 if duration_ms > 1000 else duration_ms
        stats = detail.get("statistics") or {}

        # Check image album (图文)
        images = detail.get("images") or []
        image_urls = []
        for img in images:
            ulist = img.get("url_list") or []
            if ulist:
                image_urls.append(ulist[0])

        canonical_url = f"https://www.douyin.com/video/{aweme_id}"
        return {
            "id": aweme_id,
            "platform": "douyin",
            "platform_label": "Douyin 抖音",
            "title": desc,
            "author": author_name,
            "author_avatar": avatar_url,
            "cover": cover_url or (image_urls[0] if image_urls else ""),
            "duration": _format_duration(duration_sec),
            "views": stats.get("play_count", 0) or stats.get("comment_count", 0) or 0,
            "likes": stats.get("digg_count", 0) or 0,
            "url": canonical_url,
            "download_url": direct_video_url,
            "direct_video_url": direct_video_url,
            "images": image_urls,
            "description": desc,
        }

    async def get_video_detail(self, aweme_id: str) -> Optional[Dict[str, Any]]:
        for attempt in range(2):
            cookies = await self.ensure_signing_cookies(force_refresh=(attempt > 0))
            params = {**_base_douyin_params(), "aweme_id": str(aweme_id)}
            signed_query, ws_headers = sign_douyin_query(params, cookies, self.user_agent)
            url = f"https://www.douyin.com/aweme/v1/web/aweme/detail/?{signed_query}"
            headers = {
                "User-Agent": self.user_agent,
                "Referer": f"https://www.douyin.com/video/{aweme_id}",
                **ws_headers,
            }
            try:
                async with httpx.AsyncClient(
                    headers=headers,
                    cookies=cookies,
                    follow_redirects=True,
                    timeout=15.0,
                ) as client:
                    resp = await client.get(url)
                    if resp.status_code == 200 and len(resp.text) > 200:
                        data = resp.json()
                        detail = data.get("aweme_detail")
                        if detail:
                            return self._parse_aweme_detail(detail)
            except Exception:
                continue
        return None

    async def resolve_url(self, raw_input: str) -> Optional[Dict[str, Any]]:
        aweme_id = await self.resolve_aweme_id(raw_input)
        if not aweme_id:
            return None
        return await self.get_video_detail(aweme_id)

    async def _search_via_douyin_api(
        self, keyword: str, page: int = 1, limit: int = 16
    ) -> List[Dict[str, Any]]:
        cookies = await self.ensure_signing_cookies()
        # Only call direct search if user has configured a session cookie (otherwise Douyin returns 2483 login required)
        if not (cookies.get("sessionid") or cookies.get("sessionid_ss") or cookies.get("sid_tt")):
            return []

        offset = max(0, (page - 1) * limit)
        params = {
            **_base_douyin_params(),
            "search_channel": "aweme_video_web",
            "enable_history": "1",
            "keyword": keyword,
            "search_source": "normal_search",
            "query_correct_type": "1",
            "is_filter_search": "0",
            "from_group_id": "",
            "offset": str(offset),
            "count": str(min(limit, 20)),
            "NeedFilterSettings": "1",
            "list_type": "single",
        }
        signed_query, ws_headers = sign_douyin_query(params, cookies, self.user_agent)
        url = f"https://www.douyin.com/aweme/v1/web/search/item/?{signed_query}"
        headers = {
            "User-Agent": self.user_agent,
            "Referer": "https://www.douyin.com/",
            **ws_headers,
        }
        try:
            async with httpx.AsyncClient(headers=headers, cookies=cookies, timeout=15.0) as client:
                resp = await client.get(url)
                if resp.status_code != 200 or len(resp.text) < 200:
                    return []
                payload = resp.json()
                if payload.get("status_code") != 0:
                    return []
                data_list = payload.get("data") or []
                items: List[Dict[str, Any]] = []
                for entry in data_list:
                    aweme = entry.get("aweme_info") or entry
                    if aweme.get("aweme_id"):
                        items.append(self._parse_aweme_detail(aweme))
                return items[:limit]
        except Exception:
            return []

    async def _search_via_bytedance_synthesis(
        self, keyword: str, page: int = 1, limit: int = 16
    ) -> List[Dict[str, Any]]:
        """
        Searches Douyin (Aweme) videos via ByteDance's synthesis search engine (so.toutiao.com),
        which returns real Douyin short videos without requiring a Douyin login session.
        """
        parts = [p for p in keyword.split() if p]
        first_kw = parts[0] if parts else keyword
        compact_kw = "".join(parts) if len(parts) > 1 else keyword
        extended: List[str] = []
        if len(first_kw) == 1:
            if first_kw == "猫":
                extended = ["猫咪", "小猫"]
            elif first_kw == "狗":
                extended = ["狗狗", "小狗"]
            else:
                extended = [f"{first_kw}{first_kw}", f"小{first_kw}"]

        if page <= 1:
            queries = list(dict.fromkeys([
                keyword,
                *extended,
                first_kw,
                f"抖音 {first_kw}",
                f"{compact_kw} 热门视频",
            ]))
        else:
            queries = [
                f"抖音 {first_kw} 第{page}季",
                f"{first_kw} 精选视频",
                f"{compact_kw} 测评视频",
            ]

        decoder = json.JSONDecoder()
        seen_ids: set[str] = set()
        results: List[Dict[str, Any]] = []

        async with httpx.AsyncClient(
            headers={"User-Agent": self.user_agent, "Referer": "https://so.toutiao.com/"},
            follow_redirects=True,
            timeout=15.0,
        ) as client:
            tasks = [
                client.get(
                    "https://so.toutiao.com/search",
                    params={"keyword": q, "pd": "synthesis"},
                )
                for q in queries
            ]
            responses = await asyncio.gather(*tasks, return_exceptions=True)

            for resp in responses:
                if isinstance(resp, Exception) or resp.status_code != 200:
                    continue
                scripts = re.findall(r"<script[^>]*>(.*?)</script>", resp.text, re.S)
                for s in scripts:
                    if "awemevideo" not in s and "tos-cn-i-dy" not in s:
                        continue
                    idx = s.find("data: ")
                    if idx == -1:
                        continue
                    try:
                        data_json, _ = decoder.raw_decode(s[idx + 6 :])
                        hits = (data_json.get("display") or {}).get("hits") or []
                        for h in hits:
                            gid = str(h.get("group_id") or "")
                            if not gid or gid in seen_ids:
                                continue
                            seen_ids.add(gid)

                            raw_title = h.get("title") or (h.get("raw_data") or {}).get("title") or ""
                            clean_title = html.unescape(re.sub(r"<[^>]+>", "", raw_title)).strip()
                            cover = (
                                h.get("large_thumbnail_url")
                                or h.get("thumbnail_url")
                                or ""
                            )
                            author = (h.get("info") or {}).get("user_nickname") or "Douyin Creator"
                            duration_sec = (
                                ((h.get("raw_data") or {}).get("video") or {}).get("duration") or 0
                            )
                            likes = int(h.get("digg_count") or 0)
                            views = int(h.get("play_count") or 0)
                            canonical_url = f"https://www.douyin.com/video/{gid}"

                            results.append(
                                {
                                    "id": gid,
                                    "platform": "douyin",
                                    "platform_label": "Douyin 抖音",
                                    "title": clean_title or f"Douyin Video {gid}",
                                    "author": author,
                                    "author_avatar": "",
                                    "cover": cover,
                                    "duration": _format_duration(duration_sec),
                                    "views": views,
                                    "likes": likes,
                                    "url": canonical_url,
                                    "download_url": canonical_url,
                                    "direct_video_url": "",
                                    "description": clean_title,
                                }
                            )
                    except Exception:
                        continue

        return results[:limit]

    async def search_videos(
        self, keyword: str, page: int = 1, limit: int = 16
    ) -> List[Dict[str, Any]]:
        direct_items = await self._search_via_douyin_api(keyword, page=page, limit=limit)
        if direct_items:
            return direct_items
        return await self._search_via_bytedance_synthesis(keyword, page=page, limit=limit)
