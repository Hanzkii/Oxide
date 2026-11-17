use crate::commands::agent::{
    resolve_models_dir, search_huggingface_gguf, HuggingFaceModelEntry,
};
use crate::gui::state::*;
use crate::gui::theme::*;
use crate::llm::ProviderKind;
use crate::AppState;
use eframe::egui::{self, ProgressBar, ScrollArea, Ui};
use futures_util::StreamExt;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;

pub struct CuratedModelEntry {
    pub name: &'static str,
    pub repo_id: &'static str,
    pub params: &'static str,
    pub size_gb: &'static str,
    pub min_ram_gb: &'static str,
    pub badge: &'static str,
    pub description: &'static str,
}

pub const CURATED_MODELS: &[CuratedModelEntry] = &[
    CuratedModelEntry {
        name: "Qwen 2.5 Coder 7B (Abliterated)",
        repo_id: "bartowski/Qwen2.5-Coder-7B-Instruct-abliterated-GGUF",
        params: "7B",
        size_gb: "4.7 GB",
        min_ram_gb: "8 GB",
        badge: "[Coding]",
        description: "Premier coding assistant with abliterated refusal tuning for unfiltered autonomous code generation.",
    },
    CuratedModelEntry {
        name: "Qwen 2.5 Coder 14B (Abliterated)",
        repo_id: "bartowski/Qwen2.5-Coder-14B-Instruct-abliterated-GGUF",
        params: "14B",
        size_gb: "9.0 GB",
        min_ram_gb: "16 GB",
        badge: "[Architect]",
        description: "Heavyweight engineering model for architectural decomposition, planning, and multi-file refactoring.",
    },
    CuratedModelEntry {
        name: "DeepSeek R1 Distill Qwen 7B",
        repo_id: "huihui-ai/DeepSeek-R1-Distill-Qwen-7B-abliterated-GGUF",
        params: "7B",
        size_gb: "4.7 GB",
        min_ram_gb: "8 GB",
        badge: "[Reasoning]",
        description: "Distilled reasoning model producing extensive verifiable thought chains for complex algorithmic problems.",
    },
    CuratedModelEntry {
        name: "DeepSeek R1 Distill Qwen 14B",
        repo_id: "huihui-ai/DeepSeek-R1-Distill-Qwen-14B-abliterated-GGUF",
        params: "14B",
        size_gb: "9.0 GB",
        min_ram_gb: "16 GB",
        badge: "[Reasoning]",
        description: "Large distillation model combining deep algorithmic step-by-step reasoning with structural design.",
    },
    CuratedModelEntry {
        name: "Qwen 2.5 Coder 1.5B (Ultra-Fast)",
        repo_id: "bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF",
        params: "1.5B",
        size_gb: "1.2 GB",
        min_ram_gb: "4 GB",
        badge: "[Subagent]",
        description: "Blazing fast subagent model ideal for high-throughput linting, testing, and isolated grep exploration.",
    },
    CuratedModelEntry {
        name: "DeepSeek Coder 6.7B Instruct",
        repo_id: "TheBloke/deepseek-coder-6.7B-instruct-GGUF",
        params: "6.7B",
        size_gb: "4.1 GB",
        min_ram_gb: "8 GB",
        badge: "[Coding]",
        description: "Battle-tested coding specialist with broad repository understanding and syntactical accuracy.",
    },
];

pub struct ModelHubView {
    pub search_query: String,
    pub is_searching: bool,
    pub search_results: Vec<HuggingFaceModelEntry>,
    pub search_rx: Option<tokio::sync::oneshot::Receiver<crate::error::OxideResult<Vec<HuggingFaceModelEntry>>>>,

    // Live Download Engine
    pub active_download: Option<ActiveDownloadTask>,
    pub download_rx: Option<tokio::sync::mpsc::UnboundedReceiver<ModelDownloadProgress>>,

    // Installed Models
    pub installed_models: Vec<InstalledModelItem>,
    pub status_message: Option<(String, bool)>, // (message, is_error)
}

impl Default for ModelHubView {
    fn default() -> Self {
        let mut view = Self {
            search_query: String::new(),
            is_searching: false,
            search_results: Vec::new(),
            search_rx: None,
            active_download: None,
            download_rx: None,
            installed_models: Vec::new(),
            status_message: None,
        };
        view.refresh_installed_models();
        view
    }
}

