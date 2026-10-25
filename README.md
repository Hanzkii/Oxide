<div align="center">

<img src="docs/oxide-logo.svg" alt="Oxide Studio — Rusted Cast-Iron Pipe & Valve Flange Emblem" width="140" height="140" />

# OXIDE STUDIO `[Fe₂O₃]`

### **Local-First Autonomous AI Coding Agent & Multi-Project Desktop IDE**
*Built with **Rust**, **Tauri v2**, and **React 18 / TypeScript** — Styled after **Google Antigravity***

[![Windows Installer](https://img.shields.io/badge/Windows_Installer-.exe_%2F_Portable-d45b2c?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/Hanzkii/Oxide/releases/latest)
[![Documentation Portal](https://img.shields.io/badge/GitHub_Pages-Live_Docs_%26_Interactive_Demo-9e3d1a?style=for-the-badge&logo=github&logoColor=white)](https://hanzkii.github.io/Oxide/)
[![Ollama & HuggingFace](https://img.shields.io/badge/1--Click_AI_Store-Ollama_%2B_HuggingFace_GGUF-f59e0b?style=for-the-badge)](https://hanzkii.github.io/Oxide/#models)
[![MCP Protocol](https://img.shields.io/badge/MCP-JSON--RPC_2.0_Ready-3b82f6?style=for-the-badge)](https://hanzkii.github.io/Oxide/#mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e?style=for-the-badge)](./LICENSE)

---

**[⬇ Download Latest Windows `.exe` Release](https://github.com/Hanzkii/Oxide/releases/latest)** · **[🌐 Interactive Documentation & UI Showcase](https://hanzkii.github.io/Oxide/)** · **[🔌 Model Context Protocol (MCP) Guide](#6-model-context-protocol-mcp-hub)**

</div>

---

## ⚡ What is Oxide Studio?

**Oxide Studio** is a standalone, local-first autonomous software engineering desktop application inspired by **Google Antigravity**. It lets you open multiple project folders on your PC, save persistent AI engineering conversations per project, and orchestrate a **Lead Architect AI** alongside parallel **Fast Subagents**—completely offline via **Ollama** & **HuggingFace GGUF** models (including **Coding**, **Uncensored / Abliterated**, and **DeepSeek-R1 Reasoning** models) or with hybrid cloud fallback (**Claude 3.5 Sonnet** / **GPT-4o**).

Every action taken by the AI—its internal `<think>` chain-of-thought reasoning, subagent delegation, file edits, terminal commands, and Git commits—streams live in a clean, matte-carbon interface without ever popping up sketchy background terminal windows.

---

## 🧭 System Architecture Overview

```mermaid
flowchart TB
    subgraph UI["🖥️ Oxide Studio Desktop GUI (Antigravity Layout)"]
        Sidebar["📁 Multi-Project Sidebar\n• Native OS Folder Picker\n• Saved Conversations Tree\n• 1-Click AI Model Hub"]
        Center["💬 Center Conversation Stream\n• Collapsible 'Thought for Xs ›'\n• Inline Tool & Subagent Cards\n• Floating Prompt Composer"]
        RightDock["▤ Right Floating Overview Dock\n• Project Files & Code Editor\n• Git Review, Commit, Pull/Push\n• Sandboxed Interactive Terminal"]
    end

    subgraph Core["🦀 Rust + Tauri v2 Core Engine (src-tauri)"]
        Orchestrator["🧠 Lead Architect Orchestrator\nReAct Loop + <think> Parser"]
        SubagentPool["⚡ Subagent Worker Pool\n• Coder Subagent (Fast Edits)\n• Research Subagent (Search)\n• Tester Subagent (Build/Fix)"]
        Governor["🛡️ PC Hardware Governor\nLive CPU / Free RAM / GPU VRAM\nDynamic Semaphore Limiter"]
        ModelHub["⬇️ 1-Click AI Model Installer\n• Ollama Registry Pull\n• HuggingFace GGUF (hf.co/)\n• Auto-Start / Install Ollama"]
        MCP["🔌 MCP JSON-RPC 2.0 Client\nBuiltin • Stdio (npx/uvx) • HTTP"]
        Sandbox["🔒 Defense-in-Depth Sandbox\nCanonical Path Jail + Binary Allow-List\nCREATE_NO_WINDOW Silent Execution"]
    end

    UI <-->|"Typed Tauri IPC + Live Event Stream"| Core
    Orchestrator -->|"delegate_subagents"| SubagentPool
    Governor -.->|"Caps Max Workers (1..4)"| SubagentPool
    Orchestrator -->|"JSON-RPC 2.0"| MCP
    Orchestrator & SubagentPool -->|"Validated File & CLI Ops"| Sandbox
```

---

## 🚀 1. How to Install & Open Oxide Studio

### Option A: Standalone Windows Installer or Portable `.exe` *(Recommended)*
Every push to `main` builds a native Windows NSIS installer and portable executable on GitHub Actions:
1. Go to **[GitHub Releases](https://github.com/Hanzkii/Oxide/releases/latest)**.
2. Download **`Oxide_0.1.0_x64-setup.exe`** (fast NSIS installer) or **`Oxide-Portable.exe`** (single-file portable executable).
3. Launch **Oxide Studio**.
4. Whenever new features are pushed to GitHub, click the **`↻ Update`** button in the bottom-left of the sidebar to download and install the latest release in one click.

### Option B: Local Repository Clone (`start-oxide.bat`)
```powershell
git clone https://github.com/Hanzkii/Oxide.git
cd Oxide
.\start-oxide.bat
```
- If a compiled binary is present, `start-oxide.bat` launches it directly.
- Otherwise, it starts the local Vite + Node system bridge and opens Oxide Studio in a dedicated app window (`--app=http://localhost:1420`) with full file, terminal, Git, hardware detection, and Ollama/HuggingFace support.

---

## 🖥️ 2. Antigravity-Inspired Workspace & Multi-Project Management

Oxide Studio is designed around a three-zone layout modeled after **Google Antigravity**:

| Workspace Zone | Capabilities |
| :--- | :--- |
| **Left Sidebar (`Projects & Conversations`)** | • **`+ New Conversation`** button starts a fresh agent thread in your active project.<br>• **Native Windows Folder Picker (`📁+` / `+ Folder`)**: Opens the native OS folder dialog (`FolderBrowserDialog`) so you can add or switch project directories without typing paths.<br>• **Multi-Project Tree**: Group multiple codebases in the sidebar and click any saved conversation to restore its full history, reasoning traces, and tool steps.<br>• **Automatic Disk Persistence**: Saved automatically to `%LOCALAPPDATA%/OxideStudio/studio_sessions.json`. |
| **Center Stream (`Thought & Action Trace`)** | • **Collapsible `Thought for Xs ›` Blocks**: Click to expand or collapse the AI's raw `<think>...</think>` chain-of-thought and numbered execution plan.<br>• **Inline Tool & Subagent Steps**: File reads/edits (`📄`), terminal executions (`>_`), and live subagent status badges appear inline between thoughts and answers.<br>• **Floating Bottom Composer**: Quick model switcher, `⬇ + Install AI` launcher, and `⚡ Turbo` subagent concurrency indicator. |
| **Right Dock (`Floating Overview Card`)** | • **Overview Card**: Clean, uncluttered overview displaying active workspace branch, live subagents, workflow milestones, and connected MCP servers.<br>• **Compact PC Specs Pill & Settings**: Hardware governor metrics (AMD Radeon, NVIDIA CUDA, CPU load, and 64-bit VRAM) reside in the top status bar pill and dedicated Settings tab, keeping the right overview spacious and focused.<br>• **Expandable Drawers**: Click to expand the **Project File Explorer**, **Built-in Code Editor** (with 1-click Save & New File), **Git Review & Sync** (`Commit`, `Pull`, `Push`), or **Interactive Sandboxed Terminal**. |

---

## ⬇️ 3. 1-Click AI Model Hub (Ollama + HuggingFace GGUF + PC Spec Matcher)

Click **`⬇ AI Model Hub (1-Click)`** in the sidebar (or **`⬇ + Install AI`** in the prompt bar) to open the built-in AI Model Store.

### Automatic PC Hardware Compatibility Scoring
Oxide Studio inspects your PC's **Total RAM**, **Free RAM**, **CPU cores**, and **GPU VRAM** (`nvidia-smi` / WMI) and tags every model in the store—including live HuggingFace search results—with a real-time hardware verdict:
- 🟢 **`⚡ Runs Fast on GPU`** — Model fits inside your dedicated GPU VRAM for maximum token/s speed.
- 🔵 **`✓ Compatible with Your PC`** — Fits comfortably within your system RAM.
- 🟡 **`⚠ Tight RAM Fit (Slower)`** — Close to your total RAM ceiling; layers will offload to system memory.
- 🔴 **`⛔ Too Heavy (Needs X GB RAM)`** — Exceeds your PC's hardware capacity (can be hidden automatically with the **`✅ Fits My PC Only`** toggle).

### Smart Filters: Coding, Uncensored / Abliterated, Reasoning & Fast Subagents
Filter models by specialty or search **HuggingFace Hub Live** (`https://huggingface.co/api/models?filter=gguf`) to 1-click pull any GGUF repository directly via `hf.co/<owner>/<repo>`:

| Model Name | Source / Install ID | Size / RAM Req | Specialties | Best Role |
| :--- | :--- | :---: | :--- | :--- |
| **Qwen 2.5 Coder 7B Abliterated** | `hf.co/bartowski/Qwen2.5-Coder-7B-Instruct-abliterated-GGUF` | 4.7 GB / 8 GB | `💻 Coding` `🔓 Uncensored` | Lead or Subagent for unrestricted coding & reverse engineering |
| **Qwen 2.5 Coder 14B Abliterated** | `hf.co/bartowski/Qwen2.5-Coder-14B-Instruct-abliterated-GGUF` | 9.0 GB / 16 GB | `💻 Coding` `🔓 Uncensored` | High-precision Uncensored Lead Architect |
| **DeepSeek-R1 7B Abliterated** | `hf.co/huihui-ai/DeepSeek-R1-Distill-Qwen-7B-abliterated-GGUF` | 4.7 GB / 8 GB | `💻 Coding` `🔓 Uncensored` `🧠 Reasoning` | Unfiltered chain-of-thought `<think>` reasoning + code |
| **DeepSeek-R1 14B Abliterated** | `hf.co/huihui-ai/DeepSeek-R1-Distill-Qwen-14B-abliterated-GGUF` | 9.0 GB / 16 GB | `💻 Coding` `🔓 Uncensored` `🧠 Reasoning` | Heavyweight unfiltered reasoning architect |
| **Qwen 2.5 Coder (1.5B / 3B)** | `qwen2.5-coder:1.5b` / `qwen2.5-coder:3b` | 1–2 GB / 4–6 GB | `💻 Coding` `⚡ Fast Subagent` | Ultra-fast parallel Subagent workers on any PC |
| **Qwen 2.5 Coder (7B / 14B / 32B)** | `qwen2.5-coder:7b` / `14b` / `32b` | 4.7–19.5 GB | `💻 Coding` | Standard autonomous coding & repository engineering |
| **Dolphin 2.9 Llama-3 8B** | `dolphin-llama3:8b` | 4.7 GB / 8 GB | `💻 Coding` `🔓 Uncensored` | Unfiltered instruction-following & tool use |
| **Dolphin 2.8 Mistral 7B** | `dolphin-mistral:7b` | 4.1 GB / 8 GB | `💻 Coding` `🔓 Uncensored` | Zero alignment refusals, fast agentic execution |
| **Nous Hermes 3 Llama-3.1 8B** | `hermes3:8b` | 4.7 GB / 8 GB | `💻 Coding` `🔓 Uncensored` | Steerable agent model with native JSON function calling |
| **DeepSeek-R1 (1.5B / 7B / 14B)** | `deepseek-r1:1.5b` / `7b` / `14b` | 1.1–9.0 GB | `💻 Coding` `🧠 Reasoning` | Deep `<think>` architectural planning & debugging |

> **Don't have Ollama installed yet?** Click **`⚡ 1-Click Start / Install Ollama`** inside the Model Hub to automatically install Ollama via Winget and start the local inference server in the background.

---

## ⚡ 4. GPU Layer Offloading (Hybrid Split Inference) & Hardware Governor

Running large, highly-capable models (14B, 32B, 70B) locally usually causes Out-Of-Memory (OOM) crashes on consumer GPUs with 8GB–16GB VRAM. Oxide Studio solves this with **GPU Layer Offloading (Hybrid Split Inference)**:

```
[ Heavyweight 32B / 70B Model Architecture ]
┌────────────────────────────────────────────────────────┐
│  GPU VRAM (e.g. Layers 0..36 on AMD Radeon / NVIDIA)   │ ⚡ High-speed parallel tensor math
├────────────────────────────────────────────────────────┤
│  System RAM (e.g. Layers 37..64 via CPU & System RAM)  │ 🖥️ Paged without Out-Of-Memory errors
└────────────────────────────────────────────────────────┘
```

- **Configurable Offload Policies (`Settings -> Hardware & Acceleration` Tab)**:
  - `hybrid_split`: Auto-calculates optimal VRAM/RAM split based on GPU VRAM detection (e.g. 36 layers to GPU on 12GB VRAM cards like AMD RX 6700 XT).
  - `full_gpu`: Offloads 100% of transformer layers to VRAM for maximum tokens/s (ideal for 7B/8B models).
  - `custom_layers`: Fine-tune exact GPU layer allocation via interactive slider.
  - `cpu_only`: Disables GPU execution for pure CPU inference.
- **Interactive Visual Split Bar**: Displays real-time GPU VRAM vs System RAM layer distribution percentages directly in the Hardware settings.
- **Neural Thinking & Token Speed Gauge**: Real-time pulsing badge during agent turns tracking:
  - 🧠 Inference Phase (`Deep Reasoning` in `<think>` vs `Executing Code / Tool Call`)
  - ⚡ Live token generation count and generation speed in **tok/s**
  - 🎮 Active GPU offload layer count

---

## 💬 5. Slash Commands (`/`) & Side-Queries (`/btw`)

Oxide Studio includes an interactive auto-completing slash command palette. Type `/` in the composer to access quick controls:

| Slash Command | Description | Concurrency / Tool Effect |
| :--- | :--- | :--- |
| **`/btw <question>`** | **Side-Question / By-The-Way Mode** | Bypasses file modifications and tool loops to answer quick architectural questions immediately. |
| **`/plan <task>`** | **Architectural Planning** | Orders the Lead Architect to draft a step-by-step checklist before making file changes. |
| **`/subagents <task>`** | **Multi-Agent Execution** | Decomposes task and delegates subtasks to parallel Coder, Research, and Tester subagents. |
| **`/fix <issue>`** | **Autonomous Diagnostics** | Reads compiler / test errors and issues targeted repair commands. |
| **`/test`** | **Run Test Suites** | Runs project tests (`cargo test`, `npm test`, `pytest`) silently. |
| **`/models`** | **1-Click Model Hub** | Opens the AI Model Store modal. |
| **`/hardware`** | **Governor & Acceleration** | Opens hardware specs and layer offload configuration. |
| **`/compact`** | **Context Compaction** | Compacts long conversational context into clean executive summaries. |
| **`/clear`** | **Clear Session** | Resets active conversation turns. |
| **`/help`** | **Slash Command Help** | Lists all available shortcuts. |

---

## 🤖 6. Hierarchical Lead Architect + Subagents & PC Hardware Governor

Instead of running one slow model for every tiny file lookup, Oxide Studio implements a **two-tier multi-agent hierarchy**:

```mermaid
sequenceDiagram
    participant User
    participant Lead as 🧠 Lead Architect AI (Large Model)
    participant Gov as 🛡️ PC Hardware Governor
    participant Sub1 as 💻 Coder Subagent (Fast Model)
    participant Sub2 as 🔍 Research Subagent (Fast Model)
    participant Sandbox as 🔒 Workspace & Terminal

    User->>Lead: "Refactor auth module, add tests, and verify build"
    Lead->>Lead: Streams <think> reasoning & Plan Checklist
    Lead->>Gov: Request parallel subagents (delegate_subagents)
    Gov->>Gov: Check CPU %, Free RAM & GPU VRAM (Semaphore)
    par Bounded by PC Hardware Governor
        Gov->>Sub1: Spawn Coder Subagent (qwen2.5-coder:3b/7b)
        Sub1->>Sandbox: Read & edit source files
        Gov->>Sub2: Spawn Research/Tester Subagent
        Sub2->>Sandbox: Search symbols & run cargo/npm test
    end
    Sub1-->>Lead: Structured diff & file status report
    Sub2-->>Lead: Test stdout/stderr results
    Lead->>User: Final verified summary & Git milestone ready
```

### Hardware Acceleration & Dynamic PC Governor (`src-tauri/src/hardware.rs`)
- **AMD Radeon ROCm / DirectML & NVIDIA CUDA**: Full GPU hardware acceleration detection (including 64-bit VRAM registry detection for AMD Radeon RX 6000/7000/8000 series and NVIDIA RTX), with configurable GPU offload layers (0 to 99).
- **Workstation Tier (`≥30 GB RAM` + `≥10 GB VRAM` or `≥12 Cores`)**: Effortlessly runs up to **8–16 concurrent subagents** alongside a heavyweight Lead Architect with GPU layer acceleration.
- **Balanced Desktop Tier (`≥15 GB RAM` + `≥5.5 GB Free RAM`)**: Runs up to **4–8 concurrent subagents** with hardware acceleration.
- **Compact / Memory-Saver Tier (`<15 GB RAM`)**: Automatically optimizes subagent queues with lightweight models (1.5B–3B).
- **Uncapped Concurrency & Unlimited MCP**: Full user control over worker counts and MCP server limits with zero artificial hard limits.
- **Automated Final Execution Reports**: The agent synthesizes an Antigravity-grade summary report detailing every workspace action taken, files created/edited, build results, and milestone changes upon task completion.
- **Clean In-Place Self-Updater**: Background updater streams live download percentages and executes a clean in-place replacement so old versions never linger.

---

## 🔌 7. Model Context Protocol (MCP) Hub

Oxide Studio includes a native **JSON-RPC 2.0 MCP Client & Registry** (`src-tauri/src/mcp.rs`):
- **Supported Transports**:
  - `builtin`: Built-in `oxide-memory` knowledge graph (`store_memory`, `recall_memories`) that works with zero external dependencies.
  - `stdio`: Spawns local MCP servers (`npx`, `uvx`, `node`, `python`) silently in the background (`CREATE_NO_WINDOW`).
  - `http`: Connects to remote JSON-RPC 2.0 MCP endpoints.
- **1-Click Tool Discovery**: Open **`🔌 Customizations (MCP)`** in the sidebar, click **`Discover Tools`** on any server to handshake (`initialize` → `tools/list`), and the discovered tools are automatically injected into the Lead Architect's system prompt (`call_mcp_tool`).

---

## 🔒 8. Defense-in-Depth Security & Silent Windows Execution

1. **Canonical Path Sandbox (`src-tauri/src/security/sandbox.rs`)**:
   - Every file read, write, move, delete, and terminal working directory is canonicalized and verified to reside strictly inside your active project folder, blocking `../` traversal and symlink escapes.
2. **Allow-Listed Terminal & Self-Correction (`src-tauri/src/orchestrator/terminal.rs`)**:
   - Commands execute without shell-interpolation injection, scrub cloud API keys from child environments, cap output buffers, and automatically feed non-zero exit codes + `stderr` back to the AI for autonomous self-repair.
3. **Zero Pop-up Console Windows (`CREATE_NO_WINDOW`)**:
   - Every background process on Windows (`git`, `ollama`, `nvidia-smi`, `powershell`, `npx`, and the self-updater) executes with the Win32 `CREATE_NO_WINDOW` (`0x08000000`) flag so black terminal windows never flash on your screen.

---

## 🛠️ 9. Building from Source

### Prerequisites
- **Node.js 20+** and **npm**
- **Rust stable toolchain** (`rustup`, `cargo`) + Windows WebView2 (pre-installed on Windows 10/11)

```powershell
# Install frontend dependencies
npm install

# Run in development mode (Vite + local bridge)
npm run dev

# Build production frontend bundle
npm run build

# Build native Windows NSIS Installer & Portable .exe
npm run desktop:build
```

---

## 📄 License

Distributed under the **MIT License**. See [`LICENSE`](./LICENSE) for full details.
