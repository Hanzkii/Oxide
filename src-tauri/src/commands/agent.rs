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
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, State};

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

    if ollama_models.is_empty() {
        ollama_models = vec![
            "qwen2.5-coder:14b".to_string(),
            "qwen2.5-coder:latest".to_string(),
            "qwen2.5-coder:7b".to_string(),
            "qwen2.5-coder:3b".to_string(),
            "gemma2:latest".to_string(),
            "deepseek-r1:latest".to_string(),
        ];
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
    let hw = HardwareSpecs::inspect().await;
    let mut sanitized = config;
    sanitized.max_concurrent_subagents = sanitized
        .max_concurrent_subagents
        .clamp(1, hw.hard_limit_subagents.max(1));

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
pub async fn perform_github_update() -> OxideResult<UpdateInstallResult> {
    install_github_update().await
}
