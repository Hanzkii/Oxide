use crate::commands::agent::{candidate_paths, save_provider_config};
use crate::gui::theme::*;
use crate::llm::{
    GpuOffloadPolicy, HardwareAccelerationMode, ProviderConfig, ProviderKind, SecurityReviewMode,
};
use crate::AppState;
use eframe::egui::{self, ComboBox, DragValue, ScrollArea, Slider, Ui};
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingsTab {
    Providers,
    Inference,
    Hardware,
    Governor,
}

pub struct SettingsViewState {
    pub draft_config: ProviderConfig,
    pub active_tab: SettingsTab,
    pub cloud_provider_subtab: CloudProviderKind,
    pub reveal_keys: HashMap<String, bool>,
    pub available_gguf_models: Vec<String>,
    pub save_status: Option<(String, bool)>, // (message, is_error)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudProviderKind {
    Anthropic,
    OpenAi,
    Gemini,
    DeepSeek,
    CustomOpenAi,
}

impl SettingsViewState {
    pub fn new(initial_config: &ProviderConfig) -> Self {
        let mut s = Self {
            draft_config: initial_config.clone(),
            active_tab: SettingsTab::Providers,
            cloud_provider_subtab: match initial_config.active_provider {
                ProviderKind::Anthropic => CloudProviderKind::Anthropic,
                ProviderKind::OpenAi => CloudProviderKind::OpenAi,
                ProviderKind::Gemini => CloudProviderKind::Gemini,
                ProviderKind::Deepseek => CloudProviderKind::DeepSeek,
                ProviderKind::CustomOpenai => CloudProviderKind::CustomOpenAi,
                _ => CloudProviderKind::Anthropic,
            },
            reveal_keys: HashMap::new(),
            available_gguf_models: Vec::new(),
            save_status: None,
        };
        s.refresh_available_models();
        s
    }

