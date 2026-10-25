@echo off
title Oxide Studio Launcher
cd /d "%~dp0"

:: 1. If a compiled portable or release executable exists, launch it directly!
if exist "Oxide-Portable.exe" (
    start "" "Oxide-Portable.exe"
    exit /b 0
)
if exist "src-tauri\target\release\oxide-agent.exe" (
    start "" "src-tauri\target\release\oxide-agent.exe"
    exit /b 0
)

:: 2. Ensure dependencies are installed
if not exist "node_modules" (
    echo [*] First-time setup: Installing Oxide dependencies...
    call npm install
)

:: 3. If Rust/Cargo is installed locally, run the Tauri desktop app
where cargo >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo [*] Launching Oxide Native Tauri Window...
    call npm run tauri dev
    exit /b 0
)

:: 4. Instant Desktop GUI Window Mode (uses Edge/Chrome App Mode + Local System Bridge)
echo [*] Launching Oxide GUI Studio Window...
start "" cmd /c "timeout /t 2 /nobreak >nul && start msedge --app=http://localhost:1420 --window-size=1400,880"
call npm run dev
