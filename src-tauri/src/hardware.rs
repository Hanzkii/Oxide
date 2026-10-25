use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::sync::OnceLock;
use sysinfo::System;
use tokio::process::Command;

static CACHED_GPU_INFO: OnceLock<(String, f32)> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HardwareSpecs {
    pub cpu_brand: String,
    pub cpu_cores: usize,
    pub cpu_usage_percent: f32,
    pub total_ram_gb: f32,
    pub available_ram_gb: f32,
    pub used_ram_percent: f32,
    pub gpu_name: String,
    pub gpu_vram_gb: f32,
    pub recommended_max_subagents: usize,
    pub hard_limit_subagents: usize,
    pub governor_tier: String,
    pub governor_advice: String,
    pub throttled_by_load: bool,
}

impl HardwareSpecs {
    /// Inspects current PC hardware specs and live CPU/RAM/GPU usage to compute
    /// safe subagent concurrency limits and model sizing advice.
    pub async fn inspect() -> Self {
        let mut sys = System::new_all();
        sys.refresh_all();

        let cpu_cores = sys.cpus().len().max(1);
        let cpu_brand = sys
            .cpus()
            .first()
            .map(|c| c.brand().trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("{}-Core Processor", cpu_cores));

        let cpu_usage_percent = sys.global_cpu_usage();

        let total_ram_bytes = sys.total_memory() as f64;
        let avail_ram_bytes = sys.available_memory() as f64;
        let total_ram_gb = (total_ram_bytes / (1024.0 * 1024.0 * 1024.0)) as f32;
        let available_ram_gb = (avail_ram_bytes / (1024.0 * 1024.0 * 1024.0)) as f32;
        let used_ram_percent = if total_ram_gb > 0.0 {
            ((total_ram_gb - available_ram_gb) / total_ram_gb) * 100.0
        } else {
            0.0
        };

        let (gpu_name, gpu_vram_gb) = detect_gpu().await;

        // Calculate safe concurrency bounds based on PC specs & live load
        let throttled_by_load =
            used_ram_percent > 85.0 || available_ram_gb < 3.0 || cpu_usage_percent > 88.0;

        let (hard_limit_subagents, recommended_max_subagents, governor_tier, governor_advice) =
            if throttled_by_load {
                (
                    4,
                    2,
                    "Throttled (High Load / Low Free RAM)".to_string(),
                    "System RAM or CPU usage is currently high. Subagent concurrency is softly throttled to maintain system responsiveness.".to_string(),
                )
            } else if total_ram_gb >= 30.0 && (gpu_vram_gb >= 10.0 || cpu_cores >= 12) {
                (
                    16,
                    8,
                    if gpu_name.to_lowercase().contains("radeon") {
                        "Workstation Tier (AMD Radeon ROCm / DirectML)".to_string()
                    } else if gpu_name.to_lowercase().contains("nvidia") {
                        "Workstation Tier (NVIDIA CUDA Acceleration)".to_string()
                    } else {
                        "Workstation Tier (High Spec Multi-Core)".to_string()
                    },
                    "Your PC can comfortably run a Large Architect model + multiple fast Subagents (1.5B–7B) concurrently with GPU offloading.".to_string(),
                )
            } else if total_ram_gb >= 15.0 && available_ram_gb >= 5.5 {
                (
                    8,
                    4,
                    if gpu_name.to_lowercase().contains("radeon") {
                        "Balanced Desktop (AMD Radeon Acceleration)".to_string()
                    } else {
                        "Balanced Desktop Tier (Mid Spec)".to_string()
                    },
                    "Recommended: 1 Architect model (7B–14B) + up to 4 fast Subagents with hardware acceleration.".to_string(),
                )
            } else {
                (
                    4,
                    2,
                    "Compact / Memory-Saver Tier".to_string(),
                    "Subagents execute with lightweight models (1.5B–3B) to preserve system memory.".to_string(),
                )
            };

        Self {
            cpu_brand,
            cpu_cores,
            cpu_usage_percent: (cpu_usage_percent * 10.0).round() / 10.0,
            total_ram_gb: (total_ram_gb * 10.0).round() / 10.0,
            available_ram_gb: (available_ram_gb * 10.0).round() / 10.0,
            used_ram_percent: (used_ram_percent * 10.0).round() / 10.0,
            gpu_name,
            gpu_vram_gb: (gpu_vram_gb * 10.0).round() / 10.0,
            recommended_max_subagents,
            hard_limit_subagents,
            governor_tier,
            governor_advice,
            throttled_by_load,
        }
    }
}

async fn detect_gpu() -> (String, f32) {
    if let Some(cached) = CACHED_GPU_INFO.get() {
        return cached.clone();
    }

    let detected = detect_gpu_uncached().await;
    let _ = CACHED_GPU_INFO.set(detected.clone());
    detected
}

async fn detect_gpu_uncached() -> (String, f32) {
    // 1. Try nvidia-smi for exact NVIDIA GPU name and total VRAM in MiB (hidden window)
    let mut nv_cmd = Command::new("nvidia-smi");
    nv_cmd
        .args([
            "--query-gpu=name,memory.total",
            "--format=csv,noheader,nounits",
        ])
        .stdin(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        nv_cmd.creation_flags(CREATE_NO_WINDOW);
    }

    if let Ok(out) = nv_cmd.output().await {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            if let Some(first_line) = text.lines().next() {
                let parts: Vec<&str> = first_line.split(',').collect();
                if parts.len() >= 2 {
                    let name = parts[0].trim().to_string();
                    let vram_mib: f32 = parts[1].trim().parse().unwrap_or(0.0);
                    return (name, vram_mib / 1024.0);
                }
            }
        }
    }

    // 2. Query Windows Registry for 64-bit qwMemorySize (accurate for AMD Radeon, Intel Arc & NVIDIA)
    #[cfg(target_os = "windows")]
    {
        let mut reg_cmd = Command::new("powershell");
        reg_cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            "Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | Where-Object { $_.'HardwareInformation.qwMemorySize' -gt 0 } | Select-Object -First 1 DriverDesc, @{N='VRAM_GB'; E={[math]::Round($_.'HardwareInformation.qwMemorySize' / 1GB, 1)}} | ConvertTo-Json -Compress",
        ])
        .stdin(Stdio::null());
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        reg_cmd.creation_flags(CREATE_NO_WINDOW);

        if let Ok(out) = reg_cmd.output().await {
            if out.status.success() {
                if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&out.stdout) {
                    if let Some(name) = val.get("DriverDesc").and_then(|v| v.as_str()) {
                        let vram = val.get("VRAM_GB").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
                        return (name.to_string(), vram);
                    }
                }
            }
        }

        // 3. Fallback on Windows: query Win32_VideoController via PowerShell (hidden window)
        let mut cmd = Command::new("powershell");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            "Get-CimInstance Win32_VideoController | Select-Object -First 1 Name, AdapterRAM | ConvertTo-Json -Compress",
        ])
        .stdin(Stdio::null());
        cmd.creation_flags(CREATE_NO_WINDOW);

        if let Ok(out) = cmd.output().await {
            if out.status.success() {
                if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&out.stdout) {
                    let name = val
                        .get("Name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Integrated / System GPU")
                        .to_string();
                    let ram_bytes = val
                        .get("AdapterRAM")
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.0);
                    let vram_gb = (ram_bytes / (1024.0 * 1024.0 * 1024.0)) as f32;
                    return (name, vram_gb);
                }
            }
        }
    }

    ("System GPU / Shared Memory".to_string(), 0.0)
}