impl ModelHubView {
    pub fn refresh_installed_models(&mut self) {
        let mut list = Vec::new();
        let models_dir = resolve_models_dir();
        if let Ok(rd) = std::fs::read_dir(&models_dir) {
            for entry in rd.flatten() {
                let path = entry.path();
                if path.is_file() {
                    if let Some(ext) = path.extension() {
                        if ext.to_string_lossy().eq_ignore_ascii_case("gguf") {
                            if let Some(filename) = path.file_name().and_then(|n| n.to_str()) {
                                let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
                                let size_gb = (size_bytes as f32) / (1024.0 * 1024.0 * 1024.0);
                                list.push(InstalledModelItem {
                                    filename: filename.to_string(),
                                    path: path.clone(),
                                    size_gb: (size_gb * 100.0).round() / 100.0,
                                    is_active: false,
                                });
                            }
                        }
                    }
                }
            }
        }
        list.sort_by(|a, b| a.filename.to_lowercase().cmp(&b.filename.to_lowercase()));
        self.installed_models = list;
    }

    pub fn trigger_search(&mut self, query: String, tokio_handle: &tokio::runtime::Handle) {
        let q = query.trim().to_string();
        if q.is_empty() {
            return;
        }

        self.is_searching = true;
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.search_rx = Some(rx);

        tokio_handle.spawn(async move {
            let res = search_huggingface_gguf(q).await;
            let _ = tx.send(res);
        });
    }

    pub fn start_download(
        &mut self,
        model_id: String,
        display_name: String,
        state: Arc<AppState>,
        tokio_handle: &tokio::runtime::Handle,
    ) {
        if self.active_download.is_some() {
            self.status_message = Some((
                "Another download is already in progress. Wait or cancel first.".to_string(),
                true,
            ));
            return;
        }

        let cancel_flag = Arc::new(AtomicBool::new(false));
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<ModelDownloadProgress>();

        self.download_rx = Some(rx);
        self.active_download = Some(ActiveDownloadTask {
            model_id: model_id.clone(),
            display_name: display_name.clone(),
            progress: ModelDownloadProgress {
                model_id: model_id.clone(),
                status: "Resolving model repository...".to_string(),
                completed_bytes: 0,
                total_bytes: 0,
                percent: 0.0,
                speed_mb_s: 0.0,
                is_finished: false,
                error: None,
            },
            cancel_flag: cancel_flag.clone(),
        });

        let target_model_id = model_id;
        tokio_handle.spawn(async move {
            let res = Self::run_download_task(target_model_id, tx.clone(), cancel_flag, state).await;
            if let Err(e) = res {
                let _ = tx.send(ModelDownloadProgress {
                    model_id: String::new(),
                    status: "Download error".to_string(),
                    completed_bytes: 0,
                    total_bytes: 0,
                    percent: 0.0,
                    speed_mb_s: 0.0,
                    is_finished: true,
                    error: Some(format!("{}", e)),
                });
            }
        });
    }

    async fn run_download_task(
        model_id: String,
        tx: tokio::sync::mpsc::UnboundedSender<ModelDownloadProgress>,
        cancel_flag: Arc<AtomicBool>,
        state: Arc<AppState>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let models_dir = resolve_models_dir();
        tokio::fs::create_dir_all(&models_dir).await?;

        let trimmed = model_id.trim();
        let is_direct_url = trimmed.starts_with("http://") || trimmed.starts_with("https://");

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(7200))
            .user_agent("OxideStudio/0.1 (Windows NT 10.0; Win64; x64)")
            .build()?;

