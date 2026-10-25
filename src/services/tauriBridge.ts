import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  AgentRoleKind,
  AgentStreamEvent,
  CommandExecutionResult,
  GitCommitRecord,
  GitStatusSummary,
  HardwareSpecs,
  HuggingFaceModelEntry,
  McpServerConfig,
  McpToolCallResult,
  ModelInstallResult,
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

const LOCAL_SYSTEM_PROMPT = `You are Oxide Lead Architect, a large-model autonomous AI orchestrator (modeled after Google Antigravity).
You handle complex reasoning and can delegate subtasks to faster, specialized Subagents governed by the PC's Hardware Governor!
Always explain what you are thinking first inside <think>...</think> tags so the user can watch your live reasoning in the GUI!
To perform an action or delegate subtasks, output a single JSON object enclosed in \`\`\`json ... \`\`\` fences matching one of these actions:
- {"thought": "...", "plan": ["step 1", "step 2"], "action": "delegate_subagents", "subtasks": [{"id": "sub-1", "role": "research_subagent", "title": "Inspect config", "instructions": "...", "target_path": "package.json"}, {"id": "sub-2", "role": "coder_subagent", "title": "Draft code", "instructions": "..."}]}
- {"thought": "...", "plan": ["step 1", "step 2"], "action": "list_dir", "path": "."}
- {"thought": "...", "action": "read_file", "path": "package.json"}
- {"thought": "...", "action": "write_file", "path": "src/newFile.ts", "content": "...", "rationale": "..."}
- {"thought": "...", "action": "edit_file", "path": "src/App.tsx", "target": "old", "replacement": "new", "rationale": "..."}
- {"thought": "...", "action": "move_file", "source": "old.txt", "destination": "new.txt"}
- {"thought": "...", "action": "delete_file", "path": "temp.txt"}
- {"thought": "...", "action": "run_command", "command": "git status", "rationale": "..."}
- {"thought": "...", "action": "git_action", "operation": "pull" | "push" | "commit" | "status", "message": "..."}
- {"thought": "...", "action": "open_in_vscode", "path": "."}
- {"thought": "...", "action": "call_mcp_tool", "server": "oxide-memory", "tool": "store_memory", "arguments": {"key": "...", "value": "..."}}
- {"thought": "...", "action": "complete_task", "summary": "...", "auto_commit": true, "auto_push": false}`;

function getModelForRole(config: ProviderConfig, role: AgentRoleKind): string {
  const routing = config.task_routing;
  if (!routing) return config.ollama_model;
  switch (role) {
    case "architect":
      return routing.architect_model || config.ollama_model;
    case "coder_subagent":
      return routing.coder_subagent_model || config.ollama_model;
    case "research_subagent":
      return routing.research_subagent_model || config.ollama_model;
    case "tester_subagent":
      return routing.tester_subagent_model || config.ollama_model;
  }
}

