@echo off
setlocal
title Reset Ping Monitor History
cd /d "%~dp0"

echo ====================================================
echo   RESET DATA DAN HISTORI PING MONITOR
echo   Directory: %cd%
echo ====================================================
echo.
echo PERINGATAN:
echo Tindakan ini akan menghapus seluruh data histori ping lokal:
echo   - ping_history.json
echo   - ping_history.backup.json
echo   - Folder backups/ (arsip histori)
echo.
echo Pastikan server Ping Monitor sedang tidak berjalan atau restart
echo server setelah proses reset ini agar data dimulai bersih dari nol.
echo.

set /p CONFIRM="Apakah Anda yakin ingin menghapus data histori? (Y/N): "
if /i not "%CONFIRM%"=="Y" (
    echo.
    echo [BATAL] Proses reset dibatalkan. Data tidak ada yang diubah.
    echo.
    pause
    exit /b 0
)

echo.
echo [INFO] Menghapus data histori lokal...

if exist "ping_history.json" (
    del /f /q "ping_history.json" >nul 2>&1
    echo  - File ping_history.json berhasil dihapus.
)

if exist "ping_history.backup.json" (
    del /f /q "ping_history.backup.json" >nul 2>&1
    echo  - File ping_history.backup.json berhasil dihapus.
)

if exist "backups\" (
    rmdir /s /q "backups" >nul 2>&1
    echo  - Folder backups berhasil dihapus.
)

echo.
echo ====================================================
echo   [OK] RESET BERHASIL DILAKUKAN!
echo   Semua histori telah dikosongkan.
echo   Silakan jalankan start.bat untuk mulai dari kondisi awal.
echo ====================================================
echo.
pause
exit /b 0
