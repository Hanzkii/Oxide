use crate::gui::theme::*;
use crate::orchestrator::git::GitStatusSummary;
use crate::orchestrator::terminal::{BoundedTerminalExecutor, CommandExecutionResult};
use crate::AppState;
use eframe::egui::{self, Key, ScrollArea, Ui};
use std::sync::Arc;

pub const MAX_LOG_LINES: usize = 2000;
pub const MAX_RENDERED_LINES: usize = 500;

/// Strips ANSI escape sequences (CSI and OSC codes) from console output
pub fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            if let Some(&'[') = chars.peek() {
                chars.next();
                // Consume CSI parameters until final byte in 0x40..=0x7E
                while let Some(&c) = chars.peek() {
                    chars.next();
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            } else if let Some(&']') = chars.peek() {
                chars.next();
                // Consume OSC sequence terminated by BEL (\x07) or ST (\x1b\)
                while let Some(&c) = chars.peek() {
                    chars.next();
                    if c == '\x07' {
                        break;
                    }
                    if c == '\x1b' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
        } else if ch != '\r' {
            out.push(ch);
        }
    }
    out
}

/// Appends a log line (or multi-line block), strips ANSI codes, and bounds buffer in memory
pub fn append_log_line(logs: &mut Vec<String>, line: impl AsRef<str>) {
    let cleaned = strip_ansi(line.as_ref());
    for l in cleaned.lines() {
        logs.push(l.to_string());
    }
    if logs.len() > MAX_LOG_LINES {
        let drain_count = logs.len() - MAX_LOG_LINES;
        logs.drain(0..drain_count);
    }
}

pub struct TerminalViewState {
    pub cli_input: String,
    pub is_running_cmd: bool,
    pub cmd_rx: Option<tokio::sync::oneshot::Receiver<crate::error::OxideResult<CommandExecutionResult>>>,
}

impl Default for TerminalViewState {
    fn default() -> Self {
        Self {
            cli_input: String::new(),
            is_running_cmd: false,
            cmd_rx: None,
        }
    }
}

