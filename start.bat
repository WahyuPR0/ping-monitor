@echo off
setlocal
title Ping Monitor Dashboard
cd /d "%~dp0"

echo ====================================================
echo   PING MONITOR AUTO-START SYSTEM
echo   Directory: %cd%
echo ====================================================
echo.

:: 1. Verifikasi ketersediaan Node.js di sistem
where node >nul 2>&1
if errorlevel 1 goto no_node
goto check_pkg

:no_node
echo [ERROR] Node.js tidak ditemukan di sistem Anda!
echo Silakan unduh dan instal Node.js LTS dari https://nodejs.org/
echo Setelah instalasi selesai, buka kembali file start.bat ini.
echo.
echo Tekan sembarang tombol untuk keluar...
pause >nul
exit /b 1

:check_pkg
:: 2. Deteksi Package Manager (Yarn atau NPM)
set PKG_MGR=
where yarn >nul 2>&1
if not errorlevel 1 (
    set PKG_MGR=yarn
) else (
    where npm >nul 2>&1
    if not errorlevel 1 (
        set PKG_MGR=npm
    )
)

if "%PKG_MGR%"=="" (
    echo [ERROR] Tidak ditemukan Yarn maupun NPM di sistem Anda!
    echo Pastikan Node.js terinstal dengan benar beserta npm.
    echo.
    echo Tekan sembarang tombol untuk keluar...
    pause >nul
    exit /b 1
)

:: 3. Siapkan file .env otomatis jika belum ada
if exist ".env" goto check_modules
if exist ".env.example" (
    echo [INFO] Membuat file konfigurasi .env dari .env.example...
    copy /y ".env.example" ".env" >nul
    echo [OK] File .env berhasil dibuat.
) else (
    echo [INFO] Membuat file konfigurasi .env default...
    echo PORT=80> ".env"
    echo ENABLE_ROUTER_PING=false>> ".env"
    echo MIKROTIK_HOST=>> ".env"
    echo MIKROTIK_PORT=8728>> ".env"
    echo MIKROTIK_USER=admin>> ".env"
    echo MIKROTIK_PASSWORD=>> ".env"
    echo [OK] File .env default berhasil dibuat.
)
echo.

:check_modules
:: 4. Cek dan instal dependensi jika folder node_modules belum ada
if exist "node_modules\" goto check_build
echo [INFO] Folder node_modules belum ditemukan.
echo [INFO] Menginstal dependensi otomatis menggunakan %PKG_MGR%...
echo.
if "%PKG_MGR%"=="yarn" (
    call yarn install
) else (
    call npm install
)
if errorlevel 1 (
    echo.
    echo [ERROR] Gagal menginstal dependensi!
    echo Silakan periksa koneksi internet Anda atau jalankan manual '%PKG_MGR% install'.
    echo.
    echo Tekan sembarang tombol untuk menutup jendela...
    pause >nul
    exit /b 1
)
echo.
echo [OK] Dependensi berhasil diinstal!
echo.

:check_build
:: 5. Kompilasi TypeScript otomatis agar setiap pembaruan kode selalu aktif
echo [INFO] Memeriksa dan mengompilasi TypeScript (%PKG_MGR% build)...
echo.
if "%PKG_MGR%"=="yarn" (
    call yarn build
) else (
    call npm run build
)
if errorlevel 1 (
    echo.
    echo [ERROR] Proses kompilasi / build gagal!
    echo Periksa pesan error TypeScript di atas.
    echo.
    echo Tekan sembarang tombol untuk menutup jendela...
    pause >nul
    exit /b 1
)
echo.
echo [OK] Build TypeScript selesai dengan sukses!
echo.

:: 6. Jalankan Server Ping Monitor
:run_server
echo ====================================================
echo   MEMULAI SERVER PING MONITOR...
echo   Tekan Ctrl+C untuk menghentikan server.
echo ====================================================
echo.

node build/index.js

echo.
echo [WARNING] Server Ping Monitor terhenti atau keluar!
echo.
echo Pilihan:
echo  - Tekan sembarang tombol untuk me-restart server...
echo  - Atau tutup jendela terminal ini jika ingin berhenti.
echo.
pause
goto run_server
