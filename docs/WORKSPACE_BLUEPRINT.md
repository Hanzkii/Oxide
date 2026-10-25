# Oxide — Local-First Autonomous AI Coding Agent Blueprint

Oxide is a lightweight, offline-capable desktop command center built on **Tauri v2**, **Rust**, and **React 18 / TypeScript**. It pairs a low-latency frontend for streaming telemetry with a strictly sandboxed Rust backend that orchestrates local Ollama inference (`qwen2.5-coder` / `gemma2`), bounded terminal execution, autonomous `stderr` self-correction, and automated Git milestone management.

---

## 1. Directory Structure & Separation of Concerns

```text
Oxide/
├── index.html                        # Entry HTML shell
├── package.json                      # Frontend dependencies (@tauri-apps/api v2, React 18, Vite)
├── tsconfig.json                     # Strict TypeScript configuration
├── vite.config.ts                    # Vite bundler bound to port 1420 for Tauri v2 dev server
├── docs/
│   └── WORKSPACE_BLUEPRINT.md        # Architecture & security boundary reference
├── src/                              # FRONTEND: Presentation, Streaming Logs & Workflow Status
│   ├── main.tsx                      # React root mount
│   ├── App.tsx                       # Split-pane Command Center UI + sticky "Open in VS Code" bar
│   ├── styles.css                    # Low-footprint native CSS variables & layout
│   ├── types/
│   │   └── agent.ts                  # Typed IPC contracts, stream events & status payloads
│   └── services/
│       └── tauriBridge.ts            # Typed Tauri v2 invoke() and listen() wrappers
└── src-tauri/                        # BACKEND: Execution Sandbox, LLM Loops & Git Orchestration
    ├── Cargo.toml                    # Rust crate manifest (tauri v2, tokio, reqwest, dunce)
    ├── build.rs                      # Tauri build hook
    ├── tauri.conf.json               # Tauri v2 config with locked-down CSP & window definition
    ├── capabilities/
    │   └── default.json              # Tauri v2 capability ACLs (no raw shell exposed to WebView)
    └── src/
        ├── main.rs                   # Binary entrypoint
        ├── lib.rs                    # AppState management & Tauri command registration
        ├── error.rs                  # Unified serializable OxideError enum
        ├── security/
        │   ├── mod.rs
        │   └── sandbox.rs            # WorkspaceSandbox, CommandPolicy, path & argv sanitizer
        ├── llm/
        │   ├── mod.rs                # LlmProvider async trait & ChatMessage primitives
        │   ├── ollama.rs             # Default localhost:11434 NDJSON streaming client
        │   ├── cloud.rs              # Anthropic Claude & OpenAI hybrid fallback clients
        │   └── router.rs             # HybridProviderRouter for seamless provider switching
        ├── orchestrator/
        │   ├── mod.rs                # Autonomous ReAct & stderr self-correction loop
        │   ├── terminal.rs           # Bounded tokio::process::Command runner
        │   └── git.rs                # Automated repo init, staging & Conventional Commit generator
        └── commands/
            ├── mod.rs
            ├── workspace.rs          # set_workspace & secure open_in_vscode command
            └── agent.rs              # run_agent_task, execute_bounded_command, git & provider IPC
```

---

## 2. Defense-in-Depth Security Boundaries for Local Terminal Execution

The frontend WebView has **zero direct access** to `@tauri-apps/plugin-shell`. Every process execution request passes through `WorkspaceSandbox` (`src-tauri/src/security/sandbox.rs`) and `BoundedTerminalExecutor` (`src-tauri/src/orchestrator/terminal.rs`).

| Security Layer | Threat Mitigated | Implementation in Oxide |
| :--- | :--- | :--- |
| **1. Direct OS Argv Spawning (No Shell Interpolation)** | Command injection via `;`, `&&`, `\|\|`, `` ` ``, `$()`, `\|`, `>` | `WorkspaceSandbox::sanitize_command` rejects shell chaining tokens (`FORBIDDEN_SHELL_TOKENS`) and spawns binaries directly via `tokio::process::Command::new(program).args(args)` without invoking `sh -c` or `cmd /C`. |
| **2. Canonical Workspace Jail & Symlink Verification** | Path traversal (`../../etc/passwd`) and symlink escape attacks | `WorkspaceSandbox::validate_path_in_workspace` lexically normalizes paths and resolves real disk targets using `dunce::canonicalize`, verifying `target.starts_with(&self.canonical_root)`. |
| **3. System Root & OS Directory Refusal** | Accidental or malicious binding of `/`, `C:\`, `C:\Windows`, `/etc`, `/usr` | `WorkspaceSandbox::reject_system_root` blocks shallow root directories (`<= 2` path components) and protected OS trees. |
| **4. Binary Allowlist & Privilege Escalation Blocklist** | Execution of `sudo`, `rm`, `del`, `format`, `curl`, `powershell`, `ssh`, `reg` | `CommandPolicy` enforces an explicit allowlist of build/dev tools (`cargo`, `npm`, `git`, `pytest`, `tsc`, etc.) and hard-blocks privilege escalation and destructive binaries. |
| **5. Child Environment Variable Scrubbing** | Prompt-injected scripts exfiltrating cloud API keys or SSH sockets | `BoundedTerminalExecutor::execute_sanitized` strips `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`, and `SSH_AUTH_SOCK` via `env_remove` before spawning. |
| **6. Non-Interactive Timeouts & Output Caps** | Hung interactive prompts, fork bombs, or multi-GB stdout memory exhaustion | Forces `CI=true`, `GIT_TERMINAL_PROMPT=0`, `Stdio::null()` stdin, `kill_on_drop(true)`, a 60-second `tokio::time::timeout`, and a 128 KiB stream cap (`MAX_OUTPUT_BYTES`). |
| **7. Hardened VS Code Launcher** | Argument/flag injection into the `code` CLI | `open_in_vscode` canonicalizes the directory, rejects leading `-` flags, and invokes `code -- <canonical_path>`. |
