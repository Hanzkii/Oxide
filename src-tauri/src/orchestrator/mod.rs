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

/// Maximum autonomous self-correction iterations per user task before halting for human review.
const MAX_AGENT_STEPS: usize = 8;

/// System prompt instructing the model how to emit structured JSON tool calls or final answers.
const AGENT_SYSTEM_PROMPT: &str = r#"You are Oxide, a local-first autonomous AI software engineering agent running inside a secure Rust/Tauri sandbox.
You operate iteratively on the user's project workspace.
To perform an action, respond with a single JSON object enclosed in ```json ... ``` fences matching one of these schemas:

1. Execute a bounded terminal command (no shell chaining `&&`, `;`, or `|`):
```json
{
  "action": "run_command",
  "command": "cargo check",
  "rationale": "Verify whether the Rust workspace compiles cleanly"
}
```

2. Write or update a file inside the workspace:
```json
{
  "action": "write_file",
  "path": "src/lib.rs",
  "content": "// full file content",
  "rationale": "Implement module logic"
}
```

3. Read a file inside the workspace:
```json
{
  "action": "read_file",
  "path": "Cargo.toml",
  "rationale": "Inspect crate dependencies"
}
```

4. Complete the task and trigger an automated Git milestone commit:
```json
{
  "action": "complete_task",
  "summary": "Implemented feature and verified all tests pass",
  "auto_commit": true
}
```

SELF-CORRECTION RULE:
If a `run_command` tool observation returns a non-zero ExitCode or compiler/test errors in STDERR, analyze the exact error message, modify the code or command to fix the root cause, and re-verify before calling `complete_task`."#;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum AgentToolAction {
    RunCommand {
        command: String,
        rationale: Option<String>,
    },
    WriteFile {
        path: String,
        content: String,
        rationale: Option<String>,
    },
    ReadFile {
        path: String,
        rationale: Option<String>,
    },
    CompleteTask {
        summary: String,
        #[serde(default = "default_true")]
        auto_commit: bool,
    },
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowStepStatus {
    Running,
    Succeeded,
    SelfCorrecting,
    Failed,
}

/// Real-time event payload streamed to the React frontend over Tauri IPC events.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentStreamEvent {
    TokenDelta {
        step: usize,
        provider: String,
        token: String,
    },
    WorkflowCard {
        step: usize,
        title: String,
        detail: String,
        status: WorkflowStepStatus,
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
                "Workspace Root: {}\nTask: {}",
                self.sandbox.canonical_root().display(),
                user_prompt
            )),
        ];

        for step in 1..=MAX_AGENT_STEPS {
            self.emit_event(
                &app,
                AgentStreamEvent::WorkflowCard {
                    step,
                    title: format!("Reasoning (Step {}/{})", step, MAX_AGENT_STEPS),
                    detail: format!(
                        "Querying {:?} ({})",
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

            conversation.push(ChatMessage::assistant(assistant_reply.clone()));

            let Some(action) = Self::extract_tool_action(&assistant_reply) else {
                // Model replied with direct natural language completion
                self.emit_event(
                    &app,
                    AgentStreamEvent::TaskCompleted {
                        steps_taken: step,
                        summary: assistant_reply.clone(),
                    },
                );
                return Ok(assistant_reply);
            };

            match action {
                AgentToolAction::RunCommand { command, rationale } => {
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
                                        detail: format!("Completed in {} ms", exec_result.duration_ms),
                                        status: WorkflowStepStatus::Succeeded,
                                    },
                                );
                            } else {
                                // Non-zero exit code: trigger autonomous self-correction loop
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
                                            .unwrap_or("Captured stderr for agent self-correction")
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

                AgentToolAction::WriteFile {
                    path,
                    content,
                    rationale,
                } => {
                    let target = self.sandbox.validate_path_in_workspace(Path::new(&path))?;
                    if let Some(parent) = target.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    fs::write(&target, &content)?;

                    self.emit_event(
                        &app,
                        AgentStreamEvent::WorkflowCard {
                            step,
                            title: format!("Wrote File: `{}`", path),
                            detail: rationale.unwrap_or_else(|| format!("{} bytes written", content.len())),
                            status: WorkflowStepStatus::Succeeded,
                        },
                    );

                    conversation.push(ChatMessage::tool(format!(
                        "[FILE_WRITE_SUCCESS] Wrote {} bytes to {}",
                        content.len(),
                        path
                    )));
                }

                AgentToolAction::ReadFile { path, rationale } => {
                    let target = self.sandbox.validate_path_in_workspace(Path::new(&path))?;
                    match fs::read_to_string(&target) {
                        Ok(data) => {
                            let capped: String = data.chars().take(16_000).collect();
                            self.emit_event(
                                &app,
                                AgentStreamEvent::WorkflowCard {
                                    step,
                                    title: format!("Read File: `{}`", path),
                                    detail: rationale.unwrap_or_else(|| format!("{} bytes read", data.len())),
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

                AgentToolAction::CompleteTask {
                    summary,
                    auto_commit,
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
            MAX_AGENT_STEPS
        )))
    }

    fn emit_event(&self, app: &AppHandle, event: AgentStreamEvent) {
        let _ = app.emit("oxide://agent-event", event);
    }

    /// Extracts a JSON tool block from either ```json ... ``` fences or a raw JSON object.
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
