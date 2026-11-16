@echo off
title Oxide Studio Launcher (Native Rust GUI)
cd /d "%~dp0"

:: Strip Windows Defender SmartScreen Mark-of-the-Web (Zone.Identifier)
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -Path . -Filter '*.exe' -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue" >nul 2>nul

echo [*] Starting Oxide Studio Native Rust GUI...

:: 1. Launch local compiled binary if present
if exist "%~dp0Oxide.exe" (
    echo [*] Starting Oxide Native GUI (Oxide.exe)...
    start "" "%~dp0Oxide.exe"
    exit /b 0
)

if exist "%~dp0src-tauri\target\release\oxide-agent.exe" (
    echo [*] Starting Oxide Native Release binary...
    start "" "%~dp0src-tauri\target\release\oxide-agent.exe"
    exit /b 0
)

if exist "%~dp0src-tauri\target\debug\oxide-agent.exe" (
    echo [*] Starting Oxide Native Debug binary...
    start "" "%~dp0src-tauri\target\debug\oxide-agent.exe"
    exit /b 0
)

if exist "%LOCALAPPDATA%\Oxide\oxide-agent.exe" (
    echo [*] Starting Oxide Native from AppData\Local\Oxide...
    start "" "%LOCALAPPDATA%\Oxide\oxide-agent.exe"
    exit /b 0
)

:: 2. Fallback: Build and run with cargo directly
echo [*] No pre-built binary found. Building Native Rust GUI with Cargo...
cargo run --manifest-path src-tauri\Cargo.toml
exit /b 0
