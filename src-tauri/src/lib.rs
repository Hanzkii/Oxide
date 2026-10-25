pub mod commands;
pub mod error;
pub mod hardware;
pub mod llm;
pub mod mcp;
pub mod orchestrator;
pub mod security;
pub mod updater;

use crate::llm::ProviderConfig;
use crate::mcp::McpRegistry;
use crate::security::{CommandPolicy, WorkspaceSandbox};
use std::env;
use std::sync::Arc;
use tokio::sync::RwLock;

pub struct AppState {
    pub sandbox: RwLock<Option<WorkspaceSandbox>>,
    pub provider_config: RwLock<ProviderConfig>,
    pub mcp_registry: Arc<RwLock<McpRegistry>>,
}

impl Default for AppState {
    fn default() -> Self {
        let initial_sandbox = env::current_dir()
            .ok()
            .and_then(|cwd| WorkspaceSandbox::new(cwd, CommandPolicy::default()).ok());

        Self {
            sandbox: RwLock::new(initial_sandbox),
            provider_config: RwLock::new(ProviderConfig::default()),
            mcp_registry: Arc::new(RwLock::new(McpRegistry::default())),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::workspace::set_workspace,
            commands::workspace::list_workspace_files,
            commands::workspace::read_workspace_file,
            commands::workspace::save_workspace_file,
            commands::workspace::move_workspace_file,
            commands::workspace::delete_workspace_file,
            commands::workspace::open_in_vscode,
            commands::agent::get_hardware_specs,
            commands::agent::get_provider_health,
            commands::agent::update_provider_config,
            commands::agent::list_mcp_servers,
            commands::agent::save_mcp_server,
            commands::agent::remove_mcp_server,
            commands::agent::discover_mcp_tools,
            commands::agent::call_mcp_tool,
            commands::agent::run_agent_task,
            commands::agent::execute_bounded_command,
            commands::agent::get_git_status,
            commands::agent::trigger_git_milestone,
            commands::agent::git_sync_action,
            commands::agent::check_github_update,
            commands::agent::perform_github_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Oxide Tauri application");
}
