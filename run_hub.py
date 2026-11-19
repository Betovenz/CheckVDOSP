"""
One-file launcher for the Douyin & Bilibili Hub.

Starts the FastAPI app with uvicorn on 127.0.0.1, waits until the port is
listening, then opens the default web browser at the app. Designed to be
frozen into a single .exe with PyInstaller (see build-portable.bat /
build-dist.bat). Running this file directly from source works too.
"""

from __future__ import annotations

import socket
import sys
import threading
import time
import webbrowser

import uvicorn

HOST = "127.0.0.1"
PREFERRED_PORT = 8000


def _port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((HOST, port))
            return True
        except OSError:
            return False


def _pick_port() -> int:
    if _port_is_free(PREFERRED_PORT):
        return PREFERRED_PORT
    # Preferred port busy (another copy already running, or something else on
    # 8000): let the OS hand us any free port.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((HOST, 0))
        return s.getsockname()[1]


def _open_browser_when_ready(port: int) -> None:
    url = f"http://{HOST}:{port}"
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            if s.connect_ex((HOST, port)) == 0:
                break
        time.sleep(0.25)
    try:
        webbrowser.open(url)
    except Exception:
        pass


def _enable_utf8_console() -> None:
    """Windows consoles default to a legacy code page (cp1252) that can't encode
    Thai text, which would crash print(). Switch the console + stdio to UTF-8."""
    try:
        import ctypes

        ctypes.windll.kernel32.SetConsoleOutputCP(65001)
        ctypes.windll.kernel32.SetConsoleCP(65001)
    except Exception:
        pass
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def _hub_already_running(port: int) -> bool:
    """True when our own hub already answers on this port (e.g. the Mac app was opened twice)."""
    try:
        import urllib.request

        with urllib.request.urlopen(f"http://{HOST}:{port}/", timeout=1.5) as r:
            return b"Douyin & Bilibili Hub" in r.read(4096)
    except Exception:
        return False


def _redirect_output_without_console() -> None:
    """A windowed macOS .app has no console: sys.stdout/stderr are None, which
    breaks uvicorn's logging. Send everything to a log file in the data folder."""
    if sys.stdout is not None and sys.stderr is not None:
        return
    try:
        from services.paths import DATA_ROOT

        log = open(DATA_ROOT / "hub.log", "a", encoding="utf-8", buffering=1)
    except Exception:
        import os

        log = open(os.devnull, "w", encoding="utf-8")
    sys.stdout = sys.stdout or log
    sys.stderr = sys.stderr or log


def main() -> None:
    _redirect_output_without_console()
    _enable_utf8_console()
    if sys.platform == "darwin" and _hub_already_running(PREFERRED_PORT):
        webbrowser.open(f"http://{HOST}:{PREFERRED_PORT}")
        return
    port = _pick_port()
    url = f"http://{HOST}:{port}"

    try:
        import ctypes

        ctypes.windll.kernel32.SetConsoleTitleW("Douyin & Bilibili Hub — โปรแกรมหลัก (ห้ามปิดถ้ายังใช้งาน)")
    except Exception:
        pass

    print("=" * 60)
    print("   Douyin & Bilibili Hub + AI Video Maker Studio")
    print("=" * 60)
    print(f"   เปิดใช้งานที่: {url}")
    print()
    print("   * หน้าต่างนี้คือ 'ตัวโปรแกรมหลัก' ปล่อยเปิดค้างไว้")
    print("   * ปิดแค่แท็บในบราวเซอร์ = โปรแกรมยังทำงาน เปิดลิงก์ข้างบนใหม่ได้")
    print("   * ปิดโปรแกรม = กดกากบาท (X) ปิดหน้าต่างนี้")
    print("=" * 60)
    print()

    # Import the app only after the banner so startup feels responsive.
    from main import app

    threading.Thread(target=_open_browser_when_ready, args=(port,), daemon=True).start()

    try:
        uvicorn.run(
            app,
            host=HOST,
            port=port,
            log_level="warning",
            access_log=False,
            workers=1,
        )
    except KeyboardInterrupt:
        pass
    except Exception as exc:  # keep the console open so the user can read the error
        print(f"\nServer stopped unexpectedly: {exc}")
        if getattr(sys, "frozen", False) and sys.platform == "win32":
            input("\nPress Enter to close...")


if __name__ == "__main__":
    main()
