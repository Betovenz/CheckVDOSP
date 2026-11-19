"""
A long-lived headless Chrome/Edge used to read RedNote (小红书) pages like a real visitor.

RedNote's pages build their data with JavaScript (guest cookies, request signatures), so a
plain HTTP fetch gets the login page. A real browser can open note pages as a guest, and with
the user's own login cookie it can also show search results. We open a tab, wait until the
page's window.__INITIAL_STATE__ holds what we need, read it as JSON and close the tab.
"""
from __future__ import annotations

import asyncio
import atexit
import json
import os
import random
import shutil
import subprocess
import tempfile
from typing import Any, Dict, List, Optional

import httpx
import websockets

from services.douyin_signer import _find_browser_executable

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/130.0.0.0 Safari/537.36"
)
COOKIE_DOMAINS = (".xiaohongshu.com", ".rednote.com")

# JS helper injected into every evaluation: unwraps Vue refs ({_value}/{value}) in the state
_UNREF_JS = "const un = (v) => (v && typeof v === 'object' && ('_value' in v || ('value' in v && Object.keys(v).length <= 3))) ? (v._value ?? v.value) : v;"


class BrowserUnavailable(RuntimeError):
    pass


def _kill_with_parent_job():
    """
    Windows: a Job Object that kills every process in it when this Python process dies —
    even on a hard kill or when the start.bat window is closed — so headless Chrome and its
    child processes never linger. Returns an attach(pid) function (no-op elsewhere).
    """
    if os.name != "nt":
        return lambda pid: None
    try:
        import ctypes
        from ctypes import wintypes

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CreateJobObjectW.restype = wintypes.HANDLE
        k32.OpenProcess.restype = wintypes.HANDLE

        class _BasicLimits(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class _IoCounters(ctypes.Structure):
            _fields_ = [(n, ctypes.c_uint64) for n in (
                "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

        class _ExtendedLimits(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", _BasicLimits), ("IoInfo", _IoCounters),
                ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        job = k32.CreateJobObjectW(None, None)
        info = _ExtendedLimits()
        info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not job or not k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
            return lambda pid: None

        def attach(pid: int) -> None:
            handle = k32.OpenProcess(0x0100 | 0x0001, False, pid)  # SET_QUOTA | TERMINATE
            if handle:
                k32.AssignProcessToJobObject(job, handle)
                k32.CloseHandle(handle)

        return attach
    except Exception:
        return lambda pid: None


_attach_to_job = _kill_with_parent_job()


def _remove_stale_profiles(max_age_sec: float = 6 * 3600) -> None:
    """Delete throw-away profiles left behind when the app was force-closed earlier."""
    import glob
    import time

    for path in glob.glob(os.path.join(tempfile.gettempdir(), "xhs_chrome_*")):
        try:
            if time.time() - os.path.getmtime(path) > max_age_sec:
                shutil.rmtree(path, ignore_errors=True)
        except OSError:
            pass


class XhsBrowser:
    def __init__(self) -> None:
        self._proc: Optional[subprocess.Popen] = None
        self._port = 0
        self._start_lock = asyncio.Lock()
        self._tabs = asyncio.Semaphore(3)
        self._applied_cookie: Optional[str] = None
        self._profile_dir = ""

    # ------------------------------------------------------------------ lifecycle
    async def _ensure_started(self) -> None:
        async with self._start_lock:
            if self._proc and self._proc.poll() is None and await self._alive():
                return
            exe = _find_browser_executable()
            if not exe:
                raise BrowserUnavailable("ไม่พบ Google Chrome หรือ Microsoft Edge ในเครื่อง (จำเป็นสำหรับ RedNote)")
            self.shutdown()  # clean up a crashed previous instance, if any
            _remove_stale_profiles()
            # Fresh throw-away profile per launch: no profile-lock clashes, no stale logins
            self._profile_dir = tempfile.mkdtemp(prefix="xhs_chrome_")
            self._port = random.randint(19850, 19990)
            self._applied_cookie = None
            self._proc = subprocess.Popen(
                [
                    exe,
                    "--headless=new",
                    "--disable-gpu",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--mute-audio",
                    "--autoplay-policy=user-gesture-required",
                    "--blink-settings=imagesEnabled=false",
                    f"--user-data-dir={self._profile_dir}",
                    f"--user-agent={USER_AGENT}",
                    f"--remote-debugging-port={self._port}",
                    "about:blank",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            _attach_to_job(self._proc.pid)
            for _ in range(40):
                await asyncio.sleep(0.25)
                if await self._alive():
                    return
            self.shutdown()
            raise BrowserUnavailable("เปิด Chrome แบบเบื้องหลังไม่สำเร็จ")

    async def _alive(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=1.5) as c:
                return (await c.get(f"http://127.0.0.1:{self._port}/json/version")).status_code == 200
        except Exception:
            return False

    def shutdown(self) -> None:
        """Stop Chrome and ALL its child processes (terminate() alone leaves children running on Windows)."""
        proc, self._proc = self._proc, None
        if proc and proc.poll() is None:
            try:
                if os.name == "nt":
                    subprocess.run(
                        ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
                    )
                else:
                    proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                pass
        if self._profile_dir:
            shutil.rmtree(self._profile_dir, ignore_errors=True)
            self._profile_dir = ""

    # ------------------------------------------------------------------ CDP plumbing
    async def _new_tab(self) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=5.0) as c:
            r = await c.put(f"http://127.0.0.1:{self._port}/json/new?about:blank")
            return r.json()

    async def _close_tab(self, tab_id: str) -> None:
        try:
            async with httpx.AsyncClient(timeout=3.0) as c:
                await c.get(f"http://127.0.0.1:{self._port}/json/close/{tab_id}")
        except Exception:
            pass

    @staticmethod
    async def _call(ws, msg_id: List[int], method: str, params: Optional[dict] = None) -> Dict[str, Any]:
        msg_id[0] += 1
        my_id = msg_id[0]
        await ws.send(json.dumps({"id": my_id, "method": method, "params": params or {}}))
        while True:
            data = json.loads(await ws.recv())
            if data.get("id") == my_id:
                if "error" in data:
                    raise RuntimeError(f"{method}: {data['error'].get('message')}")
                return data.get("result") or {}

    async def _sync_cookie(self, ws, msg_id: List[int], cookie: str) -> None:
        """Make the browser's RedNote login match the saved cookie (none = guest)."""
        if cookie == self._applied_cookie:
            return
        if self._applied_cookie:  # switching away from an old cookie -> start clean
            await self._call(ws, msg_id, "Network.clearBrowserCookies")
        if cookie:
            cookies = []
            for part in cookie.split(";"):
                name, _, value = part.strip().partition("=")
                if name and value:
                    for domain in COOKIE_DOMAINS:
                        cookies.append({"name": name.strip(), "value": value.strip(), "domain": domain, "path": "/", "secure": True})
            if cookies:
                await self._call(ws, msg_id, "Network.setCookies", {"cookies": cookies})
        self._applied_cookie = cookie

    # ------------------------------------------------------------------ public
    async def open_tab(self, url: str, cookie: str = "") -> "BrowserTab":
        """A tab that stays open (e.g. a search page we keep scrolling). Caller must close() it."""
        await self._ensure_started()
        info = await self._new_tab()
        ws = await websockets.connect(info["webSocketDebuggerUrl"], max_size=64 * 1024 * 1024)
        tab = BrowserTab(self, info.get("id", ""), ws)
        try:
            await tab.call("Network.enable")
            await self._sync_cookie(ws, tab.msg_id, cookie)
            await tab.call("Page.navigate", {"url": url})
        except Exception:
            await tab.close()
            raise
        return tab

    async def read_page(
        self,
        url: str,
        ready_js: str,
        result_js: str,
        cookie: str = "",
        timeout: float = 20.0,
        scroll_until_js: str = "",
        max_scrolls: int = 0,
        raise_on_timeout: bool = True,
    ) -> Any:
        """
        Open `url`, wait until `ready_js` is truthy, optionally scroll to load more (until
        `scroll_until_js` is truthy), then return JSON.parse(result_js). JS snippets can use un().
        """
        await self._ensure_started()
        async with self._tabs:
            tab = await self._new_tab()
            try:
                async with websockets.connect(tab["webSocketDebuggerUrl"], max_size=64 * 1024 * 1024) as ws:
                    msg_id = [0]
                    await self._call(ws, msg_id, "Network.enable")
                    await self._sync_cookie(ws, msg_id, cookie)
                    await self._call(ws, msg_id, "Page.navigate", {"url": url})

                    async def _eval(expr: str) -> Any:
                        res = await self._call(
                            ws, msg_id, "Runtime.evaluate",
                            {"expression": f"(() => {{ {_UNREF_JS} try {{ return ({expr}); }} catch (e) {{ return null; }} }})()",
                             "returnByValue": True},
                        )
                        return (res.get("result") or {}).get("value")

                    loop = asyncio.get_running_loop()
                    deadline = loop.time() + timeout
                    while loop.time() < deadline:
                        await asyncio.sleep(0.4)
                        if await _eval(ready_js):
                            break
                    else:
                        if raise_on_timeout:
                            raise TimeoutError("RedNote page did not finish loading")
                        max_scrolls = 0

                    for _ in range(max_scrolls):
                        if scroll_until_js and await _eval(scroll_until_js):
                            break
                        await _eval("window.scrollTo(0, document.body.scrollHeight) || 1")
                        await asyncio.sleep(1.2)

                    raw = await _eval(f"JSON.stringify({result_js})")
                    return json.loads(raw) if raw else None
            finally:
                await self._close_tab(tab.get("id", ""))


class BrowserTab:
    def __init__(self, browser: XhsBrowser, tab_id: str, ws) -> None:
        self._browser = browser
        self.tab_id = tab_id
        self._ws = ws
        self.msg_id = [0]
        self._lock = asyncio.Lock()  # one CDP command at a time per tab
        self.closed = False

    async def call(self, method: str, params: Optional[dict] = None) -> Dict[str, Any]:
        async with self._lock:
            return await XhsBrowser._call(self._ws, self.msg_id, method, params)

    async def eval(self, expr: str, await_promise: bool = False) -> Any:
        """Run JS (may use un()); returns the JSON-able value, or None if it threw."""
        res = await self.call(
            "Runtime.evaluate",
            {"expression": f"(async () => {{ {_UNREF_JS} try {{ return ({expr}); }} catch (e) {{ return null; }} }})()",
             "returnByValue": True, "awaitPromise": True},
        )
        return (res.get("result") or {}).get("value")

    async def wait_for(self, expr: str, timeout: float = 15.0, interval: float = 0.4) -> bool:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while loop.time() < deadline:
            if await self.eval(expr):
                return True
            await asyncio.sleep(interval)
        return False

    async def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        try:
            await self._ws.close()
        except Exception:
            pass
        await self._browser._close_tab(self.tab_id)


xhs_browser = XhsBrowser()
atexit.register(xhs_browser.shutdown)
