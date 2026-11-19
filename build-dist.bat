@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Build DIST (obfuscated) EXE - Douyin ^& Bilibili Hub

echo ============================================================
echo   BUILD DIST  -  single DouyinBilibiliHub.exe
echo   Source code is OBFUSCATED with PyArmor ("alien code")
echo   so the shipped .exe can't be decompiled back into
echo   readable Python. Use this build to hand the app to others.
echo ============================================================
echo.

where py >nul 2>&1 && (set "PY=py") || (set "PY=python")

echo [1/3] Installing dependencies (runtime + PyInstaller + PyArmor)...
%PY% -m pip install --disable-pip-version-check -q -r requirements.txt pyinstaller pyarmor
if errorlevel 1 (
  echo.
  echo *** pip install failed. Fix the errors above and run again. ***
  pause
  exit /b 1
)

echo [2/3] Cleaning previous build...
taskkill /f /im DouyinBilibiliHub.exe >nul 2>&1
if exist build rmdir /s /q build
if exist .pyarmor rmdir /s /q .pyarmor
if exist hub.patched.spec del /q hub.patched.spec
if exist "dist\DouyinBilibiliHub.exe" del /q "dist\DouyinBilibiliHub.exe"

echo [3/3] Obfuscating + packing one-file EXE (this can take a few minutes)...
rem PyArmor obfuscates run_hub.py and everything it imports (main + services),
rem then hands the obfuscated tree to PyInstaller using our hub.spec.
%PY% -m pyarmor.cli gen --pack hub.spec --recursive run_hub.py
if errorlevel 1 (
  echo.
  echo *** Obfuscated build failed. See the errors above. ***
  pause
  exit /b 1
)

if exist hub.patched.spec del /q hub.patched.spec

if exist "app.ico" (
  copy /y "app.ico" "dist\app.ico" >nul
)

if exist "rednote-cookie-extension" (
  echo.
  echo [*] Copying rednote-cookie-extension to dist\...
  xcopy /e /i /y "rednote-cookie-extension" "dist\rednote-cookie-extension" >nul
  powershell -NoProfile -Command "Compress-Archive -Path 'rednote-cookie-extension\*' -DestinationPath 'dist\Extension_RedNote_Downloader.zip' -Force" >nul 2>&1
)

echo.
echo ============================================================
echo   DONE.  ==^>  dist\DouyinBilibiliHub.exe   (obfuscated)
echo.
echo   Ship this .exe. Its Python code is scrambled by PyArmor,
echo   so recipients can run it but can't read or copy the code.
echo   config.json and data\ are created next to the .exe.
echo ============================================================
echo.
pause
