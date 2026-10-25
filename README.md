# Oxide Studio — Autonomous AI Coding Agent GUI

Oxide Studio is a local-first, Antigravity-style desktop GUI for running autonomous software engineering workflows offline with **Ollama** (`qwen2.5-coder`, `gemma2`, `deepseek-r1`) or hybrid cloud models (**Claude** / **OpenAI**).

- **Documentation Portal (GitHub Pages)**: [https://hanzkii.github.io/Oxide/](https://hanzkii.github.io/Oxide/)
- **Download Standalone Windows Installer (`.exe` / `.msi`)**: [https://github.com/Hanzkii/Oxide/releases/latest](https://github.com/Hanzkii/Oxide/releases/latest)

---

## 1. Easy Ways to Start Oxide

### Option A: Download the Standalone Installer / Executable (Zero Setup)
Every push to `main` automatically builds the Windows installer and portable `.exe` via GitHub Actions:
1. Open **[GitHub Releases](https://github.com/Hanzkii/Oxide/releases/latest)**.
2. Download **`Oxide_0.1.0_x64-setup.exe`** (Windows Installer) or **`Oxide-Portable.exe`** (Portable Single-File Executable).
3. Double-click to launch **Oxide Studio**.

### Option B: Double-Click `start-oxide.bat`
If you have the repository folder on your computer, simply double-click **`start-oxide.bat`**:
- If `Oxide-Portable.exe` is present, it launches the native binary directly.
- Otherwise, it launches a standalone desktop GUI window (`--app=http://localhost:1420`) backed by the local system bridge so all features work immediately without needing to install a Rust compiler first.

---

## 2. Key GUI Features

1. **🤖 Hierarchical Lead Architect + Specialized Subagents**:
   - **Lead Architect AI (Large Model)**: Handles complex architectural reasoning, task decomposition, and giving instructions to faster Subagents via `delegate_subagents`.
   - **Specialized Fast Subagents**:
     - `coder_subagent`: Fast file creation & code editing (`qwen2.5-coder:7b` / `3b`).
     - `research_subagent`: Fast file search & directory exploration (`gemma2:latest`).
     - `tester_subagent`: Terminal execution & compiler/test error repair.

2. **⚙ Task-to-Model Routing & ✨ Auto-Configure for My PC**:
   - Open **⚙ Subagents & Models** in the top bar to choose which exact AI model runs each role (`Architect`, `Coder Subagent`, `Research Subagent`, `Tester Subagent`), or click **✨ Auto-Configure for My PC** to automatically assign models based on your PC's RAM & GPU VRAM.

3. **🖥 PC Hardware Resource Governor & Subagent Concurrency Limiter**:
   - Continuously inspects your PC's **CPU cores & live CPU %**, **Free RAM / Total RAM (GB)**, and **GPU VRAM (GB)** (`src-tauri/src/hardware.rs`).
   - Enforces a strict hardware concurrency ceiling (`tokio::sync::Semaphore`) so you can never spawn more concurrent subagents than your PC can safely handle, and automatically throttles to `1` sequential subagent if RAM usage exceeds 85% or CPU exceeds 88%.

4. **↻ One-Click "Update from GitHub" Button**:
   - Located in the top-right header (`↻ Update`).
   - Checks `https://github.com/Hanzkii/Oxide` for new releases or commits on `main`, displays the latest commit message and version, and updates your installation with one click.

5. **🧠 Live AI Thinking & Current Activity Panel**:
   - Always visible at the top of the center pane.
   - Streams the AI's internal `<think>...</think>` reasoning and numbered **Task Plan Checklist** in real time alongside the **Subagent Worker Pool** on the right.
