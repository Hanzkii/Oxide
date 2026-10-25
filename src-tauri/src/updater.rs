use crate::error::{OxideError, OxideResult};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const GITHUB_REPO: &str = "Hanzkii/Oxide";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateStatus {
    pub current_version: String,
    pub latest_version: String,
    pub latest_commit_sha: String,
    pub latest_commit_message: String,
    pub latest_commit_date: String,
    pub update_available: bool,
    pub installer_download_url: Option<String>,
    pub installer_name: Option<String>,
    pub release_url: String,
    pub release_notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateInstallResult {
    pub method: String,
    pub message: String,
    pub restart_required: bool,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    body: Option<String>,
    assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Deserialize)]
struct GithubCommitResponse {
    sha: String,
    commit: GithubCommitDetail,
}

#[derive(Deserialize)]
struct GithubCommitDetail {
    message: String,
    committer: GithubCommitter,
}

#[derive(Deserialize)]
struct GithubCommitter {
    date: String,
}

pub async fn check_for_github_updates() -> OxideResult<UpdateStatus> {
    let client = Client::builder()
        .user_agent("Oxide-Agent-Updater/0.1")
        .timeout(Duration::from_secs(15))
        .build()?;

    let commit_url = format!("https://api.github.com/repos/{}/commits/main", GITHUB_REPO);
    let commit_resp = client.get(&commit_url).send().await;

    let (latest_sha, latest_msg, latest_date) = match commit_resp {
        Ok(resp) if resp.status().is_success() => {
            if let Ok(parsed) = resp.json::<GithubCommitResponse>().await {
                let short_sha = parsed.sha.chars().take(7).collect::<String>();
                let first_line = parsed
                    .commit
                    .message
                    .lines()
                    .next()
                    .unwrap_or("Update available")
                    .to_string();
                (short_sha, first_line, parsed.commit.committer.date)
            } else {
                ("unknown".to_string(), String::new(), String::new())
            }
        }
        _ => ("unknown".to_string(), String::new(), String::new()),
    };

    // Check local git HEAD if running inside a repository checkout
    let local_sha = get_local_git_head().await.unwrap_or_default();

    let release_url = format!(
        "https://api.github.com/repos/{}/releases/latest",
        GITHUB_REPO
    );
    let release_resp = client.get(&release_url).send().await;

    if let Ok(resp) = release_resp {
        if resp.status().is_success() {
            if let Ok(release) = resp.json::<GithubRelease>().await {
                let clean_latest = release.tag_name.trim_start_matches('v').to_string();
                let preferred_asset = release.assets.iter().find(|a| {
                    a.name.ends_with("-setup.exe")
                        || a.name.ends_with(".msi")
                        || a.name.ends_with(".exe")
                });

                let version_differs = clean_latest != APP_VERSION;
                let sha_differs =
                    !local_sha.is_empty() && !latest_sha.is_empty() && local_sha != latest_sha;

                return Ok(UpdateStatus {
                    current_version: if local_sha.is_empty() {
                        format!("v{}", APP_VERSION)
                    } else {
                        format!("v{} ({})", APP_VERSION, local_sha)
                    },
                    latest_version: format!("{} ({})", release.tag_name, latest_sha),
                    latest_commit_sha: latest_sha,
                    latest_commit_message: latest_msg,
                    latest_commit_date: latest_date,
                    update_available: version_differs || sha_differs,
                    installer_download_url: preferred_asset
                        .map(|a| a.browser_download_url.clone()),
                    installer_name: preferred_asset.map(|a| a.name.clone()),
                    release_url: release.html_url,
                    release_notes: release.body.unwrap_or_default(),
                });
            }
        }
    }

    let update_available =
        !local_sha.is_empty() && !latest_sha.is_empty() && local_sha != latest_sha;

    Ok(UpdateStatus {
        current_version: if local_sha.is_empty() {
            format!("v{}", APP_VERSION)
        } else {
            format!("v{} ({})", APP_VERSION, local_sha)
        },
        latest_version: format!("v{} ({})", APP_VERSION, latest_sha),
        latest_commit_sha: latest_sha,
        latest_commit_message: latest_msg.clone(),
        latest_commit_date: latest_date,
        update_available,
        installer_download_url: None,
        installer_name: None,
        release_url: format!("https://github.com/{}/releases", GITHUB_REPO),
        release_notes: latest_msg,
    })
}

pub async fn install_github_update() -> OxideResult<UpdateInstallResult> {
    let status = check_for_github_updates().await?;

    // 1. If a compiled installer asset (.exe / .msi) is published on GitHub Releases, download & launch it
    if let (Some(download_url), Some(asset_name)) =
        (status.installer_download_url, status.installer_name)
    {
        let client = Client::builder()
            .user_agent("Oxide-Agent-Updater/0.1")
            .timeout(Duration::from_secs(120))
            .build()?;

        let bytes = client
            .get(&download_url)
            .send()
            .await?
            .bytes()
            .await?;

        let target_path = env::temp_dir().join(&asset_name);
        fs::write(&target_path, &bytes)?;

        // Strip NTFS Zone.Identifier and launch installer directly with CREATE_NO_WINDOW
        // so no black cmd.exe terminal window ever pops up.
        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let zone_ads = format!("{}:Zone.Identifier", target_path.to_string_lossy());
            let _ = fs::remove_file(zone_ads);

            let mut installer_cmd = Command::new(&target_path);
            installer_cmd
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW);

            installer_cmd.spawn().map_err(|e| {
                OxideError::ExecutionError(format!("Failed to launch installer: {}", e))
            })?;
        }

        return Ok(UpdateInstallResult {
            method: "release_installer".to_string(),
            message: format!(
                "Downloaded and launched update installer '{}' ({} KB).",
                asset_name,
                bytes.len() / 1024
            ),
            restart_required: true,
        });
    }

    // 2. Otherwise, pull latest commits directly from GitHub origin/main (strictly hidden window)
    let mut git_pull = Command::new("git");
    git_pull
        .args(["pull", "--rebase", "origin", "main"])
        .stdin(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        git_pull.creation_flags(CREATE_NO_WINDOW);
    }

    let output = git_pull
        .output()
        .await
        .map_err(|e| OxideError::GitError(format!("Failed to run git pull: {}", e)))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(UpdateInstallResult {
            method: "git_pull".to_string(),
            message: format!(
                "Updated from GitHub (origin/main): {}",
                if stdout.is_empty() {
                    "Already up to date."
                } else {
                    &stdout
                }
            ),
            restart_required: false,
        })
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(OxideError::GitError(format!(
            "GitHub update failed: {}",
            stderr
        )))
    }
}

async fn get_local_git_head() -> Option<String> {
    let mut git_head = Command::new("git");
    git_head
        .args(["rev-parse", "--short", "HEAD"])
        .stdin(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        git_head.creation_flags(CREATE_NO_WINDOW);
    }

    let output = git_head.output().await.ok()?;
    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        None
    }
}
