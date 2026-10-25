use crate::error::{OxideError, OxideResult};
use crate::hardware::HardwareSpecs;
use crate::llm::router::HybridProviderRouter;
use crate::llm::ProviderConfig;
use crate::mcp::{McpServerConfig, McpToolCallResult};
use crate::orchestrator::git::{GitCommitRecord, GitManager, GitStatusSummary};
use crate::orchestrator::terminal::{BoundedTerminalExecutor, CommandExecutionResult};
use crate::orchestrator::AgentOrchestrator;
use crate::updater::{
    check_for_github_updates, install_github_update, UpdateInstallResult, UpdateStatus,
};
use crate::AppState;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelDownloadProgress {
    pub model_id: String,
    pub status: String,
    pub completed: u64,
    pub total: u64,
    pub percent: f32,
}

#[derive(Deserialize)]
struct OllamaPullProgressLine {
    status: Option<String>,
    completed: Option<u64>,
    total: Option<u64>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderHealthReport {
    pub active_provider: String,
    pub ollama_reachable: bool,
    pub ollama_models: Vec<String>,
    pub anthropic_key_present: bool,
    pub openai_key_present: bool,
    pub config: ProviderConfig,
}

#[derive(Deserialize)]
struct OllamaTagsResponse {
    models: Option<Vec<OllamaTagItem>>,
}

#[derive(Deserialize)]
struct OllamaTagItem {
    name: String,
}

#[tauri::command]
pub async fn get_hardware_specs() -> OxideResult<HardwareSpecs> {
    Ok(HardwareSpecs::inspect().await)
}

#[tauri::command]
pub async fn get_provider_health(state: State<'_, AppState>) -> OxideResult<ProviderHealthReport> {
    let config = state.provider_config.read().await.clone();
    let router = HybridProviderRouter::new(config.clone());

    let ollama_ok = router
        .build_provider(crate::llm::ProviderKind::Ollama)
        .health_check()
        .await
        .unwrap_or(false);
    let anthropic_ok = router
        .build_provider(crate::llm::ProviderKind::Anthropic)
        .health_check()
        .await
        .unwrap_or(false);
    let openai_ok = router
        .build_provider(crate::llm::ProviderKind::OpenAi)
        .health_check()
        .await
        .unwrap_or(false);

    let mut ollama_models = Vec::new();
    if ollama_ok {
        if let Ok(client) = reqwest::Client::builder()
            .timeout(Duration::from_secs(4))
            .build()
        {
            let tags_url = format!("{}/api/tags", config.ollama_base_url.trim_end_matches('/'));
            if let Ok(resp) = client.get(&tags_url).send().await {
                if let Ok(parsed) = resp.json::<OllamaTagsResponse>().await {
                    if let Some(models) = parsed.models {
                        ollama_models = models.into_iter().map(|m| m.name).collect();
                    }
                }
            }
        }
    }

    Ok(ProviderHealthReport {
        active_provider: format!("{:?}", config.active_provider).to_lowercase(),
        ollama_reachable: ollama_ok,
        ollama_models,
        anthropic_key_present: anthropic_ok,
        openai_key_present: openai_ok,
        config,
    })
}

#[tauri::command]
pub async fn update_provider_config(
    config: ProviderConfig,
    state: State<'_, AppState>,
) -> OxideResult<ProviderConfig> {
    let mut sanitized = config;
    sanitized.max_concurrent_subagents = sanitized.max_concurrent_subagents.clamp(1, 32);

    let mut guard = state.provider_config.write().await;
    *guard = sanitized.clone();
    Ok(sanitized)
}

#[tauri::command]
pub async fn list_mcp_servers(state: State<'_, AppState>) -> OxideResult<Vec<McpServerConfig>> {
    let guard = state.mcp_registry.read().await;
    Ok(guard.servers.clone())
}

#[tauri::command]
pub async fn save_mcp_server(
    server: McpServerConfig,
    state: State<'_, AppState>,
) -> OxideResult<Vec<McpServerConfig>> {
    let mut guard = state.mcp_registry.write().await;
    if let Some(existing) = guard.servers.iter_mut().find(|s| s.id == server.id) {
        *existing = server;
    } else {
        guard.servers.push(server);
    }
    Ok(guard.servers.clone())
}

#[tauri::command]
pub async fn remove_mcp_server(
    server_id: String,
    state: State<'_, AppState>,
) -> OxideResult<Vec<McpServerConfig>> {
    let mut guard = state.mcp_registry.write().await;
    guard.servers.retain(|s| s.id != server_id);
    Ok(guard.servers.clone())
}

#[tauri::command]
pub async fn discover_mcp_tools(
    server_id: String,
    state: State<'_, AppState>,
) -> OxideResult<McpServerConfig> {
    let mut guard = state.mcp_registry.write().await;
    guard.discover_server_tools(&server_id).await
}

#[tauri::command]
pub async fn call_mcp_tool(
    server_id: String,
    tool_name: String,
    arguments: Value,
    state: State<'_, AppState>,
) -> OxideResult<McpToolCallResult> {
    let guard = state.mcp_registry.read().await;
    guard.call_tool(&server_id, &tool_name, arguments).await
}

#[tauri::command]
pub async fn run_agent_task(
    prompt: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> OxideResult<String> {
    let sandbox = state
        .sandbox
        .read()
        .await
        .clone()
        .ok_or_else(|| OxideError::WorkspaceError("No active workspace configured".to_string()))?;

    let config = state.provider_config.read().await.clone();
    let mcp_registry = state.mcp_registry.clone();
    let orchestrator = AgentOrchestrator::new(sandbox, config, mcp_registry);
    orchestrator.run_autonomous_loop(app, prompt).await
}

#[tauri::command]
pub async fn execute_bounded_command(
    command_line: String,
    state: State<'_, AppState>,
) -> OxideResult<CommandExecutionResult> {
    let sandbox = state
        .sandbox
        .read()
        .await
        .clone()
        .ok_or_else(|| OxideError::WorkspaceError("No active workspace configured".to_string()))?;

    let executor = BoundedTerminalExecutor::new(sandbox);
    executor.execute(&command_line, None).await
}

#[tauri::command]
pub async fn get_git_status(state: State<'_, AppState>) -> OxideResult<GitStatusSummary> {
    let sandbox = state
        .sandbox
        .read()
        .await
        .clone()
        .ok_or_else(|| OxideError::WorkspaceError("No active workspace configured".to_string()))?;

    let git = GitManager::new(sandbox);
    git.status().await
}

#[tauri::command]
pub async fn trigger_git_milestone(
    milestone_summary: String,
    state: State<'_, AppState>,
) -> OxideResult<Option<GitCommitRecord>> {
    let sandbox = state
        .sandbox
        .read()
        .await
        .clone()
        .ok_or_else(|| OxideError::WorkspaceError("No active workspace configured".to_string()))?;

    let config = state.provider_config.read().await.clone();
    let router = HybridProviderRouter::new(config);
    let git = GitManager::new(sandbox);
    git.commit_milestone(&router, &milestone_summary).await
}

#[tauri::command]
pub async fn git_sync_action(
    operation: String,
    state: State<'_, AppState>,
) -> OxideResult<CommandExecutionResult> {
    let sandbox = state
        .sandbox
        .read()
        .await
        .clone()
        .ok_or_else(|| OxideError::WorkspaceError("No active workspace configured".to_string()))?;

    let git = GitManager::new(sandbox);
    match operation.to_lowercase().as_str() {
        "pull" => git.pull().await,
        "push" => git.push().await,
        other => Err(OxideError::GitError(format!(
            "Unsupported git sync operation: {}",
            other
        ))),
    }
}

#[tauri::command]
pub async fn check_github_update() -> OxideResult<UpdateStatus> {
    check_for_github_updates().await
}

#[tauri::command]
pub async fn perform_github_update(app: AppHandle) -> OxideResult<UpdateInstallResult> {
    install_github_update(&app).await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInstallResult {
    pub model_id: String,
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HuggingFaceModelEntry {
    pub id: String,
    pub install_id: String,
    pub name: String,
    pub author: String,
    pub downloads: u64,
    pub likes: u64,
    pub params: String,
    pub size_gb: f32,
    pub min_ram_gb: f32,
    pub recommended_vram_gb: f32,
    pub is_coding: bool,
    pub is_uncensored: bool,
    pub is_reasoning: bool,
    pub is_fast_subagent: bool,
    pub summary: String,
}

#[derive(Deserialize)]
struct HfApiModelItem {
    id: String,
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    likes: u64,
    #[serde(default)]
    tags: Vec<String>,
}

fn infer_hf_specs(repo_id: &str, tags: &[String]) -> (String, f32, f32, f32, bool, bool, bool, bool) {
    let lower = format!("{} {}", repo_id.to_lowercase(), tags.join(" ").to_lowercase());

    let is_uncensored = lower.contains("uncensored")
        || lower.contains("abliterated")
        || lower.contains("dolphin")
        || lower.contains("unfiltered")
        || lower.contains("heretic")
        || lower.contains("lexi")
        || lower.contains("dare")
        || lower.contains("ortho");

    let is_coding = lower.contains("coder")
        || lower.contains("code")
        || lower.contains("starcoder")
        || lower.contains("deepseek-coder")
        || lower.contains("codestral")
        || lower.contains("qwen2.5-coder");

    let is_reasoning = lower.contains("deepseek-r1")
        || lower.contains("-r1")
        || lower.contains("qwq")
        || lower.contains("reasoning")
        || lower.contains("think");

    let (params, size_gb, min_ram_gb, vram_gb, is_fast) = if lower.contains("70b") || lower.contains("72b") {
        ("70B".to_string(), 40.0, 48.0, 42.0, false)
    } else if lower.contains("32b") || lower.contains("34b") {
        ("32B".to_string(), 19.5, 24.0, 20.0, false)
    } else if lower.contains("14b") || lower.contains("16b") || lower.contains("13b") {
        ("14B".to_string(), 9.0, 14.0, 10.0, false)
    } else if lower.contains("1.5b") || lower.contains("1b") || lower.contains("0.5b") {
        ("1.5B".to_string(), 1.1, 4.0, 2.0, true)
    } else if lower.contains("3b") || lower.contains("2b") {
        ("3B".to_string(), 2.1, 6.0, 3.5, true)
    } else if lower.contains("8b") {
        ("8B".to_string(), 4.9, 8.0, 6.0, true)
    } else {
        ("7B".to_string(), 4.7, 8.0, 6.0, true)
    };

    (
        params,
        size_gb,
        min_ram_gb,
        vram_gb,
        is_coding,
        is_uncensored,
        is_reasoning,
        is_fast,
    )
}

/// Ensures Ollama is installed and running locally, installing it via Winget/Direct installer if missing.
#[tauri::command]
pub async fn ensure_ollama_engine() -> OxideResult<String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Stdio;
        use tokio::process::Command;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        // First try starting `ollama serve` if `ollama` binary exists
        let mut check = Command::new("ollama");
        check.arg("--version").stdin(Stdio::null());
        check.creation_flags(CREATE_NO_WINDOW);
        if check.output().await.is_ok() {
            let mut serve = Command::new("ollama");
            serve.arg("serve").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            serve.creation_flags(CREATE_NO_WINDOW);
            let _ = serve.spawn();
            tokio::time::sleep(Duration::from_millis(1200)).await;
            return Ok("Ollama engine started in background.".to_string());
        }

        // Otherwise install Ollama automatically via winget
        let mut winget = Command::new("winget");
        winget.args([
            "install",
            "-e",
            "--id",
            "Ollama.Ollama",
            "--accept-source-agreements",
            "--accept-package-agreements",
        ]);
        winget.creation_flags(CREATE_NO_WINDOW);
        let out = winget.output().await?;
        if out.status.success() {
            return Ok("Ollama installed via Winget! Starting local AI engine...".to_string());
        }
        return Err(OxideError::ProviderError {
            provider: "ollama".to_string(),
            message: "Could not auto-install Ollama via Winget. Please download from https://ollama.com/download".to_string(),
        });
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok("Please start `ollama serve` in your terminal.".to_string())
    }
}

/// 1-Click Installs an AI model from either the Ollama Registry (`qwen2.5-coder:7b`)
/// or directly from HuggingFace GGUF (`hf.co/<owner>/<repo>`).
#[tauri::command]
pub async fn install_ai_model(
    model_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> OxideResult<ModelInstallResult> {
    let config = state.provider_config.read().await.clone();
    let base_url = config.ollama_base_url.trim_end_matches('/').to_string();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3600))
        .build()?;

    let pull_url = format!("{}/api/pull", base_url);
    let body = serde_json::json!({
        "name": model_id.trim(),
        "stream": true
    });

    let resp = client.post(&pull_url).json(&body).send().await.map_err(|e| {
        OxideError::ProviderError {
            provider: "ollama".to_string(),
            message: format!("Failed to connect to local Ollama instance at {}: {}", pull_url, e),
        }
    })?;

    if !resp.status().is_success() {
        let err_text = resp.text().await.unwrap_or_default();
        return Err(OxideError::ProviderError {
            provider: "ollama".to_string(),
            message: format!("Ollama pull error: {}", err_text),
        });
    }

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk_res) = stream.next().await {
        if let Ok(chunk) = chunk_res {
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(newline_pos) = buffer.find('\n') {
                let line = buffer[..newline_pos].trim().to_string();
                buffer = buffer[newline_pos + 1..].to_string();
                if !line.is_empty() {
                    if let Ok(chunk_json) = serde_json::from_str::<OllamaPullProgressLine>(&line) {
                        if let Some(err) = chunk_json.error {
                            return Err(OxideError::ProviderError {
                                provider: "ollama".to_string(),
                                message: err,
                            });
                        }
                        let completed = chunk_json.completed.unwrap_or(0);
                        let total = chunk_json.total.unwrap_or(0);
                        let percent = if total > 0 {
                            ((completed as f64 / total as f64) * 100.0) as f32
                        } else {
                            0.0
                        };
                        let status_text = chunk_json
                            .status
                            .unwrap_or_else(|| "downloading".to_string());
                        let _ = app.emit(
                            "oxide://model-download-progress",
                            ModelDownloadProgress {
                                model_id: model_id.clone(),
                                status: status_text,
                                completed,
                                total,
                                percent,
                            },
                        );
                    }
                }
            }
        }
    }

