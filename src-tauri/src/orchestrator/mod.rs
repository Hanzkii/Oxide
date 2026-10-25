pub mod git;
pub mod terminal;

use crate::error::{OxideError, OxideResult};
use crate::llm::router::HybridProviderRouter;
use crate::llm::{ChatMessage, ProviderConfig};
use crate::orchestrator::git::{GitCommitRecord, GitManager};
use crate::orchestrator::terminal::{BoundedTerminalExecutor, CommandExecutionResult};
use crate::security::WorkspaceSandbox;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

/// Default maximum autonomous steps per task (configurable in GUI settings).
const DEFAULT_MAX_AGENT_STEPS: usize = 12;

/// Antigravity-grade System Prompt instructing the model to emit live thinking,
/// a task plan checklist, and structured JSON tool calls.
const AGENT_SYSTEM_PROMPT: &str = r#"You are Oxide, an autonomous AI software engineering agent (modeled after Google Antigravity) running inside a desktop GUI command center.
You have full autonomous capability within the workspace to inspect directories, search code, read/write/edit/move/delete files, execute terminal commands, self-correct compiler/test errors, and manage Git (status, diff, commit, pull, push).

Always explain what you are thinking first inside `<think>...</think>` tags so the user can watch your live reasoning in the GUI!
Then, to execute a tool, output a JSON block inside ```json ... ``` fences with an optional `"thought"` and `"plan"` array, plus one of these actions:

1. `list_dir` — List files and folders in a workspace directory:
```json
{
  "thought": "Inspecting the project structure to locate the entry point",
  "plan": ["Inspect workspace files", "Edit target module", "Run tests and commit"],
  "action": "list_dir",
  "path": "."
}
```

2. `search_files` — Search for text or symbols across workspace files:
```json
{
  "thought": "Searching for where the configuration struct is defined",
  "action": "search_files",
  "query": "ProviderConfig"
}
```

3. `read_file` — Read the contents of a file:
```json
{
  "thought": "Reading Cargo.toml to check installed crates",
  "action": "read_file",
  "path": "Cargo.toml"
}
```

4. `write_file` — Create a new file or overwrite an existing file:
```json
{
  "thought": "Creating a new helper module",
  "action": "write_file",
  "path": "src/helper.ts",
  "content": "export const VERSION = '1.0.0';\n",
  "rationale": "Add version helper"
}
```

5. `edit_file` — Replace an exact target snippet inside an existing file:
```json
{
  "thought": "Updating the port number in vite.config.ts",
  "action": "edit_file",
  "path": "vite.config.ts",
  "target": "port: 1420",
  "replacement": "port: 1420,\n    open: false",
  "rationale": "Configure server options"
}
```

6. `move_file` — Move or rename a file or folder inside the workspace:
```json
{
  "thought": "Renaming legacy utility file",
  "action": "move_file",
  "source": "src/old_util.ts",
  "destination": "src/utils/index.ts",
  "rationale": "Organize utils directory"
}
```

7. `delete_file` — Delete an obsolete file inside the workspace:
```json
{
  "thought": "Removing temporary scratch file",
  "action": "delete_file",
  "path": "src/temp.txt",
  "rationale": "Clean up temporary file"
}
```

8. `run_command` — Run a terminal command (no shell chaining `&&` or `|`):
```json
{
  "thought": "Running the test suite to verify our changes compile and pass",
  "action": "run_command",
  "command": "npm run build",
  "rationale": "Verify TypeScript compilation"
}
```

9. `git_action` — Run Git operations (`status`, `diff`, `pull`, `push`, `commit`, `log`):
```json
{
  "thought": "Pulling latest changes from GitHub remote before pushing",
  "action": "git_action",
  "operation": "pull",
  "message": "Sync with origin/main"
}
```

10. `open_in_vscode` — Open a file or workspace in Visual Studio Code:
```json
{
  "thought": "Opening the modified file in VS Code for the user",
  "action": "open_in_vscode",
  "path": "src/App.tsx"
}
```

