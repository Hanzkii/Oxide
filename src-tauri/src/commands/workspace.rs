use crate::error::{OxideError, OxideResult};
use crate::orchestrator::git::{GitManager, GitStatusSummary};
use crate::security::{CommandPolicy, WorkspaceSandbox};
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::State;
use tokio::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceInfo {
    pub canonical_path: String,
    pub git: GitStatusSummary,
    pub allowed_binaries: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceFileEntry {
    pub name: String,
    pub relative_path: String,
    pub is_dir: bool,
    pub size_bytes: u64,
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

#[tauri::command]
pub async fn list_workspace_files(
    sub_path: Option<String>,
    state: State<'_, AppState>,
) -> OxideResult<Vec<WorkspaceFileEntry>> {
    let guard = state.sandbox.read().await;
    let sandbox = guard.as_ref().ok_or_else(|| {
        OxideError::WorkspaceError("No active workspace configured".to_string())
    })?;

    let rel = sub_path.unwrap_or_else(|| ".".to_string());
    let target_dir = sandbox.validate_path_in_workspace(Path::new(&rel))?;
    let root = sandbox.canonical_root();

    let mut entries = Vec::new();
    for entry in fs::read_dir(&target_dir)?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".git" || name == "node_modules" || name == "target" {
            continue;
        }
        let path = entry.path();
        let meta = entry.metadata().ok();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size_bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let relative_path = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");

        entries.push(WorkspaceFileEntry {
            name,
            relative_path,
            is_dir,
            size_bytes,
        });
    }

    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(entries)
}

#[tauri::command]
pub async fn read_workspace_file(
    relative_path: String,
    state: State<'_, AppState>,
) -> OxideResult<String> {
    let guard = state.sandbox.read().await;
    let sandbox = guard.as_ref().ok_or_else(|| {
        OxideError::WorkspaceError("No active workspace configured".to_string())
    })?;
    let target = sandbox.validate_path_in_workspace(Path::new(&relative_path))?;
    Ok(fs::read_to_string(target)?)
}

#[tauri::command]
pub async fn save_workspace_file(
    relative_path: String,
    content: String,
    state: State<'_, AppState>,
) -> OxideResult<String> {
    let guard = state.sandbox.read().await;
    let sandbox = guard.as_ref().ok_or_else(|| {
        OxideError::WorkspaceError("No active workspace configured".to_string())
    })?;
    let target = sandbox.validate_path_in_workspace(Path::new(&relative_path))?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&target, &content)?;
    Ok(relative_path)
}

#[tauri::command]
pub async fn move_workspace_file(
    source_path: String,
    destination_path: String,
    state: State<'_, AppState>,
) -> OxideResult<String> {
    let guard = state.sandbox.read().await;
    let sandbox = guard.as_ref().ok_or_else(|| {
        OxideError::WorkspaceError("No active workspace configured".to_string())
    })?;
    let src = sandbox.validate_path_in_workspace(Path::new(&source_path))?;
    let dst = sandbox.validate_path_in_workspace(Path::new(&destination_path))?;
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(&src, &dst)?;
    Ok(destination_path)
}

#[tauri::command]
pub async fn delete_workspace_file(
    relative_path: String,
    state: State<'_, AppState>,
) -> OxideResult<String> {
    let guard = state.sandbox.read().await;
    let sandbox = guard.as_ref().ok_or_else(|| {
        OxideError::WorkspaceError("No active workspace configured".to_string())
    })?;
    let target = sandbox.validate_path_in_workspace(Path::new(&relative_path))?;
    if target.is_dir() {
        fs::remove_dir_all(&target)?;
    } else {
        fs::remove_file(&target)?;
    }
    Ok(relative_path)
}

/// Securely opens the target workspace directory or file in Visual Studio Code (`code -- <canonical_path>`).
#[tauri::command]
pub async fn open_in_vscode(
    workspace_path: Option<String>,
    state: State<'_, AppState>,
) -> OxideResult<String> {
    let target_dir: PathBuf = match workspace_path {
        Some(raw) if !raw.trim().is_empty() => {
            let guard = state.sandbox.read().await;
            if let Some(sandbox) = guard.as_ref() {
                if let Ok(in_ws) = sandbox.validate_path_in_workspace(Path::new(raw.trim())) {
                    in_ws
                } else {
                    let temp_sandbox = WorkspaceSandbox::new(raw.trim(), CommandPolicy::default())?;
                    temp_sandbox.canonical_root().to_path_buf()
                }
            } else {
                let temp_sandbox = WorkspaceSandbox::new(raw.trim(), CommandPolicy::default())?;
                temp_sandbox.canonical_root().to_path_buf()
            }
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
