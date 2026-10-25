import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  AgentStreamEvent,
  CommandExecutionResult,
  GitCommitRecord,
  GitStatusSummary,
  ProviderConfig,
  ProviderHealthReport,
  UpdateInstallResult,
  UpdateStatus,
  WorkspaceFileEntry,
  WorkspaceInfo,
} from "../types/agent";

type EventSubscriber = (event: AgentStreamEvent) => void;
const localSubscribers = new Set<EventSubscriber>();

function emitLocalEvent(event: AgentStreamEvent) {
  for (const sub of localSubscribers) {
    sub(event);
  }
}

function isTauriNative(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean((window as any).__TAURI_INTERNALS__)
  );
}

async function callBackend<T>(
  cmd: string,
  args: Record<string, any> = {}
): Promise<T> {
  if (isTauriNative()) {
    return invoke<T>(cmd, args);
  }

  const resp = await fetch(`/__oxide_api/${cmd}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });

  if (!resp.ok) {
    const errBody = await resp.json().catch(() => ({
      message: `HTTP ${resp.status}`,
    }));
    throw new Error(errBody.message || JSON.stringify(errBody));
  }
  return resp.json();
}

const LOCAL_SYSTEM_PROMPT = `You are Oxide, an autonomous AI software engineering agent (modeled after Google Antigravity).
Always explain what you are thinking first inside <think>...</think> tags so the user can watch your live reasoning in the GUI!
To perform an action in the workspace, output a single JSON object enclosed in \`\`\`json ... \`\`\` fences matching one of these actions:
- {"thought": "...", "plan": ["step 1", "step 2"], "action": "list_dir", "path": "."}
- {"thought": "...", "action": "read_file", "path": "package.json"}
- {"thought": "...", "action": "write_file", "path": "src/newFile.ts", "content": "...", "rationale": "..."}
- {"thought": "...", "action": "edit_file", "path": "src/App.tsx", "target": "old", "replacement": "new", "rationale": "..."}
- {"thought": "...", "action": "move_file", "source": "old.txt", "destination": "new.txt"}
- {"thought": "...", "action": "delete_file", "path": "temp.txt"}
- {"thought": "...", "action": "run_command", "command": "git status", "rationale": "..."}
- {"thought": "...", "action": "git_action", "operation": "pull" | "push" | "commit" | "status", "message": "..."}
- {"thought": "...", "action": "open_in_vscode", "path": "."}
- {"thought": "...", "action": "complete_task", "summary": "...", "auto_commit": true, "auto_push": false}`;

export const oxideBridge = {
  isNativeDesktop(): boolean {
    return isTauriNative();
  },

  async setWorkspace(workspacePath: string): Promise<WorkspaceInfo> {
    return callBackend<WorkspaceInfo>("set_workspace", { workspacePath });
  },

  async listWorkspaceFiles(subPath?: string): Promise<WorkspaceFileEntry[]> {
    return callBackend<WorkspaceFileEntry[]>("list_workspace_files", {
      subPath: subPath ?? ".",
    });
  },

  async readWorkspaceFile(relativePath: string): Promise<string> {
    return callBackend<string>("read_workspace_file", { relativePath });
  },

  async saveWorkspaceFile(
    relativePath: string,
    content: string
  ): Promise<string> {
    return callBackend<string>("save_workspace_file", {
      relativePath,
      content,
    });
  },

  async moveWorkspaceFile(
    sourcePath: string,
    destinationPath: string
  ): Promise<string> {
    return callBackend<string>("move_workspace_file", {
      sourcePath,
      destinationPath,
    });
  },

  async deleteWorkspaceFile(relativePath: string): Promise<string> {
    return callBackend<string>("delete_workspace_file", { relativePath });
  },

  async openInVsCode(workspacePath?: string): Promise<string> {
    return callBackend<string>("open_in_vscode", {
      workspacePath: workspacePath ?? null,
    });
  },

  async getProviderHealth(): Promise<ProviderHealthReport> {
    return callBackend<ProviderHealthReport>("get_provider_health");
  },

  async updateProviderConfig(config: ProviderConfig): Promise<ProviderConfig> {
    return callBackend<ProviderConfig>("update_provider_config", { config });
  },

  async executeBoundedCommand(
    commandLine: string
  ): Promise<CommandExecutionResult> {
    return callBackend<CommandExecutionResult>("execute_bounded_command", {
      commandLine,
    });
  },

  async getGitStatus(): Promise<GitStatusSummary> {
    return callBackend<GitStatusSummary>("get_git_status");
  },

  async gitSyncAction(operation: "pull" | "push"): Promise<CommandExecutionResult> {
    return callBackend<CommandExecutionResult>("git_sync_action", {
      operation,
    });
  },

  async triggerGitMilestone(
    milestoneSummary: string
  ): Promise<GitCommitRecord | null> {
    return callBackend<GitCommitRecord | null>("trigger_git_milestone", {
      milestoneSummary,
    });
  },

  async checkGithubUpdate(): Promise<UpdateStatus> {
    return callBackend<UpdateStatus>("check_github_update");
  },

  async performGithubUpdate(): Promise<UpdateInstallResult> {
    return callBackend<UpdateInstallResult>("perform_github_update");
  },

  async runAgentTask(prompt: string): Promise<string> {
    if (isTauriNative()) {
      return invoke<string>("run_agent_task", { prompt });
    }

    // Standalone local autonomous loop talking directly to Ollama + local system bridge
    const health = await this.getProviderHealth();
    const baseUrl = health.config.ollama_base_url.replace(/\/$/, "");
    const model = health.config.ollama_model;

    const messages: { role: string; content: string }[] = [
      { role: "system", content: LOCAL_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ];

    for (let step = 1; step <= 10; step++) {
      emitLocalEvent({
        type: "workflow_card",
        step,
        title: `Thinking & Planning (Step ${step}/10)`,
        detail: `Querying ${model} on ${baseUrl}`,
        status: "running",
      });

      let fullReply = "";
      try {
        const resp = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages,
            stream: true,
            options: { temperature: health.config.temperature },
          }),
        });

        if (!resp.ok || !resp.body) {
          throw new Error(
            `Ollama returned HTTP ${resp.status}. Make sure 'ollama serve' is running and '${model}' is pulled.`
          );
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let lineBuf = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          lineBuf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = lineBuf.indexOf("\n")) !== -1) {
            const line = lineBuf.slice(0, idx).trim();
            lineBuf = lineBuf.slice(idx + 1);
            if (!line) continue;
            try {
              const parsed = JSON.parse(line);
              const token = parsed.message?.content || "";
              if (token) {
                fullReply += token;
                emitLocalEvent({
                  type: "token_delta",
                  step,
                  provider: model,
                  token,
                });

                const thinkStart = fullReply.indexOf("<think>");
                if (thinkStart !== -1) {
                  const after = fullReply.slice(thinkStart + 7);
                  const thinkEnd = after.indexOf("</think>");
                  const currentThought =
                    thinkEnd !== -1 ? after.slice(0, thinkEnd) : after;
                  if (currentThought.trim()) {
                    emitLocalEvent({
                      type: "thinking_update",
                      step,
                      thought: currentThought.trim(),
                    });
                  }
                }
              }
            } catch {}
          }
        }
      } catch (err: any) {
        emitLocalEvent({
          type: "task_error",
          message: err?.message || String(err),
        });
        throw err;
      }

      messages.push({ role: "assistant", content: fullReply });

      const jsonMatch =
        fullReply.match(/```json\s*([\s\S]*?)```/) ||
        (fullReply.trim().startsWith("{") ? [null, fullReply.trim()] : null);

      if (!jsonMatch || !jsonMatch[1]) {
        emitLocalEvent({
          type: "task_completed",
          steps_taken: step,
          summary: fullReply,
        });
        return fullReply;
      }

      let tool: any;
      try {
        tool = JSON.parse(jsonMatch[1]);
      } catch {
        emitLocalEvent({
          type: "task_completed",
          steps_taken: step,
          summary: fullReply,
        });
        return fullReply;
      }

      if (tool.thought) {
        emitLocalEvent({
          type: "thinking_update",
          step,
          thought: tool.thought,
        });
      }

      if (Array.isArray(tool.plan)) {
        emitLocalEvent({
          type: "plan_update",
          step,
          items: tool.plan,
        });
      }

      if (tool.action === "list_dir") {
        const entries = await this.listWorkspaceFiles(tool.path || ".");
        const summary = entries
          .map((e) => `${e.is_dir ? "[DIR] " : "[FILE]"} ${e.relative_path}`)
          .join("\n");
        emitLocalEvent({
          type: "workflow_card",
          step,
          title: `Listed Directory: ${tool.path || "."}`,
          detail: `${entries.length} entries`,
          status: "succeeded",
        });
        messages.push({
          role: "user",
          content: `[DIR_LISTING]\n${summary}\n[/DIR_LISTING]`,
        });
      } else if (tool.action === "read_file") {
        try {
          const content = await this.readWorkspaceFile(tool.path);
          emitLocalEvent({
            type: "workflow_card",
            step,
            title: `Read File: ${tool.path}`,
            detail: `${content.length} chars`,
            status: "succeeded",
          });
          messages.push({
            role: "user",
            content: `[FILE_CONTENT path="${tool.path}"]\n${content.slice(
              0,
              12000
            )}\n[/FILE_CONTENT]`,
          });
        } catch (e: any) {
          messages.push({
            role: "user",
            content: `[FILE_READ_ERROR] ${e?.message}`,
          });
        }
      } else if (tool.action === "write_file") {
        await this.saveWorkspaceFile(tool.path, tool.content || "");
        emitLocalEvent({
          type: "file_change",
          step,
          operation: "write",
          path: tool.path,
          detail: tool.rationale || "Wrote file",
        });
        emitLocalEvent({
          type: "workflow_card",
          step,
          title: `Wrote File: ${tool.path}`,
          detail: tool.rationale || "",
          status: "succeeded",
        });
        messages.push({
          role: "user",
          content: `[FILE_WRITE_SUCCESS] Wrote ${tool.path}`,
        });
      } else if (tool.action === "edit_file") {
        const existing = await this.readWorkspaceFile(tool.path);
        if (existing.includes(tool.target)) {
          const updated = existing.replace(tool.target, tool.replacement);
          await this.saveWorkspaceFile(tool.path, updated);
          emitLocalEvent({
            type: "file_change",
            step,
            operation: "edit",
            path: tool.path,
            detail: tool.rationale || "Edited file",
          });
          emitLocalEvent({
            type: "workflow_card",
            step,
            title: `Edited File: ${tool.path}`,
            detail: tool.rationale || "",
            status: "succeeded",
          });
          messages.push({
            role: "user",
            content: `[FILE_EDIT_SUCCESS] Updated ${tool.path}`,
          });
        } else {
          emitLocalEvent({
            type: "workflow_card",
            step,
            title: `Edit Mismatch: ${tool.path}`,
            detail: "Target block not found; re-reading file",
            status: "self_correcting",
          });
          messages.push({
            role: "user",
            content: `[FILE_EDIT_ERROR] Target snippet not found in ${tool.path}`,
          });
        }
      } else if (tool.action === "move_file") {
        await this.moveWorkspaceFile(tool.source, tool.destination);
        emitLocalEvent({
          type: "file_change",
          step,
          operation: "move",
          path: `${tool.source} -> ${tool.destination}`,
          detail: tool.rationale || "Moved file",
        });
        messages.push({
          role: "user",
          content: `[FILE_MOVE_SUCCESS] Moved ${tool.source} -> ${tool.destination}`,
        });
      } else if (tool.action === "delete_file") {
        await this.deleteWorkspaceFile(tool.path);
        emitLocalEvent({
          type: "file_change",
          step,
          operation: "delete",
          path: tool.path,
          detail: tool.rationale || "Deleted file",
        });
        messages.push({
          role: "user",
          content: `[FILE_DELETE_SUCCESS] Deleted ${tool.path}`,
        });
      } else if (tool.action === "run_command") {
        const res = await this.executeBoundedCommand(tool.command);
        emitLocalEvent({
          type: "terminal_output",
          step,
          result: res,
        });
        emitLocalEvent({
          type: "workflow_card",
          step,
          title: res.succeeded
            ? `Command Succeeded: ${tool.command}`
            : `Exit ${res.exit_code} — Self-Correcting`,
          detail: res.succeeded
            ? `${res.duration_ms}ms`
            : res.stderr.slice(0, 120),
          status: res.succeeded ? "succeeded" : "self_correcting",
        });
        messages.push({
          role: "user",
          content: `[TERMINAL_OBSERVATION exit=${res.exit_code}]\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}\n[/TERMINAL_OBSERVATION]`,
        });
      } else if (tool.action === "git_action") {
        const op = (tool.operation || "status").toLowerCase();
        if (op === "pull" || op === "push") {
          const res = await this.gitSyncAction(op);
          emitLocalEvent({ type: "terminal_output", step, result: res });
          messages.push({
            role: "user",
            content: `[GIT_${op.toUpperCase()}] exit=${res.exit_code}\n${res.stdout}\n${res.stderr}`,
          });
        } else if (op === "commit") {
          const rec = await this.triggerGitMilestone(
            tool.message || "feat(agent): update milestone"
          );
          if (rec) {
            emitLocalEvent({ type: "git_milestone", step, commit: rec });
          }
          messages.push({
            role: "user",
            content: `[GIT_COMMIT] ${rec ? rec.commit_hash : "clean"}`,
          });
        } else {
          const st = await this.getGitStatus();
          messages.push({
            role: "user",
            content: `[GIT_STATUS] ${JSON.stringify(st)}`,
          });
        }
      } else if (tool.action === "open_in_vscode") {
        await this.openInVsCode(tool.path);
        messages.push({ role: "user", content: `[OPENED_IN_VSCODE]` });
      } else if (tool.action === "complete_task") {
        if (tool.auto_commit) {
          const rec = await this.triggerGitMilestone(tool.summary);
          if (rec) {
            emitLocalEvent({ type: "git_milestone", step, commit: rec });
          }
        }
        if (tool.auto_push) {
          const pushRes = await this.gitSyncAction("push");
          emitLocalEvent({ type: "terminal_output", step, result: pushRes });
        }
        emitLocalEvent({
          type: "task_completed",
          steps_taken: step,
          summary: tool.summary,
        });
        return tool.summary;
      }
    }

    return "Reached max steps";
  },

  async onAgentEvent(
    handler: (event: AgentStreamEvent) => void
  ): Promise<UnlistenFn> {
    localSubscribers.add(handler);
    let tauriUnlisten: UnlistenFn | null = null;
    if (isTauriNative()) {
      tauriUnlisten = await listen<AgentStreamEvent>(
        "oxide://agent-event",
        (evt) => {
          handler(evt.payload);
        }
      );
    }
    return () => {
      localSubscribers.delete(handler);
      if (tauriUnlisten) tauriUnlisten();
    };
  },
};
