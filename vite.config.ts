import { defineConfig, Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;

interface TaskModelRouting {
  architect_model: string;
  coder_subagent_model: string;
  research_subagent_model: string;
  tester_subagent_model: string;
}

interface LocalBridgeState {
  workspaceRoot: string;
  providerConfig: {
    active_provider: "ollama" | "anthropic" | "openai";
    ollama_base_url: string;
    ollama_model: string;
    anthropic_model: string;
    openai_model: string;
    enable_cloud_fallback: boolean;
    temperature: number;
    task_routing: TaskModelRouting;
    enable_subagents: boolean;
    max_concurrent_subagents: number;
    auto_throttle_on_high_load: boolean;
  };
  cachedGpu: { name: string; vramGb: number } | null;
  mcpServers: any[];
  builtinMemories: { key: string; value: string }[];
}

function createLocalSystemBridgePlugin(): Plugin {
  const state: LocalBridgeState = {
    workspaceRoot: process.cwd(),
    providerConfig: {
      active_provider: "ollama",
      ollama_base_url: "http://localhost:11434",
      ollama_model: "qwen2.5-coder:latest",
      anthropic_model: "claude-3-5-sonnet-latest",
      openai_model: "gpt-4o",
      enable_cloud_fallback: false,
      temperature: 0.1,
      task_routing: {
        architect_model: "qwen2.5-coder:latest",
        coder_subagent_model: "qwen2.5-coder:7b",
        research_subagent_model: "gemma2:latest",
        tester_subagent_model: "qwen2.5-coder:7b",
      },
      enable_subagents: true,
      max_concurrent_subagents: 2,
      auto_throttle_on_high_load: true,
    },
    cachedGpu: null,
    builtinMemories: [
      {
        key: "project_overview",
        value:
          "Oxide Studio is a Tauri v2 + Rust + React autonomous AI coding agent with Subagents, Hardware Governor, and MCP support.",
      },
    ],
    mcpServers: [
      {
        id: "oxide-memory",
        name: "Oxide Knowledge Graph & Memory (Built-in)",
        transport: "builtin",
        command: "builtin:memory",
        args: [],
        env: {},
        url: null,
        enabled: true,
        status: "ready",
        discovered_tools: [
          {
            name: "store_memory",
            description:
              "Store a key-value architectural note or memory for future agent tasks",
            input_schema: {
              type: "object",
              properties: {
                key: { type: "string" },
                value: { type: "string" },
              },
              required: ["key", "value"],
            },
          },
          {
            name: "recall_memories",
            description:
              "List or search stored architectural memories and project notes",
            input_schema: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
            },
          },
        ],
      },
      {
        id: "filesystem",
        name: "MCP Filesystem Server (@modelcontextprotocol/server-filesystem)",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
        env: {},
        url: null,
        enabled: false,
        status: "configured",
        discovered_tools: [],
      },
      {
        id: "sequential-thinking",
        name: "MCP Sequential Thinking (@modelcontextprotocol/server-sequential-thinking)",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
        env: {},
        url: null,
        enabled: false,
        status: "configured",
        discovered_tools: [],
      },
    ],
  };

  function runStdioMcpRequest(
    server: any,
    method: string,
    params: any
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const bin =
        process.platform === "win32" && server.command === "npx"
          ? "npx.cmd"
          : server.command;
      const child = spawn(bin, server.args || [], {
        cwd: state.workspaceRoot,
        shell: process.platform === "win32",
        windowsHide: true,
        env: { ...process.env, ...(server.env || {}) },
      });

      let buf = "";
      let initialized = false;
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("MCP server request timed out (25s)"));
      }, 25000);

      child.stdout.on("data", (chunk) => {
        buf += chunk.toString();
        let idx: number;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id === 1 && !initialized) {
              initialized = true;
              child.stdin.write(
                JSON.stringify({
                  jsonrpc: "2.0",
                  method: "notifications/initialized",
                  params: {},
                }) +
                  "\n" +
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: 2,
                    method,
                    params,
                  }) +
                  "\n"
              );
            } else if (msg.id === 2) {
              clearTimeout(timeout);
              child.kill();
              if (msg.error) {
                reject(new Error(JSON.stringify(msg.error)));
              } else {
                resolve(msg.result ?? msg);
              }
            }
          } catch {}
        }
      });

      child.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "oxide-studio", version: "0.1.0" },
          },
        }) + "\n"
      );
    });
  }

  function resolveInsideWorkspace(candidate: string): string {
    const resolved = path.resolve(state.workspaceRoot, candidate || ".");
    const rootResolved = path.resolve(state.workspaceRoot);
    if (!resolved.toLowerCase().startsWith(rootResolved.toLowerCase())) {
      throw new Error(
        `Security violation: Path '${candidate}' escapes workspace '${rootResolved}'`
      );
    }
    return resolved;
  }

  function runCommandBounded(
    cmdLine: string,
    cwd: string = state.workspaceRoot
  ): Promise<{
    program: string;
    args: string[];
    working_dir: string;
    exit_code: number;
    stdout: string;
    stderr: string;
    duration_ms: number;
    succeeded: boolean;
    truncated: boolean;
  }> {
    return new Promise((resolve, reject) => {
      const trimmed = cmdLine.trim();
      if (!trimmed) {
        return reject(new Error("Command cannot be empty"));
      }
      const tokens =
        trimmed
          .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
          ?.map((t) => t.replace(/^['"]|['"]$/g, "")) ?? [];
      const program = tokens[0];
      const args = tokens.slice(1);
      const start = Date.now();

      const child = spawn(program, args, {
        cwd,
        shell: process.platform === "win32",
        windowsHide: true,
        env: {
          ...process.env,
          CI: "true",
          GIT_TERMINAL_PROMPT: "0",
        },
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        if (stdout.length < 128 * 1024) stdout += d.toString();
      });
      child.stderr.on("data", (d) => {
        if (stderr.length < 128 * 1024) stderr += d.toString();
      });
      child.on("error", (err) => {
        resolve({
          program,
          args,
          working_dir: cwd,
          exit_code: -1,
          stdout,
          stderr: err.message,
          duration_ms: Date.now() - start,
          succeeded: false,
          truncated: false,
        });
      });
      child.on("close", (code) => {
        const exitCode = code ?? 0;
        resolve({
          program,
          args,
          working_dir: cwd,
          exit_code: exitCode,
          stdout,
          stderr,
          duration_ms: Date.now() - start,
          succeeded: exitCode === 0,
          truncated: false,
        });
      });
    });
  }

  async function inspectHardwareSpecs() {
    const cpus = os.cpus();
    const cpuCores = Math.max(1, cpus.length);
    const cpuBrand = cpus[0]?.model?.trim() || `${cpuCores}-Core Processor`;

    let totalIdle = 0;
    let totalTick = 0;
    for (const cpu of cpus) {
      for (const type of Object.keys(cpu.times) as (keyof typeof cpu.times)[]) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    }
    const cpuUsagePercent =
      Math.round(
        Math.max(5, Math.min(99, (1 - totalIdle / Math.max(1, totalTick)) * 100)) *
          10
      ) / 10;

    const totalRamGb =
      Math.round((os.totalmem() / (1024 * 1024 * 1024)) * 10) / 10;
    const availableRamGb =
      Math.round((os.freemem() / (1024 * 1024 * 1024)) * 10) / 10;
    const usedRamPercent =
      Math.round(((totalRamGb - availableRamGb) / Math.max(0.1, totalRamGb)) * 1000) /
      10;

    if (!state.cachedGpu) {
      const nv = await runCommandBounded(
        "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits"
      );
      if (nv.succeeded && nv.stdout.trim()) {
        const first = nv.stdout.trim().split(/\r?\n/)[0];
        const [gName, gMem] = first.split(",");
        state.cachedGpu = {
          name: (gName || "NVIDIA GPU").trim(),
          vramGb: Math.round(((parseFloat(gMem) || 0) / 1024) * 10) / 10,
        };
      } else {
        state.cachedGpu = {
          name: "System GPU / Unified Memory",
          vramGb: 0,
        };
      }
    }

    const throttledByLoad =
      usedRamPercent > 85 || availableRamGb < 3.0 || cpuUsagePercent > 88;

    let hardLimitSubagents = 1;
    let recommendedMaxSubagents = 1;
    let governorTier = "Compact / Memory-Saver Tier";
    let governorAdvice =
      "Limited available RAM detected. Subagents will execute 1 at a time in a sequential queue using compact models (1.5B–3B).";

    if (throttledByLoad) {
      hardLimitSubagents = 1;
      recommendedMaxSubagents = 1;
      governorTier = "Throttled (High System Load / Low Free RAM)";
      governorAdvice =
        "System RAM or CPU usage is currently high. Subagents are restricted to 1 sequential worker at a time to prevent PC slowdown.";
    } else if (
      totalRamGb >= 30 &&
      (state.cachedGpu.vramGb >= 12 || cpuCores >= 12)
    ) {
      hardLimitSubagents = 4;
      recommendedMaxSubagents = 3;
      governorTier = "Workstation Tier (High Spec)";
      governorAdvice =
        "Your PC can comfortably run 1 Large Architect model (14B–32B) + up to 3 fast Subagents (1.5B–7B) concurrently.";
    } else if (totalRamGb >= 15 && availableRamGb >= 5.5) {
      hardLimitSubagents = 2;
      recommendedMaxSubagents = 2;
      governorTier = "Balanced Desktop Tier (Mid Spec)";
      governorAdvice =
        "Recommended: 1 Architect model (7B–14B) + up to 2 fast Subagents (1.5B–3B) concurrently to stay well within RAM limits.";
    }

    return {
      cpu_brand: cpuBrand,
      cpu_cores: cpuCores,
      cpu_usage_percent: cpuUsagePercent,
      total_ram_gb: totalRamGb,
      available_ram_gb: availableRamGb,
      used_ram_percent: usedRamPercent,
      gpu_name: state.cachedGpu.name,
      gpu_vram_gb: state.cachedGpu.vramGb,
      recommended_max_subagents: recommendedMaxSubagents,
      hard_limit_subagents: hardLimitSubagents,
      governor_tier: governorTier,
      governor_advice: governorAdvice,
      throttled_by_load: throttledByLoad,
    };
  }

  async function getGitStatusSummary(cwd: string) {
    const gitDir = path.join(cwd, ".git");
    if (!fs.existsSync(gitDir)) {
      return {
        initialized: false,
        branch: "uninitialized",
        remote_url: null,
        is_clean: true,
        changed_files: [],
        last_commit: null,
      };
    }
    const branchRes = await runCommandBounded(
      "git rev-parse --abbrev-ref HEAD",
      cwd
    );
    const remoteRes = await runCommandBounded(
      "git remote get-url origin",
      cwd
    );
    const statusRes = await runCommandBounded("git status --porcelain", cwd);
    const logRes = await runCommandBounded("git log -1 --oneline", cwd);
    const changed = statusRes.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    return {
      initialized: true,
      branch: branchRes.succeeded ? branchRes.stdout.trim() : "main",
      remote_url:
        remoteRes.succeeded && remoteRes.stdout.trim()
          ? remoteRes.stdout.trim()
          : null,
      is_clean: changed.length === 0,
      changed_files: changed,
      last_commit:
        logRes.succeeded && logRes.stdout.trim()
          ? logRes.stdout.trim()
          : null,
    };
  }

  return {
    name: "oxide-local-system-bridge",
    transformIndexHtml: {
      order: "pre",
      handler() {
        return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Oxide Studio — Autonomous AI Command Center</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`;
      },
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/__oxide_api/")) {
          return next();
        }

        const action = req.url.replace("/__oxide_api/", "").split("?")[0];
        let bodyRaw = "";
        for await (const chunk of req) {
          bodyRaw += chunk;
        }
        const args = bodyRaw ? JSON.parse(bodyRaw) : {};

        res.setHeader("Content-Type", "application/json");
        try {
          if (action === "get_hardware_specs") {
            const specs = await inspectHardwareSpecs();
            res.end(JSON.stringify(specs));
            return;
          }

          if (action === "pick_folder_dialog") {
            const out = await runCommandBounded(
              `powershell -NoProfile -Sta -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Select Project Folder for Oxide Studio'; $f.ShowNewFolderButton = $true; if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }"`
            );
            const selected = out.stdout.trim();
            res.end(JSON.stringify(selected || null));
            return;
          }

          if (action === "load_studio_state") {
            const base = process.env.LOCALAPPDATA || os.tmpdir();
            const file = path.join(base, "OxideStudio", "studio_sessions.json");
            if (fs.existsSync(file)) {
              res.end(JSON.stringify(fs.readFileSync(file, "utf-8")));
            } else {
              res.end(JSON.stringify(null));
            }
            return;
          }

          if (action === "save_studio_state") {
            const base = process.env.LOCALAPPDATA || os.tmpdir();
            const dir = path.join(base, "OxideStudio");
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(
              path.join(dir, "studio_sessions.json"),
              args.stateJson || "{}",
              "utf-8"
            );
            res.end(JSON.stringify(true));
            return;
          }

          if (action === "list_mcp_servers") {
            res.end(JSON.stringify(state.mcpServers));
            return;
          }

          if (action === "save_mcp_server") {
            const srv = args.server;
            const idx = state.mcpServers.findIndex((s) => s.id === srv.id);
            if (idx !== -1) state.mcpServers[idx] = srv;
            else state.mcpServers.push(srv);
            res.end(JSON.stringify(state.mcpServers));
            return;
          }

          if (action === "remove_mcp_server") {
            state.mcpServers = state.mcpServers.filter(
              (s) => s.id !== args.serverId
            );
            res.end(JSON.stringify(state.mcpServers));
            return;
          }

          if (action === "discover_mcp_tools") {
            const srv = state.mcpServers.find((s) => s.id === args.serverId);
            if (!srv) throw new Error(`MCP server '${args.serverId}' not found`);
            if (srv.transport === "builtin") {
              srv.status = "ready";
              res.end(JSON.stringify(srv));
              return;
            }
            const result = await runStdioMcpRequest(srv, "tools/list", {});
            srv.discovered_tools = (result.tools || []).map((t: any) => ({
              name: t.name,
              description: t.description || "",
              input_schema: t.inputSchema || { type: "object" },
            }));
            srv.status = "ready";
            srv.enabled = true;
            res.end(JSON.stringify(srv));
            return;
          }

          if (action === "call_mcp_tool") {
            const srv = state.mcpServers.find((s) => s.id === args.serverId);
            if (!srv) throw new Error(`MCP server '${args.serverId}' not found`);
            if (srv.transport === "builtin") {
              const toolArgs = args.arguments || {};
              if (args.toolName === "store_memory") {
                const k = toolArgs.key || "note";
                const v = toolArgs.value || "";
                const ex = state.builtinMemories.find((m) => m.key === k);
                if (ex) ex.value = v;
                else state.builtinMemories.push({ key: k, value: v });
                res.end(
                  JSON.stringify({
                    server_id: srv.id,
                    tool_name: args.toolName,
                    succeeded: true,
                    content: `Stored memory '${k}' (${v.length} chars).`,
                  })
                );
                return;
              }
              const q = (toolArgs.query || "").toLowerCase();
              const matches = state.builtinMemories
                .filter(
                  (m) =>
                    !q ||
                    m.key.toLowerCase().includes(q) ||
                    m.value.toLowerCase().includes(q)
                )
                .map((m) => `• [${m.key}]: ${m.value}`);
              res.end(
                JSON.stringify({
                  server_id: srv.id,
                  tool_name: args.toolName,
                  succeeded: true,
                  content: matches.join("\n") || "No matching memories found.",
                })
              );
              return;
            }

            const result = await runStdioMcpRequest(srv, "tools/call", {
              name: args.toolName,
              arguments: args.arguments || {},
            });
            const content = Array.isArray(result.content)
              ? result.content
                  .map((b: any) => b.text || JSON.stringify(b))
                  .join("\n")
              : JSON.stringify(result, null, 2);
            res.end(
              JSON.stringify({
                server_id: srv.id,
                tool_name: args.toolName,
                succeeded: !result.isError,
                content,
              })
            );
            return;
          }

          if (action === "set_workspace") {
            const target = path.resolve(args.workspacePath || ".");
            if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
              throw new Error(`Directory does not exist: ${target}`);
            }
            state.workspaceRoot = target;
            const git = await getGitStatusSummary(target);
            res.end(
              JSON.stringify({
                canonical_path: target,
                git,
                allowed_binaries: [
                  "cargo",
                  "npm",
                  "npx",
                  "node",
                  "git",
                  "python",
                  "pytest",
                  "tsc",
                  "vite",
                ],
              })
            );
            return;
          }

          if (action === "list_workspace_files") {
            const targetDir = resolveInsideWorkspace(args.subPath || ".");
            const items = fs.readdirSync(targetDir, { withFileTypes: true });
            const entries = items
              .filter(
                (d) =>
                  d.name !== ".git" &&
                  d.name !== "node_modules" &&
                  d.name !== "target"
              )
              .map((d) => {
                const full = path.join(targetDir, d.name);
                const rel = path
                  .relative(state.workspaceRoot, full)
                  .replace(/\\/g, "/");
                let size = 0;
                try {
                  size = d.isDirectory() ? 0 : fs.statSync(full).size;
                } catch {}
                return {
                  name: d.name,
                  relative_path: rel,
                  is_dir: d.isDirectory(),
                  size_bytes: size,
                };
              })
              .sort((a, b) =>
                a.is_dir === b.is_dir
                  ? a.name.localeCompare(b.name)
                  : a.is_dir
                  ? -1
                  : 1
              );
            res.end(JSON.stringify(entries));
            return;
          }

          if (action === "read_workspace_file") {
            const target = resolveInsideWorkspace(args.relativePath);
            res.end(JSON.stringify(fs.readFileSync(target, "utf-8")));
            return;
          }

          if (action === "save_workspace_file") {
            const target = resolveInsideWorkspace(args.relativePath);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, args.content ?? "", "utf-8");
            res.end(JSON.stringify(args.relativePath));
            return;
          }

          if (action === "move_workspace_file") {
            const src = resolveInsideWorkspace(args.sourcePath);
            const dst = resolveInsideWorkspace(args.destinationPath);
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.renameSync(src, dst);
            res.end(JSON.stringify(args.destinationPath));
            return;
          }

          if (action === "delete_workspace_file") {
            const target = resolveInsideWorkspace(args.relativePath);
            fs.rmSync(target, { recursive: true, force: true });
            res.end(JSON.stringify(args.relativePath));
            return;
          }

          if (action === "open_in_vscode") {
            const target = args.workspacePath
              ? resolveInsideWorkspace(args.workspacePath)
              : state.workspaceRoot;
            const bin = process.platform === "win32" ? "code.cmd" : "code";
            spawn(bin, ["--", target], {
              detached: true,
              stdio: "ignore",
              shell: process.platform === "win32",
              windowsHide: true,
            }).unref();
            res.end(JSON.stringify(target));
            return;
          }

          if (action === "get_provider_health") {
            let ollamaReachable = false;
            let ollamaModels: string[] = [];
            try {
              const r = await fetch(
                `${state.providerConfig.ollama_base_url.replace(
                  /\/$/,
                  ""
                )}/api/tags`
              );
              if (r.ok) {
                ollamaReachable = true;
                const data: any = await r.json();
                ollamaModels = (data.models || []).map((m: any) => m.name);
              }
            } catch {}
            if (ollamaModels.length === 0) {
              ollamaModels = [
                "qwen2.5-coder:14b",
                "qwen2.5-coder:latest",
                "qwen2.5-coder:7b",
                "qwen2.5-coder:3b",
                "gemma2:latest",
                "deepseek-r1:latest",
              ];
            }
            res.end(
              JSON.stringify({
                active_provider: state.providerConfig.active_provider,
                ollama_reachable: ollamaReachable,
                ollama_models: ollamaModels,
                anthropic_key_present: Boolean(process.env.ANTHROPIC_API_KEY),
                openai_key_present: Boolean(process.env.OPENAI_API_KEY),
                config: state.providerConfig,
              })
            );
            return;
          }

          if (action === "update_provider_config") {
            const hw = await inspectHardwareSpecs();
            const merged = {
              ...state.providerConfig,
              ...(args.config || {}),
            };
            merged.max_concurrent_subagents = Math.max(
              1,
              Math.min(
                merged.max_concurrent_subagents || 1,
                Math.max(1, hw.hard_limit_subagents)
              )
            );
            state.providerConfig = merged;
            res.end(JSON.stringify(state.providerConfig));
            return;
          }

          if (action === "execute_bounded_command") {
            const out = await runCommandBounded(args.commandLine);
            res.end(JSON.stringify(out));
            return;
          }

          if (action === "get_git_status") {
            const status = await getGitStatusSummary(state.workspaceRoot);
            res.end(JSON.stringify(status));
            return;
          }

          if (action === "git_sync_action") {
            const op = (args.operation || "").toLowerCase();
            if (op === "pull") {
              res.end(
                JSON.stringify(await runCommandBounded("git pull --rebase"))
              );
            } else if (op === "push") {
              res.end(JSON.stringify(await runCommandBounded("git push")));
            } else {
              throw new Error(`Unsupported git sync action: ${op}`);
            }
            return;
          }

          if (action === "trigger_git_milestone") {
            await runCommandBounded("git add -A");
            const msg = (
              args.milestoneSummary || "feat(agent): update workspace milestone"
            ).replace(/"/g, "'");
            const commitRes = await runCommandBounded(
              `git commit -m "${msg}"`
            );
            if (!commitRes.succeeded) {
              res.end(JSON.stringify(null));
              return;
            }
            const hashRes = await runCommandBounded(
              "git rev-parse --short HEAD"
            );
            res.end(
              JSON.stringify({
                commit_hash: hashRes.stdout.trim(),
                message: msg,
                files_changed: 1,
              })
            );
            return;
          }

          if (action === "check_github_update") {
            const localHead = await runCommandBounded(
              "git rev-parse --short HEAD",
              process.cwd()
            );
            const localSha = localHead.succeeded
              ? localHead.stdout.trim()
              : "local";
            let latestSha = localSha;
            let latestMsg = "Up to date";
            let latestDate = new Date().toISOString();
            let installerUrl: string | null = null;
            let installerName: string | null = null;
            let releaseUrl = "https://github.com/Hanzkii/Oxide/releases";

            try {
              const commitResp = await fetch(
                "https://api.github.com/repos/Hanzkii/Oxide/commits/main",
                {
                  headers: { "User-Agent": "Oxide-Updater" },
                }
              );
              if (commitResp.ok) {
                const cData: any = await commitResp.json();
                latestSha = (cData.sha || "").slice(0, 7);
                latestMsg =
                  (cData.commit?.message || "").split("\n")[0] ||
                  "Update available";
                latestDate = cData.commit?.committer?.date || latestDate;
              }

              const relResp = await fetch(
                "https://api.github.com/repos/Hanzkii/Oxide/releases/latest",
                {
                  headers: { "User-Agent": "Oxide-Updater" },
                }
              );
              if (relResp.ok) {
                const rData: any = await relResp.json();
                releaseUrl = rData.html_url || releaseUrl;
                const asset = (rData.assets || []).find(
                  (a: any) =>
                    a.name.endsWith("-setup.exe") ||
                    a.name.endsWith(".msi") ||
                    a.name.endsWith(".exe")
                );
                if (asset) {
                  installerUrl = asset.browser_download_url;
                  installerName = asset.name;
                }
              }
            } catch {}

            res.end(
              JSON.stringify({
                current_version: `v0.1.0 (${localSha})`,
                latest_version: `v0.1.0 (${latestSha})`,
                latest_commit_sha: latestSha,
                latest_commit_message: latestMsg,
                latest_commit_date: latestDate,
                update_available:
                  Boolean(latestSha) &&
                  Boolean(localSha) &&
                  latestSha !== localSha,
                installer_download_url: installerUrl,
                installer_name: installerName,
                release_url: releaseUrl,
                release_notes: latestMsg,
              })
            );
            return;
          }

          if (action === "perform_github_update") {
            const pullRes = await runCommandBounded(
              "git pull --rebase origin main",
              process.cwd()
            );
            if (!pullRes.succeeded) {
              throw new Error(pullRes.stderr || "git pull failed");
            }
            res.end(
              JSON.stringify({
                method: "git_pull",
                message: `Successfully pulled latest update from GitHub: ${
                  pullRes.stdout.trim() || "Already up to date"
                }`,
                restart_required: false,
              })
            );
            return;
          }

          res.statusCode = 404;
          res.end(JSON.stringify({ message: `Unknown endpoint: ${action}` }));
        } catch (err: any) {
          res.statusCode = 500;
          res.end(
            JSON.stringify({
              kind: "EXECUTION_ERROR",
              message: err?.message || String(err),
            })
          );
        }
      });
    },
  };
}

export default defineConfig(async () => ({
  plugins: [react(), createLocalSystemBridgePlugin()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
