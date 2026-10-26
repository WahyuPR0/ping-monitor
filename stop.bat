@echo off
title Ping Monitor Stop
cd /d "%~dp0"

echo ====================================================
echo   PING MONITOR STOP SYSTEM
echo ====================================================

echo [INFO] Menghentikan proses Ping Monitor pada port 80...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :80 ^| findstr LISTENING') do (
    echo Menghentikan PID %%a...
    taskkill /F /PID %%a >nul 2>&1
)

echo [OK] Ping Monitor berhasil dihentikan.
pause
