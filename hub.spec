# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the Douyin & Bilibili Hub — produces ONE self-contained
# .exe that launches the server and opens the browser.
#
# Used by both builds:
#   build-portable.bat  ->  pyinstaller hub.spec              (plain)
#   build-dist.bat      ->  pyarmor gen --pack hub.spec ...   (obfuscated)

import os
from PyInstaller.utils.hooks import collect_all, collect_submodules, collect_data_files

datas = [("static", "static")]
binaries = []
hiddenimports = [
    "services.paths",
    "services.net_guard",
    "services.xhs_service",
    "services.xhs_browser",
    "services.downloader",
    "services.bilibili_service",
    "services.douyin_service",
    "services.douyin_signer",
    "services.shopee_service",
    "services.video_studio_service",
    "services.censor_service",
    "services.batch_service",
    "services.cache_service",
]

# Packages that load things dynamically and need to be pulled in whole.
for pkg in ("uvicorn", "yt_dlp", "imageio_ffmpeg", "edge_tts", "anyio", "curl_cffi", "rapidocr_onnxruntime", "onnxruntime"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

hiddenimports += ["_cffi_backend"]

# google-genai lives under the google.* namespace package.
hiddenimports += collect_submodules("google.genai")
datas += collect_data_files("google.genai")

# TLS roots for httpx / websockets.
datas += collect_data_files("certifi")

hiddenimports += [
    "h11",
    "websockets",
    "websockets.legacy",
    "websockets.legacy.client",
    "multipart",
    "email.mime.multipart",
]

block_cipher = None

a = Analysis(
    ["run_hub.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "numpy.tests", "test", "google.genai.tests"],
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

icon_path = os.path.join(SPECPATH, "app.ico")
if not os.path.exists(icon_path):
    icon_path = os.path.abspath("app.ico")
if not os.path.exists(icon_path):
    icon_path = None

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="DouyinBilibiliHub",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    icon=icon_path,
)
