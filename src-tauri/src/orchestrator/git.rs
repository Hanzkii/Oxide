use crate::error::{OxideError, OxideResult};
use crate::llm::router::HybridProviderRouter;
use crate::llm::ChatMessage;
use crate::orchestrator::terminal::BoundedTerminalExecutor;
use crate::security::WorkspaceSandbox;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitStatusSummary {
    pub initialized: bool,
    pub branch: String,
    pub is_clean: bool,
    pub changed_files: Vec<String>,
    pub last_commit: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitCommitRecord {
    pub commit_hash: String,
    pub message: String,
    pub files_changed: usize,
}

/// Automated Git repository manager operating strictly within the `WorkspaceSandbox`.
pub struct GitManager {
    executor: BoundedTerminalExecutor,
}

impl GitManager {
    pub fn new(sandbox: WorkspaceSandbox) -> Self {
        Self {
            executor: BoundedTerminalExecutor::new(sandbox),
        }
    }

    /// Initializes the Git repository if `.git` is not present and ensures local commit identity exists.
    pub async fn ensure_initialized(&self) -> OxideResult<()> {
        let git_dir = self.executor.sandbox().canonical_root().join(".git");
        if !git_dir.exists() {
            let init_res = self.executor.execute("git init", None).await?;
            if !init_res.succeeded {
                return Err(OxideError::GitError(format!(
                    "git init failed: {}",
                    init_res.stderr
                )));
            }
        }

        // Ensure local repository has fallback user.name and user.email if not configured globally
        let name_check = self.executor.execute("git config user.name", None).await?;
        if !name_check.succeeded || name_check.stdout.trim().is_empty() {
            let _ = self
                .executor
                .execute("git config user.name \"Oxide Autonomous Agent\"", None)
                .await?;
        }

        let email_check = self.executor.execute("git config user.email", None).await?;
        if !email_check.succeeded || email_check.stdout.trim().is_empty() {
            let _ = self
                .executor
                .execute("git config user.email \"agent@oxide.local\"", None)
                .await?;
        }

        Ok(())
    }

    /// Inspects current repository status, active branch, changed files, and latest commit.
    pub async fn status(&self) -> OxideResult<GitStatusSummary> {
        let git_dir = self.executor.sandbox().canonical_root().join(".git");
        if !git_dir.exists() {
            return Ok(GitStatusSummary {
                initialized: false,
                branch: "uninitialized".to_string(),
                is_clean: true,
                changed_files: Vec::new(),
                last_commit: None,
            });
        }

        let branch_res = self
            .executor
            .execute("git rev-parse --abbrev-ref HEAD", None)
            .await?;
        let branch = if branch_res.succeeded {
            branch_res.stdout.trim().to_string()
        } else {
            "main".to_string()
        };

        let status_res = self
            .executor
            .execute("git status --porcelain", None)
            .await?;
        let changed_files: Vec<String> = status_res
            .stdout
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(String::from)
            .collect();

        let log_res = self
            .executor
            .execute("git log -1 --oneline", None)
            .await?;
        let last_commit = if log_res.succeeded && !log_res.stdout.trim().is_empty() {
            Some(log_res.stdout.trim().to_string())
        } else {
            None
        };

        Ok(GitStatusSummary {
            initialized: true,
            branch,
            is_clean: changed_files.is_empty(),
            changed_files,
            last_commit,
        })
    }

    /// Stages all workspace modifications, synthesizes a clean Conventional Commit message
    /// from the staged diff & milestone context, and commits the milestone.
    pub async fn commit_milestone(
        &self,
        router: &HybridProviderRouter,
        milestone_context: &str,
    ) -> OxideResult<Option<GitCommitRecord>> {
        self.ensure_initialized().await?;

        let status_before = self.status().await?;
        if status_before.is_clean {
            return Ok(None);
        }

        let files_changed = status_before.changed_files.len();

        let add_res = self.executor.execute("git add -A", None).await?;
        if !add_res.succeeded {
            return Err(OxideError::GitError(format!(
                "Failed to stage files: {}",
                add_res.stderr
            )));
        }

        let diff_stat = self
            .executor
            .execute("git diff --cached --stat", None)
            .await?
            .stdout;

        let commit_message = self
            .generate_commit_message(router, milestone_context, &diff_stat)
            .await;

        let commit_cmd = format!(
            "git commit -m \"{}\"",
            commit_message.replace('"', "'").replace('\n', " ")
        );
        let commit_res = self.executor.execute(&commit_cmd, None).await?;
        if !commit_res.succeeded {
            return Err(OxideError::GitError(format!(
                "git commit failed: {}",
                commit_res.stderr
            )));
        }

        let hash_res = self
            .executor
            .execute("git rev-parse --short HEAD", None)
            .await?;
        let commit_hash = hash_res.stdout.trim().to_string();

        Ok(Some(GitCommitRecord {
            commit_hash,
            message: commit_message,
            files_changed,
        }))
    }

    async fn generate_commit_message(
        &self,
        router: &HybridProviderRouter,
        milestone_context: &str,
        diff_stat: &str,
    ) -> String {
        let prompt = format!(
            "Generate a single-line Conventional Commit message (e.g., `feat(scope): concise summary` or `fix(scope): concise summary`, max 72 chars, no quotes or markdown) for this completed task milestone.\n\nMilestone Context: {}\n\nGit Diff Stat:\n{}",
            milestone_context, diff_stat
        );

        let messages = vec![
            ChatMessage::system(
                "You are an expert release engineer. Output ONLY a single-line Conventional Commit subject line under 72 characters.",
            ),
            ChatMessage::user(prompt),
        ];

        let noop_cb = Arc::new(|_token: &str| {});
        if let Ok((_provider, raw_msg)) = router.stream_with_fallback(&messages, noop_cb).await {
            let cleaned = raw_msg
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .trim_matches('`')
                .trim_matches('"')
                .to_string();
            if !cleaned.is_empty() && cleaned.len() <= 100 {
                return cleaned;
            }
        }

        // Deterministic fallback if offline model is busy
        let sanitized_summary: String = milestone_context
            .chars()
            .take(50)
            .collect::<String>()
            .trim()
            .to_lowercase();
        format!("feat(agent): complete {}", sanitized_summary)
    }
}
