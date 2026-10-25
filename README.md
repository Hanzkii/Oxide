# Oxide — Local-First Autonomous AI Coding Agent

Oxide is a fast, offline-first desktop command center built with **Tauri v2**, **Rust**, and **React 18 / TypeScript** for running autonomous software engineering workflows on local hardware.

- **Documentation Portal (GitHub Pages)**: [https://hanzkii.github.io/Oxide/](https://hanzkii.github.io/Oxide/)
- **Getting Started & Launch Guide**: [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)
- **Workspace & Security Blueprint**: [docs/WORKSPACE_BLUEPRINT.md](docs/WORKSPACE_BLUEPRINT.md)

---

## How to Open & Run Oxide

### 1. Prerequisites (First-Time Setup)
1. **Node.js (v18+)**: [https://nodejs.org](https://nodejs.org)
2. **Rust Toolchain (`rustup` / `cargo`)**: [https://rustup.rs](https://rustup.rs) (plus MSVC C++ build tools on Windows)
3. **Ollama (Local LLM Daemon)**: [https://ollama.com](https://ollama.com)
   ```bash
   ollama pull qwen2.5-coder:latest
   ollama serve
   ```

### 2. Choose How to Launch

#### Option A: One-Click Windows Launcher (`start-oxide.bat`)
Double-click **`start-oxide.bat`** in the project folder (or run it in PowerShell/CMD):
```powershell
.\start-oxide.bat
```
- Automatically installs `node_modules` if missing.
- Launches the native **Oxide Desktop Window** via Tauri v2 (or automatically falls back to the browser UI preview at `http://localhost:1420` if Rust/Cargo is not yet installed).

#### Option B: Launch Native Desktop App via Terminal (Development Mode)
```bash
npm install
npm start
# (alias for: npm run tauri dev)
```

#### Option C: Build Standalone Native Desktop Executable (`.exe` / `.msi` / `.dmg`)
```bash
npm run desktop:build
# (alias for: npm run tauri build)
```
- **Portable Executable**: `src-tauri/target/release/oxide-agent.exe`
- **Windows Installers**: `src-tauri/target/release/bundle/msi/` and `src-tauri/target/release/bundle/nsis/`

#### Option D: Browser UI Preview Only (No Rust Compiler Required)
```bash
npm run dev
```
Then open **`http://localhost:1420`** in your browser.

---

## Core Architecture

1. **Tauri v2 + Rust Core**:
   - Minimal memory footprint and instant startup without Electron overhead.
   - Strict separation of concerns: the React/TypeScript frontend renders real-time token streams, terminal logs, and workflow status cards, while the Rust backend enforces filesystem/process sandboxing, LLM routing, and Git orchestration.

2. **Hybrid Local & Cloud LLM Provider Layer (`src-tauri/src/llm/`)**:
   - Routes all inference by default to a local **Ollama** instance (`http://localhost:11434`) running `qwen2.5-coder` or `gemma2` with low-latency NDJSON streaming.
   - Implements a unified `LlmProvider` async trait (`OllamaProvider`, `AnthropicProvider`, `OpenAiProvider`) orchestrated by `HybridProviderRouter`, allowing seamless switching or cloud fallback via `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`.

3. **Defense-in-Depth Terminal Sandbox & Self-Correction Loop (`src-tauri/src/security/` & `src-tauri/src/orchestrator/`)**:
   - **No Shell Interpolation**: Commands are tokenized and spawned directly via `tokio::process::Command` without `sh -c` or `cmd /C`. Shell chaining tokens (`&&`, `||`, `;`, `|`, `` ` ``, `$()`) are rejected.
   - **Canonical Workspace Jail**: Uses `dunce::canonicalize` to resolve symlinks and block `../` path traversal outside the bound workspace directory.
   - **Credential Scrubbing**: Automatically strips cloud API keys and SSH agent variables from child processes.
   - **Autonomous Self-Correction**: Non-zero exit codes and `stderr` streams are captured into structured `[TERMINAL_OBSERVATION]` blocks and fed back into the agent loop for automatic compiler/test error repair.
   - **Automated Git Milestones**: Initializes repositories, stages changes, and generates Conventional Commit messages upon milestone completion.

4. **External Editor Integration ("Open in VS Code")**:
   - Hardened `open_in_vscode` Tauri command (`code -- <canonical_path>`) paired with a prominent sticky **Open in VS Code** button in the top command header.
