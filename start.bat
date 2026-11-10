@echo off
chcp 65001 >nul
title Douyin & Bilibili Video Hub (Localhost:8000)
cd /d "%~dp0"
echo ========================================================
echo   Starting Douyin ^& Bilibili Video Search ^& Downloader
echo   URL: http://localhost:8000
echo ========================================================
start "" "http://localhost:8000"
python -m uvicorn main:app --host 127.0.0.1 --port 8000
pause
