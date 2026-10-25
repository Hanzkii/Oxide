use crate::error::{OxideError, OxideResult};
use crate::security::{SanitizedCommand, WorkspaceSandbox};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Stdio;
use std::time::Instant;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandExecutionResult {
    pub program: String,
    pub args: Vec<String>,
    pub working_dir: String,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u128,
    pub succeeded: bool,
    pub truncated: bool,
}

impl CommandExecutionResult {
    /// Formats a structured diagnostic block for feeding back into the LLM context
    /// when a command fails (non-zero exit code) to drive autonomous self-correction.
    pub fn to_agent_observation(&self) -> String {
        let status_label = if self.succeeded {
            "SUCCESS"
        } else {
            "FAILED (NON-ZERO EXIT — SELF-CORRECTION REQUIRED)"
        };

        format!(
            "[TERMINAL_OBSERVATION]\nStatus: {}\nCommand: {} {}\nWorkingDir: {}\nExitCode: {}\nDurationMs: {}\n--- STDOUT ---\n{}\n--- STDERR ---\n{}\n[/TERMINAL_OBSERVATION]",
            status_label,
            self.program,
            self.args.join(" "),
            self.working_dir,
            self.exit_code,
            self.duration_ms,
            if self.stdout.trim().is_empty() {
                "<empty>"
            } else {
                self.stdout.trim()
            },
            if self.stderr.trim().is_empty() {
                "<empty>"
            } else {
                self.stderr.trim()
            }
        )
    }
}

/// Executes commands strictly inside the `WorkspaceSandbox` without invoking an intermediate shell.
pub struct BoundedTerminalExecutor {
    sandbox: WorkspaceSandbox,
}

impl BoundedTerminalExecutor {
    pub fn new(sandbox: WorkspaceSandbox) -> Self {
        Self { sandbox }
    }

    pub fn sandbox(&self) -> &WorkspaceSandbox {
        &self.sandbox
    }

    pub async fn execute(
        &self,
        command_line: &str,
        sub_dir: Option<&Path>,
    ) -> OxideResult<CommandExecutionResult> {
        let sanitized = self.sandbox.sanitize_command(command_line, sub_dir)?;
        self.execute_sanitized(sanitized).await
    }

    pub async fn execute_sanitized(
        &self,
        cmd: SanitizedCommand,
    ) -> OxideResult<CommandExecutionResult> {
        let start = Instant::now();

        let mut process = Command::new(&cmd.program);
        process
            .args(&cmd.args)
            .current_dir(&cmd.working_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            // Force non-interactive mode so tools never hang waiting for TTY prompts
            .env("CI", "true")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("TERM", "dumb");

        for env_key in &cmd.scrubbed_env_keys {
            process.env_remove(env_key);
        }

        // On Windows, prevent flashing console windows when spawning background CLI tools
        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            process.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = process.spawn().map_err(|e| {
            OxideError::ExecutionError(format!(
                "Failed to spawn '{}': {}",
                cmd.program, e
            ))
        })?;

        let stdout_pipe = child.stdout.take();
        let stderr_pipe = child.stderr.take();
        let max_bytes = cmd.max_output_bytes;

        let read_future = async {
            let stdout_task = tokio::spawn(Self::read_bounded(stdout_pipe, max_bytes));
            let stderr_task = tokio::spawn(Self::read_bounded(stderr_pipe, max_bytes));
            let status = child.wait().await?;
            let (stdout, out_trunc) = stdout_task.await.unwrap_or_default();
            let (stderr, err_trunc) = stderr_task.await.unwrap_or_default();
            Ok::<_, std::io::Error>((status, stdout, stderr, out_trunc || err_trunc))
        };

        let (status, stdout, stderr, truncated) =
            tokio::time::timeout(cmd.timeout, read_future)
                .await
                .map_err(|_| OxideError::ExecutionTimeout(cmd.timeout.as_secs()))?
                .map_err(OxideError::Io)?;

        let exit_code = status.code().unwrap_or(-1);
        let duration_ms = start.elapsed().as_millis();

        Ok(CommandExecutionResult {
            program: cmd.program,
            args: cmd.args,
            working_dir: cmd.working_dir.to_string_lossy().to_string(),
            exit_code,
            stdout,
            stderr,
            duration_ms,
            succeeded: status.success(),
            truncated,
        })
    }

    async fn read_bounded<R: tokio::io::AsyncRead + Unpin>(
        pipe: Option<R>,
        max_bytes: usize,
    ) -> (String, bool) {
        let Some(mut reader) = pipe else {
            return (String::new(), false);
        };

        let mut buffer = Vec::with_capacity(4096);
        let mut temp = [0u8; 4096];
        let mut truncated = false;

        loop {
            match reader.read(&mut temp).await {
                Ok(0) => break,
                Ok(n) => {
                    let remaining = max_bytes.saturating_sub(buffer.len());
                    if n > remaining {
                        buffer.extend_from_slice(&temp[..remaining]);
                        truncated = true;
                        break;
                    } else {
                        buffer.extend_from_slice(&temp[..n]);
                    }
                }
                Err(_) => break,
            }
        }

        let mut text = String::from_utf8_lossy(&buffer).to_string();
        if truncated {
            text.push_str("\n...[output truncated by Oxide security boundary]...");
        }
        (text, truncated)
    }
}
