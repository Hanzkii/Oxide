use crate::gui::state::*;
use crate::gui::theme::*;
use crate::hardware::HardwareSpecs;
use crate::orchestrator::WorkflowStepStatus;
use eframe::egui::{self, Color32, Key, ScrollArea, Ui};

pub struct CommandCenterView;

impl CommandCenterView {
    /// Renders the central dashboard with conversation turns, active thought stream, and file previews
    pub fn render_central_area(
        ui: &mut Ui,
        is_running: bool,
        current_running_prompt: &str,
        current_thought: &str,
        thinking_metrics: &Option<(f32, f32, usize, String, i32)>,
        streaming_token_buffer: &str,
        plan_items: &[String],
        workflow_cards: &[WorkflowCardItem],
        conversation_history: &[ConversationTurn],
        selected_file_path: &Option<String>,
        selected_file_content: &Option<String>,
        hardware: &Option<HardwareSpecs>,
        on_quick_action: &mut Option<String>,
    ) {
        ScrollArea::vertical()
            .auto_shrink([false, false])
            .stick_to_bottom(true)
            .show(ui, |ui| {
                // If idle and no conversation history: Welcome Screen
                if conversation_history.is_empty() && !is_running {
                    Self::render_welcome_screen(ui, hardware, on_quick_action);
                }

                // Render previous conversation turns
                for turn in conversation_history {
                    card_frame().show(ui, |ui| {
                        ui.horizontal(|ui| {
                            ascii_badge(ui, "[USER]", ACCENT_CYAN);
                            ui.label(
                                egui::RichText::new(&turn.user_prompt)
                                    .strong()
                                    .color(TEXT_PRIMARY),
                            );
                        });

                        if let Some((el, tok_s, count, ref ph, layers)) = turn.thinking_metrics {
                            ui.add_space(2.0);
                            let metrics_str = format!(
                                "Metrics: {:.1}s | {:.1} tok/s | {} tokens | Phase: {} | GPU Layers: {}",
                                el, tok_s, count, ph, layers
                            );
                            ui.label(
                                egui::RichText::new(metrics_str)
                                    .color(TEXT_MUTED)
                                    .small(),
                            );
                        }

                        if !turn.thought.is_empty() {
                            ui.add_space(4.0);
                            egui::CollapsingHeader::new("Reasoning Process")
                                .default_open(false)
                                .show(ui, |ui| {
                                    nested_panel_frame().show(ui, |ui| {
                                        ui.label(
                                            egui::RichText::new(&turn.thought)
                                                .color(TEXT_SECONDARY)
                                                .small(),
                                        );
                                    });
                                });
                        }

                        if !turn.plan.is_empty() {
                            ui.add_space(4.0);
                            ui.label(egui::RichText::new("Execution Plan:").strong().small().color(ACCENT_BLUE));
                            for item in &turn.plan {
                                ui.label(egui::RichText::new(format!("  [x] {}", item)).small().color(TEXT_SECONDARY));
                            }
                        }

                        if !turn.assistant_reply.is_empty() {
                            ui.add_space(4.0);
                            ui.separator();
                            ui.add_space(2.0);
                            ui.label(egui::RichText::new(&turn.assistant_reply).color(TEXT_PRIMARY));
                        }
                    });

                    ui.add_space(8.0);
                }

                // Render active execution streaming card
                if is_running {
                    highlighted_card_frame().show(ui, |ui| {
                        ui.horizontal(|ui| {
                            ui.add(egui::Spinner::new());
                            ascii_badge(ui, "[RUNNING]", ACCENT_GREEN);
                            ui.label(
                                egui::RichText::new(current_running_prompt)
                                    .strong()
                                    .color(TEXT_PRIMARY),
                            );
                        });

                        ui.add_space(4.0);

                        // Live thinking metrics
                        if let Some((el, tok_s, count, ref ph, layers)) = thinking_metrics {
                            let stream_metric = format!(
                                "Reasoning: {:.1}s | {:.1} tok/s | {} tokens | Phase: {} | GPU Layers: {}",
                                el, tok_s, count, ph, layers
                            );
                            ui.label(
                                egui::RichText::new(stream_metric)
                                    .color(ACCENT_AMBER)
                                    .small(),
                            );
                        } else {
                            ui.label(
                                egui::RichText::new("Lead Architect reasoning next action...")
                                    .color(ACCENT_AMBER)
                                    .small(),
                            );
                        }

                        // Live thought process
                        if !current_thought.is_empty() {
                            ui.add_space(4.0);
                            nested_panel_frame().show(ui, |ui| {
                                ui.label(
                                    egui::RichText::new(current_thought)
                                        .color(TEXT_SECONDARY)
                                        .small(),
                                );
                            });
                        }

                        // Plan checklist
                        if !plan_items.is_empty() {
                            ui.add_space(4.0);
                            ui.label(egui::RichText::new("Active Plan:").strong().small().color(ACCENT_BLUE));
                            for p in plan_items {
                                ui.label(egui::RichText::new(format!("  [ ] {}", p)).small().color(TEXT_SECONDARY));
                            }
                        }

                        // Workflow step cards
                        if !workflow_cards.is_empty() {
                            ui.add_space(4.0);
                            for step in workflow_cards {
                                let (tag, color) = match step.status {
                                    WorkflowStepStatus::Running => ("[RUNNING]", ACCENT_BLUE),
                                    WorkflowStepStatus::Succeeded => ("[DONE]", ACCENT_GREEN),
                                    WorkflowStepStatus::Failed => ("[FAILED]", ACCENT_RED),
                                    WorkflowStepStatus::SelfCorrecting => ("[RETRYING]", ACCENT_AMBER),
                                };
                                ui.horizontal(|ui| {
                                    ascii_badge(ui, tag, color);
                                    ui.label(egui::RichText::new(format!("Step {}: {}", step.step, step.title)).small().strong());
                                });
                            }
                        }

                        // Streaming token preview
                        if !streaming_token_buffer.is_empty() {
                            ui.add_space(6.0);
                            ui.separator();
                            ui.add_space(4.0);
                            ui.label(egui::RichText::new(streaming_token_buffer).color(TEXT_PRIMARY));
                        }
                    });

                    ui.add_space(8.0);
                }

                // File preview accordion if a file is selected
                if let Some(ref content) = selected_file_content {
                    let file_name = selected_file_path.as_deref().unwrap_or("File Preview");
                    ui.add_space(6.0);
                    egui::CollapsingHeader::new(format!("File Content: {}", file_name))
                        .default_open(true)
                        .show(ui, |ui| {
                            nested_panel_frame().show(ui, |ui| {
                                ScrollArea::horizontal().show(ui, |ui| {
                                    ui.label(
                                        egui::RichText::new(content)
                                            .monospace()
                                            .small()
                                            .color(TEXT_SECONDARY),
                                    );
                                });
                            });
                        });
                }
            });
    }

