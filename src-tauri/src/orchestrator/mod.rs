pub mod git;
pub mod terminal;

use crate::error::{OxideError, OxideResult};
use crate::hardware::HardwareSpecs;
use crate::llm::router::HybridProviderRouter;
use crate::llm::{AgentRoleKind, ChatMessage, ProviderConfig};
use crate::mcp::McpRegistry;
use crate::orchestrator::git::{GitCommitRecord, GitManager};
use crate::orchestrator::terminal::{BoundedTerminalExecutor, CommandExecutionResult};
use crate::security::WorkspaceSandbox;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{RwLock, Semaphore};

const DEFAULT_MAX_AGENT_STEPS: usize = 12;

const AGENT_SYSTEM_PROMPT: &str = r#"You are Oxide Lead Architect, a large-model autonomous AI orchestrator (modeled after Google Antigravity) running inside a desktop GUI Studio.
You handle high-level architectural thinking, task decomposition, and reviewing results. You can either execute workspace tools directly OR delegate focused subtasks to faster, lightweight Subagents (`coder_subagent`, `research_subagent`, `tester_subagent`) governed by the PC's hardware concurrency limiter!

Always explain what you are thinking first inside `<think>...</think>` tags so the user can watch your live reasoning in the GUI!
Then, output a single JSON block inside ```json ... ``` fences with one of these actions:

0. `delegate_subagents` — Delegate 1 or more focused subtasks to specialized fast subagents (Oxide's Hardware Governor will automatically run them in parallel or queue them safely based on the user's PC RAM/CPU/VRAM):
```json
{
  "thought": "Breaking this task down: I will assign ResearchSubagent to inspect the config files and CoderSubagent to implement the helper module.",
  "plan": ["Delegate research & coding subtasks to subagents", "Review subagent outputs & verify build"],
  "action": "delegate_subagents",
  "subtasks": [
    {
      "id": "sub-1",
      "role": "research_subagent",
      "title": "Inspect workspace config files",
      "instructions": "Read package.json and summarize scripts and dependencies",
      "target_path": "package.json"
    },
    {
      "id": "sub-2",
      "role": "coder_subagent",
      "title": "Draft utility module",
      "instructions": "Analyze how to structure the requested feature"
    }
  ]
}
```

1. `list_dir` — List files and folders in a workspace directory:
```json
{
  "thought": "Inspecting project root",
  "action": "list_dir",
  "path": "."
}
```

2. `search_files` — Search for text or symbols across workspace files:
```json
{
  "thought": "Searching for ProviderConfig references",
  "action": "search_files",
  "query": "ProviderConfig"
}
```

3. `read_file` — Read the contents of a file:
```json
{
  "thought": "Reading Cargo.toml",
  "action": "read_file",
  "path": "Cargo.toml"
}
```

4. `write_file` — Create or overwrite a file:
```json
{
  "thought": "Writing helper file",
  "action": "write_file",
  "path": "src/helper.ts",
  "content": "export const VERSION = '1.0.0';\n",
  "rationale": "Add helper"
}
```

5. `edit_file` — Replace an exact target snippet inside an existing file:
```json
{
  "thought": "Updating target block in file",
  "action": "edit_file",
  "path": "vite.config.ts",
  "target": "port: 1420",
  "replacement": "port: 1420,\n    open: false",
  "rationale": "Update server config"
}
```

6. `move_file` — Move or rename a file or folder:
```json
{
  "thought": "Renaming file",
  "action": "move_file",
  "source": "src/old.ts",
  "destination": "src/new.ts"
}
```

7. `delete_file` — Delete a file inside the workspace:
```json
{
  "thought": "Removing temporary file",
  "action": "delete_file",
  "path": "src/temp.txt"
}
```

8. `run_command` — Run a terminal command:
```json
{
  "thought": "Running build verification",
  "action": "run_command",
  "command": "npm run build",
  "rationale": "Verify TypeScript build"
}
```

