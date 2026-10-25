use serde::{Deserialize, Serialize};
use std::process::Stdio;
use sysinfo::System;
use tokio::process::Command;

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
                    1,
                    1,
                    "Throttled (High Load / Low Free RAM)".to_string(),
                    "System RAM or CPU usage is currently high. Subagents are restricted to 1 sequential worker at a time to prevent system freeze.".to_string(),
                )
            } else if total_ram_gb >= 30.0 && (gpu_vram_gb >= 12.0 || cpu_cores >= 12) {
                (
                    4,
                    3,
                    "Workstation Tier (High Spec)".to_string(),
                    "Your PC can comfortably run 1 Large Architect model (14B–32B) + up to 3 fast Subagents (1.5B–7B) concurrently.".to_string(),
                )
            } else if total_ram_gb >= 15.0 && available_ram_gb >= 5.5 {
                (
                    2,
                    2,
                    "Balanced Desktop Tier (Mid Spec)".to_string(),
                    "Recommended: 1 Architect model (7B–14B) + up to 2 fast Subagents (1.5B–3B) to stay within memory limits.".to_string(),
                )
            } else {
                (
                    1,
                    1,
                    "Compact / Memory-Saver Tier".to_string(),
                    "Limited available RAM detected. Subagents will execute 1 at a time in a sequential queue using compact models (1.5B–3B).".to_string(),
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
    // 1. Try nvidia-smi for exact NVIDIA GPU name and total VRAM in MiB
    if let Ok(out) = Command::new("nvidia-smi")
        .args([
            "--query-gpu=name,memory.total",
            "--format=csv,noheader,nounits",
        ])
        .stdin(Stdio::null())
        .output()
        .await
    {
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

    // 2. Fallback on Windows: query Win32_VideoController via PowerShell
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("powershell");
        cmd.args([
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_VideoController | Select-Object -First 1 Name, AdapterRAM | ConvertTo-Json -Compress",
        ])
        .stdin(Stdio::null());
        const CREATE_NO_WINDOW: u32 = 0x08000000;
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