impl TerminalViewState {
    pub fn update(&mut self, logs: &mut Vec<String>) {
        if let Some(mut rx) = self.cmd_rx.take() {
            match rx.try_recv() {
                Ok(res) => {
                    self.is_running_cmd = false;
                    match res {
                        Ok(exec) => {
                            let status_str = if exec.succeeded { "[SUCCESS]" } else { "[FAILED]" };
                            append_log_line(
                                logs,
                                format!(
                                    "{} exit code {} ({}ms): {} {}",
                                    status_str,
                                    exec.exit_code,
                                    exec.duration_ms,
                                    exec.program,
                                    exec.args.join(" ")
                                ),
                            );
                            if !exec.stdout.trim().is_empty() {
                                append_log_line(logs, &exec.stdout);
                            }
                            if !exec.stderr.trim().is_empty() {
                                for line in exec.stderr.lines() {
                                    append_log_line(logs, format!("[STDERR] {}", line));
                                }
                            }
                        }
                        Err(e) => {
                            append_log_line(logs, format!("[EXECUTION_ERROR] {}", e));
                        }
                    }
                }
                Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {
                    self.cmd_rx = Some(rx);
                }
                Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                    self.is_running_cmd = false;
                }
            }
        }
    }

    pub fn execute_command(
        &mut self,
        cmd: String,
        state: Arc<AppState>,
        tokio_handle: &tokio::runtime::Handle,
        logs: &mut Vec<String>,
    ) {
        let trimmed = cmd.trim();
        if trimmed.is_empty() {
            return;
        }

        append_log_line(logs, format!("$ {}", trimmed));
        self.is_running_cmd = true;

        let (tx, rx) = tokio::sync::oneshot::channel();
        self.cmd_rx = Some(rx);

        let cmd_to_run = trimmed.to_string();
        tokio_handle.spawn(async move {
            let sandbox_opt = { state.sandbox.read().await.clone() };
            if let Some(sandbox) = sandbox_opt {
                let executor = BoundedTerminalExecutor::new(sandbox);
                let res = executor.execute(&cmd_to_run, None).await;
                let _ = tx.send(res);
            } else {
                let _ = tx.send(Err(crate::error::OxideError::ExecutionError(
                    "Workspace sandbox not initialized.".to_string(),
                )));
            }
        });
    }

    pub fn render(
        &mut self,
        ui: &mut Ui,
        state: Arc<AppState>,
        tokio_handle: &tokio::runtime::Handle,
        terminal_logs: &mut Vec<String>,
        git_status: &Option<GitStatusSummary>,
    ) {
        self.update(terminal_logs);

        ui.vertical(|ui| {
            // Header Bar with Git Info & Controls
            ui.horizontal(|ui| {
                ui.label(egui::RichText::new("Terminal / Logs").strong().color(TEXT_PRIMARY));

                if let Some(git) = git_status {
                    ui.separator();
                    let branch_label = format!("Branch: {}", git.branch);
                    ascii_badge(ui, &branch_label, ACCENT_BLUE);

                    if git.is_clean {
                        ascii_badge(ui, "[CLEAN]", ACCENT_GREEN);
                    } else {
                        let dirty_text = format!("[DIRTY: {} changed]", git.changed_files.len());
                        ascii_badge(ui, &dirty_text, ACCENT_AMBER);
                    }
                }

                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.button("Clear Logs").clicked() {
                        terminal_logs.clear();
                    }
                });
            });

            ui.add_space(4.0);

            // Log Console Area with Windowed Rendering
            nested_panel_frame().show(ui, |ui| {
                let available_height = (ui.available_height() - 38.0).max(100.0);
                ScrollArea::vertical()
                    .max_height(available_height)
                    .auto_shrink([false, false])
                    .stick_to_bottom(true)
                    .show(ui, |ui| {
                        if terminal_logs.is_empty() {
                            ui.label(
                                egui::RichText::new("No command logs recorded yet.")
                                    .color(TEXT_DIM)
                                    .monospace(),
                            );
                        } else {
                            let total_lines = terminal_logs.len();
                            let start_idx = total_lines.saturating_sub(MAX_RENDERED_LINES);
                            let visible_logs = &terminal_logs[start_idx..];

                            if start_idx > 0 {
                                ui.label(
                                    egui::RichText::new(format!(
                                        "[... {} older lines truncated from active viewport ...]",
                                        start_idx
                                    ))
                                    .color(TEXT_DIM)
                                    .monospace(),
                                );
                            }

                            for line in visible_logs {
                                let color = if line.starts_with('$') {
                                    ACCENT_CYAN
                                } else if line.contains("[SUCCESS]") {
                                    ACCENT_GREEN
                                } else if line.contains("[FAILED]")
                                    || line.contains("[STDERR]")
                                    || line.contains("[EXECUTION_ERROR]")
                                {
                                    ACCENT_RED
                                } else {
                                    TEXT_SECONDARY
                                };
                                ui.colored_label(color, egui::RichText::new(line).monospace());
                            }
                        }
                    });
            });

            ui.add_space(4.0);

            // Command Runner Dock
            ui.horizontal(|ui| {
                ui.label(egui::RichText::new("$").color(ACCENT_CYAN).monospace());

                let text_edit = egui::TextEdit::singleline(&mut self.cli_input)
                    .hint_text("Enter sandboxed command (e.g. cargo check, git status)...")
                    .desired_width(ui.available_width() - 80.0);

                let response = ui.add_enabled(!self.is_running_cmd, text_edit);

                let enter_pressed = response.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter));

                let run_btn = if self.is_running_cmd {
                    ui.add(egui::Spinner::new());
                    false
                } else {
                    ui.button("Execute").clicked()
                };

                if (enter_pressed || run_btn) && !self.is_running_cmd {
                    let cmd = self.cli_input.clone();
                    self.cli_input.clear();
                    self.execute_command(cmd, state, tokio_handle, terminal_logs);
                }
            });
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_ansi() {
        let colored = "\x1b[31;1mError:\x1b[0m File not found \x1b[32m[OK]\x1b[0m";
        let stripped = strip_ansi(colored);
        assert_eq!(stripped, "Error: File not found [OK]");

        let osc = "\x1b]0;My Title\x07Hello World";
        assert_eq!(strip_ansi(osc), "Hello World");
    }

    #[test]
    fn test_append_log_line_bounding() {
        let mut logs = Vec::new();
        for i in 0..2500 {
            append_log_line(&mut logs, format!("Line {}", i));
        }
        assert_eq!(logs.len(), MAX_LOG_LINES);
        assert_eq!(logs[0], "Line 500");
        assert_eq!(logs[MAX_LOG_LINES - 1], "Line 2499");
    }
}
