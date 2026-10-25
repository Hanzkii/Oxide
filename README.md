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

1. **↻ One-Click "Update from GitHub" Button**:
   - Located in the top-right header (`↻ Update`).
   - Checks `https://github.com/Hanzkii/Oxide` for new releases or commits on `main`, displays the latest commit message and version, and updates your installation with one click.

2. **🧠 Live AI Thinking & Current Activity Panel**:
   - Always visible at the top of the center pane.
   - Streams the AI's internal `<think>...</think>` reasoning and numbered **Task Plan Checklist** in real time so you can see exactly what the agent is thinking and doing at every step.

3. **⚙ Visual Models & Settings Modal**:
   - Auto-detects all models installed in your local Ollama instance (`localhost:11434/api/tags`).
   - Change models, set custom model tags, adjust temperature, or switch between Local Ollama, Anthropic Claude, and OpenAI directly in the GUI.

4. **📁 Interactive File Explorer & Built-in Editor**:
   - Browse workspace folders in the left sidebar, click any file to view/edit/save it, create new files (`+ File`), move/rename files, or delete files.

5. **🤖 Full Antigravity-Grade Autonomous Tool Suite**:
   - The AI agent can autonomously execute:
     - `list_dir` & `search_files` (workspace exploration & code search)
     - `read_file`, `write_file`, `edit_file` (create and surgically edit files)
     - `move_file` & `delete_file` (reorganize and clean up files)
     - `run_command` (execute terminal commands with automatic `stderr` self-correction)
     - `git_action` (`pull`, `push`, `commit`, `diff`, `status`)
     - `open_in_vscode` (open files or workspace in Visual Studio Code)