export const oxideBridge = {
  isNativeDesktop(): boolean {
    return isTauriNative();
  },

  async getHardwareSpecs(): Promise<HardwareSpecs> {
    return callBackend<HardwareSpecs>("get_hardware_specs");
  },

  async listMcpServers(): Promise<McpServerConfig[]> {
    return callBackend<McpServerConfig[]>("list_mcp_servers");
  },

  async saveMcpServer(server: McpServerConfig): Promise<McpServerConfig[]> {
    return callBackend<McpServerConfig[]>("save_mcp_server", { server });
  },

  async removeMcpServer(serverId: string): Promise<McpServerConfig[]> {
    return callBackend<McpServerConfig[]>("remove_mcp_server", { serverId });
  },

  async discoverMcpTools(serverId: string): Promise<McpServerConfig> {
    return callBackend<McpServerConfig>("discover_mcp_tools", { serverId });
  },

  async callMcpTool(
    serverId: string,
    toolName: string,
    args: Record<string, any> = {}
  ): Promise<McpToolCallResult> {
    return callBackend<McpToolCallResult>("call_mcp_tool", {
      serverId,
      toolName,
      arguments: args,
    });
  },

  async setWorkspace(workspacePath: string): Promise<WorkspaceInfo> {
    return callBackend<WorkspaceInfo>("set_workspace", { workspacePath });
  },

  async pickFolderDialog(): Promise<string | null> {
    return callBackend<string | null>("pick_folder_dialog");
  },

  async loadStudioState(): Promise<string | null> {
    return callBackend<string | null>("load_studio_state");
  },

  async saveStudioState(stateJson: string): Promise<boolean> {
    return callBackend<boolean>("save_studio_state", { stateJson });
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

  async gitSyncAction(
    operation: "pull" | "push"
  ): Promise<CommandExecutionResult> {
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

  async ensureOllamaEngine(): Promise<string> {
    return callBackend<string>("ensure_ollama_engine");
  },

  async installAiModel(modelId: string): Promise<ModelInstallResult> {
    return callBackend<ModelInstallResult>("install_ai_model", {
      modelId,
      model_id: modelId,
    });
  },

  async deleteAiModel(modelId: string): Promise<boolean> {
    return callBackend<boolean>("delete_ai_model", {
      modelId,
      model_id: modelId,
    });
  },

  async searchHuggingfaceGguf(query: string): Promise<HuggingFaceModelEntry[]> {
    return callBackend<HuggingFaceModelEntry[]>("search_huggingface_gguf", {
      query,
    });
  },

  async runAgentTask(prompt: string): Promise<string> {
    if (isTauriNative()) {
      return invoke<string>("run_agent_task", { prompt });
    }

    const [health, hw] = await Promise.all([
      this.getProviderHealth(),
      this.getHardwareSpecs(),
    ]);
    const baseUrl = health.config.ollama_base_url.replace(/\/$/, "");
    const architectModel = getModelForRole(health.config, "architect");
    const maxAllowedSubagents =
      health.config.auto_throttle_on_high_load && hw.throttled_by_load
        ? 1
        : Math.max(
            1,
            Math.min(
              health.config.max_concurrent_subagents || 1,
              Math.max(1, hw.hard_limit_subagents)
            )
          );

    const messages: { role: string; content: string }[] = [
      { role: "system", content: LOCAL_SYSTEM_PROMPT },
      {
        role: "user",
        content: `PC Hardware Governor: ${hw.governor_tier} (${hw.available_ram_gb} GB Free RAM, Max Concurrent Subagents: ${maxAllowedSubagents})\nSubagents Enabled: ${health.config.enable_subagents}\nUser Request: ${prompt}`,
      },
    ];

    for (let step = 1; step <= 10; step++) {
      emitLocalEvent({
        type: "workflow_card",
        step,
        title: `Lead Architect Thinking (Step ${step}/10)`,
        detail: `Architect Model: ${architectModel} (${baseUrl})`,
        status: "running",
      });

      let fullReply = "";
      try {
        const resp = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: architectModel,
            messages,
            stream: true,
            options: { temperature: health.config.temperature },
          }),
        });

        if (!resp.ok || !resp.body) {
          throw new Error(
            `Ollama returned HTTP ${resp.status}. Make sure 'ollama serve' is running and '${architectModel}' is pulled.`
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
                  provider: architectModel,
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

      if (tool.action === "delegate_subagents" && Array.isArray(tool.subtasks)) {
        const subtasks = tool.subtasks;
        const liveHw = await this.getHardwareSpecs();
        const limit =
          health.config.auto_throttle_on_high_load && liveHw.throttled_by_load
            ? 1
            : Math.max(
                1,
                Math.min(
                  health.config.max_concurrent_subagents || 1,
                  Math.max(1, liveHw.hard_limit_subagents)
                )
              );

        emitLocalEvent({
          type: "workflow_card",
          step,
          title: `Delegating ${subtasks.length} Subagent(s) [PC Limit: ${limit} concurrent]`,
          detail: `${liveHw.governor_tier} • Free RAM: ${liveHw.available_ram_gb} GB • CPU: ${liveHw.cpu_usage_percent}%`,
          status: "running",
        });

        for (const sp of subtasks) {
          const role: AgentRoleKind = sp.role || "research_subagent";
          emitLocalEvent({
            type: "subagent_status",
            id: sp.id || `sub-${Math.random()}`,
            role,
            model: getModelForRole(health.config, role),
            title: sp.title || "Subtask",
            state: liveHw.throttled_by_load
              ? "throttled_waiting_for_hardware"
              : "queued",
            thought:
              "Queued by Hardware Governor — waiting for available RAM/CPU slot...",
            output_preview: "",
            active_workers: 0,
            max_allowed_workers: limit,
          });
        }

        // Execute subtasks in hardware-bounded chunks of size `limit`
        const batchResults: string[] = [];
        for (let i = 0; i < subtasks.length; i += limit) {
          const chunk = subtasks.slice(i, i + limit);
          const chunkPromises = chunk.map(async (sp: any) => {
            const role: AgentRoleKind = sp.role || "research_subagent";
            const subModel = getModelForRole(health.config, role);
            const subId = sp.id || `sub-${i}`;

            emitLocalEvent({
              type: "subagent_status",
              id: subId,
              role,
              model: subModel,
              title: sp.title || "Subtask",
              state: "running",
              thought: `Executing instructions: ${sp.instructions}`,
              output_preview: "",
              active_workers: chunk.length,
              max_allowed_workers: limit,
            });

            let fileCtx = "";
            if (sp.target_path) {
              try {
                const raw = await this.readWorkspaceFile(sp.target_path);
                fileCtx = `\nTarget File (${sp.target_path}):\n${raw.slice(
                  0,
                  6000
                )}`;
              } catch {}
            }

            try {
              const subResp = await fetch(`${baseUrl}/api/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: subModel,
                  stream: false,
                  messages: [
                    {
                      role: "system",
                      content:
                        "You are a fast, specialized Oxide Subagent executing a focused subtask for the Lead Architect AI. Begin with a brief <think>...</think> explanation, then provide a concise result.",
                    },
                    {
                      role: "user",
                      content: `Role: ${role}\nTitle: ${sp.title}\nInstructions: ${sp.instructions}${fileCtx}`,
                    },
                  ],
                }),
              });
              const data = await subResp.json();
              const outText: string =
                data?.message?.content || "Subtask completed.";
              const thinkStart = outText.indexOf("<think>");
              const thinkEnd = outText.indexOf("</think>");
              const subThought =
                thinkStart !== -1 && thinkEnd !== -1
                  ? outText.slice(thinkStart + 7, thinkEnd).trim()
                  : "Finished analysis.";

              emitLocalEvent({
                type: "subagent_status",
                id: subId,
                role,
                model: subModel,
                title: sp.title || "Subtask",
                state: "completed",
                thought: subThought,
                output_preview: outText.slice(0, 260),
                active_workers: 0,
                max_allowed_workers: limit,
              });

              return `[SUBAGENT id="${subId}" role="${role}" model="${subModel}" status="COMPLETED"]\n${outText}\n[/SUBAGENT]`;
            } catch (e: any) {
              emitLocalEvent({
                type: "subagent_status",
                id: subId,
                role,
                model: subModel,
                title: sp.title || "Subtask",
                state: "failed",
                thought: `Error: ${e?.message}`,
                output_preview: e?.message || "Failed",
                active_workers: 0,
                max_allowed_workers: limit,
              });
              return `[SUBAGENT id="${subId}" status="FAILED"] ${e?.message}`;
            }
          });

          const settled = await Promise.all(chunkPromises);
          batchResults.push(...settled);
        }

        messages.push({
          role: "user",
          content: `[SUBAGENT_BATCH_RESULTS]\n${batchResults.join(
            "\n\n"
          )}\n[/SUBAGENT_BATCH_RESULTS]`,
        });
      } else if (tool.action === "list_dir") {
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
      } else if (tool.action === "call_mcp_tool") {
        try {
          const mcpRes = await this.callMcpTool(
            tool.server,
            tool.tool,
            tool.arguments || {}
          );
          emitLocalEvent({
            type: "workflow_card",
            step,
            title: `MCP Tool: ${tool.server}/${tool.tool}`,
            detail: mcpRes.content.slice(0, 140),
            status: mcpRes.succeeded ? "succeeded" : "self_correcting",
          });
          messages.push({
            role: "user",
            content: `[MCP_TOOL_RESULT server="${tool.server}" tool="${tool.tool}"]\n${mcpRes.content}\n[/MCP_TOOL_RESULT]`,
          });
        } catch (e: any) {
          messages.push({
            role: "user",
            content: `[MCP_TOOL_ERROR] ${e?.message}`,
          });
        }
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