    pub fn refresh_available_models(&mut self) {
        let mut list = Vec::new();
        for dir in candidate_paths("models") {
            if let Ok(rd) = std::fs::read_dir(dir) {
                for entry in rd.flatten() {
                    let path = entry.path();
                    if path.is_file() {
                        if let Some(ext) = path.extension() {
                            if ext.to_string_lossy().eq_ignore_ascii_case("gguf") {
                                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                                    if !list.contains(&name.to_string()) {
                                        list.push(name.to_string());
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        list.sort();
        self.available_gguf_models = list;
    }

    pub fn is_revealed(&self, key_id: &str) -> bool {
        self.reveal_keys.get(key_id).copied().unwrap_or(false)
    }

    pub fn toggle_reveal(&mut self, key_id: &str) {
        let cur = self.is_revealed(key_id);
        self.reveal_keys.insert(key_id.to_string(), !cur);
    }

    pub fn save_changes(&mut self, state: Arc<AppState>, tokio_handle: &tokio::runtime::Handle) {
        let config_to_save = self.draft_config.clone();

        // Synchronize environment variables for cloud keys
        if let Some(ref k) = config_to_save.anthropic_api_key {
            if !k.trim().is_empty() {
                std::env::set_var("ANTHROPIC_API_KEY", k.trim());
            }
        }
        if let Some(ref k) = config_to_save.openai_api_key {
            if !k.trim().is_empty() {
                std::env::set_var("OPENAI_API_KEY", k.trim());
            }
        }
        if let Some(ref k) = config_to_save.gemini_api_key {
            if !k.trim().is_empty() {
                std::env::set_var("GEMINI_API_KEY", k.trim());
            }
        }
        if let Some(ref k) = config_to_save.deepseek_api_key {
            if !k.trim().is_empty() {
                std::env::set_var("DEEPSEEK_API_KEY", k.trim());
            }
        }

        let cfg_clone = config_to_save.clone();
        tokio_handle.spawn(async move {
            let _ = save_provider_config(&cfg_clone);
            let mut guard = state.provider_config.write().await;
            *guard = cfg_clone;
        });

        self.save_status = Some(("Settings saved and applied successfully.".to_string(), false));
    }

    pub fn render_content(&mut self, ui: &mut Ui, state: Arc<AppState>, tokio_handle: &tokio::runtime::Handle) {
        // Tab Selection Header
        ui.horizontal(|ui| {
            let cur = self.active_tab;
            if ui.selectable_label(cur == SettingsTab::Providers, "AI Providers & Models").clicked() {
                self.active_tab = SettingsTab::Providers;
            }
            if ui.selectable_label(cur == SettingsTab::Inference, "Inference & Context").clicked() {
                self.active_tab = SettingsTab::Inference;
            }
            if ui.selectable_label(cur == SettingsTab::Hardware, "Hardware & GPU Offload").clicked() {
                self.active_tab = SettingsTab::Hardware;
            }
            if ui.selectable_label(cur == SettingsTab::Governor, "Governor & Security").clicked() {
                self.active_tab = SettingsTab::Governor;
            }

            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.button("Save & Apply Changes").clicked() {
                    self.save_changes(state.clone(), tokio_handle);
                }
            });
        });

        if let Some((ref msg, is_err)) = self.save_status {
            ui.add_space(4.0);
            let color = if is_err { ACCENT_RED } else { ACCENT_GREEN };
            let badge = if is_err { "[ERROR]" } else { "[SUCCESS]" };
            ui.horizontal(|ui| {
                ascii_badge(ui, badge, color);
                ui.colored_label(color, msg);
            });
        }

        ui.add_space(6.0);
        ui.separator();
        ui.add_space(6.0);

        ScrollArea::vertical()
            .auto_shrink([false, false])
            .show(ui, |ui| {
                match self.active_tab {
                    SettingsTab::Providers => self.render_providers_tab(ui),
                    SettingsTab::Inference => self.render_inference_tab(ui),
                    SettingsTab::Hardware => self.render_hardware_tab(ui),
                    SettingsTab::Governor => self.render_governor_tab(ui),
                }
            });
    }

    fn render_providers_tab(&mut self, ui: &mut Ui) {
        // Provider Kind Selection
        card_frame().show(ui, |ui| {
            ui.label(egui::RichText::new("Active AI Inference Provider").strong().color(ACCENT_BLUE));
            ui.label(egui::RichText::new("Choose whether reasoning is handled by the local native engine, local Ollama, or a cloud API.").color(TEXT_MUTED).small());
            ui.add_space(4.0);

            ui.horizontal(|ui| {
                let p = &mut self.draft_config.active_provider;
                let is_native = *p == ProviderKind::OxideNative;
                let is_ollama = *p == ProviderKind::Ollama;
                let is_cloud = !is_native && !is_ollama;

                if ui.radio(is_native, "Oxide Native (Embedded GGUF)").clicked() {
                    *p = ProviderKind::OxideNative;
                }
                if ui.radio(is_ollama, "Ollama Server (Local)").clicked() {
                    *p = ProviderKind::Ollama;
                }
                if ui.radio(is_cloud, "Cloud Provider (Anthropic, OpenAI, etc.)").clicked() {
                    *p = match self.cloud_provider_subtab {
                        CloudProviderKind::Anthropic => ProviderKind::Anthropic,
                        CloudProviderKind::OpenAi => ProviderKind::OpenAi,
                        CloudProviderKind::Gemini => ProviderKind::Gemini,
                        CloudProviderKind::DeepSeek => ProviderKind::Deepseek,
                        CloudProviderKind::CustomOpenAi => ProviderKind::CustomOpenai,
                    };
                }
            });
        });

        ui.add_space(8.0);

        // Details based on active provider
        let p = self.draft_config.active_provider;
        if p == ProviderKind::OxideNative {
            card_frame().show(ui, |ui| {
                ui.label(egui::RichText::new("Oxide Native Engine Configuration").strong().color(TEXT_PRIMARY));
                ui.add_space(4.0);

                ui.horizontal(|ui| {
                    ui.label("Installed GGUF Model:");
                    let current_model = self.draft_config.oxide_native_model.clone().unwrap_or_default();
                    let mut selected = current_model.clone();

                    ComboBox::from_id_salt("native_model_combo")
                        .selected_text(if selected.is_empty() { "Select a model..." } else { &selected })
                        .show_ui(ui, |ui| {
                            for m in &self.available_gguf_models {
                                ui.selectable_value(&mut selected, m.clone(), m);
                            }
                        });

                    if selected != current_model && !selected.is_empty() {
                        self.draft_config.oxide_native_model = Some(selected.clone());
                        self.draft_config.task_routing.architect_model = selected;
                    }

                    if ui.small_button("Rescan").clicked() {
                        self.refresh_available_models();
                    }
                });

                ui.add_space(4.0);

                ui.horizontal(|ui| {
                    ui.label("Local Server Port:");
                    let mut port = self.draft_config.oxide_native_port.unwrap_or(11435);
                    if ui.add(DragValue::new(&mut port).range(1024..=65535)).changed() {
                        self.draft_config.oxide_native_port = Some(port);
                    }
                });
            });
        } else if p == ProviderKind::Ollama {
            card_frame().show(ui, |ui| {
                ui.label(egui::RichText::new("Ollama Server Configuration").strong().color(TEXT_PRIMARY));
                ui.add_space(4.0);

                ui.horizontal(|ui| {
                    ui.label("Ollama Base URL:");
                    ui.text_edit_singleline(&mut self.draft_config.ollama_base_url);
                });

                ui.add_space(4.0);

                ui.horizontal(|ui| {
                    ui.label("Ollama Model Tag:");
                    ui.text_edit_singleline(&mut self.draft_config.ollama_model);
                });
            });
        } else {
            // Cloud Provider Tabs
            card_frame().show(ui, |ui| {
                ui.label(egui::RichText::new("Cloud API Configuration").strong().color(TEXT_PRIMARY));
                ui.add_space(4.0);

                ui.horizontal(|ui| {
                    let sub = self.cloud_provider_subtab;
                    if ui.selectable_label(sub == CloudProviderKind::Anthropic, "Anthropic Claude").clicked() {
                        self.cloud_provider_subtab = CloudProviderKind::Anthropic;
                        self.draft_config.active_provider = ProviderKind::Anthropic;
                    }
                    if ui.selectable_label(sub == CloudProviderKind::OpenAi, "OpenAI GPT").clicked() {
                        self.cloud_provider_subtab = CloudProviderKind::OpenAi;
                        self.draft_config.active_provider = ProviderKind::OpenAi;
                    }
                    if ui.selectable_label(sub == CloudProviderKind::Gemini, "Google Gemini").clicked() {
                        self.cloud_provider_subtab = CloudProviderKind::Gemini;
                        self.draft_config.active_provider = ProviderKind::Gemini;
                    }
                    if ui.selectable_label(sub == CloudProviderKind::DeepSeek, "DeepSeek API").clicked() {
                        self.cloud_provider_subtab = CloudProviderKind::DeepSeek;
                        self.draft_config.active_provider = ProviderKind::Deepseek;
                    }
                    if ui.selectable_label(sub == CloudProviderKind::CustomOpenAi, "Custom OpenAI Endpoint").clicked() {
                        self.cloud_provider_subtab = CloudProviderKind::CustomOpenAi;
                        self.draft_config.active_provider = ProviderKind::CustomOpenai;
                    }
                });

                ui.add_space(6.0);
                ui.separator();
                ui.add_space(6.0);

                match self.cloud_provider_subtab {
                    CloudProviderKind::Anthropic => {
                        Self::render_masked_key_input(
                            ui,
                            "Anthropic API Key:",
                            "anthropic_key",
                            &mut self.draft_config.anthropic_api_key,
                            self.reveal_keys.entry("anthropic".to_string()).or_insert(false),
                        );
                        ui.add_space(4.0);
                        ui.horizontal(|ui| {
                            ui.label("Model Name:");
                            ui.text_edit_singleline(&mut self.draft_config.anthropic_model);
                        });
                    }
                    CloudProviderKind::OpenAi => {
                        Self::render_masked_key_input(
                            ui,
                            "OpenAI API Key:",
                            "openai_key",
                            &mut self.draft_config.openai_api_key,
                            self.reveal_keys.entry("openai".to_string()).or_insert(false),
                        );
                        ui.add_space(4.0);
                        ui.horizontal(|ui| {
                            ui.label("Model Name:");
                            ui.text_edit_singleline(&mut self.draft_config.openai_model);
                        });
                    }
                    CloudProviderKind::Gemini => {
                        Self::render_masked_key_input(
                            ui,
                            "Gemini API Key:",
                            "gemini_key",
                            &mut self.draft_config.gemini_api_key,
                            self.reveal_keys.entry("gemini".to_string()).or_insert(false),
                        );
                        ui.add_space(4.0);
                        ui.horizontal(|ui| {
                            ui.label("Model Name:");
                            let mut model_str = self.draft_config.gemini_model.clone().unwrap_or_default();
                            if ui.text_edit_singleline(&mut model_str).changed() {
                                self.draft_config.gemini_model = Some(model_str);
                            }
                        });
                    }
                    CloudProviderKind::DeepSeek => {
                        Self::render_masked_key_input(
                            ui,
                            "DeepSeek API Key:",
                            "deepseek_key",
                            &mut self.draft_config.deepseek_api_key,
                            self.reveal_keys.entry("deepseek".to_string()).or_insert(false),
                        );
                        ui.add_space(4.0);
                        ui.horizontal(|ui| {
                            ui.label("Model Name:");
                            let mut model_str = self.draft_config.deepseek_model.clone().unwrap_or_default();
                            if ui.text_edit_singleline(&mut model_str).changed() {
                                self.draft_config.deepseek_model = Some(model_str);
                            }
                        });
                    }
                    CloudProviderKind::CustomOpenAi => {
                        ui.horizontal(|ui| {
                            ui.label("Custom Base URL:");
                            let mut url_str = self.draft_config.custom_openai_url.clone().unwrap_or_default();
                            if ui.text_edit_singleline(&mut url_str).changed() {
                                self.draft_config.custom_openai_url = Some(url_str);
                            }
                        });
                        ui.add_space(4.0);
                        ui.horizontal(|ui| {
                            ui.label("Custom Model Name:");
                            let mut model_str = self.draft_config.custom_openai_model.clone().unwrap_or_default();
                            if ui.text_edit_singleline(&mut model_str).changed() {
                                self.draft_config.custom_openai_model = Some(model_str);
                            }
                        });
                    }
                }
            });
        }

        ui.add_space(8.0);

        // Task Routing Matrix
        card_frame().show(ui, |ui| {
            ui.label(egui::RichText::new("Task-Specific Model Routing Matrix").strong().color(ACCENT_CYAN));
            ui.label(egui::RichText::new("Assign specific models to each agent role in the studio.").color(TEXT_MUTED).small());
            ui.add_space(4.0);

            ui.horizontal(|ui| {
                ui.label("Architect (Lead Orchestrator):");
                ui.text_edit_singleline(&mut self.draft_config.task_routing.architect_model);
            });
            ui.add_space(4.0);

            ui.horizontal(|ui| {
                ui.label("Coder Subagent:");
                ui.text_edit_singleline(&mut self.draft_config.task_routing.coder_subagent_model);
            });
            ui.add_space(4.0);

            ui.horizontal(|ui| {
                ui.label("Researcher Subagent:");
                ui.text_edit_singleline(&mut self.draft_config.task_routing.research_subagent_model);
            });
            ui.add_space(4.0);

            ui.horizontal(|ui| {
                ui.label("Tester Subagent:");
                ui.text_edit_singleline(&mut self.draft_config.task_routing.tester_subagent_model);
            });
        });
    }

    fn render_masked_key_input(
        ui: &mut Ui,
        label: &str,
        _field_id: &str,
        target_opt: &mut Option<String>,
        revealed: &mut bool,
    ) {
        ui.horizontal(|ui| {
            ui.label(label);
            let mut val = target_opt.clone().unwrap_or_default();
            let text_edit = egui::TextEdit::singleline(&mut val).password(!*revealed);
            if ui.add(text_edit).changed() {
                *target_opt = if val.trim().is_empty() {
                    None
                } else {
                    Some(val)
                };
            }

            let toggle_label = if *revealed { "Hide" } else { "Show" };
            if ui.small_button(toggle_label).clicked() {
                *revealed = !*revealed;
            }
        });
    }

    fn render_inference_tab(&mut self, ui: &mut Ui) {
        card_frame().show(ui, |ui| {
            ui.label(egui::RichText::new("Sampling & Inference Parameters").strong().color(ACCENT_BLUE));
            ui.add_space(4.0);

            ui.horizontal(|ui| {
                ui.label("Temperature:");
                ui.add(
                    Slider::new(&mut self.draft_config.temperature, 0.0..=1.0)
                        .step_by(0.05)
                        .text("Creativity / Randomness"),
                );
            });
            ui.label(
                egui::RichText::new("Values <= 0.2 yield deterministic code generation; values >= 0.7 increase creative solutions.")
                    .color(TEXT_MUTED)
                    .small(),
            );
        });

        ui.add_space(8.0);

        card_frame().show(ui, |ui| {
            ui.label(egui::RichText::new("Context Window Limit").strong().color(ACCENT_CYAN));
            ui.label(egui::RichText::new("Controls max token context provided to the model during execution.").color(TEXT_MUTED).small());
            ui.add_space(4.0);

            ui.horizontal(|ui| {
                ui.label("Context Limit:");
                ui.add(
                    Slider::new(&mut self.draft_config.context_limit, 4096..=131072)
                        .step_by(1024.0)
                        .text("Tokens"),
                );
            });

            ui.add_space(4.0);

            ui.horizontal(|ui| {
                ui.label("Quick Presets:");
                for preset in [4096, 8192, 16384, 32768, 65536, 131072] {
                    let label = if preset == 8192 {
                        format!("{} (Default)", preset)
                    } else {
                        preset.to_string()
                    };
                    if ui.selectable_label(self.draft_config.context_limit == preset, label).clicked() {
                        self.draft_config.context_limit = preset;
                    }
                }
            });
        });

        ui.add_space(8.0);

        card_frame().show(ui, |ui| {
            ui.label(egui::RichText::new("Fault Tolerance & Fallback").strong().color(TEXT_PRIMARY));
            ui.add_space(4.0);

            ui.checkbox(
                &mut self.draft_config.enable_cloud_fallback,
                "Enable Cloud Fallback (auto-retry on cloud if local native engine experiences OOM or errors)",
            );
        });
    }

    fn render_hardware_tab(&mut self, ui: &mut Ui) {
        card_frame().show(ui, |ui| {
            ui.label(egui::RichText::new("Hardware Acceleration Mode").strong().color(ACCENT_BLUE));
            ui.label(egui::RichText::new("Specifies backend compute acceleration API for transformer layers.").color(TEXT_MUTED).small());
            ui.add_space(4.0);

            let mut mode = self.draft_config.hardware_acceleration;
            let current_label = match mode {
                HardwareAccelerationMode::Auto => "Auto (Best Detected GPU)",
                HardwareAccelerationMode::NvidiaCuda => "NVIDIA CUDA Acceleration",
                HardwareAccelerationMode::AmdRocm => "AMD Radeon ROCm Acceleration",
                HardwareAccelerationMode::IntelGpu => "Intel GPU (oneAPI)",
                HardwareAccelerationMode::DirectMl => "DirectML (Windows Hardware)",
                HardwareAccelerationMode::Cpu => "CPU Only (No GPU)",
            };

            ComboBox::from_id_salt("hw_mode_combo")
                .selected_text(current_label)
                .show_ui(ui, |ui| {
                    ui.selectable_value(&mut mode, HardwareAccelerationMode::Auto, "Auto (Best Detected GPU)");
                    ui.selectable_value(&mut mode, HardwareAccelerationMode::NvidiaCuda, "NVIDIA CUDA Acceleration");
                    ui.selectable_value(&mut mode, HardwareAccelerationMode::AmdRocm, "AMD Radeon ROCm Acceleration");
                    ui.selectable_value(&mut mode, HardwareAccelerationMode::IntelGpu, "Intel GPU (oneAPI)");
                    ui.selectable_value(&mut mode, HardwareAccelerationMode::DirectMl, "DirectML (Windows Hardware)");
                    ui.selectable_value(&mut mode, HardwareAccelerationMode::Cpu, "CPU Only (No GPU)");
                });

            self.draft_config.hardware_acceleration = mode;
        });

        ui.add_space(8.0);

        card_frame().show(ui, |ui| {
            ui.label(egui::RichText::new("Hybrid Split GPU Layer Offloading").strong().color(ACCENT_CYAN));
            ui.label(egui::RichText::new("Split massive transformer layers between GPU VRAM and CPU System RAM.").color(TEXT_MUTED).small());
            ui.add_space(4.0);

            let mut policy = self.draft_config.gpu_offload_policy;
            let policy_label = match policy {
                GpuOffloadPolicy::FullGpu => "Full GPU (Offload all layers)",
                GpuOffloadPolicy::HybridSplit => "Dynamic Hybrid Split (Auto-balanced)",
                GpuOffloadPolicy::CustomLayers => "Custom Layer Count (Manual)",
                GpuOffloadPolicy::CpuOnly => "CPU Only (0 layers on GPU)",
            };

            ComboBox::from_id_salt("gpu_policy_combo")
                .selected_text(policy_label)
                .show_ui(ui, |ui| {
                    ui.selectable_value(&mut policy, GpuOffloadPolicy::FullGpu, "Full GPU (Offload all layers)");
                    ui.selectable_value(&mut policy, GpuOffloadPolicy::HybridSplit, "Dynamic Hybrid Split (Auto-balanced)");
                    ui.selectable_value(&mut policy, GpuOffloadPolicy::CustomLayers, "Custom Layer Count (Manual)");
                    ui.selectable_value(&mut policy, GpuOffloadPolicy::CpuOnly, "CPU Only (0 layers on GPU)");
                });

            self.draft_config.gpu_offload_policy = policy;

            ui.add_space(6.0);

            let can_edit_layers = policy == GpuOffloadPolicy::CustomLayers || policy == GpuOffloadPolicy::HybridSplit;
            ui.add_enabled_ui(can_edit_layers, |ui| {
                ui.horizontal(|ui| {
                    ui.label("GPU Offload Layers:");
                    ui.add(
                        Slider::new(&mut self.draft_config.gpu_offload_layers, 0..=128)
                            .text("Layers to VRAM"),
                    );
                });
            });

            if policy == GpuOffloadPolicy::FullGpu {
                ui.label(egui::RichText::new("Full GPU offload sends 99 layers directly to VRAM for maximum speed.").color(TEXT_MUTED).small());
            } else if policy == GpuOffloadPolicy::CpuOnly {
                ui.label(egui::RichText::new("CPU Only keeps 0 layers on GPU, preserving VRAM for other apps.").color(TEXT_MUTED).small());
            }
        });
    }

    fn render_governor_tab(&mut self, ui: &mut Ui) {
        card_frame().show(ui, |ui| {
            ui.label(egui::RichText::new("Subagent Concurrency Governor").strong().color(ACCENT_BLUE));
            ui.label(egui::RichText::new("Regulates concurrent worker threads and subagents to prevent host lockup.").color(TEXT_MUTED).small());
            ui.add_space(4.0);

            ui.checkbox(
                &mut self.draft_config.enable_subagents,
                "Enable Autonomous Subagents (Architect can delegate subtasks)",
            );

            ui.add_space(4.0);

            ui.add_enabled_ui(self.draft_config.enable_subagents, |ui| {
                ui.horizontal(|ui| {
                    ui.label("Max Concurrent Subagents:");
                    ui.add(
                        Slider::new(&mut self.draft_config.max_concurrent_subagents, 1..=16)
                            .text("Workers"),
                    );
                });
            });

            ui.add_space(4.0);

            ui.checkbox(
                &mut self.draft_config.auto_throttle_on_high_load,
                "Auto-Throttle on High Load (reduce concurrency if RAM > 85% or CPU > 88%)",
            );
        });

        ui.add_space(8.0);

        card_frame().show(ui, |ui| {
            ui.label(egui::RichText::new("Workspace Sandbox & Security Mode").strong().color(ACCENT_AMBER));
            ui.add_space(4.0);

            let mut sec_mode = self.draft_config.security_mode;
            let mode_label = match sec_mode {
                SecurityReviewMode::Turbo => "Turbo (Autonomous execution)",
                SecurityReviewMode::Auto => "Auto (Heuristic evaluation)",
                SecurityReviewMode::Default => "Default (Prompt on sensitive actions)",
                SecurityReviewMode::RequestReview => "Request Review (Confirm all mutations)",
            };

            ComboBox::from_id_salt("sec_mode_combo")
                .selected_text(mode_label)
                .show_ui(ui, |ui| {
                    ui.selectable_value(&mut sec_mode, SecurityReviewMode::Turbo, "Turbo (Autonomous execution)");
                    ui.selectable_value(&mut sec_mode, SecurityReviewMode::Auto, "Auto (Heuristic evaluation)");
                    ui.selectable_value(&mut sec_mode, SecurityReviewMode::Default, "Default (Prompt on sensitive actions)");
                    ui.selectable_value(&mut sec_mode, SecurityReviewMode::RequestReview, "Request Review (Confirm all mutations)");
                });
            self.draft_config.security_mode = sec_mode;

            ui.add_space(4.0);

            ui.checkbox(
                &mut self.draft_config.enforce_workspace_sandbox,
                "Enforce Workspace Sandbox (restrict all command and file I/O to project directory)",
            );

            ui.add_space(4.0);

            ui.checkbox(
                &mut self.draft_config.allow_internet_access,
                "Allow Internet Access (enable subagents to search and download packages)",
            );
        });
    }

    /// Renders Settings as a modal window overlay
    pub fn render_modal(
        &mut self,
        ctx: &egui::Context,
        is_open: &mut bool,
        state: Arc<AppState>,
        tokio_handle: &tokio::runtime::Handle,
    ) {
        if !*is_open {
            return;
        }

        let mut open = true;
        egui::Window::new("Settings")
            .open(&mut open)
            .default_size([720.0, 540.0])
            .resizable(true)
            .collapsible(false)
            .show(ctx, |ui| {
                self.render_content(ui, state, tokio_handle);
            });

        if !open {
            *is_open = false;
        }
    }
}
