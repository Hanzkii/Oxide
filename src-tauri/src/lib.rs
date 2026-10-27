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
        let initial_dir = env::current_dir()
            .ok()
            .filter(|cwd| !commands::workspace::is_installer_binary_dir(cwd))
            .unwrap_or_else(commands::workspace::default_projects_workspace_dir);
        let initial_sandbox = WorkspaceSandbox::new(initial_dir, CommandPolicy::default()).ok();

        Self {
            sandbox: RwLock::new(initial_sandbox),
            provider_config: RwLock::new(commands::agent::load_provider_config()),
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
            commands::workspace::pick_folder_dialog,
            commands::workspace::load_studio_state,
            commands::workspace::save_studio_state,
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
            commands::agent::ensure_ollama_engine,
            commands::agent::install_ai_model,
            commands::agent::delete_ai_model,
            commands::agent::search_huggingface_gguf,
            commands::agent::open_native_models_folder,
            commands::agent::open_native_runtime_folder,
            commands::agent::start_native_engine,
            commands::agent::stop_native_engine,
            commands::agent::test_provider_connection,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Oxide Tauri application");
}
