use crate::commands::workspace::WorkspaceFileEntry;
use crate::gui::state::*;
use crate::gui::theme::*;
use crate::hardware::HardwareSpecs;
use crate::orchestrator::SubagentRunState;
use eframe::egui::{self, ScrollArea, Ui};
use std::path::Path;

pub const MAX_PREVIEW_BYTES: u64 = 512 * 1024; // 512 KB

/// Reads a file for GUI preview bounded to 512 KB to avoid excessive memory allocation
pub fn read_file_preview(path: &Path) -> Option<String> {
    use std::io::Read;
    let metadata = std::fs::metadata(path).ok()?;
    let file_size = metadata.len();
    let mut file = std::fs::File::open(path).ok()?;
    let read_limit = file_size.min(MAX_PREVIEW_BYTES) as usize;
    let mut buffer = vec![0u8; read_limit];
    file.read_exact(&mut buffer).ok()?;

    let mut content = String::from_utf8_lossy(&buffer).to_string();
    if file_size > MAX_PREVIEW_BYTES {
        content.push_str(&format!(
            "\n\n[... Truncated: showing first 512 KB of {:.1} MB ...]",
            file_size as f64 / (1024.0 * 1024.0)
        ));
    }
    Some(content)
}

pub struct SidebarsView;

impl SidebarsView {
    /// Renders the Left Sidebar (Multi-Project Explorer, Workspace File Tree, Saved Conversations History)
    pub fn render_left_sidebar(
        ui: &mut Ui,
        sidebar_state: &mut SidebarState,
        workspace_path: &mut String,
        files: &[WorkspaceFileEntry],
        selected_file_path: &mut Option<String>,
        selected_file_content: &mut Option<String>,
        sessions_file: &mut StudioSessionsFile,
        conversation_history: &mut Vec<ConversationTurn>,
        active_conv_id: &mut Option<String>,
        on_project_changed: &mut bool,
        on_open_folder_clicked: &mut bool,
        on_refresh_files_clicked: &mut bool,
    ) {
        ui.vertical(|ui| {
            // Header with collapse toggle and tabs
            ui.horizontal(|ui| {
                let tab = sidebar_state.left_tab;
                if ui.selectable_label(tab == LeftSidebarTab::Files, "Files").clicked() {
                    sidebar_state.left_tab = LeftSidebarTab::Files;
                }
                if ui.selectable_label(tab == LeftSidebarTab::Projects, "Projects").clicked() {
                    sidebar_state.left_tab = LeftSidebarTab::Projects;
                }
                if ui.selectable_label(tab == LeftSidebarTab::History, "History").clicked() {
                    sidebar_state.left_tab = LeftSidebarTab::History;
                }

                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.small_button("[<<]").on_hover_text("Collapse Sidebar").clicked() {
                        sidebar_state.left_collapsed = true;
                    }
                });
            });

            ui.add_space(4.0);
            ui.separator();

            match sidebar_state.left_tab {
                LeftSidebarTab::Files => {
                    Self::render_files_tab(
                        ui,
                        workspace_path,
                        files,
                        selected_file_path,
                        selected_file_content,
                        on_refresh_files_clicked,
                    );
                }
                LeftSidebarTab::Projects => {
                    Self::render_projects_tab(
                        ui,
                        workspace_path,
                        sessions_file,
                        on_project_changed,
                        on_open_folder_clicked,
                    );
                }
                LeftSidebarTab::History => {
                    Self::render_history_tab(
                        ui,
                        sessions_file,
                        conversation_history,
                        active_conv_id,
                    );
                }
            }
        });
    }

    fn render_files_tab(
        ui: &mut Ui,
        workspace_path: &str,
        files: &[WorkspaceFileEntry],
        selected_file_path: &mut Option<String>,
        selected_file_content: &mut Option<String>,
        on_refresh_files_clicked: &mut bool,
    ) {
        ui.horizontal(|ui| {
            let folder_name = Path::new(workspace_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "Workspace".to_string());
            ui.label(egui::RichText::new(&folder_name).strong().color(TEXT_PRIMARY));

            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.small_button("Reload").clicked() {
                    *on_refresh_files_clicked = true;
                }
            });
        });

        ui.add_space(4.0);

        ScrollArea::vertical()
            .auto_shrink([false, false])
            .show(ui, |ui| {
                if files.is_empty() {
                    ui.label(egui::RichText::new("No files in workspace.").color(TEXT_DIM).small());
                } else {
                    for f in files {
                        let is_selected = selected_file_path.as_deref() == Some(&f.relative_path);
                        let icon = if f.is_dir { "[DIR] " } else { "      " };
                        let label = format!("{}{}", icon, f.name);

                        let color = if f.is_dir { ACCENT_CYAN } else { TEXT_PRIMARY };

                        let resp = ui.selectable_label(
                            is_selected,
                            egui::RichText::new(label).color(color).monospace().small(),
                        );

                        if resp.clicked() {
                            *selected_file_path = Some(f.relative_path.clone());
                            let full = Path::new(workspace_path).join(&f.relative_path);
                            if full.is_file() {
                                *selected_file_content = read_file_preview(&full);
                            } else {
                                *selected_file_content = None;
                            }
                        }
                    }
                }
            });
    }

    fn render_projects_tab(
        ui: &mut Ui,
        workspace_path: &mut String,
        sessions_file: &mut StudioSessionsFile,
        on_project_changed: &mut bool,
        on_open_folder_clicked: &mut bool,
    ) {
        ui.horizontal(|ui| {
            ui.label(egui::RichText::new("Multi-Project Explorer").strong().color(TEXT_PRIMARY));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.button("+ Open Folder").clicked() {
                    *on_open_folder_clicked = true;
                }
            });
        });

        ui.add_space(4.0);

        ScrollArea::vertical()
            .auto_shrink([false, false])
            .show(ui, |ui| {
                if sessions_file.projects.is_empty() {
                    ui.label(
                        egui::RichText::new("No projects recorded yet.\nClick [+ Open Folder] to add a project workspace.")
                            .color(TEXT_DIM)
                            .small(),
                    );
                } else {
                    let mut proj_to_remove = None;
                    for (idx, proj) in sessions_file.projects.iter().enumerate() {
                        let is_active = workspace_path == &proj.path;

                        card_frame().show(ui, |ui| {
                            ui.horizontal(|ui| {
                                let label_text = if is_active {
                                    format!("* {}", proj.name)
                                } else {
                                    proj.name.clone()
                                };

                                let label_color = if is_active { ACCENT_BLUE } else { TEXT_PRIMARY };

                                if ui.selectable_label(is_active, egui::RichText::new(label_text).color(label_color).strong()).clicked() {
                                    *workspace_path = proj.path.clone();
                                    sessions_file.active_project_id = Some(proj.id.clone());
                                    *on_project_changed = true;
                                }

                                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                    if ui.small_button("x").on_hover_text("Remove project from list").clicked() {
                                        proj_to_remove = Some(idx);
                                    }
                                });
                            });

                            ui.label(egui::RichText::new(&proj.path).color(TEXT_DIM).small().monospace());
                        });

                        ui.add_space(4.0);
                    }

                    if let Some(idx) = proj_to_remove {
                        sessions_file.projects.remove(idx);
                        sessions_file.save_to_disk();
                    }
                }
            });
    }

    fn render_history_tab(
        ui: &mut Ui,
        sessions_file: &mut StudioSessionsFile,
        conversation_history: &mut Vec<ConversationTurn>,
        active_conv_id: &mut Option<String>,
    ) {
        ui.horizontal(|ui| {
            ui.label(egui::RichText::new("Saved History").strong().color(TEXT_PRIMARY));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.button("+ New Chat").clicked() {
                    // Save current chat if it has turns
                    if !conversation_history.is_empty() {
                        let conv_id = active_conv_id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                        let title = conversation_history.first()
                            .map(|t| {
                                let prompt = t.user_prompt.trim();
                                if prompt.len() > 32 {
                                    format!("{}...", &prompt[..32])
                                } else {
                                    prompt.to_string()
                                }
                            })
                            .unwrap_or_else(|| "Session".to_string());

                        let updated_at = chrono::Utc::now().to_rfc3339();
                        let turns_dto = conversation_history.iter().map(|t| t.to_dto()).collect();

                        if let Some(existing) = sessions_file.conversations.iter_mut().find(|c| c.id == conv_id) {
                            existing.title = title;
                            existing.updated_at = updated_at;
                            existing.turns = turns_dto;
                        } else {
                            sessions_file.conversations.insert(0, SavedConversation {
                                id: conv_id,
                                project_id: sessions_file.active_project_id.clone().unwrap_or_default(),
                                title,
                                updated_at,
                                turns: turns_dto,
                            });
                        }
                        sessions_file.save_to_disk();
                    }

                    // Reset active conversation
                    conversation_history.clear();
                    let new_id = uuid::Uuid::new_v4().to_string();
                    *active_conv_id = Some(new_id.clone());
                    sessions_file.active_conv_id = Some(new_id);
                    sessions_file.save_to_disk();
                }
            });
        });

        ui.add_space(4.0);

        ScrollArea::vertical()
            .auto_shrink([false, false])
            .show(ui, |ui| {
                if sessions_file.conversations.is_empty() {
                    ui.label(egui::RichText::new("No saved conversations yet.").color(TEXT_DIM).small());
                } else {
                    let mut conv_to_activate = None;
                    let mut conv_to_delete = None;

                    for (idx, conv) in sessions_file.conversations.iter().enumerate() {
                        let is_active = active_conv_id.as_deref() == Some(&conv.id);

                        card_frame().show(ui, |ui| {
                            ui.horizontal(|ui| {
                                let color = if is_active { ACCENT_BLUE } else { TEXT_PRIMARY };
                                if ui.selectable_label(is_active, egui::RichText::new(&conv.title).color(color).strong()).clicked() {
                                    conv_to_activate = Some(idx);
                                }

                                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                    if ui.small_button("x").on_hover_text("Delete conversation").clicked() {
                                        conv_to_delete = Some(idx);
                                    }
                                });
                            });

                            let date_short = conv.updated_at.get(..10).unwrap_or(&conv.updated_at);
                            ui.label(
                                egui::RichText::new(format!("Turns: {} | {}", conv.turns.len(), date_short))
                                    .color(TEXT_DIM)
                                    .small(),
                            );
                        });

                        ui.add_space(4.0);
                    }

                    if let Some(idx) = conv_to_activate {
                        let conv = &sessions_file.conversations[idx];
                        *active_conv_id = Some(conv.id.clone());
                        sessions_file.active_conv_id = Some(conv.id.clone());
                        *conversation_history = conv.turns.iter().map(ConversationTurn::from_dto).collect();
                        sessions_file.save_to_disk();
                    }

                    if let Some(idx) = conv_to_delete {
                        if active_conv_id.as_deref() == Some(&sessions_file.conversations[idx].id) {
                            *active_conv_id = None;
                            conversation_history.clear();
                        }
                        sessions_file.conversations.remove(idx);
                        sessions_file.save_to_disk();
                    }
                }
            });
    }

    /// Renders the Right Sidebar (Live Subagents Concurrency Monitor & Telemetry)
    pub fn render_right_sidebar(
        ui: &mut Ui,
        sidebar_state: &mut SidebarState,
        subagents: &[SubagentItem],
        hardware: &Option<HardwareSpecs>,
    ) {
        ui.vertical(|ui| {
            ui.horizontal(|ui| {
                let tab = sidebar_state.right_tab;
                if ui.selectable_label(tab == RightSidebarTab::Subagents, "Subagents").clicked() {
                    sidebar_state.right_tab = RightSidebarTab::Subagents;
                }
                if ui.selectable_label(tab == RightSidebarTab::Telemetry, "Hardware").clicked() {
                    sidebar_state.right_tab = RightSidebarTab::Telemetry;
                }

                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.small_button("[>>]").on_hover_text("Collapse Sidebar").clicked() {
                        sidebar_state.right_collapsed = true;
                    }
                });
            });

            ui.add_space(4.0);
            ui.separator();

            match sidebar_state.right_tab {
                RightSidebarTab::Subagents => {
                    Self::render_subagents_tab(ui, subagents, hardware);
                }
                RightSidebarTab::Telemetry => {
                    Self::render_telemetry_tab(ui, hardware);
                }
            }
        });
    }

    fn render_subagents_tab(
        ui: &mut Ui,
        subagents: &[SubagentItem],
        hardware: &Option<HardwareSpecs>,
    ) {
        let hard_limit = hardware.as_ref().map(|h| h.hard_limit_subagents).unwrap_or(8);
        let active_count = subagents.iter().filter(|s| matches!(s.state, SubagentRunState::Running)).count();

        ui.horizontal(|ui| {
            ui.label(egui::RichText::new("Live Subagents Monitor").strong().color(TEXT_PRIMARY));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                let pill = format!("{}/{} Workers", active_count, hard_limit);
                ascii_badge(ui, &pill, if active_count > 0 { ACCENT_GREEN } else { TEXT_MUTED });
            });
        });

        ui.add_space(4.0);

        ScrollArea::vertical()
            .auto_shrink([false, false])
            .show(ui, |ui| {
                if subagents.is_empty() {
                    ui.label(
                        egui::RichText::new("No active subagents.\nLead Architect will dispatch tasks to subagents as needed.")
                            .color(TEXT_DIM)
                            .small(),
                    );
                } else {
                    for sub in subagents {
                        let (badge_color, state_txt) = match sub.state {
                            SubagentRunState::Running => (ACCENT_BLUE, "RUNNING"),
                            SubagentRunState::Completed => (ACCENT_GREEN, "DONE"),
                            SubagentRunState::Failed => (ACCENT_RED, "FAILED"),
                            SubagentRunState::Queued | SubagentRunState::ThrottledWaitingForHardware => (ACCENT_AMBER, "QUEUED"),
                        };

                        card_frame().show(ui, |ui| {
                            ui.horizontal(|ui| {
                                ascii_badge(ui, &format!("[{}]", state_txt), badge_color);
                                ui.label(egui::RichText::new(&sub.title).strong().color(TEXT_PRIMARY).small());
                            });

                            ui.label(
                                egui::RichText::new(format!(
                                    "Role: {:?} | Model: {}",
                                    sub.role, sub.model
                                ))
                                .color(TEXT_MUTED)
                                .small(),
                            );

                            if !sub.thought.is_empty() {
                                ui.add_space(2.0);
                                ui.label(
                                    egui::RichText::new(&sub.thought)
                                        .color(TEXT_SECONDARY)
                                        .small(),
                                );
                            }

                            if !sub.output_preview.is_empty() {
                                ui.add_space(2.0);
                                nested_panel_frame().show(ui, |ui| {
                                    ui.label(
                                        egui::RichText::new(&sub.output_preview)
                                            .color(TEXT_MUTED)
                                            .monospace()
                                            .small(),
                                    );
                                });
                            }
                        });

                        ui.add_space(4.0);
                    }
                }
            });
    }

    fn render_telemetry_tab(ui: &mut Ui, hardware: &Option<HardwareSpecs>) {
        ui.label(egui::RichText::new("Hardware & Governor").strong().color(TEXT_PRIMARY));
        ui.add_space(4.0);

        if let Some(hw) = hardware {
            card_frame().show(ui, |ui| {
                ui.label(egui::RichText::new("CPU & System").strong().color(ACCENT_BLUE));
                ui.label(format!("Processor: {}", hw.cpu_brand));
                ui.label(format!("Cores: {} | CPU Load: {:.1}%", hw.cpu_cores, hw.cpu_usage_percent));
                ui.label(format!(
                    "RAM: {:.1} GB / {:.1} GB (Avail: {:.1} GB)",
                    hw.total_ram_gb - hw.available_ram_gb,
                    hw.total_ram_gb,
                    hw.available_ram_gb
                ));
            });

            ui.add_space(4.0);

            card_frame().show(ui, |ui| {
                ui.label(egui::RichText::new("GPU Acceleration").strong().color(ACCENT_CYAN));
                ui.label(format!("GPU: {}", hw.gpu_name));
                ui.label(format!("VRAM: {:.1} GB", hw.gpu_vram_gb));
                ui.label(format!("Governor Tier: {}", hw.governor_tier));
                ui.label(format!("Max Subagents: {}", hw.hard_limit_subagents));
                if hw.throttled_by_load {
                    ascii_badge(ui, "[THROTTLED: HIGH LOAD]", ACCENT_AMBER);
                } else {
                    ascii_badge(ui, "[GOVERNOR: OPTIMAL]", ACCENT_GREEN);
                }
            });

            ui.add_space(4.0);
            ui.label(egui::RichText::new(&hw.governor_advice).color(TEXT_MUTED).small());
        } else {
            ui.label(egui::RichText::new("Inspecting hardware telemetry...").color(TEXT_DIM));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_read_file_preview_small_file() {
        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("test_preview_small.txt");
        let content = "Hello Oxide Studio preview!";
        std::fs::write(&test_file, content).unwrap();

        let preview = read_file_preview(&test_file);
        let _ = std::fs::remove_file(&test_file);

        assert_eq!(preview, Some(content.to_string()));
    }

    #[test]
    fn test_read_file_preview_large_file_bounded() {
        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("test_preview_large.bin");
        // Create 600 KB file (exceeds 512 KB limit)
        let data = vec![b'A'; 600 * 1024];
        std::fs::write(&test_file, &data).unwrap();

        let preview = read_file_preview(&test_file);
        let _ = std::fs::remove_file(&test_file);

        assert!(preview.is_some());
        let res = preview.unwrap();
        assert!(res.contains("[... Truncated: showing first 512 KB"));
        assert!(res.starts_with("AAAA"));
    }
}
