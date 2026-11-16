use crate::commands::workspace::WorkspaceFileEntry;
use crate::error::OxideResult;
use crate::hardware::HardwareSpecs;
use crate::llm::{AgentRoleKind, ProviderKind};
use crate::orchestrator::git::GitStatusSummary;
use crate::orchestrator::{
    AgentOrchestrator, AgentStreamEvent, SubagentRunState, WorkflowStepStatus,
};
use crate::updater::{
    check_for_github_updates, install_github_update_standalone, UpdateInstallResult, UpdateStatus,
};
use crate::AppState;
use eframe::egui;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct SubagentItem {
    pub id: String,
    pub role: AgentRoleKind,
    pub model: String,
    pub title: String,
    pub state: SubagentRunState,
    pub thought: String,
    pub output_preview: String,
    pub active_workers: usize,
    pub max_allowed_workers: usize,
}

#[derive(Clone, Debug)]
pub struct WorkflowCardItem {
    pub step: usize,
    pub title: String,
    pub detail: String,
    pub status: WorkflowStepStatus,
}

#[derive(Clone, Debug)]
pub struct ConversationTurn {
    pub user_prompt: String,
    pub thought: String,
    pub thinking_metrics: Option<(f32, f32, usize, String, i32)>,
    pub plan: Vec<String>,
    pub workflow_steps: Vec<WorkflowCardItem>,
    pub assistant_reply: String,
    pub subagents: Vec<SubagentItem>,
}

pub struct OxideApp {
    state: Arc<AppState>,
    tokio_handle: tokio::runtime::Handle,

    // Workspace & Files
    workspace_path: String,
    files: Vec<WorkspaceFileEntry>,
    selected_file_path: Option<String>,
    selected_file_content: Option<String>,

    // Hardware Specs & Async Channel
    hardware: Option<HardwareSpecs>,
    last_hw_refresh: Instant,
    hw_rx: Option<tokio::sync::oneshot::Receiver<HardwareSpecs>>,

    // Native Engine & Routing
    native_engine_running: bool,
    active_model_name: String,
    last_health_check: Instant,
    health_rx: Option<tokio::sync::oneshot::Receiver<bool>>,

    // Folder Picker Channel
    browse_rx: Option<tokio::sync::oneshot::Receiver<OxideResult<Option<String>>>>,

    // Auto-Updater Channel
    update_status: Option<UpdateStatus>,
    is_checking_update: bool,
    update_rx: Option<tokio::sync::oneshot::Receiver<OxideResult<UpdateStatus>>>,
    install_update_rx: Option<tokio::sync::oneshot::Receiver<OxideResult<UpdateInstallResult>>>,

    // Agent Execution
    user_input: String,
    is_running: bool,
    current_running_prompt: String,
    current_thought: String,
    thinking_metrics: Option<(f32, f32, usize, String, i32)>, // (elapsed_s, tok_s, count, phase, gpu_layers)
    streaming_token_buffer: String,
    plan_items: Vec<String>,
    workflow_cards: Vec<WorkflowCardItem>,
    subagents: Vec<SubagentItem>,
    conversation_history: Vec<ConversationTurn>,
    event_rx: Option<tokio::sync::mpsc::UnboundedReceiver<AgentStreamEvent>>,

    // Terminal & Logs
    terminal_logs: Vec<String>,
    git_status: Option<GitStatusSummary>,

    // Status Banner
    status_banner: Option<(String, bool)>, // (message, is_error)
}

impl OxideApp {
    pub fn new(
        _cc: &eframe::CreationContext<'_>,
        state: Arc<AppState>,
        tokio_handle: tokio::runtime::Handle,
    ) -> Self {
        let initial_ws = {
            let sb_guard = state.sandbox.blocking_read();
            sb_guard
                .as_ref()
                .map(|sb| sb.canonical_root().display().to_string())
                .unwrap_or_else(|| {
                    crate::commands::workspace::default_projects_workspace_dir()
                        .display()
                        .to_string()
                })
        };

        let initial_model = {
            let cfg = state.provider_config.blocking_read();
            cfg.task_routing.architect_model.clone()
        };

        let mut app = Self {
            state,
            tokio_handle,
            workspace_path: initial_ws.clone(),
            files: Vec::new(),
            selected_file_path: None,
            selected_file_content: None,
            hardware: None,
            last_hw_refresh: Instant::now() - Duration::from_secs(60),
            hw_rx: None,
            native_engine_running: false,
            active_model_name: initial_model,
            last_health_check: Instant::now() - Duration::from_secs(60),
            health_rx: None,
            browse_rx: None,
            update_status: None,
            is_checking_update: false,
            update_rx: None,
            install_update_rx: None,
            user_input: String::new(),
            is_running: false,
            current_running_prompt: String::new(),
            current_thought: String::new(),
            thinking_metrics: None,
            streaming_token_buffer: String::new(),
            plan_items: Vec::new(),
            workflow_cards: Vec::new(),
            subagents: Vec::new(),
            conversation_history: Vec::new(),
            event_rx: None,
            terminal_logs: Vec::new(),
            git_status: None,
            status_banner: None,
        };

        app.refresh_workspace_files();
        app.trigger_hardware_refresh();
        app.trigger_engine_health_check();
        app.trigger_check_update();
        app
    }

