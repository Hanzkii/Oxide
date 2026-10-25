# How to Open & Run Oxide

Oxide can be launched in **three ways** depending on whether you want a one-click development launch, a standalone native desktop installer (`.exe` / `.msi`), or a fast browser UI preview.

---

## 1. Prerequisites (First-Time Setup)

Before launching the full desktop agent with local AI inference, ensure the following are installed:

1. **Node.js (v18+)**: [https://nodejs.org](https://nodejs.org)
2. **Rust Toolchain (`rustup` / `cargo`)**: [https://rustup.rs](https://rustup.rs)
   - *Windows Note*: Ensure **Desktop development with C++** (MSVC Build Tools) and **WebView2** (pre-installed on Windows 10/11) are present.
3. **Ollama (Local LLM Daemon)**: [https://ollama.com](https://ollama.com)
   - Pull at least one coding model in your terminal:
     ```bash
     ollama pull qwen2.5-coder:latest
     # or
     ollama pull gemma2:latest
     ```
   - Verify Ollama is running on `http://localhost:11434`:
     ```bash
     ollama serve
     ```

---

## 2. Opening Oxide

### Option A: One-Click Windows Launcher (`start-oxide.bat`)
On Windows, double-click **`start-oxide.bat`** in the root of the repository (or run it from PowerShell/Command Prompt):
```powershell
.\start-oxide.bat
```
- If `node_modules` is missing, it installs dependencies automatically.
- If Rust/`cargo` is installed, it compiles and opens the native **Oxide Desktop Window**.
- If Rust is not yet installed, it automatically falls back to launching the frontend UI preview at `http://localhost:1420`.

### Option B: Launch Native Desktop Window via Terminal (Recommended for Dev)
From the project root directory (`Oxide/`):
```bash
# 1. Install frontend packages (once)
npm install

# 2. Start the Tauri v2 desktop application
npm start
# (alias for: npm run tauri dev)
```
The first launch compiles the Rust backend crates in `src-tauri/` and opens the native **Oxide — Autonomous AI Command Center** desktop window. Subsequent launches start in seconds.

### Option C: Build a Standalone Desktop Executable (`.exe` / `.msi` / `.dmg`)
To build a production native binary that you can pin to your taskbar or Desktop without running a dev server:
```bash
npm run desktop:build
# (alias for: npm run tauri build)
```
Once complete, your standalone executable and installer will be located at:
- **Portable Binary**: `src-tauri/target/release/oxide-agent.exe`
- **Windows Installer**: `src-tauri/target/release/bundle/msi/` or `src-tauri/target/release/bundle/nsis/`

### Option D: Frontend UI-Only Preview (No Rust Compiler Required)
If you only want to inspect or style the React/TypeScript Command Center UI in your browser:
```bash
npm run dev
```
Then open **`http://localhost:1420`** in your browser.

---

## 3. Using the Command Center Once Open

1. **Bind Your Target Workspace**:
   - In the top bar, enter the path to the local project folder you want the agent to work on (e.g., `C:\projects\my-service`) and click **Bind Sandbox**.
   - Oxide canonicalizes the path (`WorkspaceSandbox`) and locks all file reads, writes, and terminal executions strictly inside that directory.
2. **Select Your AI Model**:
   - Choose `Local: Ollama / qwen2.5-coder` or `Local: Ollama / gemma2` in the top dropdown.
   - *(Optional)* Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in your system environment if you want to switch to or fall back to cloud models.
3. **Pop Open Visual Studio Code Anytime**:
   - Click the blue **Open in VS Code** button in the top-right header to immediately open the bound workspace in Visual Studio Code (`code -- <canonical_path>`).
4. **Dispatch an Autonomous Task**:
   - Type your task in the bottom-left prompt box and click **Dispatch Agent**.
   - Watch live streamed tokens on the left and step-by-step **Workflow Status Cards** + **Sandboxed Terminal Telemetry** (`stdout` / `stderr`) on the right.
   - If a command exits with a non-zero code, Oxide automatically transitions the step to `SELF-CORRECTING` and feeds `stderr` back to the model until tests compile and pass.
