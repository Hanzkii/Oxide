use crate::error::{OxideError, OxideResult};
use crate::llm::router::HybridProviderRouter;
use crate::llm::ProviderConfig;
use crate::orchestrator::git::{GitCommitRecord, GitManager, GitStatusSummary};
use crate::orchestrator::terminal::{BoundedTerminalExecutor, CommandExecutionResult};
use crate::orchestrator::AgentOrchestrator;
use crate::AppState;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderHealthReport {
    pub active_provider: String,
    pub ollama_reachable: bool,
    pub anthropic_key_present: bool,
    pub openai_key_present: bool,
    pub config: ProviderConfig,
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

    Ok(ProviderHealthReport {
        active_provider: format!("{:?}", config.active_provider).to_lowercase(),
        ollama_reachable: ollama_ok,
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
    let mut guard = state.provider_config.write().await;
    *guard = config.clone();
    Ok(config)
}

/// Runs an autonomous multi-step coding task with real-time streaming and stderr self-correction.
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
    let orchestrator = AgentOrchestrator::new(sandbox, config);
    orchestrator.run_autonomous_loop(app, prompt).await
}

/// Executes a single bounded terminal command inside the active workspace sandbox.
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
