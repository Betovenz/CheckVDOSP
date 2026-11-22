# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for macOS — produces "Douyin Bilibili Hub.app" (onedir
# bundle; one-file .app is discouraged by PyInstaller on macOS).
#
# Used by build-mac-dist.sh:
#   ./build-mac-dist.sh          ->  pyarmor gen --pack hub-mac.spec ...  (obfuscated)
#   ./build-mac-dist.sh --plain  ->  pyinstaller hub-mac.spec             (plain)
#
# Keep the hiddenimports / collect_all lists in sync with hub.spec (Windows).

import os
from PyInstaller.utils.hooks import collect_all, collect_submodules, collect_data_files

APP_NAME = "Douyin Bilibili Hub"
APP_VERSION = os.environ.get("HUB_VERSION", "1.0.0")

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

for pkg in ("uvicorn", "yt_dlp", "imageio_ffmpeg", "edge_tts", "anyio", "curl_cffi", "rapidocr_onnxruntime", "onnxruntime"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

hiddenimports += ["_cffi_backend"]
hiddenimports += collect_submodules("google.genai")
datas += collect_data_files("google.genai")
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

# .icns preferred; PyInstaller converts app.ico automatically when Pillow is installed.
icon_path = None
for cand in ("app.icns", "app.ico"):
    p = os.path.join(SPECPATH, cand)
    if os.path.exists(p):
        icon_path = p
        break

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="DouyinBilibiliHub",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    argv_emulation=False,
    target_arch=None,  # build machine's arch (arm64 on Apple Silicon, x86_64 on Intel)
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="DouyinBilibiliHub",
)

app = BUNDLE(
    coll,
    name=f"{APP_NAME}.app",
    icon=icon_path,
    bundle_identifier="com.douyinbilibilihub.app",
    version=APP_VERSION,
    info_plist={
        "CFBundleDisplayName": APP_NAME,
        "CFBundleShortVersionString": APP_VERSION,
        "CFBundleVersion": APP_VERSION,
        "NSHighResolutionCapable": True,
        "LSApplicationCategoryType": "public.app-category.video",
        "LSMinimumSystemVersion": "11.0",
    },
)