    fn render_welcome_screen(
        ui: &mut Ui,
        hardware: &Option<HardwareSpecs>,
        on_quick_action: &mut Option<String>,
    ) {
        ui.add_space(12.0);

        ui.horizontal(|ui| {
            ui.label(
                egui::RichText::new("OXIDE STUDIO")
                    .heading()
                    .strong()
                    .color(ACCENT_BLUE),
            );
            ascii_badge(ui, "[NATIVE GUI]", ACCENT_CYAN);
        });

        ui.label(
            egui::RichText::new("Local-First Autonomous AI Software Engineering Studio | Multi-Agent Orchestrator")
                .color(TEXT_MUTED)
                .small(),
        );

        ui.add_space(16.0);

        ui.label(egui::RichText::new("Quick Autonomous Workflows:").strong().color(TEXT_PRIMARY));
        ui.add_space(6.0);

        ui.horizontal_wrapped(|ui| {
            let card1 = egui::Button::new(
                egui::RichText::new("Inspect & Map Workspace\nAnalyze project layout, dependencies, & architecture")
                    .color(TEXT_PRIMARY),
            )
            .fill(BG_CARD)
            .min_size(egui::vec2(240.0, 56.0));
            if ui.add(card1).clicked() {
                *on_quick_action = Some("Inspect workspace structure, analyze dependencies, and summarize architecture.".to_string());
            }

            let card2 = egui::Button::new(
                egui::RichText::new("Autonomous Build & Test\nCompile codebase, run test suite, & verify fixes")
                    .color(TEXT_PRIMARY),
            )
            .fill(BG_CARD)
            .min_size(egui::vec2(240.0, 56.0));
            if ui.add(card2).clicked() {
                *on_quick_action = Some("Inspect available compilers, build the project, run tests, and report any errors.".to_string());
            }

            let card3 = egui::Button::new(
                egui::RichText::new("Plan Architecture (/plan)\nFormulate step-by-step modular architectural design")
                    .color(TEXT_PRIMARY),
            )
            .fill(BG_CARD)
            .min_size(egui::vec2(240.0, 56.0));
            if ui.add(card3).clicked() {
                *on_quick_action = Some("/plan ".to_string());
            }

            let card4 = egui::Button::new(
                egui::RichText::new("Debug & Fix Errors (/fix)\nIsolate errors, reproduce failures, & apply minimal patches")
                    .color(TEXT_PRIMARY),
            )
            .fill(BG_CARD)
            .min_size(egui::vec2(240.0, 56.0));
            if ui.add(card4).clicked() {
                *on_quick_action = Some("/fix ".to_string());
            }
        });

        ui.add_space(16.0);
        ui.separator();
        ui.add_space(8.0);

        // Hardware Telemetry Summary Card
        card_frame().show(ui, |ui| {
            ui.label(egui::RichText::new("Hardware & Acceleration Engine").strong().color(ACCENT_CYAN));
            ui.add_space(4.0);

            if let Some(hw) = hardware {
                ui.label(format!("Processor: {} ({} Cores, {:.1}% CPU)", hw.cpu_brand, hw.cpu_cores, hw.cpu_usage_percent));
                ui.label(format!("Graphics Accelerator: {} ({:.1} GB Dedicated VRAM)", hw.gpu_name, hw.gpu_vram_gb));
                ui.label(format!("Governor Tier: {} | Concurrency Limit: {} Subagents", hw.governor_tier, hw.hard_limit_subagents));
            } else {
                ui.label(egui::RichText::new("Inspecting hardware capabilities...").color(TEXT_MUTED));
            }
        });
    }

