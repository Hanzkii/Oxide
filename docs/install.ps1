# Oxide Studio — Zero-SmartScreen One-Line Installer & Launcher
$ErrorActionPreference = "Stop"
Write-Host "==========================================================" -ForegroundColor DarkYellow
Write-Host "  OXIDE STUDIO // Fe2O3 — Direct Windows Installer" -ForegroundColor Yellow
Write-Host "==========================================================" -ForegroundColor DarkYellow

$installDir = Join-Path $env:LOCALAPPDATA "OxideStudio"
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$exePath = Join-Path $installDir "Oxide-Portable.exe"

Write-Host "[*] Fetching latest release from GitHub (Hanzkii/Oxide)..." -ForegroundColor Cyan
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/Hanzkii/Oxide/releases/latest" -Headers @{ "User-Agent" = "Oxide-Installer" }
$asset = $release.assets | Where-Object { $_.name -eq "Oxide-Portable.exe" } | Select-Object -First 1

if (-not $asset) {
    $asset = $release.assets | Where-Object { $_.name -like "*.exe" } | Select-Object -First 1
}

if (-not $asset) {
    Write-Host "[!] Release binary is still building on GitHub Actions. Try again in a moment." -ForegroundColor Red
    exit 1
}

Write-Host "[*] Downloading $($asset.name)..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $exePath -UseBasicParsing

# Strip NTFS Zone.Identifier (Mark of the Web) so Windows Defender SmartScreen NEVER blocks the app
Unblock-File -Path $exePath -ErrorAction SilentlyContinue
Remove-Item -Path "$exePath`:Zone.Identifier" -Force -ErrorAction SilentlyContinue

# Create Desktop Shortcut
$desktopPath = [Environment]::GetFolderPath("Desktop")
$shortcutFile = Join-Path $desktopPath "Oxide Studio.lnk"
$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutFile)
$shortcut.TargetPath = $exePath
$shortcut.WorkingDirectory = $installDir
$shortcut.Description = "Oxide Studio — Autonomous Local AI Agent"
$shortcut.Save()

Write-Host "[+] Installed to $exePath (SmartScreen Unblocked + Desktop Shortcut Created)" -ForegroundColor Green
Write-Host "[*] Launching Oxide Studio..." -ForegroundColor Yellow
Start-Process -FilePath $exePath