9. `git_action` — Run Git operations (`status`, `diff`, `pull`, `push`, `commit`):
```json
{
  "thought": "Pulling latest changes from GitHub",
  "action": "git_action",
  "operation": "pull"
}
```

10. `open_in_vscode` — Open a file or workspace in Visual Studio Code:
```json
{
  "thought": "Opening file in VS Code",
  "action": "open_in_vscode",
  "path": "src/App.tsx"
}
```

11. `complete_task` — Finish the task, auto-commit milestone, and optionally push to Git:
```json
{
  "thought": "All subtasks verified; completing task",
  "action": "complete_task",
  "summary": "Completed task and verified build passes",
  "auto_commit": true,
  "auto_push": false
}
```

12. `call_mcp_tool` — Invoke any tool exposed by an enabled Model Context Protocol (MCP) server:
```json
{
  "thought": "Calling the MCP memory server to store architectural notes",
  "action": "call_mcp_tool",
  "server": "oxide-memory",
  "tool": "store_memory",
  "arguments": {
    "key": "auth_flow",
    "value": "Uses local token validation"
  }
}
```"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubagentTaskSpec {
    pub id: String,
    pub role: AgentRoleKind,
    pub title: String,
    pub instructions: String,
    pub target_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubagentRunState {
    Queued,
    ThrottledWaitingForHardware,
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum AgentToolAction {
    DelegateSubagents {
        subtasks: Vec<SubagentTaskSpec>,
        thought: Option<String>,
        plan: Option<Vec<String>>,
    },
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
    CallMcpTool {
        server: String,
        tool: String,
        #[serde(default)]
        arguments: Value,
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
            Self::DelegateSubagents { thought, .. }
            | Self::ListDir { thought, .. }
            | Self::SearchFiles { thought, .. }
            | Self::ReadFile { thought, .. }
            | Self::WriteFile { thought, .. }
            | Self::EditFile { thought, .. }
            | Self::MoveFile { thought, .. }
            | Self::DeleteFile { thought, .. }
            | Self::RunCommand { thought, .. }
            | Self::GitAction { thought, .. }
            | Self::OpenInVscode { thought, .. }
            | Self::CallMcpTool { thought, .. }
            | Self::CompleteTask { thought, .. } => thought.as_deref(),
        }
    }

    pub fn plan(&self) -> Option<&[String]> {
        match self {
            Self::DelegateSubagents { plan, .. }
            | Self::ListDir { plan, .. }
            | Self::SearchFiles { plan, .. }
            | Self::ReadFile { plan, .. }
            | Self::WriteFile { plan, .. }
            | Self::EditFile { plan, .. }
            | Self::MoveFile { plan, .. }
            | Self::DeleteFile { plan, .. }
            | Self::RunCommand { plan, .. }
            | Self::GitAction { plan, .. }
            | Self::OpenInVscode { plan, .. }
            | Self::CallMcpTool { plan, .. }
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
    SubagentStatus {
        id: String,
        role: AgentRoleKind,
        model: String,
        title: String,
        state: SubagentRunState,
        thought: String,
        output_preview: String,
        active_workers: usize,
        max_allowed_workers: usize,
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
    mcp_registry: Arc<RwLock<McpRegistry>>,
}

impl AgentOrchestrator {
    pub fn new(
        sandbox: WorkspaceSandbox,
        provider_config: ProviderConfig,
        mcp_registry: Arc<RwLock<McpRegistry>>,
    ) -> Self {
        Self {
            sandbox,
            provider_config,
            mcp_registry,
        }
    }

    pub async fn run_autonomous_loop(
        &self,
        app: AppHandle,
        user_prompt: String,
    ) -> OxideResult<String> {
        let router = Arc::new(HybridProviderRouter::new(self.provider_config.clone()));
        let executor = BoundedTerminalExecutor::new(self.sandbox.clone());
        let git_manager = GitManager::new(self.sandbox.clone());

        let hw = HardwareSpecs::inspect().await;
        let effective_max_subagents = self
            .provider_config
            .max_concurrent_subagents
            .clamp(1, hw.hard_limit_subagents.max(1));

        let mcp_tools_summary = self
            .mcp_registry
            .read()
            .await
            .format_tools_for_agent_prompt();

        let mut conversation = vec![
            ChatMessage::system(AGENT_SYSTEM_PROMPT),
            ChatMessage::user(format!(
                "Workspace Root: {}\nPC Hardware Governor: {} ({:.1} GB Free RAM, Max Concurrent Subagents: {})\nTask Model Routing: Architect={}, CoderSubagent={}, ResearchSubagent={}, TesterSubagent={}\n[AVAILABLE_MCP_TOOLS]\n{}\n[/AVAILABLE_MCP_TOOLS]\nUser Request: {}",
                self.sandbox.canonical_root().display(),
                hw.governor_tier,
                hw.available_ram_gb,
                effective_max_subagents,
                self.provider_config.task_routing.architect_model,
                self.provider_config.task_routing.coder_subagent_model,
                self.provider_config.task_routing.research_subagent_model,
                self.provider_config.task_routing.tester_subagent_model,
                mcp_tools_summary,
                user_prompt
            )),
        ];

        for step in 1..=DEFAULT_MAX_AGENT_STEPS {
            self.emit_event(
                &app,
                AgentStreamEvent::WorkflowCard {
                    step,
                    title: format!(
                        "Lead Architect Thinking (Step {}/{})",
                        step, DEFAULT_MAX_AGENT_STEPS
                    ),
                    detail: format!(
                        "Architect Model: {}",
                        self.provider_config.model_for_role(AgentRoleKind::Architect)
                    ),
                    status: WorkflowStepStatus::Running,
                },
            );

            let app_for_stream = app.clone();
            let arch_model = self
                .provider_config
                .model_for_role(AgentRoleKind::Architect)
                .to_string();
            let token_cb = Arc::new(move |token: &str| {
                let _ = app_for_stream.emit(
                    "oxide://agent-event",
                    AgentStreamEvent::TokenDelta {
                        step,
                        provider: arch_model.clone(),
                        token: token.to_string(),
                    },
                );
            });

            let (_used_provider, assistant_reply) = router
                .stream_for_role(AgentRoleKind::Architect, &conversation, token_cb)
                .await?;

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
                AgentToolAction::DelegateSubagents { subtasks, .. } => {
                    let results = self
                        .execute_subagent_batch(&app, step, &router, subtasks)
                        .await;
                    conversation.push(ChatMessage::tool(format!(
                        "[SUBAGENT_BATCH_RESULTS]\n{}\n[/SUBAGENT_BATCH_RESULTS]",
                        results.join("\n\n")
                    )));
                }

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

                    let detail =
                        rationale.unwrap_or_else(|| format!("Wrote {} bytes", content.len()));
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
                                let detail = rationale.unwrap_or_else(|| {
                                    "Applied target replacement edit".to_string()
                                });
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
                                        detail:
                                            "Target snippet not found in file; re-reading required"
                                                .to_string(),
                                        status: WorkflowStepStatus::SelfCorrecting,
                                    },
                                );
                                conversation.push(ChatMessage::tool(format!(
                                    "[FILE_EDIT_ERROR path=\"{}\"] Exact target string was not found.",
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

                    let detail =
                        rationale.unwrap_or_else(|| format!("Moved {} -> {}", source, destination));
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
                                        detail: format!("Exit 0 in {} ms", exec_result.duration_ms),
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
                            format!(
                                "git pull exit={}: {}\n{}",
                                res.exit_code, res.stdout, res.stderr
                            )
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
                            format!(
                                "git push exit={}: {}\n{}",
                                res.exit_code, res.stdout, res.stderr
                            )
                        }
                        "commit" => {
                            let summary =
                                message.unwrap_or_else(|| "Agent milestone update".to_string());
                            if let Some(rec) = git_manager.commit_milestone(&router, &summary).await?
                            {
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
                            detail: result_summary
                                .lines()
                                .next()
                                .unwrap_or("Completed")
                                .to_string(),
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

                AgentToolAction::CallMcpTool {
                    server,
                    tool,
                    arguments,
                    ..
                } => {
                    self.emit_event(
                        &app,
                        AgentStreamEvent::WorkflowCard {
                            step,
                            title: format!("Calling MCP Tool: `{}/{}`", server, tool),
                            detail: arguments.to_string(),
                            status: WorkflowStepStatus::Running,
                        },
                    );

                    let mcp_guard = self.mcp_registry.read().await;
                    match mcp_guard.call_tool(&server, &tool, arguments).await {
                        Ok(mcp_res) => {
                            self.emit_event(
                                &app,
                                AgentStreamEvent::WorkflowCard {
                                    step,
                                    title: format!("MCP Result: `{}/{}`", server, tool),
                                    detail: mcp_res
                                        .content
                                        .lines()
                                        .next()
                                        .unwrap_or("Completed")
                                        .to_string(),
                                    status: if mcp_res.succeeded {
                                        WorkflowStepStatus::Succeeded
                                    } else {
                                        WorkflowStepStatus::SelfCorrecting
                                    },
                                },
                            );
                            conversation.push(ChatMessage::tool(format!(
                                "[MCP_TOOL_RESULT server=\"{}\" tool=\"{}\" succeeded={}]\n{}\n[/MCP_TOOL_RESULT]",
                                server, tool, mcp_res.succeeded, mcp_res.content
                            )));
                        }
                        Err(e) => {
                            self.emit_event(
                                &app,
                                AgentStreamEvent::WorkflowCard {
                                    step,
                                    title: format!("MCP Tool Error: `{}/{}`", server, tool),
                                    detail: e.to_string(),
                                    status: WorkflowStepStatus::SelfCorrecting,
                                },
                            );
                            conversation.push(ChatMessage::tool(format!(
                                "[MCP_TOOL_ERROR server=\"{}\" tool=\"{}\"] {}",
                                server, tool, e
                            )));
                        }
                    }
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

    /// Executes a batch of delegated Subagents governed by PC Hardware Specs (RAM, VRAM, CPU load).
    /// Prevents system overload by bounding concurrency with a semaphore and live RAM checks.
    async fn execute_subagent_batch(
        &self,
        app: &AppHandle,
        step: usize,
        router: &Arc<HybridProviderRouter>,
        subtasks: Vec<SubagentTaskSpec>,
    ) -> Vec<String> {
        let hw = HardwareSpecs::inspect().await;
        let max_allowed = if self.provider_config.auto_throttle_on_high_load && hw.throttled_by_load
        {
            1
        } else {
            self.provider_config
                .max_concurrent_subagents
                .clamp(1, hw.hard_limit_subagents.max(1))
        };

        self.emit_event(
            app,
            AgentStreamEvent::WorkflowCard {
                step,
                title: format!(
                    "Delegating {} Subagent(s) [Hardware Limit: {} concurrent]",
                    subtasks.len(),
                    max_allowed
                ),
                detail: format!(
                    "{} • Free RAM: {:.1} GB • CPU: {:.0}%",
                    hw.governor_tier, hw.available_ram_gb, hw.cpu_usage_percent
                ),
                status: WorkflowStepStatus::Running,
            },
        );

        let semaphore = Arc::new(Semaphore::new(max_allowed));
        let mut handles = Vec::new();

        for spec in &subtasks {
            let model_name = self.provider_config.model_for_role(spec.role).to_string();
            self.emit_event(
                app,
                AgentStreamEvent::SubagentStatus {
                    id: spec.id.clone(),
                    role: spec.role,
                    model: model_name,
                    title: spec.title.clone(),
                    state: if hw.throttled_by_load {
                        SubagentRunState::ThrottledWaitingForHardware
                    } else {
                        SubagentRunState::Queued
                    },
                    thought: "Queued by Hardware Governor — waiting for execution slot...".to_string(),
                    output_preview: String::new(),
                    active_workers: 0,
                    max_allowed_workers: max_allowed,
                },
            );
        }

        for spec in subtasks {
            let sem_clone = semaphore.clone();
            let router_clone = router.clone();
            let app_clone = app.clone();
            let sandbox_clone = self.sandbox.clone();
            let model_name = self.provider_config.model_for_role(spec.role).to_string();

            let handle = tokio::spawn(async move {
                let _permit = sem_clone.acquire().await.unwrap();
                let active_now = max_allowed.saturating_sub(sem_clone.available_permits());

                let _ = app_clone.emit(
                    "oxide://agent-event",
                    AgentStreamEvent::SubagentStatus {
                        id: spec.id.clone(),
                        role: spec.role,
                        model: model_name.clone(),
                        title: spec.title.clone(),
                        state: SubagentRunState::Running,
                        thought: format!("Running subtask: {}", spec.instructions),
                        output_preview: String::new(),
                        active_workers: active_now,
                        max_allowed_workers: max_allowed,
                    },
                );

                // Optional context file pre-load for the subagent
                let file_context = if let Some(ref rel_path) = spec.target_path {
                    if let Ok(resolved) =
                        sandbox_clone.validate_path_in_workspace(Path::new(rel_path))
                    {
                        fs::read_to_string(resolved)
                            .ok()
                            .map(|c| c.chars().take(8000).collect::<String>())
                            .unwrap_or_default()
                    } else {
                        String::new()
                    }
                } else {
                    String::new()
                };

                let sub_messages = vec![
                    ChatMessage::system(
                        "You are a fast, specialized Oxide Subagent executing a focused subtask for the Lead Architect AI. Begin with a brief `<think>...</think>` explanation of your approach, then provide a concise, actionable result.",
                    ),
                    ChatMessage::user(format!(
                        "Subtask Role: {:?}\nSubtask Title: {}\nInstructions: {}\n{}",
                        spec.role,
                        spec.title,
                        spec.instructions,
                        if file_context.is_empty() {
                            String::new()
                        } else {
                            format!("\nTarget File Content:\n{}", file_context)
                        }
                    )),
                ];

                let noop_cb = Arc::new(|_t: &str| {});
                match router_clone
                    .stream_for_role(spec.role, &sub_messages, noop_cb)
                    .await
                {
                    Ok((_prov, output)) => {
                        let thought = Self::extract_think_tag(&output)
                            .unwrap_or_else(|| "Completed subtask analysis.".to_string());
                        let preview: String = output.chars().take(280).collect();

                        let _ = app_clone.emit(
                            "oxide://agent-event",
                            AgentStreamEvent::SubagentStatus {
                                id: spec.id.clone(),
                                role: spec.role,
                                model: model_name.clone(),
                                title: spec.title.clone(),
                                state: SubagentRunState::Completed,
                                thought,
                                output_preview: preview,
                                active_workers: active_now.saturating_sub(1),
                                max_allowed_workers: max_allowed,
                            },
                        );

                        format!(
                            "[SUBAGENT id=\"{}\" role=\"{:?}\" model=\"{}\" status=\"COMPLETED\"]\n{}\n[/SUBAGENT]",
                            spec.id, spec.role, model_name, output
                        )
                    }
                    Err(e) => {
                        let _ = app_clone.emit(
                            "oxide://agent-event",
                            AgentStreamEvent::SubagentStatus {
                                id: spec.id.clone(),
                                role: spec.role,
                                model: model_name.clone(),
                                title: spec.title.clone(),
                                state: SubagentRunState::Failed,
                                thought: format!("Subagent error: {}", e),
                                output_preview: e.to_string(),
                                active_workers: active_now.saturating_sub(1),
                                max_allowed_workers: max_allowed,
                            },
                        );
                        format!(
                            "[SUBAGENT id=\"{}\" status=\"FAILED\"] {}",
                            spec.id, e
                        )
                    }
                }
            });

            handles.push(handle);
        }

        let mut outputs = Vec::new();
        for h in handles {
            if let Ok(res) = h.await {
                outputs.push(res);
            }
        }
        outputs
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
