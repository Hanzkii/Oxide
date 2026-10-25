@echo off
title Oxide Studio Launcher
cd /d "%~dp0"

:: Strip Windows Defender SmartScreen Mark-of-the-Web (Zone.Identifier) from downloaded .exe files
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -Path . -Filter '*.exe' -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue" >nul 2>nul

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

:: 3. Launch Oxide in Default Browser or App Mode (Never requires Edge!)
echo [*] Launching Oxide Studio...
start "" powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 2; if (Get-Command chrome -ErrorAction SilentlyContinue) { Start-Process chrome '--app=http://localhost:1420 --window-size=1400,880' } elseif (Get-Command brave -ErrorAction SilentlyContinue) { Start-Process brave '--app=http://localhost:1420 --window-size=1400,880' } elseif (Get-Command msedge -ErrorAction SilentlyContinue) { Start-Process msedge '--app=http://localhost:1420 --window-size=1400,880' } else { Start-Process 'http://localhost:1420' }"
call npm run dev