11. `complete_task` — Finish the task, auto-commit milestone, and optionally push to Git:
```json
{
  "thought": "All checks passed; completing task and committing milestone",
  "action": "complete_task",
  "summary": "Implemented requested feature and verified build passes",
  "auto_commit": true,
  "auto_push": false
}
```

SELF-CORRECTION RULE:
If `run_command` or any tool returns an error or non-zero ExitCode (`STDERR`), analyze the error inside `<think>...</think>`, fix the file or command, and re-verify before calling `complete_task`."#;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum AgentToolAction {
    ListDir {
        #[serde(default = "default_dot")]
        path: String,
        thought: Option<String>,
        plan: Option<Vec<String>>,
    },
    SearchFiles {
        query: String,
        thought: Option<String>,
        plan: Option<Vec<String>>,
    },
    ReadFile {
        path: String,
        rationale: Option<String>,
        thought: Option<String>,
        plan: Option<Vec<String>>,
    },
    WriteFile {
        path: String,
        content: String,
        rationale: Option<String>,
        thought: Option<String>,
        plan: Option<Vec<String>>,
    },
    EditFile {
        path: String,
        target: String,
        replacement: String,
        rationale: Option<String>,
        thought: Option<String>,
        plan: Option<Vec<String>>,
    },
    MoveFile {
        source: String,
        destination: String,
        rationale: Option<String>,
        thought: Option<String>,
        plan: Option<Vec<String>>,
    },
    DeleteFile {
        path: String,
        rationale: Option<String>,
        thought: Option<String>,
        plan: Option<Vec<String>>,
    },
    RunCommand {
        command: String,
        rationale: Option<String>,
        thought: Option<String>,
        plan: Option<Vec<String>>,
    },
    GitAction {
        operation: String,
        message: Option<String>,
        thought: Option<String>,
        plan: Option<Vec<String>>,
    },
    OpenInVscode {
        path: Option<String>,
        thought: Option<String>,
        plan: Option<Vec<String>>,
    },
    CompleteTask {
        summary: String,
        #[serde(default = "default_true")]
        auto_commit: bool,
        #[serde(default)]
        auto_push: bool,
        thought: Option<String>,
        plan: Option<Vec<String>>,
    },
}

fn default_true() -> bool {
    true
}

fn default_dot() -> String {
    ".".to_string()
}

impl AgentToolAction {
    pub fn thought(&self) -> Option<&str> {
        match self {
            Self::ListDir { thought, .. }
            | Self::SearchFiles { thought, .. }
            | Self::ReadFile { thought, .. }
            | Self::WriteFile { thought, .. }
            | Self::EditFile { thought, .. }
            | Self::MoveFile { thought, .. }
            | Self::DeleteFile { thought, .. }
            | Self::RunCommand { thought, .. }
            | Self::GitAction { thought, .. }
            | Self::OpenInVscode { thought, .. }
            | Self::CompleteTask { thought, .. } => thought.as_deref(),
        }
    }

