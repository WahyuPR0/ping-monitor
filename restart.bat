@echo off
title Ping Monitor Restart
cd /d "%~dp0"

echo ====================================================
echo   PING MONITOR RESTART SYSTEM
echo ====================================================

echo [INFO] Menghentikan proses Ping Monitor pada port 80...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :80 ^| findstr LISTENING') do (
    echo Menghentikan PID %%a...
    taskkill /F /PID %%a >nul 2>&1
)

timeout /t 2 >nul
echo [OK] Proses pada port 80 dihentikan. Memulai kembali...
start cmd.exe /c start.bat
