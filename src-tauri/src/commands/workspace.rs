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

/// Opens a native OS folder selection dialog and returns the chosen directory path.
#[tauri::command]
pub async fn pick_folder_dialog() -> OxideResult<Option<String>> {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("powershell");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Sta",
            "-Command",
            "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Select Project Folder for Oxide Studio'; $f.ShowNewFolderButton = $true; if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }",
        ])
        .stdin(Stdio::null());
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);

        let out = cmd.output().await?;
        let selected = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if selected.is_empty() {
            return Ok(None);
        }
        return Ok(Some(selected));
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(None)
    }
}

/// Returns the Oxide install root directory (`C:\Users\<user>\AppData\Local\Programs\Oxide` on Windows),
/// falling back to the current executable's folder or local appdata.
pub fn oxide_install_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        // 1. If currently running from an installed directory, use its parent
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(parent) = exe_path.parent() {
                let name = parent
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                if name == "oxide" || parent.join("uninstall.exe").exists() {
                    return parent.to_path_buf();
                }
            }
        }

        // 2. Standard Windows per-user installation path: %LOCALAPPDATA%\Programs\Oxide
        if let Ok(local_appdata) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(local_appdata).join("Programs").join("Oxide");
        }

        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            return PathBuf::from(user_profile)
                .join("AppData")
                .join("Local")
                .join("Programs")
                .join("Oxide");
        }
    }

    std::env::var("HOME")
        .map(|h| PathBuf::from(h).join(".local").join("share").join("Programs").join("Oxide"))
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn studio_state_file_path() -> PathBuf {
    let install_dir = oxide_install_dir();
    let _ = fs::create_dir_all(&install_dir);
    let state_file = install_dir.join("studio_sessions.json");

    // Migrate from legacy %LOCALAPPDATA%\OxideStudio\studio_sessions.json if present
    if !state_file.exists() {
        if let Ok(local_appdata) = std::env::var("LOCALAPPDATA") {
            let legacy_dir = PathBuf::from(local_appdata).join("OxideStudio");
            let legacy_file = legacy_dir.join("studio_sessions.json");
            if legacy_file.exists() {
                let _ = fs::copy(&legacy_file, &state_file);
                let _ = fs::remove_file(&legacy_file);
                let _ = fs::remove_dir(&legacy_dir);
            }
        }
    }

    state_file
}

/// Returns the default user projects workspace folder inside the install directory
/// (`C:\Users\<user>\AppData\Local\Programs\Oxide\workspace`),
/// creating it automatically if it does not exist yet.
pub fn default_projects_workspace_dir() -> PathBuf {
    // Proactively clean up any legacy C:\Users\<user>\.oxide directory so nothing remains in .oxide
    if let Ok(user_profile) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        let dot_oxide = PathBuf::from(user_profile).join(".oxide");
        if dot_oxide.exists() {
            let _ = fs::remove_dir_all(&dot_oxide);
        }
    }

    let install_dir = oxide_install_dir();
    let workspace = install_dir.join("workspace");
    let _ = fs::create_dir_all(&workspace);
    workspace
}

/// Checks if a path is the NSIS installer root application directory (`AppData\Local\Programs\Oxide` or `AppData\Local\Oxide`)
/// rather than a user project or workspace.
pub fn is_installer_binary_dir(path: &Path) -> bool {
    let s = path.to_string_lossy().to_lowercase();
    // Allow the workspace subfolder
    if s.ends_with("\\programs\\oxide\\workspace")
        || s.ends_with("/programs/oxide/workspace")
        || s.ends_with("\\oxide\\workspace")
        || s.ends_with("/oxide/workspace")
    {
        return false;
    }
    s.ends_with("\\appdata\\local\\programs\\oxide")
        || s.ends_with("/appdata/local/programs/oxide")
        || s.ends_with("\\appdata\\local\\oxide")
        || s.ends_with("/appdata/local/oxide")
        || (path.join("uninstall.exe").exists()
            && !path
                .file_name()
                .map(|n| n.to_string_lossy().eq_ignore_ascii_case("workspace"))
                .unwrap_or(false))
}

/// Loads persisted Projects and Conversation History from disk (`%LOCALAPPDATA%/OxideStudio/studio_sessions.json`).
#[tauri::command]
pub async fn load_studio_state() -> OxideResult<Option<String>> {
    let path = studio_state_file_path();
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(fs::read_to_string(path)?))
}

/// Saves Projects and Conversation History to disk so conversations persist across restarts and updates.
#[tauri::command]
pub async fn save_studio_state(state_json: String) -> OxideResult<bool> {
    let path = studio_state_file_path();
    fs::write(path, state_json)?;
    Ok(true)
}

/// Sets and validates the active target workspace directory, locking in the `WorkspaceSandbox`.
#[tauri::command]
pub async fn set_workspace(
    workspace_path: String,
    state: State<'_, AppState>,
) -> OxideResult<WorkspaceInfo> {
    let trimmed = workspace_path.trim();
    let candidate = if trimmed.is_empty() || trimmed == "." {
        let cwd = std::env::current_dir().unwrap_or_else(|_| default_projects_workspace_dir());
        if is_installer_binary_dir(&cwd) {
            default_projects_workspace_dir()
        } else {
            cwd
        }
    } else {
        let p = PathBuf::from(trimmed);
        if is_installer_binary_dir(&p) {
            default_projects_workspace_dir()
        } else {
            p
        }
    };

    let _ = fs::create_dir_all(&candidate);
    let policy = CommandPolicy::default();
    let sandbox = WorkspaceSandbox::new(&candidate, policy.clone())?;
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