        let (download_url, local_filename) = if is_direct_url {
            let fname = Path::new(trimmed)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("model.gguf")
                .to_string();
            (trimmed.to_string(), fname)
        } else {
            let repo = trimmed.replace("hf.co/", "").replace("huggingface.co/", "");

            let _ = tx.send(ModelDownloadProgress {
                model_id: model_id.clone(),
                status: format!("Querying HuggingFace API for {}...", repo),
                completed_bytes: 0,
                total_bytes: 0,
                percent: 2.0,
                speed_mb_s: 0.0,
                is_finished: false,
                error: None,
            });

            let tree_url = format!("https://huggingface.co/api/models/{}/tree/main", repo);
            let tree_resp = client.get(&tree_url).send().await?;

            if !tree_resp.status().is_success() {
                return Err(format!("HuggingFace repository '{}' returned HTTP {}", repo, tree_resp.status()).into());
            }

            let file_list: Vec<serde_json::Value> = tree_resp.json().await.unwrap_or_default();
            let gguf_files: Vec<String> = file_list
                .iter()
                .filter_map(|f| {
                    let path = f.get("path").or_else(|| f.get("rfilename")).and_then(|v| v.as_str())?;
                    if path.to_lowercase().ends_with(".gguf") {
                        Some(path.to_string())
                    } else {
                        None
                    }
                })
                .collect();

            if gguf_files.is_empty() {
                return Err(format!("No .gguf model files found in repository '{}'", repo).into());
            }

            let chosen = gguf_files
                .iter()
                .find(|f| f.contains("Q4_K_M"))
                .or_else(|| gguf_files.iter().find(|f| f.contains("Q4_0")))
                .or_else(|| gguf_files.iter().find(|f| f.contains("Q5_K_M")))
                .or_else(|| gguf_files.iter().find(|f| f.contains("Q4_K_S")))
                .unwrap_or(&gguf_files[0])
                .clone();

            let durl = format!("https://huggingface.co/{}/resolve/main/{}", repo, chosen);
            (durl, chosen)
        };

        let temp_path = models_dir.join(format!("{}.download", local_filename));
        let final_path = models_dir.join(&local_filename);

        let _ = tx.send(ModelDownloadProgress {
            model_id: model_id.clone(),
            status: format!("Connecting to download {}...", local_filename),
            completed_bytes: 0,
            total_bytes: 0,
            percent: 5.0,
            speed_mb_s: 0.0,
            is_finished: false,
            error: None,
        });

        let resp = client.get(&download_url).send().await?;
        if !resp.status().is_success() {
            return Err(format!("Download stream returned HTTP {}", resp.status()).into());
        }

        let total_bytes = resp.content_length().unwrap_or(0);
        let mut downloaded_bytes: u64 = 0;
        let mut stream = resp.bytes_stream();

        let mut file = tokio::fs::File::create(&temp_path).await?;
        let mut last_tick = Instant::now();
        let mut last_bytes = 0u64;

        while let Some(chunk_res) = stream.next().await {
            if cancel_flag.load(Ordering::Relaxed) {
                drop(file);
                let _ = tokio::fs::remove_file(&temp_path).await;
                let _ = tx.send(ModelDownloadProgress {
                    model_id: model_id.clone(),
                    status: "Download cancelled by user.".to_string(),
                    completed_bytes: 0,
                    total_bytes: 0,
                    percent: 0.0,
                    speed_mb_s: 0.0,
                    is_finished: true,
                    error: Some("Download cancelled by user.".to_string()),
                });
                return Ok(());
            }

            let chunk = chunk_res?;
            file.write_all(&chunk).await?;
            downloaded_bytes += chunk.len() as u64;

            let elapsed = last_tick.elapsed();
            if elapsed >= Duration::from_millis(200) || downloaded_bytes == total_bytes {
                let bytes_diff = downloaded_bytes.saturating_sub(last_bytes);
                let speed_mb_s = (bytes_diff as f32 / (1024.0 * 1024.0)) / elapsed.as_secs_f32().max(0.001);
                last_tick = Instant::now();
                last_bytes = downloaded_bytes;

                let percent = if total_bytes > 0 {
                    ((downloaded_bytes as f64 / total_bytes as f64) * 100.0) as f32
                } else {
                    50.0
                };

                let mb_done = downloaded_bytes / (1024 * 1024);
                let mb_total = total_bytes / (1024 * 1024);
                let status_msg = if mb_total > 0 {
                    format!("Downloading {} ({} MB / {} MB)", local_filename, mb_done, mb_total)
                } else {
                    format!("Downloading {} ({} MB)", local_filename, mb_done)
                };

                let _ = tx.send(ModelDownloadProgress {
                    model_id: model_id.clone(),
                    status: status_msg,
                    completed_bytes: downloaded_bytes,
                    total_bytes,
                    percent,
                    speed_mb_s,
                    is_finished: false,
                    error: None,
                });
            }
        }

        file.flush().await?;
        drop(file);

        if final_path.exists() {
            let _ = tokio::fs::remove_file(&final_path).await;
        }
        tokio::fs::rename(&temp_path, &final_path).await?;

