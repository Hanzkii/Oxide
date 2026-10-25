@echo off
title Oxide — Autonomous AI Command Center Launcher
echo ===================================================
echo   Oxide — Local-First Autonomous AI Coding Agent
echo ===================================================
echo.

where cargo >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [!] Rust / Cargo was not found on your PATH.
    echo     Install Rust from https://rustup.rs and restart your terminal.
    echo     Falling back to Frontend UI Preview at http://localhost:1420 ...
    echo.
    call npm run dev
    pause
    exit /b 0
)

if not exist "node_modules" (
    echo [*] Installing frontend dependencies...
    call npm install
)

echo [*] Launching Oxide Desktop Application (Tauri v2)...
call npm run tauri dev
pause
