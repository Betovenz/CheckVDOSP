@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Build Portable EXE - Douyin ^& Bilibili Hub

echo ============================================================
echo   BUILD PORTABLE  -  single DouyinBilibiliHub.exe
echo   (plain build - code is NOT obfuscated)
echo ============================================================
echo.

where py >nul 2>&1 && (set "PY=py") || (set "PY=python")

echo [1/3] Installing build + runtime dependencies...
%PY% -m pip install --disable-pip-version-check -q -r requirements.txt pyinstaller
if errorlevel 1 (
  echo.
  echo *** pip install failed. Fix the errors above and run again. ***
  pause
  exit /b 1
)

echo [2/3] Cleaning previous build...
taskkill /f /im DouyinBilibiliHub.exe >nul 2>&1
if exist build rmdir /s /q build
if exist "dist\DouyinBilibiliHub.exe" del /q "dist\DouyinBilibiliHub.exe"

echo [3/3] Building one-file EXE with PyInstaller (this can take a few minutes)...
%PY% -m PyInstaller --noconfirm --clean hub.spec
if errorlevel 1 (
  echo.
  echo *** Build failed. See the errors above. ***
  pause
  exit /b 1
)

if exist "app.ico" (
  copy /y "app.ico" "dist\app.ico" >nul
)

if exist "rednote-cookie-extension" (
  echo.
  echo [*] Copying rednote-cookie-extension to dist\...
  xcopy /e /i /y "rednote-cookie-extension" "dist\rednote-cookie-extension" >nul
  powershell -NoProfile -Command "Compress-Archive -Path 'rednote-cookie-extension\*' -DestinationPath 'dist\Extension_RedNote_Cookie.zip' -Force" >nul 2>&1
)

echo.
echo ============================================================
echo   DONE.  ==^>  dist\DouyinBilibiliHub.exe
echo.
echo   Double-click that .exe to run. It starts the server and
echo   opens your browser automatically. config.json and the
echo   data\ folder are created next to the .exe.
echo ============================================================
echo.
pause