    Ok(ModelInstallResult {
        model_id: model_id.clone(),
        success: true,
        message: format!("Installed {} successfully!", model_id),
    })
}

/// Removes an installed AI model from Ollama to free disk space.
#[tauri::command]
pub async fn delete_ai_model(
    model_id: String,
    state: State<'_, AppState>,
) -> OxideResult<bool> {
    let config = state.provider_config.read().await.clone();
    let base_url = config.ollama_base_url.trim_end_matches('/').to_string();

    if let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
    {
        let del_url = format!("{}/api/delete", base_url);
        let body = serde_json::json!({ "name": model_id.trim() });
        if let Ok(resp) = client.delete(&del_url).json(&body).send().await {
            if resp.status().is_success() {
                return Ok(true);
            }
        }
    }

    use std::process::Stdio;
    use tokio::process::Command;
    let mut cmd = Command::new("ollama");
    cmd.args(["rm", model_id.trim()]).stdin(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().await?;
    Ok(out.status.success())
}

/// Searches HuggingFace Hub for GGUF models compatible with 1-click Ollama installation (`hf.co/<repo>`).
#[tauri::command]
pub async fn search_huggingface_gguf(query: String) -> OxideResult<Vec<HuggingFaceModelEntry>> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("OxideStudio/0.1")
        .build()?;

    let q = if query.trim().is_empty() {
        "coder abliterated".to_string()
    } else {
        query.trim().to_string()
    };

    let url = format!(
        "https://huggingface.co/api/models?search={}&filter=gguf&sort=downloads&direction=-1&limit=18",
        urlencoding_encode(&q)
    );

    let resp = client.get(&url).send().await?;
    let items: Vec<HfApiModelItem> = resp.json().await.unwrap_or_default();

    let mut results = Vec::with_capacity(items.len());
    for item in items {
        let parts: Vec<&str> = item.id.split('/').collect();
        let author = parts.first().copied().unwrap_or("hf").to_string();
        let name = parts.get(1).copied().unwrap_or(&item.id).to_string();
        let (params, size_gb, min_ram_gb, vram_gb, is_coding, is_uncensored, is_reasoning, is_fast) =
            infer_hf_specs(&item.id, &item.tags);

        let mut badges = Vec::new();
        if is_coding {
            badges.push("Coding");
        }
        if is_uncensored {
            badges.push("Uncensored/Abliterated");
        }
        if is_reasoning {
            badges.push("Reasoning");
        }
        let badge_str = if badges.is_empty() {
            "General GGUF".to_string()
        } else {
            badges.join(" • ")
        };

        results.push(HuggingFaceModelEntry {
            id: item.id.clone(),
            install_id: format!("hf.co/{}", item.id),
            name,
            author,
            downloads: item.downloads,
            likes: item.likes,
            params,
            size_gb,
            min_ram_gb,
            recommended_vram_gb: vram_gb,
            is_coding,
            is_uncensored,
            is_reasoning,
            is_fast_subagent: is_fast,
            summary: format!(
                "HuggingFace GGUF ({}) — {} downloads, ♥ {} likes. 1-Click direct pull via hf.co.",
                badge_str, item.downloads, item.likes
            ),
        });
    }

    Ok(results)
}

fn urlencoding_encode(input: &str) -> String {
    let mut out = String::new();
    for b in input.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => {
                out.push(b as char);
            }
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}
