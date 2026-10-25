use crate::error::{OxideError, OxideResult};
use crate::orchestrator::git::{GitManager, GitStatusSummary};
use crate::security::{CommandPolicy, WorkspaceSandbox};
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use tauri::State;
use tokio::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceInfo {
    pub canonical_path: String,
    pub git: GitStatusSummary,
    pub allowed_binaries: Vec<String>,
}

/// Sets and validates the active target workspace directory, locking in the `WorkspaceSandbox`.
#[tauri::command]
pub async fn set_workspace(
    workspace_path: String,
    state: State<'_, AppState>,
) -> OxideResult<WorkspaceInfo> {
    let policy = CommandPolicy::default();
    let sandbox = WorkspaceSandbox::new(&workspace_path, policy.clone())?;
    let canonical_path = sandbox.canonical_root().to_string_lossy().to_string();

    let git_manager = GitManager::new(sandbox.clone());
    let git_status = git_manager.status().await?;

    let mut guard = state.sandbox.write().await;
    *guard = Some(sandbox);

    let mut allowed: Vec<String> = policy.allowed_binaries.into_iter().collect();
    allowed.sort();

    Ok(WorkspaceInfo {
        canonical_path,
        git: git_status,
        allowed_binaries: allowed,
    })
}

/// Securely opens the target workspace directory in Visual Studio Code (`code -- <canonical_path>`).
/// Protects against CLI argument injection and shell interpolation by canonicalizing the directory
/// and passing `--` before the path argument directly to the OS process spawner.
#[tauri::command]
pub async fn open_in_vscode(
    workspace_path: Option<String>,
    state: State<'_, AppState>,
) -> OxideResult<String> {
    let target_dir: PathBuf = match workspace_path {
        Some(raw) if !raw.trim().is_empty() => {
            let temp_sandbox = WorkspaceSandbox::new(raw.trim(), CommandPolicy::default())?;
            temp_sandbox.canonical_root().to_path_buf()
        }
        _ => {
            let guard = state.sandbox.read().await;
            let sandbox = guard.as_ref().ok_or_else(|| {
                OxideError::WorkspaceError(
                    "No active workspace selected. Choose a workspace directory first.".to_string(),
                )
            })?;
            sandbox.canonical_root().to_path_buf()
        }
    };

    let canonical_str = target_dir.to_string_lossy().to_string();
    if canonical_str.starts_with('-') {
        return Err(OxideError::SecurityViolation(
            "Refusing to pass flag-prefixed path to VS Code CLI".to_string(),
        ));
    }

    // On Windows, `code.cmd` is the standard batch shim installed on PATH by VS Code;
    // fallback to `code` if `code.cmd` is not found.
    let candidates: &[&str] = if cfg!(target_os = "windows") {
        &["code.cmd", "code"]
    } else {
        &["code"]
    };

    let mut last_err = None;
    for bin in candidates {
        let mut cmd = Command::new(bin);
        cmd.arg("--")
            .arg(&target_dir)
            .current_dir(&target_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        match cmd.spawn() {
            Ok(_child) => return Ok(canonical_str),
            Err(e) => last_err = Some(e),
        }
    }

    Err(OxideError::ExecutionError(format!(
        "Failed to launch Visual Studio Code ('code' CLI not found on PATH): {}",
        last_err
            .map(|e| e.to_string())
            .unwrap_or_else(|| "unknown error".to_string())
    )))
}
