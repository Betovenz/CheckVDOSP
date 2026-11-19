#!/usr/bin/env bash
# ============================================================
#   BUILD MAC DIST  -  "Douyin Bilibili Hub.app" + .dmg
#   Run this ON A MAC (PyInstaller cannot cross-compile from Windows).
#
#   ./build-mac-dist.sh           obfuscated with PyArmor (for handing out)
#   ./build-mac-dist.sh --plain   plain PyInstaller build (faster, for testing)
#
#   Output: dist/DouyinBilibiliHub-<version>-<arch>.dmg
#   The .app is built for THIS Mac's CPU: build on Apple Silicon for M1/M2/M3...
#   Macs, on an Intel Mac for Intel Macs.
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="Douyin Bilibili Hub"
VERSION="${HUB_VERSION:-1.0.0}"
ARCH="$(uname -m)"
MODE="dist"
[[ "${1:-}" == "--plain" ]] && MODE="plain"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "*** This script must run on macOS. ***"
  exit 1
fi

PY="${PYTHON:-python3}"
if ! command -v "$PY" >/dev/null 2>&1; then
  echo "*** python3 not found. Install Python 3.10+ from python.org (or: brew install python). ***"
  exit 1
fi

echo "============================================================"
echo "  BUILD MAC ($MODE)  -  $APP_NAME $VERSION ($ARCH)"
echo "============================================================"

# Build inside a private virtualenv so the system / Homebrew Python stays untouched.
VENV=".venv-macbuild"
echo "[1/5] Preparing build environment ($VENV)..."
if [[ ! -x "$VENV/bin/python" ]]; then
  "$PY" -m venv "$VENV"
fi
VPY="$VENV/bin/python"
"$VPY" -m pip install --disable-pip-version-check -q --upgrade pip
EXTRA="pyinstaller pillow"
[[ "$MODE" == "dist" ]] && EXTRA="$EXTRA pyarmor"
# shellcheck disable=SC2086
"$VPY" -m pip install --disable-pip-version-check -q -r requirements.txt $EXTRA

echo "[2/5] Cleaning previous build..."
pkill -f "$APP_NAME.app/Contents/MacOS/" 2>/dev/null || true
rm -rf build .pyarmor hub-mac.patched.spec "dist/$APP_NAME.app" dist/DouyinBilibiliHub dist/dmg-staging

echo "[3/5] Building $APP_NAME.app (this can take a few minutes)..."
export HUB_VERSION="$VERSION"
if [[ "$MODE" == "dist" ]]; then
  # PyArmor obfuscates run_hub.py + everything it imports (main + services),
  # then packs the obfuscated tree with PyInstaller using hub-mac.spec.
  "$VPY" -m pyarmor.cli gen --pack hub-mac.spec --recursive run_hub.py
  rm -f hub-mac.patched.spec
else
  "$VPY" -m PyInstaller --noconfirm --clean hub-mac.spec
fi

APP="dist/$APP_NAME.app"
if [[ ! -d "$APP" ]]; then
  echo "*** Build failed: $APP was not created. See the errors above. ***"
  exit 1
fi
# The onedir folder COLLECT leaves next to the .app is not needed in the DMG.
rm -rf dist/DouyinBilibiliHub

echo "[4/5] Signing (ad-hoc) so macOS will launch it..."
xattr -cr "$APP" || true
codesign --force --deep --sign - "$APP"
codesign --verify --deep "$APP" && echo "      signature OK"

echo "[5/5] Creating DMG..."
STAGE="dist/dmg-staging"
DMG="dist/DouyinBilibiliHub-$VERSION-$ARCH.dmg"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
if [[ -d "rednote-cookie-extension" ]]; then
  cp -R "rednote-cookie-extension" "$STAGE/rednote-cookie-extension"
  rm -f dist/Extension_RedNote_Cookie.zip
  (cd rednote-cookie-extension && zip -qr -X ../dist/Extension_RedNote_Cookie.zip . -x ".*")
  cp dist/Extension_RedNote_Cookie.zip "$STAGE/"
fi
cat > "$STAGE/อ่านก่อนเปิด - READ ME.txt" <<'TXT'
วิธีติดตั้ง
1. ลาก "Douyin Bilibili Hub" ไปใส่โฟลเดอร์ Applications
2. ครั้งแรก: คลิกขวาที่แอป > Open (เปิด) > กด Open อีกครั้ง
   (แอปไม่ได้เซ็นกับ Apple จึงต้องเปิดแบบนี้ครั้งแรกครั้งเดียว)
   ถ้ายังเปิดไม่ได้: System Settings > Privacy & Security > กด "Open Anyway"
3. แอปจะเปิดหน้าเว็บในบราวเซอร์ให้อัตโนมัติ (http://127.0.0.1:8000)

การใช้งาน
- ปิดแท็บบราวเซอร์ = โปรแกรมยังทำงานอยู่ เปิดแอปซ้ำเพื่อเปิดหน้าเว็บใหม่
- ปิดโปรแกรม: คลิกขวาไอคอนที่ Dock > Quit
  (ถ้าไม่ปิด ให้กด Option ค้างแล้วเลือก Force Quit)
- ข้อมูล/คีย์ API/คุกกี้ เก็บที่ ~/Library/Application Support/DouyinBilibiliHub
- คลิกที่เรนเดอร์เสร็จ เซฟที่ ~/Movies/AI Clips (เปลี่ยนได้ในแอป)
- ฟีเจอร์ RedNote / Douyin บางส่วนต้องมี Google Chrome หรือ Microsoft Edge ในเครื่อง
- Extension คัดลอก Cookie RedNote: แตก Extension_RedNote_Cookie.zip แล้วติดตั้งตาม README.md ข้างใน
TXT

rm -f "$DMG"
hdiutil create -volname "$APP_NAME" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"

echo
echo "============================================================"
echo "  DONE.  ==>  $DMG"
echo "  App   ==>  $APP"
echo "  Built for $ARCH Macs only."
echo "============================================================"
