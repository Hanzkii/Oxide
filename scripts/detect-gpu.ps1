try {
    $gpu = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch "Basic|Virtual" } | Select-Object -First 1
    if ($gpu) {
        $gpuName = $gpu.Name
        $vramBytes = 0

        # Try 64-bit VRAM from registry first
        $regKeys = Get-ChildItem -Path "HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}" -ErrorAction SilentlyContinue
        foreach ($k in $regKeys) {
            $p = Get-ItemProperty -Path $k.PSPath -ErrorAction SilentlyContinue
            if ($p -and $p.DriverDesc -eq $gpuName -and $p."HardwareInformation.qwMemorySize") {
                $vramBytes = [int64]$p."HardwareInformation.qwMemorySize"
                break
            }
        }

        # Fallback to AdapterRAM
        if ($vramBytes -le 0 -and $gpu.AdapterRAM) {
            $vramBytes = [int64]$gpu.AdapterRAM
        }

        $vramGb = [math]::Round($vramBytes / 1GB, 1)
        Write-Output "$gpuName|$vramGb"
        exit 0
    }
} catch {}

# Fallback to nvidia-smi if available
try {
    $nv = nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>$null
    if ($LASTEXITCODE -eq 0 -and $nv) {
        $parts = $nv.Trim().Split(',')
        $nvName = $parts[0].Trim()
        $nvMemGb = [math]::Round(([double]$parts[1].Trim()) / 1024, 1)
        Write-Output "$nvName|$nvMemGb"
        exit 0
    }
} catch {}

Write-Output "Integrated Graphics|0"