        // Update provider configuration
        {
            let mut cfg_guard = state.provider_config.write().await;
            cfg_guard.oxide_native_model = Some(local_filename.clone());
            cfg_guard.task_routing.architect_model = local_filename.clone();
            if cfg_guard.active_provider == ProviderKind::Ollama {
                cfg_guard.active_provider = ProviderKind::OxideNative;
            }
            let _ = crate::commands::agent::save_provider_config(&cfg_guard);
        }

        let _ = tx.send(ModelDownloadProgress {
            model_id: model_id.clone(),
            status: format!("Successfully installed {}!", local_filename),
            completed_bytes: total_bytes,
            total_bytes,
            percent: 100.0,
            speed_mb_s: 0.0,
            is_finished: true,
            error: None,
        });

        Ok(())
    }

    pub fn update(&mut self, ctx: &egui::Context) {
        // Poll search receiver
        if let Some(mut rx) = self.search_rx.take() {
            match rx.try_recv() {
                Ok(res) => {
                    self.is_searching = false;
                    match res {
                        Ok(entries) => {
                            self.search_results = entries;
                            self.status_message = None;
                        }
                        Err(e) => {
                            self.status_message = Some((format!("Search failed: {}", e), true));
                        }
                    }
                }
                Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {
                    self.search_rx = Some(rx);
                    ctx.request_repaint();
                }
                Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                    self.is_searching = false;
                }
            }
        }

        // Poll download receiver
        if let Some(ref mut rx) = self.download_rx {
            while let Ok(prog) = rx.try_recv() {
                ctx.request_repaint();
                if let Some(ref mut task) = self.active_download {
                    task.progress = prog.clone();
                }

                if prog.is_finished {
                    if let Some(err) = prog.error {
                        self.status_message = Some((format!("Download failed: {}", err), true));
                    } else {
                        self.status_message = Some((
                            "Model downloaded and installed successfully!".to_string(),
                            false,
                        ));
                    }
                    self.active_download = None;
                    self.download_rx = None;
                    self.refresh_installed_models();
                    break;
                }
            }
        }
    }

    pub fn render(
        &mut self,
        ui: &mut Ui,
        ctx: &egui::Context,
        state: Arc<AppState>,
        tokio_handle: &tokio::runtime::Handle,
    ) {
        self.update(ctx);

        let active_native_model = {
            state.provider_config.blocking_read().oxide_native_model.clone()
        };

        // Mark installed models as active
        for item in &mut self.installed_models {
            item.is_active = active_native_model.as_deref() == Some(&item.filename);
        }

        ui.vertical(|ui| {
            // Header Bar
            ui.horizontal(|ui| {
                ui.label(
                    egui::RichText::new("1-Click Model Installer Hub")
                        .heading()
                        .color(TEXT_PRIMARY),
                );
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.button("Open Models Folder").clicked() {
                        let _ = crate::commands::agent::open_native_models_folder();
                    }
                    if ui.button("Refresh Installed").clicked() {
                        self.refresh_installed_models();
                    }
                });
            });

            ui.add_space(4.0);
            ui.label(
                egui::RichText::new("Search, download, and manage GGUF models directly from HuggingFace and local storage.")
                    .color(TEXT_MUTED)
                    .small(),
            );

            // Active Download Progress Bar Widget
            if let Some(ref task) = self.active_download {
                ui.add_space(6.0);
                highlighted_card_frame().show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.add(egui::Spinner::new());
                        ui.label(
                            egui::RichText::new(&task.display_name)
                                .strong()
                                .color(TEXT_PRIMARY),
                        );
                        ui.label(
                            egui::RichText::new(format!("{:.1}%", task.progress.percent))
                                .strong()
                                .color(ACCENT_BLUE),
                        );

                        if task.progress.speed_mb_s > 0.0 {
                            ui.label(
                                egui::RichText::new(format!("({:.1} MB/s)", task.progress.speed_mb_s))
                                    .color(ACCENT_CYAN)
                                    .small(),
                            );
                        }

                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if ui.button("Cancel Download").clicked() {
                                task.cancel_flag.store(true, Ordering::Relaxed);
                            }
                        });
                    });

                    ui.add_space(4.0);

                    let progress_fraction = (task.progress.percent / 100.0).clamp(0.0, 1.0);
                    let bar = ProgressBar::new(progress_fraction)
                        .show_percentage()
                        .animate(true);
                    ui.add(bar);

                    ui.add_space(2.0);
                    ui.label(
                        egui::RichText::new(&task.progress.status)
                            .color(TEXT_MUTED)
                            .small(),
                    );
                });
            }

            if let Some((ref msg, is_err)) = self.status_message {
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

            // Search Bar & Filter Chips
            card_frame().show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.label(egui::RichText::new("Search Models:").strong());

                    let text_edit = egui::TextEdit::singleline(&mut self.search_query)
                        .hint_text("Search HuggingFace GGUF models (e.g. qwen, deepseek, coder)...")
                        .desired_width(ui.available_width() - 120.0);

                    let response = ui.add(text_edit);
                    let enter_pressed = response.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));

                    if (ui.button("Search").clicked() || enter_pressed) && !self.is_searching {
                        let q = self.search_query.clone();
                        self.trigger_search(q, tokio_handle);
                    }

                    if self.is_searching {
                        ui.add(egui::Spinner::new());
                    }
                });

                ui.add_space(6.0);

                // Quick Search Chips
                ui.horizontal(|ui| {
                    ui.label(egui::RichText::new("Quick Filters:").small().color(TEXT_MUTED));

                    if ui.selectable_label(false, "[All Coding]").clicked() {
                        self.search_query = "coder gguf".to_string();
                        self.trigger_search(self.search_query.clone(), tokio_handle);
                    }
                    if ui.selectable_label(false, "[Qwen 2.5]").clicked() {
                        self.search_query = "qwen2.5-coder gguf".to_string();
                        self.trigger_search(self.search_query.clone(), tokio_handle);
                    }
                    if ui.selectable_label(false, "[DeepSeek R1]").clicked() {
                        self.search_query = "deepseek-r1 gguf".to_string();
                        self.trigger_search(self.search_query.clone(), tokio_handle);
                    }
                    if ui.selectable_label(false, "[Abliterated]").clicked() {
                        self.search_query = "abliterated gguf".to_string();
                        self.trigger_search(self.search_query.clone(), tokio_handle);
                    }
                    if ui.selectable_label(false, "[Fast Subagents]").clicked() {
                        self.search_query = "qwen2.5 1.5B gguf".to_string();
                        self.trigger_search(self.search_query.clone(), tokio_handle);
                    }
                });
            });

            ui.add_space(8.0);

            // Two-column or tabbed views: Installed Models & Curated / Search Results
            ScrollArea::vertical()
                .auto_shrink([false, false])
                .show(ui, |ui| {
                    // 1. INSTALLED MODELS SECTION
                    ui.label(
                        egui::RichText::new("Installed GGUF Models")
                            .strong()
                            .color(ACCENT_BLUE),
                    );
                    ui.add_space(4.0);

                    if self.installed_models.is_empty() {
                        card_frame().show(ui, |ui| {
                            ui.label(
                                egui::RichText::new("No GGUF models found in your models directory.\nClick 1-Click Install below to download a model.")
                                    .color(TEXT_MUTED)
                                    .small(),
                            );
                        });
                    } else {
                        let mut model_to_delete = None;
                        let mut model_to_activate = None;

                        for item in &self.installed_models {
                            card_frame().show(ui, |ui| {
                                ui.horizontal(|ui| {
                                    if item.is_active {
                                        ascii_badge(ui, "[ACTIVE]", ACCENT_GREEN);
                                    } else {
                                        ascii_badge(ui, "[INSTALLED]", TEXT_MUTED);
                                    }

                                    ui.label(
                                        egui::RichText::new(&item.filename)
                                            .strong()
                                            .color(TEXT_PRIMARY),
                                    );

                                    ui.label(
                                        egui::RichText::new(format!("({:.2} GB)", item.size_gb))
                                            .color(TEXT_MUTED)
                                            .small(),
                                    );

                                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                        if ui.button("Delete").clicked() {
                                            model_to_delete = Some(item.path.clone());
                                        }

                                        if !item.is_active {
                                            if ui.button("Set as Active").clicked() {
                                                model_to_activate = Some(item.filename.clone());
                                            }
                                        }
                                    });
                                });
                            });
                            ui.add_space(4.0);
                        }

                        if let Some(path) = model_to_delete {
                            match std::fs::remove_file(&path) {
                                Ok(_) => {
                                    self.refresh_installed_models();
                                    self.status_message = Some(("Model deleted successfully.".to_string(), false));
                                }
                                Err(e) => {
                                    self.refresh_installed_models();
                                    self.status_message = Some((
                                        format!(
                                            "Cannot delete model: file is locked by running engine. Stop engine first. ({})",
                                            e
                                        ),
                                        true,
                                    ));
                                }
                            }
                        }

                        if let Some(filename) = model_to_activate {
                            let mut cfg_guard = state.provider_config.blocking_write();
                            cfg_guard.oxide_native_model = Some(filename.clone());
                            cfg_guard.task_routing.architect_model = filename.clone();
                            cfg_guard.active_provider = ProviderKind::OxideNative;
                            let _ = crate::commands::agent::save_provider_config(&cfg_guard);
                            drop(cfg_guard);
                            self.refresh_installed_models();
                            self.status_message = Some((
                                format!("Active model set to {}", filename),
                                false,
                            ));
                        }
                    }

                    ui.add_space(10.0);
                    ui.separator();
                    ui.add_space(6.0);

                    let mut to_download = None;

                    // 2. LIVE SEARCH RESULTS OR CURATED CATALOG
                    if !self.search_results.is_empty() {
                        ui.label(
                            egui::RichText::new(format!("Search Results ({} models found)", self.search_results.len()))
                                .strong()
                                .color(ACCENT_CYAN),
                        );
                        ui.add_space(4.0);

                        for item in &self.search_results {
                            card_frame().show(ui, |ui| {
                                ui.horizontal(|ui| {
                                    ascii_badge(ui, &format!("[{}]", item.params), ACCENT_BLUE);

                                    if item.is_coding {
                                        ascii_badge(ui, "[Coding]", ACCENT_GREEN);
                                    }
                                    if item.is_reasoning {
                                        ascii_badge(ui, "[Reasoning]", ACCENT_PURPLE);
                                    }
                                    if item.is_uncensored {
                                        ascii_badge(ui, "[Uncensored]", ACCENT_AMBER);
                                    }

                                    ui.label(
                                        egui::RichText::new(&item.name)
                                            .strong()
                                            .color(TEXT_PRIMARY),
                                    );

                                    ui.label(
                                        egui::RichText::new(format!(
                                            "{} | RAM: {} GB",
                                            item.size_gb, item.min_ram_gb
                                        ))
                                        .color(TEXT_MUTED)
                                        .small(),
                                    );

                                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                        let is_downloading_this = self.active_download.as_ref().map(|d| d.model_id == item.install_id).unwrap_or(false);
                                        if is_downloading_this {
                                            ui.add(egui::Spinner::new());
                                        } else if ui.button("1-Click Install").clicked() {
                                            to_download = Some((item.install_id.clone(), item.name.clone()));
                                        }
                                    });
                                });

                                ui.add_space(2.0);
                                ui.label(
                                    egui::RichText::new(&item.summary)
                                        .color(TEXT_SECONDARY)
                                        .small(),
                                );
                            });
                            ui.add_space(4.0);
                        }
                    } else {
                        // Curated Catalog
                        ui.label(
                            egui::RichText::new("Curated Verified Models Catalog")
                                .strong()
                                .color(ACCENT_CYAN),
                        );
                        ui.add_space(4.0);

                        for cur in CURATED_MODELS {
                            card_frame().show(ui, |ui| {
                                ui.horizontal(|ui| {
                                    ascii_badge(ui, cur.badge, ACCENT_BLUE);
                                    ascii_badge(ui, &format!("[{}]", cur.params), ACCENT_CYAN);

                                    ui.label(
                                        egui::RichText::new(cur.name)
                                            .strong()
                                            .color(TEXT_PRIMARY),
                                    );

                                    ui.label(
                                        egui::RichText::new(format!("{} | Min RAM: {}", cur.size_gb, cur.min_ram_gb))
                                            .color(TEXT_MUTED)
                                            .small(),
                                    );

                                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                        let is_downloading_this = self.active_download.as_ref().map(|d| d.model_id == cur.repo_id).unwrap_or(false);
                                        if is_downloading_this {
                                            ui.add(egui::Spinner::new());
                                        } else if ui.button("1-Click Install").clicked() {
                                            to_download = Some((cur.repo_id.to_string(), cur.name.to_string()));
                                        }
                                    });
                                });

                                ui.add_space(2.0);
                                ui.label(
                                    egui::RichText::new(cur.description)
                                        .color(TEXT_SECONDARY)
                                        .small(),
                                );
                            });
                            ui.add_space(4.0);
                        }
                    }

                    if let Some((id, name)) = to_download {
                        self.start_download(id, name, state.clone(), tokio_handle);
                    }
                });
        });
    }
}
