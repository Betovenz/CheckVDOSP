import re
import html
import httpx
from typing import List, Dict, Any, Optional

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)


class BilibiliService:
    def __init__(self):
        self.headers = {
            "User-Agent": USER_AGENT,
            "Referer": "https://www.bilibili.com/",
        }
        self._cookies: Dict[str, str] = {}

    async def _ensure_cookies(self, client: httpx.AsyncClient):
        if not self._cookies.get("buvid3"):
            try:
                resp = await client.get(
                    "https://www.bilibili.com/",
                    headers=self.headers,
                    follow_redirects=True,
                    timeout=10.0,
                )
                for k, v in resp.cookies.items():
                    self._cookies[k] = v
                for k, v in client.cookies.items():
                    self._cookies[k] = v
            except Exception:
                pass

    @staticmethod
    def _clean_title(raw_title: str) -> str:
        if not raw_title:
            return ""
        no_tags = re.sub(r"<[^>]+>", "", raw_title)
        return html.unescape(no_tags).strip()

    @staticmethod
    def _normalize_pic(pic_url: str) -> str:
        if not pic_url:
            return ""
        if pic_url.startswith("//"):
            return "https:" + pic_url
        if pic_url.startswith("http://"):
            return "https://" + pic_url[len("http://") :]
        return pic_url

    async def search_videos(self, keyword: str, page: int = 1, limit: int = 16) -> List[Dict[str, Any]]:
        async with httpx.AsyncClient(
            headers=self.headers,
            cookies=self._cookies,
            follow_redirects=True,
            timeout=15.0,
        ) as client:
            await self._ensure_cookies(client)
            params = {
                "search_type": "video",
                "keyword": keyword,
                "page": page,
                "page_size": min(limit, 30),
            }
            resp = await client.get(
                "https://api.bilibili.com/x/web-interface/search/type",
                params=params,
                cookies=self._cookies,
            )
            if resp.status_code != 200:
                return []

            data = resp.json()
            results = data.get("data", {}).get("result", []) or []
            items: List[Dict[str, Any]] = []

            for item in results[:limit]:
                bvid = item.get("bvid") or ""
                if not bvid:
                    continue
                title = self._clean_title(item.get("title", ""))
                cover = self._normalize_pic(item.get("pic", ""))
                video_url = f"https://www.bilibili.com/video/{bvid}"
                items.append(
                    {
                        "id": bvid,
                        "platform": "bilibili",
                        "platform_label": "Bilibili 哔哩哔哩",
                        "title": title,
                        "author": item.get("author", "Bilibili User"),
                        "author_avatar": self._normalize_pic(item.get("upic", "")),
                        "cover": cover,
                        "duration": str(item.get("duration", "")),
                        "views": item.get("play", 0) or 0,
                        "likes": item.get("like", 0) or item.get("favorites", 0) or 0,
                        "url": video_url,
                        "download_url": video_url,
                        "description": self._clean_title(item.get("description", "")),
                    }
                )
            return items

    async def resolve_url(self, raw_url: str) -> Optional[Dict[str, Any]]:
        async with httpx.AsyncClient(
            headers=self.headers,
            cookies=self._cookies,
            follow_redirects=True,
            timeout=15.0,
        ) as client:
            await self._ensure_cookies(client)
            resolved_url = raw_url

            if "b23.tv" in raw_url:
                resp = await client.get(raw_url, cookies=self._cookies)
                resolved_url = str(resp.url)

            bvid_match = re.search(r"(BV[0-9A-Za-z]{10})", resolved_url)
            aid_match = re.search(r"/av(\d+)", resolved_url, re.IGNORECASE)

            params: Dict[str, Any] = {}
            if bvid_match:
                params["bvid"] = bvid_match.group(1)
            elif aid_match:
                params["aid"] = aid_match.group(1)
            else:
                return None

            resp = await client.get(
                "https://api.bilibili.com/x/web-interface/view",
                params=params,
                cookies=self._cookies,
            )
            if resp.status_code != 200:
                return None

            payload = resp.json()
            if payload.get("code") != 0 or not payload.get("data"):
                return None

            vdata = payload["data"]
            bvid = vdata.get("bvid", "")
            duration_sec = int(vdata.get("duration", 0) or 0)
            mins, secs = divmod(duration_sec, 60)
            duration_str = f"{mins}:{secs:02d}"
            owner = vdata.get("owner", {}) or {}
            stat = vdata.get("stat", {}) or {}
            canonical_url = f"https://www.bilibili.com/video/{bvid}"

            return {
                "id": bvid,
                "platform": "bilibili",
                "platform_label": "Bilibili 哔哩哔哩",
                "title": vdata.get("title", ""),
                "author": owner.get("name", "Bilibili User"),
                "author_avatar": self._normalize_pic(owner.get("face", "")),
                "cover": self._normalize_pic(vdata.get("pic", "")),
                "duration": duration_str,
                "views": stat.get("view", 0) or 0,
                "likes": stat.get("like", 0) or 0,
                "url": canonical_url,
                "download_url": canonical_url,
                "description": vdata.get("desc", ""),
            }

    async def get_preview_mp4_url(self, bvid: str) -> Optional[str]:
        async with httpx.AsyncClient(
            headers=self.headers,
            cookies=self._cookies,
            follow_redirects=True,
            timeout=15.0,
        ) as client:
            await self._ensure_cookies(client)
            r_view = await client.get(
                "https://api.bilibili.com/x/web-interface/view",
                params={"bvid": bvid},
                cookies=self._cookies,
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
                cookies=self._cookies,
            )
            if r_play.status_code != 200:
                return None
            durl = (r_play.json().get("data") or {}).get("durl") or []
            if durl and durl[0].get("url"):
                return durl[0]["url"]
        return None
