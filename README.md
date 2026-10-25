# Oxide — Local-First Autonomous AI Coding Agent

Oxide is a fast, offline-first desktop command center built with **Tauri v2**, **Rust**, and **React 18 / TypeScript** for running autonomous software engineering workflows on local hardware.

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

## Development Setup

### Prerequisites
- **Rust** (stable toolchain)
- **Node.js** (v18+)
- **Ollama** running locally on `http://localhost:11434` (`ollama pull qwen2.5-coder:latest` or `ollama pull gemma2:latest`)

### Commands

```bash
# Install frontend dependencies
npm install

# Run frontend typecheck & production bundle build
npm run build

# Run Rust backend unit tests (including sandbox security tests)
cd src-tauri && cargo test

# Launch the Tauri desktop app in development mode
npm run tauri dev
```