    /// Renders the bottom input dock with slash commands, multiline prompt input, and Run/Cancel buttons
    pub fn render_bottom_dock(
        ui: &mut Ui,
        user_input: &mut String,
        is_running: bool,
        status_banner: &Option<(String, bool)>,
        on_run_clicked: &mut bool,
        on_cancel_clicked: &mut bool,
    ) {
        ui.vertical(|ui| {
            // Status or Error Banner
            if let Some((ref msg, is_err)) = status_banner {
                let color = if *is_err { ACCENT_RED } else { ACCENT_GREEN };
                let badge = if *is_err { "[ERROR]" } else { "[INFO]" };
                ui.horizontal(|ui| {
                    ascii_badge(ui, badge, color);
                    ui.colored_label(color, msg);
                });
                ui.add_space(2.0);
            }

            // Quick slash command buttons
            ui.horizontal(|ui| {
                ui.label(egui::RichText::new("Commands:").small().color(TEXT_MUTED));

                if ui.small_button("/plan").clicked() {
                    *user_input = "/plan ".to_string();
                }
                if ui.small_button("/fix").clicked() {
                    *user_input = "/fix ".to_string();
                }
                if ui.small_button("/test").clicked() {
                    *user_input = "/test ".to_string();
                }
                if ui.small_button("/btw").clicked() {
                    *user_input = "/btw ".to_string();
                }

                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.label(egui::RichText::new("Shift+Enter for newline | Enter to send").small().color(TEXT_DIM));
                });
            });

            ui.add_space(4.0);

            // Multiline text edit and action buttons
            ui.horizontal(|ui| {
                let text_edit = egui::TextEdit::multiline(user_input)
                    .desired_rows(2)
                    .desired_width(ui.available_width() - 140.0)
                    .hint_text("Ask Lead Architect to inspect, plan, implement, or test (e.g. /plan rework GUI)...");

                let response = ui.add(text_edit);

                let enter_pressed = response.has_focus()
                    && ui.input(|i| i.key_pressed(Key::Enter) && !i.modifiers.shift);

                if is_running {
                    let cancel_btn = egui::Button::new(
                        egui::RichText::new("CANCEL")
                            .color(Color32::WHITE)
                            .strong(),
                    )
                    .min_size(egui::vec2(130.0, 44.0))
                    .fill(ACCENT_RED);

                    if ui.add(cancel_btn).clicked() {
                        *on_cancel_clicked = true;
                    }
                } else {
                    let run_btn = egui::Button::new(
                        egui::RichText::new("RUN AGENT")
                            .color(Color32::WHITE)
                            .strong(),
                    )
                    .min_size(egui::vec2(130.0, 44.0))
                    .fill(ACCENT_BLUE);

                    if (ui.add(run_btn).clicked() || enter_pressed) && !user_input.trim().is_empty() {
                        *on_run_clicked = true;
                    }
                }
            });
        });
    }
}