    pub fn plan(&self) -> Option<&[String]> {
        match self {
            Self::ListDir { plan, .. }
            | Self::SearchFiles { plan, .. }
            | Self::ReadFile { plan, .. }
            | Self::WriteFile { plan, .. }
            | Self::EditFile { plan, .. }
            | Self::MoveFile { plan, .. }
            | Self::DeleteFile { plan, .. }
            | Self::RunCommand { plan, .. }
            | Self::GitAction { plan, .. }
            | Self::OpenInVscode { plan, .. }
            | Self::CompleteTask { plan, .. } => plan.as_deref(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowStepStatus {
    Running,
    Succeeded,
    SelfCorrecting,
    Failed,
}

/// Real-time event payload streamed to the React GUI over Tauri IPC events.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentStreamEvent {
    TokenDelta {
        step: usize,
        provider: String,
        token: String,
    },
    ThinkingUpdate {
        step: usize,
        thought: String,
    },
    PlanUpdate {
        step: usize,
        items: Vec<String>,
    },
    WorkflowCard {
        step: usize,
        title: String,
        detail: String,
        status: WorkflowStepStatus,
    },
    FileChange {
        step: usize,
        operation: String,
        path: String,
        detail: String,
    },
    TerminalOutput {
        step: usize,
        result: CommandExecutionResult,
    },
    GitMilestone {
        step: usize,
        commit: GitCommitRecord,
    },
    TaskCompleted {
        steps_taken: usize,
        summary: String,
    },
    TaskError {
        message: String,
    },
}

pub struct AgentOrchestrator {
    sandbox: WorkspaceSandbox,
    provider_config: ProviderConfig,
}

impl AgentOrchestrator {
    pub fn new(sandbox: WorkspaceSandbox, provider_config: ProviderConfig) -> Self {
        Self {
            sandbox,
            provider_config,
        }
    }

    pub async fn run_autonomous_loop(
        &self,
        app: AppHandle,
        user_prompt: String,
    ) -> OxideResult<String> {
        let router = HybridProviderRouter::new(self.provider_config.clone());
        let executor = BoundedTerminalExecutor::new(self.sandbox.clone());
        let git_manager = GitManager::new(self.sandbox.clone());

        let mut conversation = vec![
            ChatMessage::system(AGENT_SYSTEM_PROMPT),
            ChatMessage::user(format!(
                "Workspace Root: {}\nUser Request: {}",
                self.sandbox.canonical_root().display(),
                user_prompt
            )),
        ];

        for step in 1..=DEFAULT_MAX_AGENT_STEPS {
            self.emit_event(
                &app,
                AgentStreamEvent::WorkflowCard {
                    step,
                    title: format!("Thinking & Planning (Step {}/{})", step, DEFAULT_MAX_AGENT_STEPS),
                    detail: format!(
                        "Model: {:?} ({})",
                        self.provider_config.active_provider, self.provider_config.ollama_model
                    ),
                    status: WorkflowStepStatus::Running,
                },
            );

            let app_for_stream = app.clone();
            let provider_label = format!("{:?}", self.provider_config.active_provider);
            let token_cb = Arc::new(move |token: &str| {
                let _ = app_for_stream.emit(
                    "oxide://agent-event",
                    AgentStreamEvent::TokenDelta {
                        step,
                        provider: provider_label.clone(),
                        token: token.to_string(),
                    },
                );
            });

            let (_used_provider, assistant_reply) =
                router.stream_with_fallback(&conversation, token_cb).await?;

            // Extract `<think>...</think>` block if emitted by reasoning models
            if let Some(think_text) = Self::extract_think_tag(&assistant_reply) {
                self.emit_event(
                    &app,
                    AgentStreamEvent::ThinkingUpdate {
                        step,
                        thought: think_text,
                    },
                );
            }

            conversation.push(ChatMessage::assistant(assistant_reply.clone()));

            let Some(action) = Self::extract_tool_action(&assistant_reply) else {
                self.emit_event(
                    &app,
                    AgentStreamEvent::TaskCompleted {
                        steps_taken: step,
                        summary: assistant_reply.clone(),
                    },
                );
                return Ok(assistant_reply);
            };

            if let Some(thought_str) = action.thought() {
                self.emit_event(
                    &app,
                    AgentStreamEvent::ThinkingUpdate {
                        step,
                        thought: thought_str.to_string(),
                    },
                );
            }

            if let Some(plan_items) = action.plan() {
                self.emit_event(
                    &app,
                    AgentStreamEvent::PlanUpdate {
                        step,
                        items: plan_items.to_vec(),
                    },
                );
            }

            match action {
                AgentToolAction::ListDir { path, .. } => {
                    let target = self.sandbox.validate_path_in_workspace(Path::new(&path))?;
                    let mut entries = Vec::new();
                    if let Ok(read_dir) = fs::read_dir(&target) {
                        for entry in read_dir.flatten() {
                            let name = entry.file_name().to_string_lossy().to_string();
                            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                            entries.push(if is_dir {
                                format!("[DIR]  {}", name)
                            } else {
                                format!("[FILE] {}", name)
                            });
                        }
                    }
                    entries.sort();
                    let listing = entries.join("\n");

                    self.emit_event(
                        &app,
                        AgentStreamEvent::WorkflowCard {
                            step,
                            title: format!("Listed Directory: `{}`", path),
                            detail: format!("{} entries found", entries.len()),
                            status: WorkflowStepStatus::Succeeded,
                        },
                    );
                    conversation.push(ChatMessage::tool(format!(
                        "[DIR_LISTING path=\"{}\"]\n{}\n[/DIR_LISTING]",
                        path, listing
                    )));
                }

                AgentToolAction::SearchFiles { query, .. } => {
                    let matches = self.search_in_workspace(&query);
                    self.emit_event(
                        &app,
                        AgentStreamEvent::WorkflowCard {
                            step,
                            title: format!("Searched Workspace: `{}`", query),
                            detail: format!("{} matching lines", matches.len()),
                            status: WorkflowStepStatus::Succeeded,
                        },
                    );
                    conversation.push(ChatMessage::tool(format!(
                        "[SEARCH_RESULTS query=\"{}\"]\n{}\n[/SEARCH_RESULTS]",
                        query,
                        if matches.is_empty() {
                            "No matches found.".to_string()
                        } else {
                            matches.join("\n")
                        }
                    )));
                }

                AgentToolAction::ReadFile {
                    path, rationale, ..
                } => {
                    let target = self.sandbox.validate_path_in_workspace(Path::new(&path))?;
                    match fs::read_to_string(&target) {
                        Ok(data) => {
                            let capped: String = data.chars().take(16_000).collect();
                            self.emit_event(
                                &app,
                                AgentStreamEvent::WorkflowCard {
                                    step,
                                    title: format!("Read File: `{}`", path),
                                    detail: rationale
                                        .unwrap_or_else(|| format!("{} bytes read", data.len())),
                                    status: WorkflowStepStatus::Succeeded,
                                },
                            );
                            conversation.push(ChatMessage::tool(format!(
                                "[FILE_CONTENT path=\"{}\"]\n{}\n[/FILE_CONTENT]",
                                path, capped
                            )));
                        }
                        Err(e) => {
                            conversation.push(ChatMessage::tool(format!(
                                "[FILE_READ_ERROR path=\"{}\"] {}",
                                path, e
                            )));
                        }
                    }
                }

                AgentToolAction::WriteFile {
                    path,
                    content,
                    rationale,
                    ..
                } => {
                    let target = self.sandbox.validate_path_in_workspace(Path::new(&path))?;
                    if let Some(parent) = target.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    fs::write(&target, &content)?;

                    let detail = rationale
                        .unwrap_or_else(|| format!("Wrote {} bytes", content.len()));
                    self.emit_event(
                        &app,
                        AgentStreamEvent::FileChange {
                            step,
                            operation: "write".to_string(),
                            path: path.clone(),
                            detail: detail.clone(),
                        },
                    );
                    self.emit_event(
                        &app,
                        AgentStreamEvent::WorkflowCard {
                            step,
                            title: format!("Wrote File: `{}`", path),
                            detail,
                            status: WorkflowStepStatus::Succeeded,
                        },
                    );

                    conversation.push(ChatMessage::tool(format!(
                        "[FILE_WRITE_SUCCESS] Wrote {} bytes to {}",
                        content.len(),
                        path
                    )));
                }

                AgentToolAction::EditFile {
                    path,
                    target,
                    replacement,
                    rationale,
                    ..
                } => {
                    let resolved = self.sandbox.validate_path_in_workspace(Path::new(&path))?;
                    match fs::read_to_string(&resolved) {
                        Ok(existing) => {
                            if existing.contains(&target) {
                                let updated = existing.replace(&target, &replacement);
                                fs::write(&resolved, &updated)?;
                                let detail = rationale
                                    .unwrap_or_else(|| "Applied target replacement edit".to_string());
                                self.emit_event(
                                    &app,
                                    AgentStreamEvent::FileChange {
                                        step,
                                        operation: "edit".to_string(),
                                        path: path.clone(),
                                        detail: detail.clone(),
                                    },
                                );
                                self.emit_event(
                                    &app,
                                    AgentStreamEvent::WorkflowCard {
                                        step,
                                        title: format!("Edited File: `{}`", path),
                                        detail,
                                        status: WorkflowStepStatus::Succeeded,
                                    },
                                );
                                conversation.push(ChatMessage::tool(format!(
                                    "[FILE_EDIT_SUCCESS path=\"{}\"] Replaced target block.",
                                    path
                                )));
                            } else {
                                self.emit_event(
                                    &app,
                                    AgentStreamEvent::WorkflowCard {
                                        step,
                                        title: format!("Edit Target Mismatch: `{}`", path),
                                        detail: "Target snippet not found in file; re-reading required".to_string(),
                                        status: WorkflowStepStatus::SelfCorrecting,
                                    },
                                );
                                conversation.push(ChatMessage::tool(format!(
                                    "[FILE_EDIT_ERROR path=\"{}\"] Exact target string was not found. Use `read_file` to inspect exact contents before editing.",
                                    path
                                )));
                            }
                        }
                        Err(e) => {
                            conversation.push(ChatMessage::tool(format!(
                                "[FILE_EDIT_ERROR path=\"{}\"] {}",
                                path, e
                            )));
                        }
                    }
                }

                AgentToolAction::MoveFile {
                    source,
                    destination,
                    rationale,
                    ..
                } => {
                    let src_path = self.sandbox.validate_path_in_workspace(Path::new(&source))?;
                    let dst_path = self
                        .sandbox
                        .validate_path_in_workspace(Path::new(&destination))?;
                    if let Some(parent) = dst_path.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    fs::rename(&src_path, &dst_path)?;

                    let detail = rationale.unwrap_or_else(|| {
                        format!("Moved {} -> {}", source, destination)
                    });
                    self.emit_event(
                        &app,
                        AgentStreamEvent::FileChange {
                            step,
                            operation: "move".to_string(),
                            path: format!("{} -> {}", source, destination),
                            detail: detail.clone(),
                        },
                    );
                    self.emit_event(
                        &app,
                        AgentStreamEvent::WorkflowCard {
                            step,
                            title: format!("Moved File: `{}` -> `{}`", source, destination),
                            detail,
                            status: WorkflowStepStatus::Succeeded,
                        },
                    );
                    conversation.push(ChatMessage::tool(format!(
                        "[FILE_MOVE_SUCCESS] Moved {} to {}",
                        source, destination
                    )));
                }

                AgentToolAction::DeleteFile {
                    path, rationale, ..
                } => {
                    let target = self.sandbox.validate_path_in_workspace(Path::new(&path))?;
                    if target.is_dir() {
                        fs::remove_dir_all(&target)?;
                    } else {
                        fs::remove_file(&target)?;
                    }
                    let detail = rationale.unwrap_or_else(|| format!("Deleted {}", path));
                    self.emit_event(
                        &app,
                        AgentStreamEvent::FileChange {
                            step,
                            operation: "delete".to_string(),
                            path: path.clone(),
                            detail: detail.clone(),
                        },
                    );
                    self.emit_event(
                        &app,
                        AgentStreamEvent::WorkflowCard {
                            step,
                            title: format!("Deleted File: `{}`", path),
                            detail,
                            status: WorkflowStepStatus::Succeeded,
                        },
                    );
                    conversation.push(ChatMessage::tool(format!(
                        "[FILE_DELETE_SUCCESS] Deleted {}",
                        path
                    )));
                }

                AgentToolAction::RunCommand {
                    command, rationale, ..
                } => {
                    let detail = rationale.unwrap_or_else(|| command.clone());
                    self.emit_event(
                        &app,
                        AgentStreamEvent::WorkflowCard {
                            step,
                            title: format!("Executing: `{}`", command),
                            detail,
                            status: WorkflowStepStatus::Running,
                        },
                    );

                    match executor.execute(&command, None).await {
                        Ok(exec_result) => {
                            let observation = exec_result.to_agent_observation();
                            let succeeded = exec_result.succeeded;

                            self.emit_event(
                                &app,
                                AgentStreamEvent::TerminalOutput {
                                    step,
                                    result: exec_result.clone(),
                                },
                            );

                            if succeeded {
                                self.emit_event(
                                    &app,
                                    AgentStreamEvent::WorkflowCard {
                                        step,
                                        title: format!("Command Succeeded: `{}`", command),
                                        detail: format!(
                                            "Exit 0 in {} ms",
                                            exec_result.duration_ms
                                        ),
                                        status: WorkflowStepStatus::Succeeded,
                                    },
                                );
                            } else {
                                self.emit_event(
                                    &app,
                                    AgentStreamEvent::WorkflowCard {
                                        step,
                                        title: format!(
                                            "Non-Zero Exit ({}) — Self-Correcting",
                                            exec_result.exit_code
                                        ),
                                        detail: exec_result
                                            .stderr
                                            .lines()
                                            .next()
                                            .unwrap_or("Captured stderr for autonomous repair")
                                            .to_string(),
                                        status: WorkflowStepStatus::SelfCorrecting,
                                    },
                                );
                            }

                            conversation.push(ChatMessage::tool(observation));
                        }
                        Err(sec_or_exec_err) => {
                            let err_msg = sec_or_exec_err.to_string();
                            self.emit_event(
                                &app,
                                AgentStreamEvent::WorkflowCard {
                                    step,
                                    title: "Command Blocked / Failed".to_string(),
                                    detail: err_msg.clone(),
                                    status: WorkflowStepStatus::SelfCorrecting,
                                },
                            );
                            conversation.push(ChatMessage::tool(format!(
                                "[TOOL_ERROR]\n{}\nAdjust command to comply with workspace sandbox policy.",
                                err_msg
                            )));
                        }
                    }
                }

                AgentToolAction::GitAction {
                    operation, message, ..
                } => {
                    let op_lower = operation.to_lowercase();
                    let result_summary = match op_lower.as_str() {
                        "pull" => {
                            let res = git_manager.pull().await?;
                            self.emit_event(
                                &app,
                                AgentStreamEvent::TerminalOutput {
                                    step,
                                    result: res.clone(),
                                },
                            );
                            format!("git pull exit={}: {}\n{}", res.exit_code, res.stdout, res.stderr)
                        }
                        "push" => {
                            let res = git_manager.push().await?;
                            self.emit_event(
                                &app,
                                AgentStreamEvent::TerminalOutput {
                                    step,
                                    result: res.clone(),
                                },
                            );
                            format!("git push exit={}: {}\n{}", res.exit_code, res.stdout, res.stderr)
                        }
                        "commit" => {
                            let summary = message.unwrap_or_else(|| "Agent milestone update".to_string());
                            if let Some(rec) = git_manager.commit_milestone(&router, &summary).await? {
                                self.emit_event(
                                    &app,
                                    AgentStreamEvent::GitMilestone {
                                        step,
                                        commit: rec.clone(),
                                    },
                                );
                                format!("Committed [{}] {}", rec.commit_hash, rec.message)
                            } else {
                                "Working tree clean; nothing to commit.".to_string()
                            }
                        }
                        "diff" => git_manager.diff().await?,
                        _ => {
                            let st = git_manager.status().await?;
                            serde_json::to_string_pretty(&st).unwrap_or_default()
                        }
                    };

                    self.emit_event(
                        &app,
                        AgentStreamEvent::WorkflowCard {
                            step,
                            title: format!("Git Operation: `{}`", op_lower),
                            detail: result_summary.lines().next().unwrap_or("Completed").to_string(),
                            status: WorkflowStepStatus::Succeeded,
                        },
                    );
                    conversation.push(ChatMessage::tool(format!(
                        "[GIT_RESULT operation=\"{}\"]\n{}\n[/GIT_RESULT]",
                        op_lower, result_summary
                    )));
                }

                AgentToolAction::OpenInVscode { path, .. } => {
                    let target = match path {
                        Some(ref p) => self.sandbox.validate_path_in_workspace(Path::new(p))?,
                        None => self.sandbox.canonical_root().to_path_buf(),
                    };
                    let _ = tokio::process::Command::new(if cfg!(target_os = "windows") {
                        "code.cmd"
                    } else {
                        "code"
                    })
                    .arg("--")
                    .arg(&target)
                    .spawn();

                    self.emit_event(
                        &app,
                        AgentStreamEvent::WorkflowCard {
                            step,
                            title: "Opened in VS Code".to_string(),
                            detail: target.to_string_lossy().to_string(),
                            status: WorkflowStepStatus::Succeeded,
                        },
                    );
                    conversation.push(ChatMessage::tool(format!(
                        "[VSCODE_OPENED] {}",
                        target.display()
                    )));
                }

                AgentToolAction::CompleteTask {
                    summary,
                    auto_commit,
                    auto_push,
                    ..
                } => {
                    if auto_commit {
                        if let Ok(Some(commit_record)) =
                            git_manager.commit_milestone(&router, &summary).await
                        {
                            self.emit_event(
                                &app,
                                AgentStreamEvent::GitMilestone {
                                    step,
                                    commit: commit_record,
                                },
                            );
                        }
                    }

                    if auto_push {
                        if let Ok(push_res) = git_manager.push().await {
                            self.emit_event(
                                &app,
                                AgentStreamEvent::TerminalOutput {
                                    step,
                                    result: push_res,
                                },
                            );
                        }
                    }

                    self.emit_event(
                        &app,
                        AgentStreamEvent::TaskCompleted {
                            steps_taken: step,
                            summary: summary.clone(),
                        },
                    );
                    return Ok(summary);
                }
            }
        }

        Err(OxideError::ExecutionError(format!(
            "Reached maximum autonomous step limit ({}) without final task completion",
            DEFAULT_MAX_AGENT_STEPS
        )))
    }

    fn search_in_workspace(&self, query: &str) -> Vec<String> {
        let mut results = Vec::new();
        let root = self.sandbox.canonical_root();
        Self::walk_and_search(root, root, query, &mut results);
        results
    }

    fn walk_and_search(root: &Path, dir: &Path, query: &str, results: &mut Vec<String>) {
        if results.len() >= 60 {
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            if results.len() >= 60 {
                return;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name == ".git" || name == "node_modules" || name == "target" || name == "dist" {
                continue;
            }
            if path.is_dir() {
                Self::walk_and_search(root, &path, query, results);
            } else if let Ok(content) = fs::read_to_string(&path) {
                let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy();
                for (idx, line) in content.lines().enumerate() {
                    if line.contains(query) {
                        results.push(format!("{}:{}: {}", rel, idx + 1, line.trim()));
                        if results.len() >= 60 {
                            break;
                        }
                    }
                }
            }
        }
    }

    fn emit_event(&self, app: &AppHandle, event: AgentStreamEvent) {
        let _ = app.emit("oxide://agent-event", event);
    }

    fn extract_think_tag(text: &str) -> Option<String> {
        let start = text.find("<think>")?;
        let after = &text[start + 7..];
        let end = after.find("</think>").unwrap_or(after.len());
        let cleaned = after[..end].trim().to_string();
        if cleaned.is_empty() {
            None
        } else {
            Some(cleaned)
        }
    }

    fn extract_tool_action(text: &str) -> Option<AgentToolAction> {
        if let Some(start_idx) = text.find("```json") {
            let after_fence = &text[start_idx + 7..];
            if let Some(end_idx) = after_fence.find("```") {
                let json_slice = after_fence[..end_idx].trim();
                if let Ok(parsed) = serde_json::from_str::<AgentToolAction>(json_slice) {
                    return Some(parsed);
                }
            }
        }

        let trimmed = text.trim();
        if trimmed.starts_with('{') && trimmed.ends_with('}') {
            if let Ok(parsed) = serde_json::from_str::<AgentToolAction>(trimmed) {
                return Some(parsed);
            }
        }

        None
    }
}