    fn refresh_workspace_files(&mut self) {
        let dir = PathBuf::from(&self.workspace_path);
        if !dir.exists() {
            return;
        }

        let mut entries = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') || name == "node_modules" || name == "target" || name == "dist" {
                    continue;
                }
                let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
                let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
                entries.push(WorkspaceFileEntry {
                    name: name.clone(),
                    relative_path: name,
                    is_dir,
                    size_bytes,
                });
            }
        }
        entries.sort_by(|a, b| {
            if a.is_dir != b.is_dir {
                b.is_dir.cmp(&a.is_dir)
            } else {
                a.name.to_lowercase().cmp(&b.name.to_lowercase())
            }
        });
        self.files = entries;
    }

    fn trigger_hardware_refresh(&mut self) {
        if self.hw_rx.is_some() {
            return;
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.hw_rx = Some(rx);
        self.last_hw_refresh = Instant::now();
        self.tokio_handle.spawn(async move {
            let specs = HardwareSpecs::inspect().await;
            let _ = tx.send(specs);
        });
    }

    fn trigger_engine_health_check(&mut self) {
        if self.health_rx.is_some() {
            return;
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.health_rx = Some(rx);
        self.last_health_check = Instant::now();
        self.tokio_handle.spawn(async move {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_millis(800))
                .build()
                .unwrap();
            let is_up = client
                .get("http://127.0.0.1:11435/health")
                .send()
                .await
                .map(|r| r.status().is_success())
                .unwrap_or(false);
            let _ = tx.send(is_up);
        });
    }

    fn trigger_check_update(&mut self) {
        if self.is_checking_update || self.update_rx.is_some() {
            return;
        }
        self.is_checking_update = true;
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.update_rx = Some(rx);
        self.tokio_handle.spawn(async move {
            let res = check_for_github_updates().await;
            let _ = tx.send(res);
        });
    }

    fn trigger_install_update(&mut self) {
        if self.install_update_rx.is_some() {
            return;
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.install_update_rx = Some(rx);
        self.status_banner = Some(("Downloading and launching latest Oxide update...".to_string(), false));
        self.tokio_handle.spawn(async move {
            let res = install_github_update_standalone().await;
            let _ = tx.send(res);
        });
    }

    fn toggle_native_engine(&mut self) {
        if self.native_engine_running {
            crate::commands::agent::stop_native_engine_sync();
            self.native_engine_running = false;
            self.status_banner = Some(("Oxide Native Engine stopped.".to_string(), false));
        } else {
            let state = self.state.clone();
            self.status_banner = Some(("Starting Oxide Native Engine (Port 11435)...".to_string(), false));
            self.tokio_handle.spawn(async move {
                let config = state.provider_config.read().await.clone();
                let _ = crate::commands::agent::ensure_native_engine_running(&config).await;
            });
            self.trigger_engine_health_check();
        }
    }

    fn trigger_run_agent(&mut self) {
        let prompt = self.user_input.trim().to_string();
        if prompt.is_empty() || self.is_running {
            return;
        }

        self.is_running = true;
        self.current_running_prompt = prompt.clone();
        self.user_input.clear();
        self.current_thought.clear();
        self.streaming_token_buffer.clear();
        self.thinking_metrics = None;
        self.plan_items.clear();
        self.workflow_cards.clear();
        self.subagents.clear();
        self.status_banner = None;

        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<AgentStreamEvent>();
        self.event_rx = Some(rx);

        let state = self.state.clone();
        state.cancel_flag.store(false, Ordering::Relaxed);
        let cancel_flag = state.cancel_flag.clone();

        self.tokio_handle.spawn(async move {
            let config = state.provider_config.read().await.clone();
            if config.active_provider == ProviderKind::OxideNative {
                let _ = crate::commands::agent::ensure_native_engine_running(&config).await;
            }

            let sandbox = match state.sandbox.read().await.clone() {
                Some(sb) => sb,
                None => {
                    let _ = tx.send(AgentStreamEvent::TaskError {
                        message: "No active workspace configured. Please select a project directory.".to_string(),
                    });
                    return;
                }
            };

            let mcp_registry = state.mcp_registry.clone();
            let orchestrator = AgentOrchestrator::new(sandbox, config, mcp_registry);
            let _ = orchestrator.run_autonomous_loop(tx, prompt, cancel_flag).await;
        });
    }

    fn trigger_cancel_agent(&mut self) {
        self.state.cancel_flag.store(true, Ordering::Relaxed);
        self.status_banner = Some(("Cancelling prompt execution...".to_string(), false));
    }
}

impl eframe::App for OxideApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // Poll async hardware receiver
        if let Some(ref mut rx) = self.hw_rx {
            if let Ok(specs) = rx.try_recv() {
                self.hardware = Some(specs);
                self.hw_rx = None;
            }
        }

        // Poll async engine health receiver
        if let Some(ref mut rx) = self.health_rx {
            if let Ok(is_up) = rx.try_recv() {
                self.native_engine_running = is_up;
                self.health_rx = None;
            }
        }

        // Poll async folder picker receiver
        if let Some(ref mut rx) = self.browse_rx {
            if let Ok(res) = rx.try_recv() {
                if let Ok(Some(chosen)) = res {
                    self.workspace_path = chosen.clone();
                    let state = self.state.clone();
                    let chosen_path = PathBuf::from(&chosen);
                    self.tokio_handle.spawn(async move {
                        let sb = crate::security::WorkspaceSandbox::new(
                            chosen_path,
                            crate::security::CommandPolicy::default(),
                        ).ok();
                        *state.sandbox.write().await = sb;
                    });
                    self.refresh_workspace_files();
                }
                self.browse_rx = None;
            }
        }

        // Poll async update checker receiver
        if let Some(ref mut rx) = self.update_rx {
            if let Ok(res) = rx.try_recv() {
                self.is_checking_update = false;
                if let Ok(status) = res {
                    self.update_status = Some(status);
                }
                self.update_rx = None;
            }
        }

        // Poll async update installer receiver
        if let Some(ref mut rx) = self.install_update_rx {
            if let Ok(res) = rx.try_recv() {
                match res {
                    Ok(r) => {
                        self.status_banner = Some((format!("Update installed: {}", r.message), false));
                    }
                    Err(e) => {
                        self.status_banner = Some((format!("Update failed: {}", e), true));
                    }
                }
                self.install_update_rx = None;
            }
        }

        // Poll incoming agent stream events
        let mut events = Vec::new();
        if let Some(ref mut rx) = self.event_rx {
            while let Ok(ev) = rx.try_recv() {
                events.push(ev);
            }
        }

        for ev in events {
            match ev {
                AgentStreamEvent::TokenDelta { token, .. } => {
                    self.streaming_token_buffer.push_str(&token);
                }
                AgentStreamEvent::ThinkingUpdate { thought, .. } => {
                    self.current_thought = thought;
                }
                AgentStreamEvent::ThinkingMetrics {
                    tokens_generated,
                    tokens_per_second,
                    elapsed_seconds,
                    phase,
                    gpu_layers,
                    ..
                } => {
                    self.thinking_metrics = Some((
                        elapsed_seconds,
                        tokens_per_second,
                        tokens_generated,
                        phase,
                        gpu_layers,
                    ));
                }
                AgentStreamEvent::PlanUpdate { items, .. } => {
                    self.plan_items = items;
                }
                AgentStreamEvent::SubagentStatus {
                    id,
                    role,
                    model,
                    title,
                    state,
                    thought,
                    output_preview,
                    active_workers,
                    max_allowed_workers,
                } => {
                    if let Some(item) = self.subagents.iter_mut().find(|s| s.id == id) {
                        item.state = state;
                        item.thought = thought;
                        item.output_preview = output_preview;
                        item.active_workers = active_workers;
                        item.max_allowed_workers = max_allowed_workers;
                    } else {
                        self.subagents.push(SubagentItem {
                            id,
                            role,
                            model,
                            title,
                            state,
                            thought,
                            output_preview,
                            active_workers,
                            max_allowed_workers,
                        });
                    }
                }
                AgentStreamEvent::WorkflowCard {
                    step,
                    title,
                    detail,
                    status,
                } => {
                    if let Some(card) = self
                        .workflow_cards
                        .iter_mut()
                        .find(|c| c.step == step && c.title == title)
                    {
                        card.status = status;
                        card.detail = detail;
                    } else {
                        self.workflow_cards.push(WorkflowCardItem {
                            step,
                            title,
                            detail,
                            status,
                        });
                    }
                }
                AgentStreamEvent::TerminalOutput { result, .. } => {
                    let cmd_str = format!("{} {}", result.program, result.args.join(" "));
                    let log = format!(
                        "$ {}\n[exit {}]\n{}\n{}",
                        cmd_str, result.exit_code, result.stdout, result.stderr
                    );
                    self.terminal_logs.push(log);
                }
                AgentStreamEvent::TaskCompleted { summary, .. } => {
                    self.is_running = false;
                    self.conversation_history.push(ConversationTurn {
                        user_prompt: self.current_running_prompt.clone(),
                        thought: self.current_thought.clone(),
                        thinking_metrics: self.thinking_metrics.take(),
                        plan: std::mem::take(&mut self.plan_items),
                        workflow_steps: std::mem::take(&mut self.workflow_cards),
                        assistant_reply: summary,
                        subagents: self.subagents.clone(),
                    });
                    self.current_thought.clear();
                    self.streaming_token_buffer.clear();
                    self.status_banner = Some(("Task completed successfully.".to_string(), false));
                }
                AgentStreamEvent::TaskError { message } => {
                    self.is_running = false;
                    self.status_banner = Some((message, true));
                }
                _ => {}
            }
        }

        // Periodic background refreshes
        if self.last_hw_refresh.elapsed() > Duration::from_secs(6) {
            self.trigger_hardware_refresh();
        }
        if self.last_health_check.elapsed() > Duration::from_secs(3) {
            self.trigger_engine_health_check();
        }

        if self.is_running || self.hw_rx.is_some() || self.health_rx.is_some() {
            ctx.request_repaint();
        }

        // Apply dark styling
        let mut visuals = egui::Visuals::dark();
        visuals.override_text_color = Some(egui::Color32::from_rgb(220, 224, 230));
        visuals.panel_fill = egui::Color32::from_rgb(18, 20, 26);
        ctx.set_visuals(visuals);

        // TOP BAR: Title, Workspace, Engine Status & Cancel Button
        egui::TopBottomPanel::top("top_header").show(ctx, |ui| {
            ui.add_space(6.0);
            ui.horizontal(|ui| {
                ui.heading(
                    egui::RichText::new("OXIDE AGENT IDE")
                        .color(egui::Color32::from_rgb(79, 172, 254))
                        .strong(),
                );

                #[cfg(debug_assertions)]
                let channel_badge = "[DEBUG: Local Build]";
                #[cfg(not(debug_assertions))]
                let channel_badge = "[RELEASE: GitHub]";

                ui.label(
                    egui::RichText::new(channel_badge)
                        .color(egui::Color32::from_rgb(120, 160, 200))
                        .small(),
                );

                ui.separator();

                // Workspace path & browse button
                ui.label(egui::RichText::new("Workspace:").strong());
                let short_ws = if self.workspace_path.len() > 38 {
                    format!("...{}", &self.workspace_path[self.workspace_path.len() - 35..])
                } else {
                    self.workspace_path.clone()
                };
                ui.monospace(short_ws);

                if ui.button("Browse...").clicked() {
                    let (tx, rx) = tokio::sync::oneshot::channel();
                    self.browse_rx = Some(rx);
                    self.tokio_handle.spawn(async move {
                        let res = crate::commands::workspace::pick_folder_dialog().await;
                        let _ = tx.send(res);
                    });
                }

                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    // Cancel button
                    if self.is_running {
                        let cancel_btn = egui::Button::new(
                            egui::RichText::new(" CANCEL AGENT ")
                                .color(egui::Color32::WHITE)
                                .strong(),
                        )
                        .fill(egui::Color32::from_rgb(220, 53, 69));
                        if ui.add(cancel_btn).clicked() {
                            self.trigger_cancel_agent();
                        }
                    }

                    // Engine toggle button
                    let (btn_txt, btn_color) = if self.native_engine_running {
                        ("Stop Engine", egui::Color32::from_rgb(180, 60, 60))
                    } else {
                        ("Start Engine", egui::Color32::from_rgb(40, 140, 60))
                    };
                    if ui.add(egui::Button::new(btn_txt).fill(btn_color)).clicked() {
                        self.toggle_native_engine();
                    }

                    // Engine status indicator
                    if self.native_engine_running {
                        ui.colored_label(
                            egui::Color32::from_rgb(40, 167, 69),
                            "● Engine: ONLINE (11435)",
                        );
                    } else {
                        ui.colored_label(
                            egui::Color32::from_rgb(255, 193, 7),
                            "○ Engine: STANDBY",
                        );
                    }

                    ui.label(
                        egui::RichText::new(format!("Model: {}", self.active_model_name))
                            .small()
                            .color(egui::Color32::from_rgb(170, 190, 210)),
                    );

                    if ui.button("Refresh Files").clicked() {
                        self.refresh_workspace_files();
                    }
                });
            });
            ui.add_space(4.0);
        });

        // HARDWARE & MEMORY TELEMETRY BAR
        egui::TopBottomPanel::top("hardware_telemetry_bar").show(ctx, |ui| {
            ui.add_space(2.0);
            ui.horizontal(|ui| {
                if let Some(ref hw) = self.hardware {
                    let total_ram = hw.total_ram_gb;
                    let used_ram = total_ram - hw.available_ram_gb;
                    let vram_gb = hw.gpu_vram_gb;
                    let total_combined = total_ram + vram_gb;
                    let used_combined = used_ram + (vram_gb * 0.7);

                    ui.label(
                        egui::RichText::new(format!(
                            "RAM: {:.1}/{:.1} GB ({:.0}%)",
                            used_ram, total_ram, hw.used_ram_percent
                        ))
                        .color(egui::Color32::from_rgb(180, 210, 240)),
                    );

                    ui.separator();

                    ui.label(
                        egui::RichText::new(format!(
                            "GPU: {} ({:.1} GB VRAM)",
                            hw.gpu_name, hw.gpu_vram_gb
                        ))
                        .color(egui::Color32::from_rgb(140, 220, 180)),
                    );

                    ui.separator();

                    ui.label(
                        egui::RichText::new(format!(
                            "Combined Memory (RAM+VRAM): {:.1}/{:.1} GB",
                            used_combined, total_combined
                        ))
                        .color(egui::Color32::from_rgb(240, 200, 120)),
                    );

                    ui.separator();

                    ui.label(
                        egui::RichText::new(format!(
                            "Governor: {} (Max Concurrency: {})",
                            hw.governor_tier, hw.hard_limit_subagents
                        ))
                        .small(),
                    );
                } else {
                    ui.label("Inspecting system hardware telemetry...");
                }

                // GitHub Auto-Updater pill
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if let Some(ref upd) = self.update_status {
                        if upd.update_available {
                            let btn = egui::Button::new(
                                egui::RichText::new(format!(" Update to {} ", upd.latest_version))
                                    .color(egui::Color32::WHITE)
                                    .strong(),
                            )
                            .fill(egui::Color32::from_rgb(40, 167, 69));
                            if ui.add(btn).clicked() {
                                self.trigger_install_update();
                            }
                        } else {
                            ui.label(
                                egui::RichText::new(format!("Latest: {}", upd.current_version))
                                    .small()
                                    .color(egui::Color32::GRAY),
                            );
                        }
                    } else if self.is_checking_update {
                        ui.label(egui::RichText::new("Checking updates...").small());
                    } else if ui.small_button("Check Updates").clicked() {
                        self.trigger_check_update();
                    }
                });
            });
            ui.add_space(2.0);
        });

        // BOTTOM BAR: Status & Prompt Input
        egui::TopBottomPanel::bottom("bottom_input_dock").show(ctx, |ui| {
            ui.add_space(4.0);

            // Status or Error Banner
            if let Some((ref msg, is_err)) = self.status_banner {
                let color = if is_err {
                    egui::Color32::from_rgb(255, 100, 100)
                } else {
                    egui::Color32::from_rgb(100, 220, 150)
                };
                ui.colored_label(color, msg);
            }

            // Quick slash commands row
            ui.horizontal(|ui| {
                ui.label(egui::RichText::new("Quick Commands:").small().color(egui::Color32::GRAY));
                if ui.small_button("/plan <task>").clicked() {
                    self.user_input = "/plan ".to_string();
                }
                if ui.small_button("/fix <error>").clicked() {
                    self.user_input = "/fix ".to_string();
                }
                if ui.small_button("/btw <question>").clicked() {
                    self.user_input = "/btw ".to_string();
                }
            });

            // Prompt text edit and Run button
            ui.horizontal(|ui| {
                let input_field = egui::TextEdit::multiline(&mut self.user_input)
                    .desired_rows(2)
                    .desired_width(ui.available_width() - 140.0)
                    .hint_text("Ask Lead Architect to inspect, code, test, or delegate subagents (Enter prompt or /plan, /fix)...");
                ui.add(input_field);

                if self.is_running {
                    let cancel_btn = egui::Button::new(
                        egui::RichText::new("CANCEL")
                            .color(egui::Color32::WHITE)
                            .strong(),
                    )
                    .min_size(egui::vec2(120.0, 42.0))
                    .fill(egui::Color32::from_rgb(220, 53, 69));
                    if ui.add(cancel_btn).clicked() {
                        self.trigger_cancel_agent();
                    }
                } else {
                    let run_btn = egui::Button::new(
                        egui::RichText::new("RUN AGENT")
                            .color(egui::Color32::WHITE)
                            .strong(),
                    )
                    .min_size(egui::vec2(120.0, 42.0))
                    .fill(egui::Color32::from_rgb(0, 122, 255));
                    if ui.add(run_btn).clicked() {
                        self.trigger_run_agent();
                    }
                }
            });
            ui.add_space(4.0);
        });

        // LEFT PANEL: Workspace Files Explorer
        egui::SidePanel::left("left_file_panel")
            .resizable(true)
            .default_width(220.0)
            .width_range(160.0..=360.0)
            .show(ctx, |ui| {
                ui.add_space(4.0);
                ui.horizontal(|ui| {
                    ui.label(egui::RichText::new("WORKSPACE FILES").strong().small());
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui.small_button("Reload").clicked() {
                            self.refresh_workspace_files();
                        }
                    });
                });
                ui.separator();

                egui::ScrollArea::vertical().show(ui, |ui| {
                    for f in &self.files {
                        let icon = if f.is_dir { "[DIR] " } else { "      " };
                        let label = format!("{}{}", icon, f.name);
                        if ui.selectable_label(self.selected_file_path.as_deref() == Some(&f.relative_path), label).clicked() {
                            self.selected_file_path = Some(f.relative_path.clone());
                            let full = Path::new(&self.workspace_path).join(&f.relative_path);
                            if full.is_file() {
                                self.selected_file_content = std::fs::read_to_string(&full).ok();
                            } else {
                                self.selected_file_content = None;
                            }
                        }
                    }

                    if let Some(ref git) = self.git_status {
                        ui.add_space(8.0);
                        ui.separator();
                        ui.label(egui::RichText::new("GIT STATUS").strong().small());
                        ui.label(format!("Branch: {}", git.branch));
                        ui.label(format!("Changed: {} files", git.changed_files.len()));
                    }
                });
            });

        // RIGHT PANEL: Subagents & Concurrency Monitor
        egui::SidePanel::right("right_subagent_panel")
            .resizable(true)
            .default_width(260.0)
            .width_range(200.0..=420.0)
            .show(ctx, |ui| {
                ui.add_space(4.0);
                ui.label(egui::RichText::new("SUBAGENTS MONITOR").strong().small());
                ui.separator();

                if self.subagents.is_empty() {
                    ui.label(
                        egui::RichText::new("No active subagents.\nLead Architect will delegate subtasks as needed.")
                            .small()
                            .color(egui::Color32::GRAY),
                    );
                } else {
                    egui::ScrollArea::vertical().show(ui, |ui| {
                        for sub in &self.subagents {
                            let (badge_color, state_txt) = match sub.state {
                                SubagentRunState::Running => (egui::Color32::from_rgb(0, 122, 255), "RUNNING"),
                                SubagentRunState::Completed => (egui::Color32::from_rgb(40, 167, 69), "COMPLETED"),
                                SubagentRunState::Failed => (egui::Color32::from_rgb(220, 53, 69), "FAILED"),
                                _ => (egui::Color32::GRAY, "IDLE"),
                            };

                            egui::Frame::none()
                                .fill(egui::Color32::from_rgb(26, 30, 38))
                                .inner_margin(6.0)
                                .rounding(4.0)
                                .show(ui, |ui| {
                                    ui.horizontal(|ui| {
                                        ui.colored_label(badge_color, format!("[{}]", state_txt));
                                        ui.label(egui::RichText::new(&sub.title).strong().small());
                                    });
                                    ui.label(
                                        egui::RichText::new(format!(
                                            "Role: {:?} | Workers: {}/{}",
                                            sub.role, sub.active_workers, sub.max_allowed_workers
                                        ))
                                        .small()
                                        .color(egui::Color32::from_rgb(140, 160, 190)),
                                    );

                                    if !sub.thought.is_empty() {
                                        ui.label(
                                            egui::RichText::new(&sub.thought)
                                                .small()
                                                .color(egui::Color32::from_rgb(200, 200, 200)),
                                        );
                                    }
                                });
                            ui.add_space(4.0);
                        }
                    });
                }
            });

        // CENTRAL MAIN PANEL: Conversation, Live Thinking & Dashboard
        egui::CentralPanel::default().show(ctx, |ui| {
            egui::ScrollArea::vertical()
                .auto_shrink([false; 2])
                .stick_to_bottom(true)
                .show(ui, |ui| {
                    // If no active run and no history, show the Command Center Dashboard!
                    if self.conversation_history.is_empty() && !self.is_running {
                        ui.add_space(12.0);
                        ui.heading(
                            egui::RichText::new("OXIDE LEAD ARCHITECT COMMAND CENTER")
                                .strong()
                                .color(egui::Color32::from_rgb(100, 180, 255)),
                        );
                        ui.label(
                            egui::RichText::new("Autonomous Local AI Engineering Studio | Multi-Agent Orchestrator | Zero Web Overhead")
                                .small()
                                .color(egui::Color32::from_rgb(150, 170, 190)),
                        );
                        ui.add_space(12.0);

                        // Quick 1-Click Action Cards Grid
                        ui.label(egui::RichText::new("QUICK ACTIONS:").strong().small());
                        ui.add_space(4.0);

                        ui.horizontal_wrapped(|ui| {
                            let btn1 = egui::Button::new(
                                egui::RichText::new(" Inspect & Map Workspace ")
                                    .strong()
                                    .color(egui::Color32::WHITE),
                            )
                            .fill(egui::Color32::from_rgb(32, 45, 65))
                            .min_size(egui::vec2(220.0, 48.0));
                            if ui.add(btn1).clicked() {
                                self.user_input = "Inspect workspace structure, analyze dependencies, and summarize architecture.".to_string();
                                self.trigger_run_agent();
                            }

                            let btn2 = egui::Button::new(
                                egui::RichText::new(" Autonomous C++ / Rust Build ")
                                    .strong()
                                    .color(egui::Color32::WHITE),
                            )
                            .fill(egui::Color32::from_rgb(32, 60, 50))
                            .min_size(egui::vec2(220.0, 48.0));
                            if ui.add(btn2).clicked() {
                                self.user_input = "Inspect available compilers (clang, gcc, cl, rustc, cmake), build the project, run tests, and report any errors.".to_string();
                                self.trigger_run_agent();
                            }

                            let btn3 = egui::Button::new(
                                egui::RichText::new(" Plan Architecture (/plan) ")
                                    .strong()
                                    .color(egui::Color32::WHITE),
                            )
                            .fill(egui::Color32::from_rgb(60, 45, 30))
                            .min_size(egui::vec2(220.0, 48.0));
                            if ui.add(btn3).clicked() {
                                self.user_input = "/plan ".to_string();
                            }

                            let btn4 = egui::Button::new(
                                egui::RichText::new(" Debug & Fix Errors (/fix) ")
                                    .strong()
                                    .color(egui::Color32::WHITE),
                            )
                            .fill(egui::Color32::from_rgb(65, 30, 40))
                            .min_size(egui::vec2(220.0, 48.0));
                            if ui.add(btn4).clicked() {
                                self.user_input = "/fix ".to_string();
                            }
                        });

                        ui.add_space(16.0);
                        ui.separator();
                        ui.add_space(8.0);

                        // System Capabilities & Architecture Overview
                        ui.label(egui::RichText::new("SYSTEM SPECIFICATIONS & HARDWARE ACCELERATION").strong().small());
                        ui.add_space(4.0);

                        egui::Frame::none()
                            .fill(egui::Color32::from_rgb(22, 26, 34))
                            .inner_margin(10.0)
                            .rounding(6.0)
                            .show(ui, |ui| {
                                if let Some(ref hw) = self.hardware {
                                    ui.label(format!("Processor: {} ({} Cores, {:.0}% load)", hw.cpu_brand, hw.cpu_cores, hw.cpu_usage_percent));
                                    ui.label(format!("Direct GPU Acceleration: {} ({:.1} GB Dedicated VRAM)", hw.gpu_name, hw.gpu_vram_gb));
                                    ui.label(format!("Supported Backends: NVIDIA CUDA, Intel Arc / OneAPI, AMD Radeon (ROCm/Vulkan), CPU AVX2"));
                                    ui.label(format!("Hybrid Split Concurrency: {} (Max Recommended: {} Subagents)", hw.governor_tier, hw.recommended_max_subagents));
                                } else {
                                    ui.label("Gathering system specs...");
                                }
                            });
                    }

                    // Previous conversation turns
                    for turn in &self.conversation_history {
                        egui::Frame::none()
                            .fill(egui::Color32::from_rgb(22, 26, 34))
                            .inner_margin(8.0)
                            .rounding(6.0)
                            .show(ui, |ui| {
                                ui.label(
                                    egui::RichText::new(format!("User: {}", turn.user_prompt))
                                        .strong()
                                        .color(egui::Color32::from_rgb(100, 180, 255)),
                                );

                                if let Some((el, tok_s, count, ref ph, _)) = turn.thinking_metrics {
                                    ui.label(
                                        egui::RichText::new(format!(
                                            "Thinking: {:.1}s | {:.1} tok/s | {} tokens | Phase: {}",
                                            el, tok_s, count, ph
                                        ))
                                        .small()
                                        .color(egui::Color32::from_rgb(130, 150, 180)),
                                    );
                                }

                                if !turn.thought.is_empty() {
                                    egui::CollapsingHeader::new("Thought Process")
                                        .default_open(false)
                                        .show(ui, |ui| {
                                            ui.label(
                                                egui::RichText::new(&turn.thought)
                                                    .small()
                                                    .color(egui::Color32::from_rgb(180, 180, 180)),
                                            );
                                        });
                                }

                                if !turn.plan.is_empty() {
                                    ui.label(egui::RichText::new("Plan Blueprint:").strong().small());
                                    for item in &turn.plan {
                                        ui.label(format!(" - {}", item));
                                    }
                                }

                                ui.separator();
                                ui.label(egui::RichText::new(&turn.assistant_reply));
                            });
                        ui.add_space(8.0);
                    }

                    // Active execution card
                    if self.is_running {
                        egui::Frame::none()
                            .fill(egui::Color32::from_rgb(24, 32, 44))
                            .inner_margin(10.0)
                            .rounding(6.0)
                            .show(ui, |ui| {
                                ui.label(
                                    egui::RichText::new(format!("User: {}", self.current_running_prompt))
                                        .strong()
                                        .color(egui::Color32::from_rgb(100, 180, 255)),
                                );

                                // Live thinking metrics banner
                                if let Some((el, tok_s, count, ref ph, _)) = self.thinking_metrics {
                                    ui.label(
                                        egui::RichText::new(format!(
                                            "Reasoning Stream: {:.1}s | {:.1} tok/s | {} tokens | Phase: {}",
                                            el, tok_s, count, ph
                                        ))
                                        .small()
                                        .color(egui::Color32::from_rgb(255, 193, 7)),
                                    );
                                } else {
                                    ui.label(
                                        egui::RichText::new("Lead Architect reasoning next action...")
                                            .small()
                                            .color(egui::Color32::from_rgb(255, 193, 7)),
                                    );
                                }

                                if !self.current_thought.is_empty() {
                                    ui.add_space(4.0);
                                    egui::Frame::none()
                                        .fill(egui::Color32::from_rgb(16, 20, 28))
                                        .inner_margin(6.0)
                                        .rounding(4.0)
                                        .show(ui, |ui| {
                                            ui.label(
                                                egui::RichText::new(&self.current_thought)
                                                    .small()
                                                    .color(egui::Color32::from_rgb(210, 210, 210)),
                                            );
                                        });
                                }

                                // Plan items
                                if !self.plan_items.is_empty() {
                                    ui.add_space(4.0);
                                    ui.label(egui::RichText::new("Active Plan:").strong().small());
                                    for p in &self.plan_items {
                                        ui.label(format!(" [ ] {}", p));
                                    }
                                }

                                // Workflow steps
                                if !self.workflow_cards.is_empty() {
                                    ui.add_space(4.0);
                                    for step in &self.workflow_cards {
                                        let status_tag = match step.status {
                                            WorkflowStepStatus::Running => "[RUNNING]",
                                            WorkflowStepStatus::Succeeded => "[DONE]",
                                            WorkflowStepStatus::Failed => "[FAILED]",
                                            _ => "[PENDING]",
                                        };
                                        ui.label(format!("Step {}: {} {}", step.step, status_tag, step.title));
                                    }
                                }

                                // Streaming text preview
                                if !self.streaming_token_buffer.is_empty() {
                                    ui.add_space(4.0);
                                    ui.label(
                                        egui::RichText::new(&self.streaming_token_buffer)
                                            .color(egui::Color32::from_rgb(230, 230, 230)),
                                    );
                                }
                            });
                    }

                    // If file is selected, show file preview
                    if let Some(ref content) = self.selected_file_content {
                        ui.add_space(10.0);
                        egui::CollapsingHeader::new(format!(
                            "File Preview: {}",
                            self.selected_file_path.as_deref().unwrap_or("")
                        ))
                        .default_open(true)
                        .show(ui, |ui| {
                            egui::ScrollArea::horizontal().show(ui, |ui| {
                                ui.monospace(content);
                            });
                        });
                    }
                });
        });
    }

    fn on_exit(&mut self, _gl: Option<&eframe::glow::Context>) {
        // Auto-stop native engine when closing the application
        crate::commands::agent::stop_native_engine_sync();
    }
}
