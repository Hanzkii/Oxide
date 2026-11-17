pub mod command_center;
pub mod model_hub;
pub mod settings_view;
pub mod sidebars;
pub mod state;
pub mod terminal_view;
pub mod theme;

use crate::commands::workspace::WorkspaceFileEntry;
use crate::error::OxideResult;
use crate::gui::command_center::CommandCenterView;
use crate::gui::model_hub::ModelHubView;
use crate::gui::settings_view::SettingsViewState;
use crate::gui::sidebars::SidebarsView;
use crate::gui::state::*;
use crate::gui::terminal_view::TerminalViewState;
use crate::gui::theme::*;
use crate::hardware::HardwareSpecs;
use crate::llm::ProviderKind;
use crate::orchestrator::git::GitStatusSummary;
use crate::orchestrator::{AgentOrchestrator, AgentStreamEvent};
use crate::updater::{
    check_for_github_updates, install_github_update_standalone, UpdateInstallResult, UpdateStatus,
};
use crate::AppState;
use eframe::egui;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub struct OxideApp {
    state: Arc<AppState>,
    tokio_handle: tokio::runtime::Handle,

    // Navigation & Modal Views
    current_view: MainView,
    show_settings_modal: bool,
    sidebar_state: SidebarState,

    // Child Feature States
    settings_view_state: SettingsViewState,
    model_hub_view: ModelHubView,
    terminal_view_state: TerminalViewState,
    sessions_file: StudioSessionsFile,
    active_conv_id: Option<String>,

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

    // Agent Stream Execution
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
        cc: &eframe::CreationContext<'_>,
        state: Arc<AppState>,
        tokio_handle: tokio::runtime::Handle,
    ) -> Self {
        // Apply modern dark theme visuals to egui context
        theme::configure_visuals(&cc.egui_ctx);

        let initial_ws = {
            let guard = state.sandbox.blocking_read();
            guard
                .as_ref()
                .map(|sb| sb.canonical_root().to_string_lossy().to_string())
                .unwrap_or_else(|| {
                    std::env::current_dir()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|_| ".".to_string())
                })
        };

        let initial_config = { state.provider_config.blocking_read().clone() };
        let active_model = initial_config.task_routing.architect_model.clone();

        let mut sessions_file = StudioSessionsFile::load_from_disk();
        if sessions_file.projects.is_empty() && !initial_ws.is_empty() {
            let proj_name = Path::new(&initial_ws)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "Workspace".to_string());
            let proj_id = uuid::Uuid::new_v4().to_string();
            sessions_file.projects.push(ProjectWorkspace {
                id: proj_id.clone(),
                name: proj_name,
                path: initial_ws.clone(),
            });
            sessions_file.active_project_id = Some(proj_id);
            sessions_file.save_to_disk();
        }

        let mut app = Self {
            state: state.clone(),
            tokio_handle: tokio_handle.clone(),

            current_view: MainView::CommandCenter,
            show_settings_modal: false,
            sidebar_state: SidebarState::default(),

            settings_view_state: SettingsViewState::new(&initial_config),
            model_hub_view: ModelHubView::default(),
            terminal_view_state: TerminalViewState::default(),
            sessions_file,
            active_conv_id: None,

            workspace_path: initial_ws,
            files: Vec::new(),
            selected_file_path: None,
            selected_file_content: None,

            hardware: None,
            last_hw_refresh: Instant::now() - Duration::from_secs(10),
            hw_rx: None,

            native_engine_running: false,
            active_model_name: active_model,
            last_health_check: Instant::now() - Duration::from_secs(10),
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
        app
    }

    fn refresh_workspace_files(&mut self) {
        let dir = PathBuf::from(&self.workspace_path);
        if !dir.is_dir() {
            return;
        }

        let mut entries = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.')
                    || name == "node_modules"
                    || name == "target"
                    || name == "dist"
                {
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

        // Refresh Git status asynchronously
        let state = self.state.clone();
        self.tokio_handle.spawn(async move {
            let sandbox_opt = { state.sandbox.read().await.clone() };
            if let Some(sb) = sandbox_opt {
                let git_mgr = crate::orchestrator::git::GitManager::new(sb);
                let _ = git_mgr.status().await;
            }
        });
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

    fn toggle_native_engine(&mut self) {
        if self.native_engine_running {
            crate::commands::agent::stop_native_engine_sync();
            self.native_engine_running = false;
            self.status_banner = Some(("Native engine stopped.".to_string(), false));
        } else {
            let state = self.state.clone();
            self.tokio_handle.spawn(async move {
                let config = state.provider_config.read().await.clone();
                let _ = crate::commands::agent::ensure_native_engine_running(&config).await;
            });
            self.status_banner = Some(("Starting native engine on port 11435...".to_string(), false));
        }
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
        self.tokio_handle.spawn(async move {
            let res = install_github_update_standalone().await;
            let _ = tx.send(res);
        });
    }

    fn trigger_run_agent(&mut self) {
        if self.is_running {
            return;
        }

        let prompt = self.user_input.trim().to_string();
        if prompt.is_empty() {
            return;
        }

        self.user_input.clear();
        self.current_running_prompt = prompt.clone();
        self.current_thought.clear();
        self.thinking_metrics = None;
        self.streaming_token_buffer.clear();
        self.plan_items.clear();
        self.workflow_cards.clear();
        self.is_running = true;
        self.status_banner = None;

        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        self.event_rx = Some(rx);

        let state = self.state.clone();
        let cancel_flag = self.state.cancel_flag.clone();
        cancel_flag.store(false, Ordering::Relaxed);

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
        if let Some(mut rx) = self.hw_rx.take() {
            match rx.try_recv() {
                Ok(specs) => {
                    self.hardware = Some(specs);
                }
                Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {
                    self.hw_rx = Some(rx);
                }
                Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {}
            }
        }

        // Poll async engine health receiver
        if let Some(mut rx) = self.health_rx.take() {
            match rx.try_recv() {
                Ok(is_up) => {
                    self.native_engine_running = is_up;
                }
                Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {
                    self.health_rx = Some(rx);
                }
                Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {}
            }
        }

        // Poll async folder picker receiver
        if let Some(mut rx) = self.browse_rx.take() {
            match rx.try_recv() {
                Ok(res) => {
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

                        // Register project in sessions file
                        let proj_name = Path::new(&chosen)
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_else(|| "Project".to_string());
                        let proj_id = uuid::Uuid::new_v4().to_string();
                        self.sessions_file.projects.push(ProjectWorkspace {
                            id: proj_id.clone(),
                            name: proj_name,
                            path: chosen.clone(),
                        });
                        self.sessions_file.active_project_id = Some(proj_id);
                        self.sessions_file.save_to_disk();

                        self.refresh_workspace_files();
                    }
                }
                Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {
                    self.browse_rx = Some(rx);
                }
                Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {}
            }
        }

        // Poll async update checker receiver
        if let Some(mut rx) = self.update_rx.take() {
            match rx.try_recv() {
                Ok(res) => {
                    self.is_checking_update = false;
                    if let Ok(status) = res {
                        self.update_status = Some(status);
                    }
                }
                Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {
                    self.update_rx = Some(rx);
                }
                Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                    self.is_checking_update = false;
                }
            }
        }

        // Poll async install update receiver
        if let Some(mut rx) = self.install_update_rx.take() {
            match rx.try_recv() {
                Ok(res) => {
                    match res {
                        Ok(inst) => {
                            self.status_banner = Some((inst.message, false));
                        }
                        Err(e) => {
                            self.status_banner = Some((format!("Update install failed: {}", e), true));
                        }
                    }
                }
                Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {
                    self.install_update_rx = Some(rx);
                }
                Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {}
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
                    crate::gui::terminal_view::append_log_line(
                        &mut self.terminal_logs,
                        format!("$ {} [exit {}]", cmd_str, result.exit_code),
                    );
                    if !result.stdout.trim().is_empty() {
                        crate::gui::terminal_view::append_log_line(&mut self.terminal_logs, &result.stdout);
                    }
                    if !result.stderr.trim().is_empty() {
                        for line in result.stderr.lines() {
                            crate::gui::terminal_view::append_log_line(
                                &mut self.terminal_logs,
                                format!("[STDERR] {}", line),
                            );
                        }
                    }
                }
                AgentStreamEvent::TaskCompleted { summary, .. } => {
                    self.is_running = false;
                    let turn = ConversationTurn {
                        user_prompt: self.current_running_prompt.clone(),
                        thought: self.current_thought.clone(),
                        thinking_metrics: self.thinking_metrics.take(),
                        plan: std::mem::take(&mut self.plan_items),
                        workflow_steps: std::mem::take(&mut self.workflow_cards),
                        assistant_reply: summary,
                        subagents: self.subagents.clone(),
                    };
                    self.conversation_history.push(turn);
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

        // Keep repainting if tasks are active
        if self.is_running
            || self.hw_rx.is_some()
            || self.health_rx.is_some()
            || self.model_hub_view.active_download.is_some()
            || self.terminal_view_state.is_running_cmd
        {
            ctx.request_repaint();
        }

        // TOP NAVIGATION & APP HEADER
        egui::TopBottomPanel::top("top_header").show(ctx, |ui| {
            ui.add_space(4.0);
            ui.horizontal(|ui| {
                ui.heading(
                    egui::RichText::new("OXIDE STUDIO")
                        .color(ACCENT_BLUE)
                        .strong(),
                );

                ui.separator();

                // Navigation Tabs
                let cur = self.current_view;
                if ui.selectable_label(cur == MainView::CommandCenter, "Studio").clicked() {
                    self.current_view = MainView::CommandCenter;
                }
                if ui.selectable_label(cur == MainView::ModelHub, "Model Hub").clicked() {
                    self.current_view = MainView::ModelHub;
                }
                if ui.selectable_label(cur == MainView::Settings, "Settings").clicked() {
                    self.current_view = MainView::Settings;
                }
                if ui.selectable_label(cur == MainView::TerminalLogs, "Terminal / Logs").clicked() {
                    self.current_view = MainView::TerminalLogs;
                }

                ui.separator();

                // Settings Modal Toggle Button
                if ui.button("[Settings Modal]").on_hover_text("Open Settings overlay modal").clicked() {
                    self.show_settings_modal = true;
                }

                // Workspace path & Browse
                ui.separator();
                ui.label(egui::RichText::new("Workspace:").strong().small());
                let short_ws = if self.workspace_path.len() > 30 {
                    format!("...{}", &self.workspace_path[self.workspace_path.len() - 27..])
                } else {
                    self.workspace_path.clone()
                };
                ui.monospace(egui::RichText::new(short_ws).small());

                if ui.small_button("Browse").clicked() {
                    let (tx, rx) = tokio::sync::oneshot::channel();
                    self.browse_rx = Some(rx);
                    self.tokio_handle.spawn(async move {
                        let res = crate::commands::workspace::pick_folder_dialog().await;
                        let _ = tx.send(res);
                    });
                }

                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    // Engine Status Pill & Toggle
                    let (btn_txt, btn_color) = if self.native_engine_running {
                        ("Stop Engine", ACCENT_RED)
                    } else {
                        ("Start Engine", ACCENT_GREEN)
                    };
                    if ui.add(egui::Button::new(btn_txt).fill(btn_color)).clicked() {
                        self.toggle_native_engine();
                    }

                    ascii_status_pill(ui, self.native_engine_running, "ENGINE ONLINE", "ENGINE STANDBY");

                    // Auto-updater button / status
                    if let Some(ref upd) = self.update_status {
                        if upd.update_available {
                            let btn = egui::Button::new(format!("Update to {}", upd.latest_version)).fill(ACCENT_GREEN);
                            if ui.add(btn).clicked() {
                                self.trigger_install_update();
                            }
                        } else {
                            ui.label(egui::RichText::new(format!("v{}", upd.current_version)).small().color(TEXT_DIM));
                        }
                    } else if self.is_checking_update {
                        ui.add(egui::Spinner::new());
                    } else if ui.small_button("Check Updates").clicked() {
                        self.trigger_check_update();
                    }

                    if let Some(ref hw) = self.hardware {
                        let ram_str = format!("RAM: {:.1}/{:.1} GB", hw.total_ram_gb - hw.available_ram_gb, hw.total_ram_gb);
                        ascii_badge(ui, &ram_str, ACCENT_BLUE);
                    }

                    ui.label(
                        egui::RichText::new(format!("Model: {}", self.active_model_name))
                            .small()
                            .color(TEXT_MUTED),
                    );
                });
            });
            ui.add_space(4.0);
        });

        // SETTINGS MODAL OVERLAY (when toggled)
        if self.show_settings_modal {
            self.settings_view_state.render_modal(
                ctx,
                &mut self.show_settings_modal,
                self.state.clone(),
                &self.tokio_handle,
            );
        }

        // VIEW ROUTING
        match self.current_view {
            MainView::CommandCenter => {
                // Bottom input dock (fixed at bottom)
                egui::TopBottomPanel::bottom("bottom_dock").show(ctx, |ui| {
                    let mut on_run_clicked = false;
                    let mut on_cancel_clicked = false;

                    // Collapsible terminal drawer toggle
                    ui.horizontal(|ui| {
                        let drawer_label = if self.sidebar_state.terminal_drawer_open {
                            "[-] Terminal Drawer"
                        } else {
                            "[+] Terminal Drawer"
                        };
                        if ui.small_button(drawer_label).clicked() {
                            self.sidebar_state.terminal_drawer_open = !self.sidebar_state.terminal_drawer_open;
                        }
                    });

                    if self.sidebar_state.terminal_drawer_open {
                        ui.add_space(4.0);
                        ui.scope(|ui| {
                            ui.set_max_height(200.0);
                            self.terminal_view_state.render(
                                ui,
                                self.state.clone(),
                                &self.tokio_handle,
                                &mut self.terminal_logs,
                                &self.git_status,
                            );
                        });
                        ui.add_space(4.0);
                        ui.separator();
                    }

                    CommandCenterView::render_bottom_dock(
                        ui,
                        &mut self.user_input,
                        self.is_running,
                        &self.status_banner,
                        &mut on_run_clicked,
                        &mut on_cancel_clicked,
                    );

                    if on_run_clicked {
                        self.trigger_run_agent();
                    }
                    if on_cancel_clicked {
                        self.trigger_cancel_agent();
                    }
                });

                // Left collapsible sidebar
                if !self.sidebar_state.left_collapsed {
                    egui::SidePanel::left("left_sidebar")
                        .resizable(true)
                        .default_width(240.0)
                        .width_range(180.0..=380.0)
                        .show(ctx, |ui| {
                            let mut project_changed = false;
                            let mut open_folder_clicked = false;
                            let mut refresh_files_clicked = false;

                            SidebarsView::render_left_sidebar(
                                ui,
                                &mut self.sidebar_state,
                                &mut self.workspace_path,
                                &self.files,
                                &mut self.selected_file_path,
                                &mut self.selected_file_content,
                                &mut self.sessions_file,
                                &mut self.conversation_history,
                                &mut self.active_conv_id,
                                &mut project_changed,
                                &mut open_folder_clicked,
                                &mut refresh_files_clicked,
                            );

                            if project_changed {
                                let state = self.state.clone();
                                let chosen_path = PathBuf::from(&self.workspace_path);
                                self.tokio_handle.spawn(async move {
                                    let sb = crate::security::WorkspaceSandbox::new(
                                        chosen_path,
                                        crate::security::CommandPolicy::default(),
                                    ).ok();
                                    *state.sandbox.write().await = sb;
                                });
                                self.refresh_workspace_files();
                            }

                            if open_folder_clicked {
                                let (tx, rx) = tokio::sync::oneshot::channel();
                                self.browse_rx = Some(rx);
                                self.tokio_handle.spawn(async move {
                                    let res = crate::commands::workspace::pick_folder_dialog().await;
                                    let _ = tx.send(res);
                                });
                            }

                            if refresh_files_clicked {
                                self.refresh_workspace_files();
                            }
                        });
                } else {
                    egui::SidePanel::left("left_sidebar_collapsed")
                        .resizable(false)
                        .exact_width(28.0)
                        .show(ctx, |ui| {
                            ui.vertical_centered(|ui| {
                                ui.add_space(8.0);
                                if ui.small_button("[>>]").on_hover_text("Expand Left Sidebar").clicked() {
                                    self.sidebar_state.left_collapsed = false;
                                }
                            });
                        });
                }

                // Right collapsible sidebar
                if !self.sidebar_state.right_collapsed {
                    egui::SidePanel::right("right_sidebar")
                        .resizable(true)
                        .default_width(260.0)
                        .width_range(200.0..=400.0)
                        .show(ctx, |ui| {
                            SidebarsView::render_right_sidebar(
                                ui,
                                &mut self.sidebar_state,
                                &self.subagents,
                                &self.hardware,
                            );
                        });
                } else {
                    egui::SidePanel::right("right_sidebar_collapsed")
                        .resizable(false)
                        .exact_width(28.0)
                        .show(ctx, |ui| {
                            ui.vertical_centered(|ui| {
                                ui.add_space(8.0);
                                if ui.small_button("[<<]").on_hover_text("Expand Right Sidebar").clicked() {
                                    self.sidebar_state.right_collapsed = false;
                                }
                            });
                        });
                }

                // Central Command Center
                egui::CentralPanel::default().show(ctx, |ui| {
                    let mut quick_action = None;

                    CommandCenterView::render_central_area(
                        ui,
                        self.is_running,
                        &self.current_running_prompt,
                        &self.current_thought,
                        &self.thinking_metrics,
                        &self.streaming_token_buffer,
                        &self.plan_items,
                        &self.workflow_cards,
                        &self.conversation_history,
                        &self.selected_file_path,
                        &self.selected_file_content,
                        &self.hardware,
                        &mut quick_action,
                    );

                    if let Some(prompt) = quick_action {
                        self.user_input = prompt;
                        self.trigger_run_agent();
                    }
                });
            }

            MainView::ModelHub => {
                egui::CentralPanel::default().show(ctx, |ui| {
                    self.model_hub_view.render(ui, ctx, self.state.clone(), &self.tokio_handle);
                });
            }

            MainView::Settings => {
                egui::CentralPanel::default().show(ctx, |ui| {
                    self.settings_view_state.render_content(ui, self.state.clone(), &self.tokio_handle);
                });
            }

            MainView::TerminalLogs => {
                egui::CentralPanel::default().show(ctx, |ui| {
                    self.terminal_view_state.render(
                        ui,
                        self.state.clone(),
                        &self.tokio_handle,
                        &mut self.terminal_logs,
                        &self.git_status,
                    );
                });
            }
        }
    }
}
