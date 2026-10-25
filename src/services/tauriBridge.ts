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
  ModelDownloadProgress,
  UpdateDownloadProgress,
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

const modelProgressListeners = new Set<(p: ModelDownloadProgress) => void>();
export function emitModelProgress(p: ModelDownloadProgress) {
  modelProgressListeners.forEach((l) => l(p));
}

async function streamChatFromProvider(
  health: ProviderHealthReport,
  requestedModel: string,
  messages: { role: string; content: string }[],
  onToken: (token: string) => void
): Promise<{ text: string; effectiveModel: string }> {
  const provider = health.config.active_provider || "ollama";
  let targetModel = requestedModel;

  if (provider === "oxide_native") {
    const port = health.config.oxide_native_port || 11435;
    const nativeModel =
      health.config.oxide_native_model ||
      (health.oxide_native_models && health.oxide_native_models[0]) ||
      "qwen2.5-coder-14b-instruct-abliterated.gguf";

    const endpoint = `http://127.0.0.1:${port}/v1/chat/completions`;
    let resp: Response;
    try {
      resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: nativeModel,
          messages,
          stream: true,
          temperature: health.config.temperature ?? 0.1,
        }),
      });
    } catch {
      throw new Error(
        `Oxide Native Engine not responding on http://127.0.0.1:${port}. Click 'Start Native Engine' in Settings -> AI Providers.`
      );
    }

    if (!resp.ok || !resp.body) {
      throw new Error(`Oxide Native Engine returned HTTP ${resp.status}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let lineBuf = "";
    let fullReply = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      lineBuf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = lineBuf.indexOf("\n")) !== -1) {
        const line = lineBuf.slice(0, idx).trim();
        lineBuf = lineBuf.slice(idx + 1);
        if (!line || !line.startsWith("data: ")) continue;
        const dataStr = line.slice(6).trim();
        if (dataStr === "[DONE]") break;
        try {
          const parsed = JSON.parse(dataStr);
          const delta = parsed.choices?.[0]?.delta;
          const token = delta?.content || delta?.reasoning_content || "";
          if (token) {
            fullReply += token;
            onToken(token);
          }
        } catch {}
      }
    }
    return { text: fullReply, effectiveModel: nativeModel };
  }

  if (provider === "custom_openai") {
    const customUrl = (
      health.config.custom_openai_url || "http://127.0.0.1:1234/v1"
    ).replace(/\/$/, "");
    const customModel = health.config.custom_openai_model || "local-model";
    const resp = await fetch(`${customUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: customModel,
        messages,
        stream: true,
        temperature: health.config.temperature ?? 0.1,
      }),
    });
    if (!resp.ok || !resp.body) {
      throw new Error(
        `OpenAI-compatible server returned HTTP ${resp.status} from ${customUrl}`
      );
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let lineBuf = "";
    let fullReply = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      lineBuf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = lineBuf.indexOf("\n")) !== -1) {
        const line = lineBuf.slice(0, idx).trim();
        lineBuf = lineBuf.slice(idx + 1);
        if (!line || !line.startsWith("data: ")) continue;
        const dataStr = line.slice(6).trim();
        if (dataStr === "[DONE]") break;
        try {
          const parsed = JSON.parse(dataStr);
          const delta = parsed.choices?.[0]?.delta;
          const token = delta?.content || delta?.reasoning_content || "";
          if (token) {
            fullReply += token;
            onToken(token);
          }
        } catch {}
      }
    }
    return { text: fullReply, effectiveModel: customModel };
  }

  if (provider === "anthropic") {
    const key = health.config.anthropic_api_key || "";
    if (!key) {
      throw new Error(
        "Anthropic API key is missing. Please set your Anthropic API Key in Settings -> AI Providers."
      );
    }
    const model = health.config.anthropic_model || "claude-3-5-sonnet-20241022";
    const systemMsg = messages.find((m) => m.role === "system")?.content || "";
    const chatMsgs = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      }));

    if (chatMsgs.length === 0) {
      chatMsgs.push({ role: "user", content: "Hello" });
    }

    const payload: any = {
      model,
      max_tokens: 4096,
      messages: chatMsgs,
      stream: true,
      temperature: health.config.temperature ?? 0.1,
    };
    if (systemMsg) payload.system = systemMsg;

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok || !resp.body) {
      const errText = await resp.text().catch(() => "");
      throw new Error(
        `Anthropic Claude returned HTTP ${resp.status}: ${errText}`
      );
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let lineBuf = "";
    let fullReply = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      lineBuf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = lineBuf.indexOf("\n")) !== -1) {
        const line = lineBuf.slice(0, idx).trim();
        lineBuf = lineBuf.slice(idx + 1);
        if (!line || !line.startsWith("data: ")) continue;
        const dataStr = line.slice(6).trim();
        if (dataStr === "[DONE]") break;
        try {
          const parsed = JSON.parse(dataStr);
          if (parsed.type === "content_block_delta" && parsed.delta?.text) {
            const token = parsed.delta.text;
            fullReply += token;
            onToken(token);
          }
        } catch {}
      }
    }
    return { text: fullReply, effectiveModel: model };
  }

  if (provider === "openai") {
    const key = health.config.openai_api_key || "";
    if (!key) {
      throw new Error(
        "OpenAI API key is missing. Please set your OpenAI API Key in Settings -> AI Providers."
      );
    }
    const model = health.config.openai_model || "gpt-4o";
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        temperature: health.config.temperature ?? 0.1,
      }),
    });

    if (!resp.ok || !resp.body) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`OpenAI returned HTTP ${resp.status}: ${errText}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let lineBuf = "";
    let fullReply = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      lineBuf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = lineBuf.indexOf("\n")) !== -1) {
        const line = lineBuf.slice(0, idx).trim();
        lineBuf = lineBuf.slice(idx + 1);
        if (!line || !line.startsWith("data: ")) continue;
        const dataStr = line.slice(6).trim();
        if (dataStr === "[DONE]") break;
        try {
          const parsed = JSON.parse(dataStr);
          const delta = parsed.choices?.[0]?.delta;
          const token = delta?.content || delta?.reasoning_content || "";
          if (token) {
            fullReply += token;
            onToken(token);
          }
        } catch {}
      }
    }
    return { text: fullReply, effectiveModel: model };
  }

  if (provider === "gemini") {
    const key = health.config.gemini_api_key || "";
    if (!key) {
      throw new Error(
        "Google Gemini API key is missing. Please set your Gemini API Key in Settings -> AI Providers."
      );
    }
    const model = health.config.gemini_model || "gemini-2.0-flash";
    const resp = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          temperature: health.config.temperature ?? 0.1,
        }),
      }
    );

    if (!resp.ok || !resp.body) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`Google Gemini returned HTTP ${resp.status}: ${errText}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let lineBuf = "";
    let fullReply = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      lineBuf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = lineBuf.indexOf("\n")) !== -1) {
        const line = lineBuf.slice(0, idx).trim();
        lineBuf = lineBuf.slice(idx + 1);
        if (!line || !line.startsWith("data: ")) continue;
        const dataStr = line.slice(6).trim();
        if (dataStr === "[DONE]") break;
        try {
          const parsed = JSON.parse(dataStr);
          const delta = parsed.choices?.[0]?.delta;
          const token = delta?.content || delta?.reasoning_content || "";
          if (token) {
            fullReply += token;
            onToken(token);
          }
        } catch {}
      }
    }
    return { text: fullReply, effectiveModel: model };
  }

  if (provider === "deepseek") {
    const key = health.config.deepseek_api_key || "";
    if (!key) {
      throw new Error(
        "DeepSeek API key is missing. Please set your DeepSeek API Key in Settings -> AI Providers."
      );
    }
    const model = health.config.deepseek_model || "deepseek-chat";
    const resp = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        temperature: health.config.temperature ?? 0.1,
      }),
    });

    if (!resp.ok || !resp.body) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`DeepSeek returned HTTP ${resp.status}: ${errText}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let lineBuf = "";
    let fullReply = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      lineBuf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = lineBuf.indexOf("\n")) !== -1) {
        const line = lineBuf.slice(0, idx).trim();
        lineBuf = lineBuf.slice(idx + 1);
        if (!line || !line.startsWith("data: ")) continue;
        const dataStr = line.slice(6).trim();
        if (dataStr === "[DONE]") break;
        try {
          const parsed = JSON.parse(dataStr);
          const delta = parsed.choices?.[0]?.delta;
          const token = delta?.content || delta?.reasoning_content || "";
          if (token) {
            fullReply += token;
            onToken(token);
          }
        } catch {}
      }
    }
    return { text: fullReply, effectiveModel: model };
  }

  // Default: Ollama
  const baseUrl = health.config.ollama_base_url.replace(/\/$/, "");
  const installedModels = health.ollama_models || [];

  // Auto-heal model if requested is missing from installed list
  if (installedModels.length > 0 && !installedModels.includes(targetModel)) {
    targetModel = installedModels[0];
  }

  let resp = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: targetModel,
      messages,
      stream: true,
      options: { temperature: health.config.temperature },
    }),
  });

  // If 404, retry once with first installed model if available
  if (
    resp.status === 404 &&
    installedModels.length > 0 &&
    targetModel !== installedModels[0]
  ) {
    targetModel = installedModels[0];
    resp = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: targetModel,
        messages,
        stream: true,
        options: { temperature: health.config.temperature },
      }),
    });
  }

  if (!resp.ok || !resp.body) {
    if (resp.status === 404) {
      throw new Error(
        `Ollama returned HTTP 404: model '${targetModel}' not found. Please install a model via the AI Model Hub, or switch to Oxide Native Engine in Settings.`
      );
    }
    throw new Error(
      `Ollama returned HTTP ${resp.status}. Make sure 'ollama serve' is running.`
    );
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let lineBuf = "";
  let fullReply = "";

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
          onToken(token);
        }
      } catch {}
    }
  }

  return { text: fullReply, effectiveModel: targetModel };
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

  async createWorkspaceFolder(relativePath: string): Promise<string> {
    return callBackend<string>("create_workspace_folder", { relativePath });
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

  async startNativeEngine(model?: string, layers?: number): Promise<any> {
    return callBackend("start_native_engine", { model, layers });
  },

  async stopNativeEngine(): Promise<any> {
    return callBackend("stop_native_engine");
  },

  async openNativeModelsFolder(): Promise<void> {
    return callBackend("open_native_models_folder");
  },

  async openNativeRuntimeFolder(): Promise<void> {
    return callBackend("open_native_runtime_folder");
  },

  async installAiModel(modelId: string): Promise<ModelInstallResult> {
    if (isTauriNative()) {
      return callBackend<ModelInstallResult>("install_ai_model", {
        modelId,
        model_id: modelId,
      });
    }

    const resp = await fetch("/__oxide_api/install_ai_model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId, model_id: modelId }),
    });

    if (!resp.ok || !resp.body) {
      const err = await resp
        .json()
        .catch(() => ({ message: `HTTP ${resp.status}` }));
      throw new Error(err.message || "Failed to start model download");
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let lineBuf = "";
    let finalResult: ModelInstallResult = {
      model_id: modelId,
      success: true,
      message: `Installed ${modelId} successfully!`,
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      lineBuf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = lineBuf.indexOf("\n")) !== -1) {
        const line = lineBuf.slice(0, idx).trim();
        lineBuf = lineBuf.slice(idx + 1);
        if (!line || !line.startsWith("data: ")) continue;
        const dataStr = line.slice(6).trim();
        try {
          const data = JSON.parse(dataStr);
          if (data.error) throw new Error(data.error);
          if (data.type === "progress") {
            emitModelProgress({
              model_id: data.model_id || modelId,
              status: data.status || "Downloading...",
              completed: data.completed || 0,
              total: data.total || 0,
              percent: data.percent || 0,
            });
          } else if (data.type === "done") {
            finalResult = {
              model_id: data.model_id || modelId,
              success: Boolean(data.success),
              message: data.message || `Installed ${modelId} successfully!`,
            };
          }
        } catch (e: any) {
          if (
            e.message &&
            !e.message.includes("Unexpected token") &&
            !e.message.includes("is not valid JSON")
          ) {
            throw e;
          }
        }
      }
    }

    return finalResult;
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

  async testProviderConnection(
    config: ProviderConfig
  ): Promise<{ success: boolean; message: string }> {
    const provider = config.active_provider;
    try {
      if (provider === "anthropic") {
        if (!config.anthropic_api_key)
          throw new Error("Anthropic API key is empty");
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": config.anthropic_api_key,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: config.anthropic_model || "claude-3-5-sonnet-20241022",
            max_tokens: 16,
            messages: [{ role: "user", content: "Hi" }],
          }),
        });
        if (!resp.ok) {
          const text = await resp.text();
          throw new Error(`HTTP ${resp.status}: ${text}`);
        }
        return {
          success: true,
          message: `Connected to Anthropic (${
            config.anthropic_model || "Claude 3.5 Sonnet"
          }) successfully!`,
        };
      }

      if (provider === "openai") {
        if (!config.openai_api_key) throw new Error("OpenAI API key is empty");
        const resp = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.openai_api_key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: config.openai_model || "gpt-4o",
            max_tokens: 16,
            messages: [{ role: "user", content: "Hi" }],
          }),
        });
        if (!resp.ok) {
          const text = await resp.text();
          throw new Error(`HTTP ${resp.status}: ${text}`);
        }
        return {
          success: true,
          message: `Connected to OpenAI (${
            config.openai_model || "gpt-4o"
          }) successfully!`,
        };
      }

      if (provider === "gemini") {
        if (!config.gemini_api_key) throw new Error("Gemini API key is empty");
        const resp = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.gemini_api_key}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: config.gemini_model || "gemini-2.0-flash",
              max_tokens: 16,
              messages: [{ role: "user", content: "Hi" }],
            }),
          }
        );
        if (!resp.ok) {
          const text = await resp.text();
          throw new Error(`HTTP ${resp.status}: ${text}`);
        }
        return {
          success: true,
          message: `Connected to Google Gemini (${
            config.gemini_model || "gemini-2.0-flash"
          }) successfully!`,
        };
      }

      if (provider === "deepseek") {
        if (!config.deepseek_api_key)
          throw new Error("DeepSeek API key is empty");
        const resp = await fetch("https://api.deepseek.com/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.deepseek_api_key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: config.deepseek_model || "deepseek-chat",
            max_tokens: 16,
            messages: [{ role: "user", content: "Hi" }],
          }),
        });
        if (!resp.ok) {
          const text = await resp.text();
          throw new Error(`HTTP ${resp.status}: ${text}`);
        }
        return {
          success: true,
          message: `Connected to DeepSeek (${
            config.deepseek_model || "deepseek-chat"
          }) successfully!`,
        };
      }

      if (provider === "oxide_native") {
        const port = config.oxide_native_port || 11435;
        const ping = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(1500),
        });
        if (!ping.ok) throw new Error(`HTTP ${ping.status}`);
        return {
          success: true,
          message: `Oxide Native Engine running on port ${port}!`,
        };
      }

      if (provider === "custom_openai") {
        const url = (
          config.custom_openai_url || "http://127.0.0.1:1234/v1"
        ).replace(/\/$/, "");
        const resp = await fetch(`${url}/models`, {
          signal: AbortSignal.timeout(2000),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return {
          success: true,
          message: `Connected to custom OpenAI endpoint at ${url}!`,
        };
      }

      const baseUrl = config.ollama_base_url.replace(/\/$/, "");
      const resp = await fetch(`${baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return { success: true, message: "Connected to Ollama engine!" };
    } catch (err: any) {
      return {
        success: false,
        message: `Connection failed: ${err?.message || String(err)}`,
      };
    }
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
        const streamRes = await streamChatFromProvider(
          health,
          architectModel,
          messages,
          (token) => {
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
        );
        fullReply = streamRes.text;
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
          detail: `${liveHw.governor_tier} | Free RAM: ${liveHw.available_ram_gb} GB | CPU: ${liveHw.cpu_usage_percent}%`,
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
              "Queued by Hardware Governor - waiting for available RAM/CPU slot...",
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
              const subResult = await streamChatFromProvider(
                health,
                subModel,
                [
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
                () => {}
              );
              const outText: string = subResult.text || "Subtask completed.";
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
            : `Exit ${res.exit_code} - Self-Correcting`,
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
      } else if (tool.action === "web_search") {
        if (!health.config.allow_internet_access) {
          messages.push({
            role: "user",
            content: `[SECURITY_BLOCKED] Internet access is disabled in Settings -> Security. Enable 'Allow Internet Access' to permit web searches.`,
          });
        } else {
          emitLocalEvent({
            type: "workflow_card",
            step,
            title: `Web Search: ${tool.query}`,
            detail: tool.rationale || "Searching internet documentation",
            status: "running",
          });
          try {
            const searchResp = await fetch(
              `https://html.duckduckgo.com/html/?q=${encodeURIComponent(
                tool.query
              )}`,
              {
                headers: {
                  "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                },
              }
            );
            const html = await searchResp.text();
            const snippets: string[] = [];
            const parts = html.split('class="result__snippet"');
            for (let i = 1; i < Math.min(parts.length, 6); i++) {
              const end = parts[i].indexOf("</a>");
              if (end !== -1) {
                const raw = parts[i].slice(0, end);
                const cleaned = raw
                  .replace(/<[^>]*>/g, "")
                  .replace(/&quot;/g, '"')
                  .replace(/&amp;/g, "&")
                  .trim()
                  .replace(/^>/, "")
                  .trim();
                if (cleaned) snippets.push(`- ${cleaned}`);
              }
            }
            const results =
              snippets.length > 0
                ? snippets.join("\n")
                : `Web search completed for '${tool.query}'.`;
            emitLocalEvent({
              type: "workflow_card",
              step,
              title: `Web Search: ${tool.query}`,
              detail: `${snippets.length} results extracted`,
              status: "succeeded",
            });
            messages.push({
              role: "user",
              content: `[WEB_SEARCH_RESULTS query="${tool.query}"]\n${results}\n[/WEB_SEARCH_RESULTS]`,
            });
          } catch (e: any) {
            messages.push({
              role: "user",
              content: `[WEB_SEARCH_ERROR] ${e?.message || String(e)}`,
            });
          }
        }
      } else if (tool.action === "fetch_web_url") {
        if (!health.config.allow_internet_access) {
          messages.push({
            role: "user",
            content: `[SECURITY_BLOCKED] Internet access is disabled in Settings -> Security.`,
          });
        } else {
          emitLocalEvent({
            type: "workflow_card",
            step,
            title: `Fetching URL: ${tool.url}`,
            detail: "Downloading webpage text",
            status: "running",
          });
          try {
            const resp = await fetch(tool.url);
            const text = (await resp.text()).slice(0, 12000);
            emitLocalEvent({
              type: "workflow_card",
              step,
              title: `Fetched URL: ${tool.url}`,
              detail: `${text.length} characters received`,
              status: "succeeded",
            });
            messages.push({
              role: "user",
              content: `[FETCHED_URL url="${tool.url}"]\n${text}\n[/FETCHED_URL]`,
            });
          } catch (e: any) {
            messages.push({
              role: "user",
              content: `[FETCH_URL_ERROR] ${e?.message || String(e)}`,
            });
          }
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

  async onModelDownloadProgress(
    handler: (progress: ModelDownloadProgress) => void
  ): Promise<UnlistenFn> {
    modelProgressListeners.add(handler);
    let tauriUnlisten: (() => void) | null = null;
    if (isTauriNative()) {
      listen<ModelDownloadProgress>(
        "oxide://model-download-progress",
        (evt) => handler(evt.payload)
      ).then((u) => {
        tauriUnlisten = u;
      });
    }
    return () => {
      modelProgressListeners.delete(handler);
      if (tauriUnlisten) tauriUnlisten();
    };
  },

  async onUpdateDownloadProgress(
    handler: (progress: UpdateDownloadProgress) => void
  ): Promise<UnlistenFn> {
    if (isTauriNative()) {
      return listen<UpdateDownloadProgress>(
        "oxide://update-download-progress",
        (evt) => handler(evt.payload)
      );
    }
    return () => {};
  },
};
