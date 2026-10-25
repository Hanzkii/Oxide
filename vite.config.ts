import { defineConfig, Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;

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
  };
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
    },
  };

  function resolveInsideWorkspace(candidate: string): string {
    const resolved = path.resolve(state.workspaceRoot, candidate || ".");
    const rootResolved = path.resolve(state.workspaceRoot);
    if (
      !resolved.toLowerCase().startsWith(rootResolved.toLowerCase())
    ) {
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
                "qwen2.5-coder:latest",
                "qwen2.5-coder:7b",
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
            state.providerConfig = {
              ...state.providerConfig,
              ...(args.config || {}),
            };
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
