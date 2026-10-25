@echo off
title Oxide Studio Launcher
cd /d "%~dp0"

:: Strip Windows Defender SmartScreen Mark-of-the-Web (Zone.Identifier) from downloaded .exe files
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -Path . -Filter '*.exe' -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue" >nul 2>nul

:: 1. If a compiled portable or release executable exists locally, launch it immediately!
if exist "%~dp0Oxide-Portable.exe" (
    echo [*] Starting Oxide Studio Native Desktop Application...
    start "" "%~dp0Oxide-Portable.exe"
    exit /b 0
)

if exist "%LOCALAPPDATA%\Programs\Oxide\Oxide-Portable.exe" (
    echo [*] Starting Oxide Studio from Programs\Oxide...
    start "" "%LOCALAPPDATA%\Programs\Oxide\Oxide-Portable.exe"
    exit /b 0
)

if exist "%LOCALAPPDATA%\Programs\Oxide\Oxide.exe" (
    echo [*] Starting Oxide Studio Installed Executable...
    start "" "%LOCALAPPDATA%\Programs\Oxide\Oxide.exe"
    exit /b 0
)

if exist "%~dp0src-tauri\target\release\oxide-agent.exe" (
    echo [*] Starting compiled Tauri release binary...
    start "" "%~dp0src-tauri\target\release\oxide-agent.exe"
    exit /b 0
)

:: 2. If no executable is present, offer to download the official standalone executable
echo [*] No pre-compiled Oxide-Portable.exe detected locally.
echo [*] Downloading latest Oxide-Portable.exe from GitHub Releases...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://github.com/Hanzkii/Oxide/releases/download/v0.1.15/Oxide-Portable.exe' -OutFile 'Oxide-Portable.exe' -UseBasicParsing; Unblock-File 'Oxide-Portable.exe'; exit 0 } catch { exit 1 }"
if exist "%~dp0Oxide-Portable.exe" (
    echo [OK] Oxide-Portable.exe downloaded successfully! Launching...
    start "" "%~dp0Oxide-Portable.exe"
    exit /b 0
)

:: 3. Fallback: Clean up any hung node process on port 1420 and launch Dev Server
echo [*] Freeing port 1420 from any prior hung processes...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :1420 ^| findstr LISTENING') do taskkill /f /pid %%a >nul 2>nul

if not exist "node_modules" (
    echo [*] First-time setup: Installing Oxide dependencies...
    call npm install
)

echo [*] Launching Oxide Studio in App Mode...
start "" powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 2; $chromePaths = @('C:\Program Files\Google\Chrome\Application\chrome.exe', 'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe', \"$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe\", 'C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe'); $found = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1; if ($found) { Start-Process $found '--app=http://localhost:1420 --window-size=1400,880' } elseif (Get-Command chrome -ErrorAction SilentlyContinue) { Start-Process chrome '--app=http://localhost:1420 --window-size=1400,880' } elseif (Get-Command brave -ErrorAction SilentlyContinue) { Start-Process brave '--app=http://localhost:1420 --window-size=1400,880' } else { Start-Process 'http://localhost:1420' }"
call npm run dev
