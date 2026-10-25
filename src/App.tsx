import React, { useEffect, useState } from "react";
import { oxideBridge } from "./services/tauriBridge";
import {
  CURATED_MODEL_CATALOG,
  CatalogModelEntry,
  evaluateModelHardwareFit,
  hfEntryToCatalogEntry,
} from "./data/modelCatalog";
import {
  AgentRoleKind,
  CommandExecutionResult,
  GitStatusSummary,
  HardwareSpecs,
  McpServerConfig,
  ModelDownloadProgress,
  UpdateDownloadProgress,
  HardwareAccelerationMode,
  GpuOffloadPolicy,
  SecurityReviewMode,
  ProviderConfig,
  ProviderKind,
  SubagentRunState,
  UpdateStatus,
  WorkflowStepStatus,
  WorkspaceFileEntry,
} from "./types/agent";

interface WorkflowCardItem {
  id: string;
  step: number;
  title: string;
  detail: string;
  status: WorkflowStepStatus;
}

interface SubagentItem {
  id: string;
  role: AgentRoleKind;
  model: string;
  title: string;
  state: SubagentRunState;
  thought: string;
  output_preview: string;
  active_workers: number;
  max_allowed_workers: number;
}

interface ConversationTurn {
  id: string;
  userPrompt: string;
  thought: string;
  thoughtSeconds: number;
  plan: string[];
  steps: WorkflowCardItem[];
  assistantReply: string;
  timestamp: string;
}

interface SavedConversation {
  id: string;
  projectId: string;
  title: string;
  updatedAt: string;
  turns: ConversationTurn[];
}

interface ProjectWorkspace {
  id: string;
  name: string;
  path: string;
}



export interface SlashCommandItem {
  command: string;
  label: string;
  description: string;
  badge: string;
}

export const SLASH_COMMANDS: SlashCommandItem[] = [
  {
    command: "/btw",
    label: "/btw <question>",
    description: "Ask a quick side-question without modifying files or running commands",
    badge: "Side Question",
  },
  {
    command: "/plan",
    label: "/plan <task>",
    description: "Generate an architectural blueprint & step-by-step plan without executing",
    badge: "Plan Mode",
  },
  {
    command: "/fix",
    label: "/fix <issue>",
    description: "Focus Lead Architect and Coder Subagent on debugging and fixing an error",
    badge: "Debugging",
  },
  {
    command: "/test",
    label: "/test [cmd]",
    description: "Run workspace tests or build verification and diagnose issues",
    badge: "Verification",
  },
  {
    command: "/models",
    label: "/models",
    description: "Open 1-Click AI Model Hub (Ollama & HuggingFace GGUF)",
    badge: "Model Store",
  },
  {
    command: "/hardware",
    label: "/hardware",
    description: "Configure Hybrid Split Inference and GPU Layer Offloading",
    badge: "Hardware",
  },
  {
    command: "/subagents",
    label: "/subagents",
    description: "Open Subagent Delegation Guide & Routing Matrix",
    badge: "Subagents",
  },
  {
    command: "/compact",
    label: "/compact",
    description: "Compact chat conversation to save context tokens",
    badge: "Memory",
  },
  {
    command: "/clear",
    label: "/clear",
    description: "Clear active conversation history",
    badge: "Workspace",
  },
  {
    command: "/help",
    label: "/help",
    description: "Show command reference, subagent delegation tips & shortcuts",
    badge: "Help",
  },
];

function formatModelDisplayName(modelId: string): string {
  if (!modelId) return "Select Model";
  if (modelId.includes("hf.co/") || modelId.includes("bartowski/")) {
    const parts = modelId.split("/");
    const repo = parts[parts.length - 1]
      .replace(/:latest$/, "")
      .replace(/-GGUF$/i, "")
      .replace(/-Instruct$/i, "");
    return repo.length > 20 ? repo.slice(0, 18) + "â€¦" : repo;
  }
  if (modelId.includes(":")) {
    const clean = modelId.replace(":latest", "");
    return clean.length > 20 ? clean.slice(0, 18) + "â€¦" : clean;
  }
  return modelId.length > 20 ? modelId.slice(0, 18) + "â€¦" : modelId;
}

function getStepIcon(title: string): string {
  const t = title.toLowerCase();
  if (t.includes("read") || t.includes("search") || t.includes("list")) return "ðŸ”";
  if (t.includes("wrote") || t.includes("write") || t.includes("edit") || t.includes("modify")) return "âœï¸";
  if (t.includes("command") || t.includes("execut") || t.includes("terminal")) return "âš¡";
  if (t.includes("git") || t.includes("commit") || t.includes("push") || t.includes("pull")) return "ðŸŒ¿";
  if (t.includes("subagent") || t.includes("delegat") || t.includes("worker")) return "ðŸ¤–";
  if (t.includes("mcp") || t.includes("tool")) return "ðŸ”Œ";
  return "ðŸ“„";
}

function getBaseName(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function isAppInstallDir(p: string): boolean {
  const lower = p.replace(/[\\/]+$/, "").toLowerCase();
  // Allow the workspace subfolder
  if (
    lower.endsWith("\\programs\\oxide\\workspace") ||
    lower.endsWith("/programs/oxide/workspace") ||
    lower.endsWith("\\oxide\\workspace") ||
    lower.endsWith("/oxide/workspace")
  ) {
    return false;
  }
  return (
    lower.endsWith("\\appdata\\local\\oxide") ||
    lower.endsWith("/appdata/local/oxide") ||
    lower.endsWith("\\appdata\\local\\programs\\oxide") ||
    lower.endsWith("/appdata/local/programs/oxide") ||
    lower.includes("\\.oxide\\scratch") ||
    lower.includes("/.oxide/scratch") ||
    lower.endsWith("\\.oxide") ||
    lower.endsWith("/.oxide")
  );
}

export const App: React.FC = () => {
  // Multi-Workspace & Saved Conversations
  const [projects, setProjects] = useState<ProjectWorkspace[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string>("default");
  const [conversations, setConversations] = useState<SavedConversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string>("conv-1");
  const [expandedThoughts, setExpandedThoughts] = useState<
    Record<string, boolean>
  >({});

  // Right Dock & Drawer State
  const [rightDrawer, setRightDrawer] = useState<
    "overview" | "files" | "review" | "terminal" | "editor"
  >("overview");
  const [showRightPanel, setShowRightPanel] = useState<boolean>(true);

  // Explorer & Editor State
  const [files, setFiles] = useState<WorkspaceFileEntry[]>([]);
  const [currentDir, setCurrentDir] = useState<string>(".");
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [activeFileContent, setActiveFileContent] = useState<string>("");

  const [gitStatus, setGitStatus] = useState<GitStatusSummary | null>(null);
  const [hwSpecs, setHwSpecs] = useState<HardwareSpecs | null>(null);

  const [providerConfig, setProviderConfig] = useState<ProviderConfig>({
    active_provider: "ollama",
    ollama_base_url: "http://localhost:11434",
    ollama_model: "",
    anthropic_model: "claude-3-5-sonnet-latest",
    openai_model: "gpt-4o",
    enable_cloud_fallback: false,
    temperature: 0.1,
    task_routing: {
      architect_model: "",
      coder_subagent_model: "",
      research_subagent_model: "",
      tester_subagent_model: "",
    },
    enable_subagents: true,
    max_concurrent_subagents: 2,
    auto_throttle_on_high_load: true,
  });

  // Real installed Ollama models only (starts empty until verified from Ollama)
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaOnline, setOllamaOnline] = useState<boolean>(false);

  // Live Active Turn State
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [prompt, setPrompt] = useState<string>("");
  const [liveThinking, setLiveThinking] = useState<string>("");
  const [planChecklist, setPlanChecklist] = useState<string[]>([]);
  const [streamingBuffer, setStreamingBuffer] = useState<string>("");
  const [liveSteps, setLiveSteps] = useState<WorkflowCardItem[]>([]);
  const [subagents, setSubagents] = useState<SubagentItem[]>([]);
  const [terminalLogs, setTerminalLogs] = useState<CommandExecutionResult[]>(
    []
  );
  const [quickCommand, setQuickCommand] = useState<string>("git status");
  const [statusBanner, setStatusBanner] = useState<string>("");

  // Modals & Tabbed Settings State
  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false);
  const [settingsTab, setSettingsTab] = useState<
    | "general"
    | "hardware"
    | "security"
    | "providers"
    | "agents"
    | "mcp"
    | "updates"
  >("general");
  const [showModelHubModal, setShowModelHubModal] = useState<boolean>(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [isUpdating, setIsUpdating] = useState<boolean>(false);

  // Model Store State
  const [modelCategoryFilter, setModelCategoryFilter] = useState<
    | "all"
    | "coding"
    | "uncensored"
    | "coding_uncensored"
    | "reasoning"
    | "subagent"
  >("all");
  const [modelSourceFilter, setModelSourceFilter] = useState<
    "all" | "ollama" | "huggingface"
  >("all");
  const [onlyFitsMyPc, setOnlyFitsMyPc] = useState<boolean>(false);
  const [modelSearchQuery, setModelSearchQuery] = useState<string>("");
  const [hfSearchResults, setHfSearchResults] = useState<CatalogModelEntry[]>(
    []
  );
  const [isSearchingHf, setIsSearchingHf] = useState<boolean>(false);
  const [installingModelId, setInstallingModelId] = useState<string | null>(
    null
  );
  const [customInstallTag, setCustomInstallTag] = useState<string>("");
  const [modelProgressMap, setModelProgressMap] = useState<
    Record<string, ModelDownloadProgress>
  >({});
  const [updateDownloadProgress, setUpdateDownloadProgress] =
    useState<UpdateDownloadProgress | null>(null);
  const [liveThoughtExpanded, setLiveThoughtExpanded] = useState<boolean>(true);
  const [showSubagentsGuide, setShowSubagentsGuide] = useState<boolean>(false);
  const [showSecurityMenu, setShowSecurityMenu] = useState<boolean>(false);
  const [isInstallingOllama, setIsInstallingOllama] = useState<boolean>(false);
  const [ollamaInstallStep, setOllamaInstallStep] = useState<string>("");
  const [selectedSlashIndex, setSelectedSlashIndex] = useState<number>(0);
  const [liveMetrics, setLiveMetrics] = useState<{
    step: number;
    tokens_generated: number;
    tokens_per_second: number;
    elapsed_seconds: number;
    phase: string;
    gpu_layers?: number;
  } | null>(null);

  // MCP Servers State
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);
  const [newMcpId, setNewMcpId] = useState<string>("");
  const [newMcpCommand, setNewMcpCommand] = useState<string>("npx");
  const [newMcpArgs, setNewMcpArgs] = useState<string>(
    "-y @modelcontextprotocol/server-memory"
  );

  const activeProject =
    projects.find((p) => p.id === activeProjectId) || projects[0];
  const activeConversation = conversations.find((c) => c.id === activeConvId);

  const persistStudioSessions = async (
    nextProjects: ProjectWorkspace[],
    nextConvs: SavedConversation[],
    nextActiveProjId: string,
    nextActiveConvId: string
  ) => {
    const payload = JSON.stringify({
      projects: nextProjects,
      conversations: nextConvs,
      activeProjectId: nextActiveProjId,
      activeConvId: nextActiveConvId,
    });
    try {
      localStorage.setItem("oxide_studio_sessions_v1", payload);
    } catch {}
    try {
      await oxideBridge.saveStudioState(payload);
    } catch {}
  };

  const refreshWorkspaceState = async (dir: string = currentDir) => {
    try {
      const [fileList, git, health, hw, mcpList] = await Promise.all([
        oxideBridge.listWorkspaceFiles(dir),
        oxideBridge.getGitStatus(),
        oxideBridge.getProviderHealth(),
        oxideBridge.getHardwareSpecs(),
        oxideBridge.listMcpServers(),
      ]);
      setFiles(fileList);
      setGitStatus(git);
      setHwSpecs(hw);
      setMcpServers(mcpList);
      setOllamaOnline(health.ollama_reachable);

      const installed = health.ollama_models || [];
      setOllamaModels(installed);

      setProviderConfig((prev) => {
        const merged = {
          ...prev,
          ...health.config,
          task_routing: {
            ...prev.task_routing,
            ...(health.config.task_routing || {}),
          },
        };
        // Ensure selected models are actually in the installed list (if any are installed)
        if (installed.length > 0) {
          if (!installed.includes(merged.ollama_model)) {
            merged.ollama_model = installed[0];
          }
          if (!installed.includes(merged.task_routing.architect_model)) {
            merged.task_routing.architect_model = installed[0];
          }
          if (!installed.includes(merged.task_routing.coder_subagent_model)) {
            merged.task_routing.coder_subagent_model =
              installed[installed.length - 1] || installed[0];
          }
          if (
            !installed.includes(merged.task_routing.research_subagent_model)
          ) {
            merged.task_routing.research_subagent_model =
              installed[installed.length - 1] || installed[0];
          }
          if (!installed.includes(merged.task_routing.tester_subagent_model)) {
            merged.task_routing.tester_subagent_model =
              installed[installed.length - 1] || installed[0];
          }
        } else {
          merged.ollama_model = "";
          merged.task_routing.architect_model = "";
          merged.task_routing.coder_subagent_model = "";
          merged.task_routing.research_subagent_model = "";
          merged.task_routing.tester_subagent_model = "";
        }
        return merged;
      });
    } catch {}
  };

  useEffect(() => {
    (async () => {
      let restored = false;
      try {
        const rawDisk = await oxideBridge.loadStudioState();
        const rawLocal = localStorage.getItem("oxide_studio_sessions_v1");
        const raw = rawDisk || rawLocal;
        if (raw) {
          const parsed = JSON.parse(raw);
          if (
            Array.isArray(parsed.projects) &&
            parsed.projects.length > 0 &&
            Array.isArray(parsed.conversations)
          ) {
            // Migrate any old AppData\Local\Oxide binary dir or .oxide to the default workspace folder
            const defaultInfo = await oxideBridge.setWorkspace(".");
            const migratedProjects: ProjectWorkspace[] = parsed.projects.map(
              (p: ProjectWorkspace) => {
                if (isAppInstallDir(p.path)) {
                  return {
                    ...p,
                    name: getBaseName(defaultInfo.canonical_path),
                    path: defaultInfo.canonical_path,
                  };
                }
                return p;
              }
            );
            const cleanedConvs: SavedConversation[] = parsed.conversations.map(
              (c: SavedConversation) => ({
                ...c,
                title:
                  c.title === "Initial Workspace Session" ||
                  c.title === "New Workspace Session"
                    ? "New Conversation"
                    : c.title,
              })
            );

            setProjects(migratedProjects);
            setConversations(cleanedConvs);
            const projId = parsed.activeProjectId || migratedProjects[0].id;
            setActiveProjectId(projId);
            setActiveConvId(
              parsed.activeConvId || cleanedConvs[0]?.id || "conv-1"
            );
            const proj =
              migratedProjects.find(
                (p: ProjectWorkspace) => p.id === projId
              ) || migratedProjects[0];
            await oxideBridge.setWorkspace(proj.path);
            restored = true;
          }
        }
      } catch {}

      if (!restored) {
        try {
          // "." automatically resolves to C:\Users\<user>\AppData\Local\Programs\Oxide\workspace when run from installer
          const info = await oxideBridge.setWorkspace(".");
          const defaultProj: ProjectWorkspace = {
            id: "proj-default",
            name: getBaseName(info.canonical_path),
            path: info.canonical_path,
          };
          const defaultConv: SavedConversation = {
            id: "conv-default",
            projectId: defaultProj.id,
            title: "New Conversation",
            updatedAt: "now",
            turns: [],
          };
          setProjects([defaultProj]);
          setConversations([defaultConv]);
          setActiveProjectId(defaultProj.id);
          setActiveConvId(defaultConv.id);
          setGitStatus(info.git);
        } catch {}
      }

      await refreshWorkspaceState(".");
      oxideBridge
        .checkGithubUpdate()
        .then(setUpdateStatus)
        .catch(() => {});
    })();

    const hwTimer = setInterval(() => {
      oxideBridge
        .getHardwareSpecs()
        .then(setHwSpecs)
        .catch(() => {});
    }, 6000);

    const unlistenPromise = oxideBridge.onAgentEvent((event) => {
      switch (event.type) {
        case "token_delta":
          setStreamingBuffer((prev) => prev + event.token);
          break;
        case "thinking_update":
          setLiveThinking(event.thought);
          break;
        case "plan_update":
          setPlanChecklist(event.items);
          break;
        case "thinking_metrics":
          setLiveMetrics({
            step: event.step,
            tokens_generated: event.tokens_generated,
            tokens_per_second: event.tokens_per_second,
            elapsed_seconds: event.elapsed_seconds,
            phase: event.phase,
            gpu_layers: event.gpu_layers,
          });
          break;
        case "subagent_status":
          setSubagents((prev) => {
            const idx = prev.findIndex((s) => s.id === event.id);
            const item: SubagentItem = {
              id: event.id,
              role: event.role,
              model: event.model,
              title: event.title,
              state: event.state,
              thought: event.thought,
              output_preview: event.output_preview,
              active_workers: event.active_workers,
              max_allowed_workers: event.max_allowed_workers,
            };
            if (idx !== -1) {
              const copy = [...prev];
              copy[idx] = item;
              return copy;
            }
            return [item, ...prev];
          });
          break;
        case "workflow_card":
          setLiveSteps((prev) => [
            ...prev,
            {
              id: `${event.step}-${Date.now()}-${Math.random()}`,
              step: event.step,
              title: event.title,
              detail: event.detail,
              status: event.status,
            },
          ]);
          break;
        case "file_change":
          refreshWorkspaceState(currentDir);
          break;
        case "terminal_output":
          setTerminalLogs((prev) => [event.result, ...prev]);
          break;
        case "git_milestone":
          refreshWorkspaceState(currentDir);
          break;
        case "task_completed":
          refreshWorkspaceState(currentDir);
          break;
        case "task_error":
          setStatusBanner(`Error: ${event.message}`);
          break;
      }
    });

    const modelProgPromise = oxideBridge.onModelDownloadProgress((prog) => {
      setModelProgressMap((prev) => ({
        ...prev,
        [prog.model_id]: prog,
      }));
    });

    const updateProgPromise = oxideBridge.onUpdateDownloadProgress((prog) => {
      setUpdateDownloadProgress(prog);
    });

    return () => {
      clearInterval(hwTimer);
      unlistenPromise.then((unlisten) => unlisten());
      modelProgPromise.then((unlisten) => unlisten());
      updateProgPromise.then((unlisten) => unlisten());
    };
  }, []);

  const handlePickProjectFolder = async () => {
    try {
      const picked = await oxideBridge.pickFolderDialog();
      if (!picked?.trim()) return;

      const info = await oxideBridge.setWorkspace(picked.trim());
      const existingProj = projects.find(
        (p) => p.path.toLowerCase() === info.canonical_path.toLowerCase()
      );

      let nextProjects = [...projects];
      let targetProjId: string;

      if (existingProj) {
        targetProjId = existingProj.id;
      } else {
        const newProj: ProjectWorkspace = {
          id: `proj-${Date.now()}`,
          name: getBaseName(info.canonical_path),
          path: info.canonical_path,
        };
        nextProjects = [newProj, ...projects];
        targetProjId = newProj.id;
      }

      const projConvs = conversations.filter(
        (c) => c.projectId === targetProjId
      );
      let nextConvs = [...conversations];
      let targetConvId: string;

      if (projConvs.length === 0) {
        const firstConv: SavedConversation = {
          id: `conv-${Date.now()}`,
          projectId: targetProjId,
          title: "New Conversation",
          updatedAt: "now",
          turns: [],
        };
        nextConvs = [firstConv, ...conversations];
        targetConvId = firstConv.id;
      } else {
        targetConvId = projConvs[0].id;
      }

      setProjects(nextProjects);
      setConversations(nextConvs);
      setActiveProjectId(targetProjId);
      setActiveConvId(targetConvId);
      setCurrentDir(".");
      setGitStatus(info.git);
      await refreshWorkspaceState(".");
      await persistStudioSessions(
        nextProjects,
        nextConvs,
        targetProjId,
        targetConvId
      );
      setStatusBanner(`Opened workspace '${getBaseName(info.canonical_path)}'`);
    } catch (err: any) {
      setStatusBanner(`Folder error: ${err?.message || String(err)}`);
    }
  };

  const handleSelectConversation = async (
    proj: ProjectWorkspace,
    conv: SavedConversation
  ) => {
    setActiveProjectId(proj.id);
    setActiveConvId(conv.id);
    try {
      const info = await oxideBridge.setWorkspace(proj.path);
      setGitStatus(info.git);
      setCurrentDir(".");
      await refreshWorkspaceState(".");
      await persistStudioSessions(projects, conversations, proj.id, conv.id);
    } catch {}
  };

  const handleNewConversation = async (forProjectId?: string) => {
    const targetProjId = forProjectId || activeProjectId;
    // Reuse an existing empty conversation in this project instead of creating duplicates
    const existingEmpty = conversations.find(
      (c) => c.projectId === targetProjId && c.turns.length === 0
    );
    if (existingEmpty) {
      setActiveProjectId(targetProjId);
      setActiveConvId(existingEmpty.id);
      return;
    }

    const newConv: SavedConversation = {
      id: `conv-${Date.now()}`,
      projectId: targetProjId,
      title: "New Conversation",
      updatedAt: "now",
      turns: [],
    };
    const nextConvs = [newConv, ...conversations];
    setConversations(nextConvs);
    setActiveProjectId(targetProjId);
    setActiveConvId(newConv.id);
    setLiveThinking("");
    setPlanChecklist([]);
    setLiveSteps([]);
    setStreamingBuffer("");
    await persistStudioSessions(
      projects,
      nextConvs,
      targetProjId,
      newConv.id
    );
  };

  const handleDeleteProject = async (
    e: React.MouseEvent,
    projectId: string
  ) => {
    e.stopPropagation();
    const remainingProjects = projects.filter((p) => p.id !== projectId);
    const remainingConvs = conversations.filter(
      (c) => c.projectId !== projectId
    );

    if (remainingProjects.length === 0) {
      try {
        const info = await oxideBridge.setWorkspace(".");
        const defaultProj: ProjectWorkspace = {
          id: `proj-${Date.now()}`,
          name: getBaseName(info.canonical_path),
          path: info.canonical_path,
        };
        const defaultConv: SavedConversation = {
          id: `conv-${Date.now()}`,
          projectId: defaultProj.id,
          title: "New Conversation",
          updatedAt: "now",
          turns: [],
        };
        setProjects([defaultProj]);
        setConversations([defaultConv]);
        setActiveProjectId(defaultProj.id);
        setActiveConvId(defaultConv.id);
        await persistStudioSessions(
          [defaultProj],
          [defaultConv],
          defaultProj.id,
          defaultConv.id
        );
      } catch {}
      return;
    }

    const nextProj =
      activeProjectId === projectId
        ? remainingProjects[0]
        : projects.find((p) => p.id === activeProjectId) ||
          remainingProjects[0];

    let nextConvs = [...remainingConvs];
    let nextProjConvs = nextConvs.filter((c) => c.projectId === nextProj.id);
    if (nextProjConvs.length === 0) {
      const fresh: SavedConversation = {
        id: `conv-${Date.now()}`,
        projectId: nextProj.id,
        title: "New Conversation",
        updatedAt: "now",
        turns: [],
      };
      nextConvs = [fresh, ...nextConvs];
      nextProjConvs = [fresh];
    }

    const nextConvId = nextProjConvs[0].id;
    setProjects(remainingProjects);
    setConversations(nextConvs);
    setActiveProjectId(nextProj.id);
    setActiveConvId(nextConvId);
    try {
      await oxideBridge.setWorkspace(nextProj.path);
      await refreshWorkspaceState(".");
    } catch {}
    await persistStudioSessions(
      remainingProjects,
      nextConvs,
      nextProj.id,
      nextConvId
    );
  };

  const handleDeleteConversation = async (
    e: React.MouseEvent,
    convId: string
  ) => {
    e.stopPropagation();
    const remaining = conversations.filter((c) => c.id !== convId);
    if (remaining.length === 0) {
      const fresh: SavedConversation = {
        id: `conv-${Date.now()}`,
        projectId: activeProjectId,
        title: "New Conversation",
        updatedAt: "now",
        turns: [],
      };
      setConversations([fresh]);
      setActiveConvId(fresh.id);
      await persistStudioSessions(
        projects,
        [fresh],
        activeProjectId,
        fresh.id
      );
      return;
    }
    const nextActiveId =
      activeConvId === convId ? remaining[0].id : activeConvId;
    setConversations(remaining);
    setActiveConvId(nextActiveId);
    await persistStudioSessions(
      projects,
      remaining,
      activeProjectId,
      nextActiveId
    );
  };

  const handleRunTask = async (customPrompt?: string) => {
    const taskPrompt = (customPrompt ?? prompt).trim();
    if (!taskPrompt || isRunning) return;

    // Guard: If using local Ollama and no models are installed yet, open the Model Store
    if (
      providerConfig.active_provider === "ollama" &&
      ollamaModels.length === 0
    ) {
      setStatusBanner(
        "No AI model installed yet â€” install a local AI model below first."
      );
      setShowModelHubModal(true);
      return;
    }

    if (!customPrompt) setPrompt("");

    const startTime = Date.now();
    setIsRunning(true);
    setStreamingBuffer("");
    setLiveThinking(`Analyzing request and planning next actions...`);
    setLiveMetrics(null);
    setPlanChecklist([]);
    setLiveSteps([]);

    let currentThought = "Analyzed request and executed workspace actions.";
    let currentPlan: string[] = [];
    const collectedSteps: WorkflowCardItem[] = [];

    const tempUnlisten = await oxideBridge.onAgentEvent((evt) => {
      if (evt.type === "thinking_update") {
        currentThought = evt.thought;
      } else if (evt.type === "plan_update") {
        currentPlan = evt.items;
      } else if (evt.type === "workflow_card") {
        collectedSteps.push({
          id: `${evt.step}-${Date.now()}-${Math.random()}`,
          step: evt.step,
          title: evt.title,
          detail: evt.detail,
          status: evt.status,
        });
      }
    });

    try {
      const finalReply = await oxideBridge.runAgentTask(taskPrompt);
      const elapsedSecs = Math.max(
        1,
        Math.round((Date.now() - startTime) / 1000)
      );

      const newTurn: ConversationTurn = {
        id: `turn-${Date.now()}`,
        userPrompt: taskPrompt,
        thought: currentThought,
        thoughtSeconds: elapsedSecs,
        plan: currentPlan,
        steps: collectedSteps,
        assistantReply: finalReply,
        timestamp: "just now",
      };

      const nextConvs = conversations.map((c) => {
        if (c.id !== activeConvId) return c;
        const autoTitle =
          c.turns.length === 0
            ? taskPrompt.slice(0, 38) + (taskPrompt.length > 38 ? "..." : "")
            : c.title;
        return {
          ...c,
          title: autoTitle,
          updatedAt: "just now",
          turns: [...c.turns, newTurn],
        };
      });

      setConversations(nextConvs);
      setStreamingBuffer("");
      setLiveThinking("");
      setLiveSteps([]);
      await persistStudioSessions(
        projects,
        nextConvs,
        activeProjectId,
        activeConvId
      );
    } catch (err: any) {
      setStatusBanner(`Agent error: ${err?.message || String(err)}`);
    } finally {
      tempUnlisten();
      setIsRunning(false);
    }
  };

  const handleOpenFileOrDir = async (entry: WorkspaceFileEntry) => {
    if (entry.is_dir) {
      setCurrentDir(entry.relative_path);
      const list = await oxideBridge.listWorkspaceFiles(entry.relative_path);
      setFiles(list);
    } else {
      const content = await oxideBridge.readWorkspaceFile(entry.relative_path);
      setActiveFile(entry.relative_path);
      setActiveFileContent(content);
      setRightDrawer("editor");
      setShowRightPanel(true);
    }
  };

  const handleSaveActiveFile = async () => {
    if (!activeFile) return;
    await oxideBridge.saveWorkspaceFile(activeFile, activeFileContent);
    await refreshWorkspaceState(currentDir);
    setStatusBanner(`Saved ${activeFile}`);
  };

  const handleCreateNewFile = async () => {
    const name = window.prompt(
      "New file path relative to workspace folder (e.g. src/utils.ts):"
    );
    if (!name?.trim()) return;
    await oxideBridge.saveWorkspaceFile(name.trim(), "");
    await refreshWorkspaceState(currentDir);
    setActiveFile(name.trim());
    setActiveFileContent("");
    setRightDrawer("editor");
  };

  const handleGitAction = async (op: "pull" | "push" | "commit") => {
    try {
      setStatusBanner(`Running git ${op}...`);
      if (op === "commit") {
        const msg =
          window.prompt("Commit message:") || "feat: update project milestone";
        const rec = await oxideBridge.triggerGitMilestone(msg);
        if (rec) {
          setStatusBanner(`Committed [${rec.commit_hash}] ${rec.message}`);
        } else {
          setStatusBanner("Working tree clean");
        }
      } else {
        const res = await oxideBridge.gitSyncAction(op);
        setTerminalLogs((prev) => [res, ...prev]);
        setStatusBanner(`git ${op} exit=${res.exit_code}`);
      }
      await refreshWorkspaceState(currentDir);
    } catch (err: any) {
      setStatusBanner(`Git error: ${err?.message}`);
    }
  };

  const handleAutoAssignOptimalModels = async () => {
    if (ollamaModels.length === 0) {
      setStatusBanner("Install at least one AI model in Models first.");
      setShowModelHubModal(true);
      return;
    }
    const hw = await oxideBridge.getHardwareSpecs();
    setHwSpecs(hw);
    const mainModel = ollamaModels[0];
    const subModel = ollamaModels[ollamaModels.length - 1] || ollamaModels[0];

    const updated: ProviderConfig = {
      ...providerConfig,
      ollama_model: mainModel,
      max_concurrent_subagents: hw.recommended_max_subagents,
      auto_throttle_on_high_load: true,
      task_routing: {
        architect_model: mainModel,
        coder_subagent_model: subModel,
        research_subagent_model: subModel,
        tester_subagent_model: subModel,
      },
    };
    const saved = await oxideBridge.updateProviderConfig(updated);
    setProviderConfig(saved);
    setStatusBanner(
      `Assigned Agent: ${mainModel} • Subagent: ${subModel}`
    );
  };

  const handleInstallOllama = async () => {
    setIsInstallingOllama(true);
    setOllamaInstallStep("Step 1/3: Checking local system & Winget repository...");
    setStatusBanner("Installing Ollama local AI engine...");

    const t1 = setTimeout(() => {
      setOllamaInstallStep("Step 2/3: Downloading & installing Ollama background service...");
    }, 2500);

    const t2 = setTimeout(() => {
      setOllamaInstallStep("Step 3/3: Waiting for Ollama daemon on http://localhost:11434...");
    }, 7000);

    try {
      const msg = await oxideBridge.ensureOllamaEngine();
      setOllamaInstallStep("✓ Ollama installed and running!");
      setStatusBanner(msg);
      await refreshWorkspaceState(currentDir);
    } catch (err: any) {
      setOllamaInstallStep(`Installation error: ${err?.message || String(err)}`);
      setStatusBanner(`Ollama setup error: ${err?.message || String(err)}`);
    } finally {
      clearTimeout(t1);
      clearTimeout(t2);
      setTimeout(() => {
        setIsInstallingOllama(false);
        setOllamaInstallStep("");
      }, 4000);
    }
  };

  return (
    <div className="ag-shell">
      {/* ==================== LEFT SIDEBAR ==================== */}
      <aside className="ag-sidebar">
        <div className="ag-sidebar-top">
          <div className="ag-brand">
            <svg width="20" height="20" viewBox="0 0 64 64">
              <polygon
                points="18,4 46,4 60,18 60,46 46,60 18,60 4,46 4,18"
                fill="#1d1512"
                stroke="#d45b2c"
                strokeWidth="4"
              />
              <rect x="6" y="22" width="52" height="20" fill="#9e3d1a" />
              <rect x="22" y="6" width="20" height="52" fill="#7a280e" />
              <circle
                cx="32"
                cy="32"
                r="17"
                fill="#14100e"
                stroke="#e06336"
                strokeWidth="4"
              />
              <circle cx="32" cy="32" r="7" fill="#090706" />
            </svg>
            <span>Oxide</span>
          </div>
          <div style={{ display: "flex", gap: "0.2rem" }}>
            <button
              className="ag-icon-btn"
              onClick={handlePickProjectFolder}
              title="Open Workspace Folder"
            >
              ðŸ“+
            </button>
            <button
              className="ag-icon-btn"
              onClick={() => {
                setRightDrawer("files");
                setShowRightPanel(true);
              }}
              title="Open Explorer"
            >
              ðŸ”
            </button>
          </div>
        </div>

        <div className="ag-new-conv-wrap">
          <button
            className="ag-new-conv-btn"
            onClick={() => handleNewConversation()}
          >
            <span>+</span>
            <span>New Conversation</span>
          </button>
        </div>

        <div className="ag-nav-list">
          <button
            className={`ag-nav-item ${
              rightDrawer === "files" && showRightPanel ? "active" : ""
            }`}
            onClick={() => {
              setRightDrawer("files");
              setShowRightPanel(true);
            }}
          >
            <span>ðŸ“ Explorer</span>
            <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
              {files.length}
            </span>
          </button>

          <button
            className="ag-nav-item"
            onClick={() => setShowModelHubModal(true)}
            style={{
              border:
                ollamaModels.length === 0
                  ? "1px solid rgba(212, 91, 44, 0.45)"
                  : undefined,
              background:
                ollamaModels.length === 0
                  ? "rgba(212, 91, 44, 0.1)"
                  : undefined,
            }}
          >
            <span>ðŸ§  Models</span>
            <span
              style={{
                fontSize: "0.7rem",
                color:
                  ollamaModels.length > 0 ? "#4ade80" : "var(--oxide-ember)",
                fontWeight: 600,
              }}
            >
              {ollamaModels.length > 0
                ? `${ollamaModels.length} installed`
                : "Install AI"}
            </span>
          </button>

          <button
            className="ag-nav-item"
            onClick={() => {
              setSettingsTab("agents");
              setShowSettingsModal(true);
            }}
          >
            <span>âš¡ Agents &amp; Subagents</span>
            <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
              Max {providerConfig.max_concurrent_subagents}
            </span>
          </button>

          <button
            className="ag-nav-item"
            onClick={() => {
              setSettingsTab("mcp");
              setShowSettingsModal(true);
            }}
          >
            <span>ðŸ”Œ MCP Servers</span>
            <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
              {mcpServers.filter((s) => s.enabled).length} active
            </span>
          </button>
        </div>

        {/* Workspaces & Saved Conversations Tree */}
        <div className="ag-projects-header">
          <span>Workspaces</span>
          <button
            className="ag-icon-btn"
            onClick={handlePickProjectFolder}
            title="Open Folder as Workspace"
            style={{ padding: "0.1rem 0.35rem", fontSize: "0.75rem" }}
          >
            + Open Folder
          </button>
        </div>

        <div className="ag-projects-scroll">
          {projects.map((proj) => {
            const projConvs = conversations.filter(
              (c) => c.projectId === proj.id
            );
            return (
              <div key={proj.id} className="ag-project-group">
                <div
                  className="ag-project-title"
                  onClick={() => handleNewConversation(proj.id)}
                  title={proj.path}
                >
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    ðŸ“ {proj.name}
                  </span>
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "0.35rem",
                    }}
                  >
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        handleNewConversation(proj.id);
                      }}
                      title={`New conversation in ${proj.name}`}
                      style={{
                        fontSize: "0.78rem",
                        padding: "0 0.2rem",
                        opacity: 0.75,
                      }}
                    >
                      +
                    </span>
                    <span
                      onClick={(e) => handleDeleteProject(e, proj.id)}
                      title={`Remove workspace '${proj.name}'`}
                      style={{
                        fontSize: "0.72rem",
                        padding: "0 0.2rem",
                        opacity: 0.65,
                      }}
                    >
                      âœ•
                    </span>
                  </div>
                </div>

                {projConvs.map((conv) => {
                  const isActive = conv.id === activeConvId;
                  return (
                    <div
                      key={conv.id}
                      className={`ag-conv-item ${isActive ? "active" : ""}`}
                      onClick={() => handleSelectConversation(proj, conv)}
                    >
                      <span className="ag-conv-title">{conv.title}</span>
                      <div
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "0.35rem",
                          flexShrink: 0,
                        }}
                      >
                        <span className="ag-conv-meta">
                          {isActive && isRunning ? "âŸ³" : conv.updatedAt}
                        </span>
                        <span
                          className="ag-conv-meta"
                          onClick={(e) => handleDeleteConversation(e, conv.id)}
                          title="Delete conversation"
                          style={{
                            padding: "0 0.2rem",
                            fontSize: "0.72rem",
                          }}
                        >
                          âœ•
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        <div className="ag-sidebar-footer">
          <button
            className="ag-icon-btn"
            onClick={() => {
              setSettingsTab("general");
              setShowSettingsModal(true);
            }}
          >
            âš™ Settings
          </button>
          <button
            className="ag-pill-btn"
            style={{
              borderColor: updateStatus?.update_available
                ? "#22c55e"
                : undefined,
              color: updateStatus?.update_available ? "#4ade80" : undefined,
            }}
            onClick={() => {
              setSettingsTab("updates");
              setShowSettingsModal(true);
              oxideBridge
                .checkGithubUpdate()
                .then(setUpdateStatus)
                .catch(() => {});
            }}
          >
            â†» {updateStatus?.update_available ? "Update Available" : "Updates"}
          </button>
        </div>
      </aside>

      {/* ==================== CENTER MAIN WORKSPACE ==================== */}
      <main className="ag-main">
        {/* Top Header Bar */}
        <header className="ag-topbar">
          <div className="ag-breadcrumbs">
            <span
              className="ag-breadcrumb-project"
              onClick={handlePickProjectFolder}
              title={`Workspace folder: ${activeProject?.path}\nClick to switch folder`}
            >
              {activeProject?.name || "workspace"}
            </span>
            <span>/</span>
            <span className="ag-breadcrumb-conv">
              {activeConversation?.title || "New Conversation"}
            </span>
          </div>

          <div className="ag-topbar-right">
            {hwSpecs && (
              <button
                className="oxide-top-pill"
                onClick={() => {
                  setSettingsTab("hardware");
                  setShowSettingsModal(true);
                }}
                title={`PC Hardware Governor: ${hwSpecs.governor_tier}\nCPU: ${hwSpecs.cpu_brand} (${hwSpecs.cpu_cores} Cores)\nRAM: ${hwSpecs.available_ram_gb} GB free / ${hwSpecs.total_ram_gb} GB\nGPU: ${hwSpecs.gpu_name} (${hwSpecs.gpu_vram_gb} GB VRAM)\nClick to configure hardware acceleration.`}
              >
                ðŸ–¥ {hwSpecs.gpu_name} ({hwSpecs.gpu_vram_gb > 0 ? `${hwSpecs.gpu_vram_gb} GB VRAM` : `${hwSpecs.available_ram_gb} GB free`})
              </button>
            )}

            <button
              className="ag-pill-btn"
              style={{
                borderColor: "rgba(212, 91, 44, 0.55)",
                color: "#f49d7c",
                fontWeight: 600,
              }}
              onClick={() => setShowModelHubModal(true)}
              title="Open AI Model Store (1-Click Install via Ollama & HuggingFace)"
            >
              ðŸ§  Models ({ollamaModels.length} Installed)
            </button>

            <button
              className="ag-pill-btn"
              onClick={() =>
                oxideBridge.openInVsCode(activeFile || activeProject?.path)
              }
              title="Open current workspace in Visual Studio Code"
            >
              Open in VS Code
            </button>

            <button
              className={`ag-pill-btn ${showRightPanel ? "active" : ""}`}
              onClick={() => setShowRightPanel((v) => !v)}
              title="Toggle Right Panel"
            >
              â–¤
            </button>
          </div>
        </header>

        <div className="ag-workspace-body">
          {/* Center Conversation Stream */}
          <div className="ag-center-column">
            <div className="ag-chat-scroll">
              <div className="ag-chat-container">
                {(!activeConversation ||
                  activeConversation.turns.length === 0) &&
                  !isRunning && (
                    <div
                      style={{
                        marginTop: "10vh",
                        textAlign: "center",
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        gap: "0.85rem",
                      }}
                    >
                      <div
                        style={{
                          fontSize: "1.35rem",
                          fontWeight: 600,
                          color: "var(--text-primary)",
                        }}
                      >
                        {activeProject?.name || "workspace"}
                      </div>
                      <div
                        style={{
                          fontSize: "0.81rem",
                          color: "var(--text-secondary)",
                          maxWidth: "520px",
                        }}
                      >
                        Workspace: <code>{activeProject?.path}</code>
                      </div>

                      {ollamaModels.length === 0 && (
                        <div
                          className="hw-spec-box"
                          style={{
                            maxWidth: "500px",
                            borderColor: "rgba(212, 91, 44, 0.5)",
                            textAlign: "left",
                          }}
                        >
                          <div
                            style={{
                              fontWeight: 600,
                              color: "var(--oxide-ember)",
                            }}
                          >
                            âš¡ No Local AI Model Installed Yet
                          </div>
                          <div
                            style={{
                              fontSize: "0.77rem",
                              color: "var(--text-secondary)",
                            }}
                          >
                            Open <strong>Models</strong> to 1-click install an
                            AI model matched to your PC specs (Coding,
                            Uncensored, or DeepSeek-R1 Reasoning).
                          </div>
                          <div>
                            <button
                              className="btn btn-primary"
                              onClick={() => setShowModelHubModal(true)}
                            >
                              ðŸ§  Open Models (1-Click Install)
                            </button>
                          </div>
                        </div>
                      )}

                      <div
                        style={{
                          display: "flex",
                          gap: "0.5rem",
                          flexWrap: "wrap",
                          justifyContent: "center",
                          marginTop: "0.3rem",
                        }}
                      >
                        <button
                          className="ag-pill-btn"
                          onClick={handlePickProjectFolder}
                        >
                          ðŸ“ Open Folder...
                        </button>
                        <button
                          className="ag-pill-btn"
                          onClick={() => setShowModelHubModal(true)}
                        >
                          ðŸ§  Models ({ollamaModels.length} Installed)
                        </button>
                        <button
                          className="ag-pill-btn"
                          onClick={() => {
                            setRightDrawer("files");
                            setShowRightPanel(true);
                          }}
                        >
                          ðŸ“„ Explorer ({files.length})
                        </button>
                      </div>
                    </div>
                  )}

                {/* Saved Conversation Turns */}
                {activeConversation?.turns.map((turn) => {
                  const isExpanded = Boolean(expandedThoughts[turn.id]);
                  return (
                    <div
                      key={turn.id}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "0.75rem",
                      }}
                    >
                      <div className="ag-user-bubble">{turn.userPrompt}</div>

                      {liveMetrics && (
                      <div className="oxide-thinking-gauge">
                        <span style={{ fontSize: "0.9rem" }}>🧠</span>
                        <span style={{ fontWeight: 600 }}>
                          {liveMetrics.phase === "reasoning" ? "Deep Reasoning" : "Executing Code"}
                        </span>
                        <span>•</span>
                        <span>Turn Step {liveMetrics.step}</span>
                        <span>•</span>
                        <span className="oxide-token-speed">
                          ⚡ {liveMetrics.tokens_generated} tokens ({liveMetrics.tokens_per_second.toFixed(1)} tok/s)
                        </span>
                        {liveMetrics.gpu_layers && liveMetrics.gpu_layers > 0 && (
                          <>
                            <span>•</span>
                            <span style={{ color: "#34d399", fontWeight: 600 }}>
                              🎮 GPU: {liveMetrics.gpu_layers} layers
                            </span>
                          </>
                        )}
                      </div>
                    )}
                    <div className="ag-trace-group">
                        <button
                          className="ag-thought-toggle"
                          onClick={() =>
                            setExpandedThoughts((prev) => ({
                              ...prev,
                              [turn.id]: !prev[turn.id],
                            }))
                          }
                        >
                          <span>
                            Thought for {turn.thoughtSeconds}s{" "}
                            {isExpanded ? "â–¾" : "â€º"}
                          </span>
                        </button>

                        {isExpanded && (
                          <div className="ag-thought-body">
                            {turn.thought}
                            {turn.plan.length > 0 && (
                              <div style={{ marginTop: "0.45rem" }}>
                                {turn.plan.map((p, idx) => (
                                  <div key={idx}>
                                    {idx + 1}. {p}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {turn.steps.map((s) => (
                          <div key={s.id} className="ag-tool-step">
                            <span className="ag-tool-step-icon">{getStepIcon(s.title)}</span>
                            <span className="ag-tool-step-label">
                              {s.title}
                            </span>
                            <span className="ag-tool-step-badge">
                              {s.detail.slice(0, 72)}
                            </span>
                          </div>
                        ))}
                      </div>

                      <div className="ag-assistant-reply">
                        {turn.assistantReply}
                      </div>
                    </div>
                  );
                })}

                {/* Live Running Turn */}
                {isRunning && (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.75rem",
                    }}
                  >
                    <div className="ag-trace-group">
                      <button
                        className="ag-thought-toggle"
                        onClick={() => setLiveThoughtExpanded((v) => !v)}
                      >
                        <span style={{ color: "var(--oxide-ember)" }}>
                          âš¡ Thinking... {liveThoughtExpanded ? "â–¾" : "â€º"}
                        </span>
                      </button>
                      {liveThoughtExpanded && (
                        <div className="ag-thought-body">
                          {liveThinking || "Reasoning workspace operations..."}
                          {planChecklist.length > 0 && (
                            <div style={{ marginTop: "0.45rem" }}>
                              {planChecklist.map((item, idx) => (
                                <div key={idx}>
                                  {idx + 1}. {item}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {subagents.slice(0, 3).map((sub) => (
                        <div key={sub.id} className="ag-tool-step">
                          <span className="ag-tool-step-icon">âš¡</span>
                          <span className="ag-tool-step-label">
                            [{sub.role.toUpperCase()}] {sub.title}
                          </span>
                          <span className="ag-tool-step-badge">
                            {sub.model} â€¢ {sub.state}
                          </span>
                        </div>
                      ))}

                      {liveSteps.map((s) => (
                        <div key={s.id} className="ag-tool-step">
                          <span className="ag-tool-step-icon">{getStepIcon(s.title)}</span>
                          <span className="ag-tool-step-label">{s.title}</span>
                          <span className="ag-tool-step-badge">
                            {s.detail.slice(0, 70)}
                          </span>
                        </div>
                      ))}
                    </div>

                    {streamingBuffer && (
                      <div className="ag-assistant-reply">
                        {streamingBuffer}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* ==================== BOTTOM FLOATING CHAT COMPOSER ==================== */}
            <div className="ag-composer-dock">
              <div className="ag-composer-card" style={{ position: "relative" }}>
                {/* Floating Slash Commands Palette */}
                {prompt.startsWith("/") && !prompt.includes(" ") && (
                  <div className="oxide-slash-palette">
                    <div
                      style={{
                        fontSize: "0.7rem",
                        color: "var(--text-muted)",
                        padding: "0.2rem 0.5rem",
                        borderBottom: "1px solid var(--border-subtle)",
                        marginBottom: "0.25rem",
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <span>⚡ Slash Commands</span>
                      <span>Tab / Enter to select • Esc to dismiss</span>
                    </div>
                    {SLASH_COMMANDS.filter((cmd) =>
                      cmd.command.toLowerCase().startsWith(prompt.toLowerCase())
                    ).map((cmd, idx) => (
                      <button
                        key={cmd.command}
                        type="button"
                        className={`oxide-slash-item ${selectedSlashIndex === idx ? "selected" : ""}`}
                        onClick={() => {
                          setPrompt(cmd.command + " ");
                        }}
                      >
                        <div className="oxide-slash-left">
                          <span className="oxide-slash-cmd">{cmd.command}</span>
                          <span className="oxide-slash-desc">{cmd.description}</span>
                        </div>
                        <span className="oxide-slash-badge">{cmd.badge}</span>
                      </button>
                    ))}
                  </div>
                )}

                <textarea
                  className="ag-composer-textarea"
                  placeholder="Ask Oxide to write code, edit files, or run commands... (Type / for commands)"
                  value={prompt}
                  onChange={(e) => {
                    setPrompt(e.target.value);
                    setSelectedSlashIndex(0);
                  }}
                  onKeyDown={(e) => {
                    const filtered = prompt.startsWith("/") && !prompt.includes(" ")
                      ? SLASH_COMMANDS.filter((cmd) => cmd.command.toLowerCase().startsWith(prompt.toLowerCase()))
                      : [];
                    if (filtered.length > 0) {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setSelectedSlashIndex((prev) => (prev + 1) % filtered.length);
                        return;
                      } else if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setSelectedSlashIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
                        return;
                      } else if (e.key === "Tab" || (e.key === "Enter" && selectedSlashIndex < filtered.length)) {
                        e.preventDefault();
                        setPrompt(filtered[selectedSlashIndex].command + " ");
                        return;
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setPrompt("");
                        return;
                      }
                    }

                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleRunTask();
                    }
                  }}
                />

                <div className="ag-composer-toolbar">
                  {/* Main Agent & Subagent Selectors (ONLY Installed Models) */}
                  <div className="ag-toolbar-left">
                    {/* Main Agent Model Picker */}
                    <div
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "0.3rem",
                      }}
                    >
                      <span
                        style={{
                          fontSize: "0.71rem",
                          color: "var(--text-muted)",
                        }}
                      >
                        Agent:
                      </span>
                      {ollamaModels.length > 0 ? (
                        <select
                          className="ag-model-picker-inline"
                          style={{
                            background: "var(--bg-elevated)",
                            border: "1px solid var(--border-subtle)",
                          }}
                          value={
                            providerConfig.task_routing.architect_model ||
                            ollamaModels[0]
                          }
                          onChange={async (e) => {
                            const model = e.target.value;
                            const updated: ProviderConfig = {
                              ...providerConfig,
                              ollama_model: model,
                              task_routing: {
                                ...providerConfig.task_routing,
                                architect_model: model,
                              },
                            };
                            setProviderConfig(updated);
                            await oxideBridge.updateProviderConfig(updated);
                          }}
                        >
                          {ollamaModels.map((m) => (
                            <option
                              key={m}
                              value={m}
                              title={m}
                              style={{ background: "#18181b", color: "#ececef" }}
                            >
                              {formatModelDisplayName(m)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <button
                          className="ag-model-picker-inline"
                          style={{
                            color: "var(--oxide-ember)",
                            border: "1px solid rgba(212, 91, 44, 0.45)",
                          }}
                          onClick={() => setShowModelHubModal(true)}
                        >
                          + Install Agent Model
                        </button>
                      )}
                    </div>

                    {/* Subagent Model Picker */}
                    <div
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "0.3rem",
                      }}
                    >
                      <span
                        style={{
                          fontSize: "0.71rem",
                          color: "var(--text-muted)",
                        }}
                      >
                        Subagent:
                      </span>
                      {ollamaModels.length > 0 ? (
                        <select
                          className="ag-model-picker-inline"
                          style={{
                            background: "var(--bg-elevated)",
                            border: "1px solid var(--border-subtle)",
                          }}
                          value={
                            !providerConfig.enable_subagents
                              ? "__off__"
                              : providerConfig.task_routing
                                  .coder_subagent_model || ollamaModels[0]
                          }
                          onChange={async (e) => {
                            const val = e.target.value;
                            if (val === "__off__") {
                              const updated: ProviderConfig = {
                                ...providerConfig,
                                enable_subagents: false,
                              };
                              setProviderConfig(updated);
                              await oxideBridge.updateProviderConfig(updated);
                            } else {
                              const updated: ProviderConfig = {
                                ...providerConfig,
                                enable_subagents: true,
                                task_routing: {
                                  ...providerConfig.task_routing,
                                  coder_subagent_model: val,
                                  research_subagent_model: val,
                                  tester_subagent_model: val,
                                },
                              };
                              setProviderConfig(updated);
                              await oxideBridge.updateProviderConfig(updated);
                            }
                          }}
                        >
                          {ollamaModels.map((m) => (
                            <option
                              key={m}
                              value={m}
                              style={{ background: "#18181b", color: "#ececef" }}
                            >
                              {m}
                            </option>
                          ))}
                          <option
                            value="__off__"
                            style={{ background: "#18181b", color: "#a1a1aa" }}
                          >
                            Off (Single Agent)
                          </option>
                        </select>
                      ) : (
                        <button
                          className="ag-model-picker-inline"
                          onClick={() => setShowModelHubModal(true)}
                        >
                          None
                        </button>
                      )}
                    </div>

                    <button
                      className="ag-model-picker-inline"
                      onClick={() => setShowModelHubModal(true)}
                      title="Install or manage AI models"
                    >
                      + Models
                    </button>

                    <button
                      className="ag-model-picker-inline"
                      onClick={() => setShowSubagentsGuide(true)}
                      title="Subagent Architecture & Multi-Agent Delegation Guide"
                      style={{
                        borderColor: providerConfig.enable_subagents ? "rgba(34, 197, 94, 0.4)" : undefined,
                        color: providerConfig.enable_subagents ? "#86efac" : undefined,
                      }}
                    >
                      🤖 Subagents
                    </button>
                  </div>

                  <div className="ag-toolbar-right">
                    {statusBanner && (
                      <span
                        style={{
                          fontSize: "0.72rem",
                          color: "var(--text-muted)",
                          maxWidth: "240px",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={statusBanner}
                      >
                        {statusBanner}
                      </span>
                    )}

                    {/* Security Review Mode Dropdown (Antigravity Style) */}
                    <div className="oxide-security-wrapper">
                      <button
                        type="button"
                        className="oxide-security-btn"
                        onClick={() => setShowSecurityMenu((v) => !v)}
                        title="AI Execution Security Mode"
                      >
                        <span style={{ fontSize: "0.85rem" }}>
                          {providerConfig.security_mode === "request_review"
                            ? "🛡️"
                            : providerConfig.security_mode === "default"
                            ? "🔒"
                            : providerConfig.security_mode === "auto"
                            ? "✨"
                            : "⚡"}
                        </span>
                        <span>
                          {providerConfig.security_mode === "request_review"
                            ? "Request Review"
                            : providerConfig.security_mode === "default"
                            ? "Default"
                            : providerConfig.security_mode === "auto"
                            ? "Auto"
                            : "Turbo"}
                        </span>
                        <span style={{ fontSize: "0.62rem", color: "var(--text-muted)" }}>
                          {showSecurityMenu ? "▴" : "▾"}
                        </span>
                      </button>

                      {showSecurityMenu && (
                        <div
                          className="oxide-security-menu"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            className={`oxide-security-item ${
                              providerConfig.security_mode === "request_review" ? "active" : ""
                            }`}
                            onClick={async () => {
                              const updated: ProviderConfig = {
                                ...providerConfig,
                                security_mode: "request_review",
                              };
                              setProviderConfig(updated);
                              setShowSecurityMenu(false);
                              await oxideBridge.updateProviderConfig(updated);
                              setStatusBanner("Execution mode set to Request Review.");
                            }}
                          >
                            <span className="oxide-security-item-icon">🛡️</span>
                            <div className="oxide-security-item-body">
                              <span className="oxide-security-item-title">Request Review</span>
                              <span className="oxide-security-item-desc">
                                Every command requires approval.
                              </span>
                            </div>
                            {providerConfig.security_mode === "request_review" && (
                              <span className="oxide-security-item-check">✓</span>
                            )}
                          </button>

                          <button
                            type="button"
                            className={`oxide-security-item ${
                              providerConfig.security_mode === "default" ? "active" : ""
                            }`}
                            onClick={async () => {
                              const updated: ProviderConfig = {
                                ...providerConfig,
                                security_mode: "default",
                              };
                              setProviderConfig(updated);
                              setShowSecurityMenu(false);
                              await oxideBridge.updateProviderConfig(updated);
                              setStatusBanner("Execution mode set to Default.");
                            }}
                          >
                            <span className="oxide-security-item-icon">🔒</span>
                            <div className="oxide-security-item-body">
                              <span className="oxide-security-item-title">Default</span>
                              <span className="oxide-security-item-desc">
                                Ask before sensitive operations.
                              </span>
                            </div>
                            {providerConfig.security_mode === "default" && (
                              <span className="oxide-security-item-check">✓</span>
                            )}
                          </button>

                          <button
                            type="button"
                            className={`oxide-security-item ${
                              providerConfig.security_mode === "auto" ? "active" : ""
                            }`}
                            onClick={async () => {
                              const updated: ProviderConfig = {
                                ...providerConfig,
                                security_mode: "auto",
                              };
                              setProviderConfig(updated);
                              setShowSecurityMenu(false);
                              await oxideBridge.updateProviderConfig(updated);
                              setStatusBanner("Execution mode set to Auto (Preview).");
                            }}
                          >
                            <span className="oxide-security-item-icon">✨</span>
                            <div className="oxide-security-item-body">
                              <span className="oxide-security-item-title">Auto (Preview)</span>
                              <span className="oxide-security-item-desc">
                                Automatically decide if commands run.
                              </span>
                            </div>
                            {providerConfig.security_mode === "auto" && (
                              <span className="oxide-security-item-check">✓</span>
                            )}
                          </button>

                          <button
                            type="button"
                            className={`oxide-security-item ${
                              providerConfig.security_mode === "turbo" || !providerConfig.security_mode
                                ? "active"
                                : ""
                            }`}
                            onClick={async () => {
                              const updated: ProviderConfig = {
                                ...providerConfig,
                                security_mode: "turbo",
                              };
                              setProviderConfig(updated);
                              setShowSecurityMenu(false);
                              await oxideBridge.updateProviderConfig(updated);
                              setStatusBanner("Execution mode set to Turbo (Unrestricted).");
                            }}
                          >
                            <span className="oxide-security-item-icon">⚡</span>
                            <div className="oxide-security-item-body">
                              <span className="oxide-security-item-title">Turbo</span>
                              <span className="oxide-security-item-desc">
                                Run all commands without restrictions.
                              </span>
                            </div>
                            {(providerConfig.security_mode === "turbo" ||
                              !providerConfig.security_mode) && (
                              <span className="oxide-security-item-check">✓</span>
                            )}
                          </button>
                        </div>
                      )}
                    </div>

                    <button
                      className="ag-send-btn"
                      disabled={isRunning || !prompt.trim()}
                      onClick={() => handleRunTask()}
                      title="Send (Enter)"
                    >
                      â†’
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* ==================== RIGHT DOCK: OVERVIEW + PC HARDWARE GOVERNOR ==================== */}
          {showRightPanel && (
            <aside className="ag-right-dock">
              <div className="ag-overview-card">
                <div className="ag-overview-header">
                  <span>Overview</span>
                  <span
                    style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}
                  >
                    {gitStatus?.branch || "local"}
                  </span>
                </div>

                <div className="ag-overview-nav">
                  <button
                    className={`ag-overview-row ${
                      rightDrawer === "review" ? "active" : ""
                    }`}
                    onClick={() => setRightDrawer("review")}
                  >
                    <span>ðŸ“‹ Source Control</span>
                    <span style={{ fontSize: "0.72rem" }}>
                      {gitStatus?.changed_files.length || 0} changed
                    </span>
                  </button>

                  <button
                    className={`ag-overview-row ${
                      rightDrawer === "files" || rightDrawer === "editor"
                        ? "active"
                        : ""
                    }`}
                    onClick={() => setRightDrawer("files")}
                  >
                    <span>ðŸ“ Explorer</span>
                    <span style={{ fontSize: "0.72rem" }}>{files.length}</span>
                  </button>

                  <button
                    className={`ag-overview-row ${
                      rightDrawer === "terminal" ? "active" : ""
                    }`}
                    onClick={() => setRightDrawer("terminal")}
                  >
                    <span>&gt;_ Terminal</span>
                    <span style={{ fontSize: "0.72rem" }}>
                      {terminalLogs.length}
                    </span>
                  </button>

                  <button
                    className="ag-overview-row"
                    onClick={() => {
                      setSettingsTab("mcp");
                      setShowSettingsModal(true);
                    }}
                  >
                    <span>ðŸ”Œ MCP Servers</span>
                    <span style={{ fontSize: "0.72rem" }}>
                      {mcpServers.filter((s) => s.enabled).length} active
                    </span>
                  </button>
                </div>
              </div>

              {/* Expandable Right Drawer Content */}
              {rightDrawer === "overview" && (
                <div className="ag-drawer-panel" style={{ padding: "0.9rem" }}>
                  <div
                    style={{
                      fontSize: "0.74rem",
                      fontWeight: 600,
                      color: "var(--text-secondary)",
                      marginBottom: "0.5rem",
                    }}
                  >
                    Active Workspace
                  </div>
                  <div
                    style={{
                      fontSize: "0.76rem",
                      color: "var(--text-muted)",
                      wordBreak: "break-all",
                      marginBottom: "0.75rem",
                    }}
                  >
                    {activeProject?.path}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.45rem",
                    }}
                  >
                    <button
                      className="btn"
                      onClick={handlePickProjectFolder}
                      style={{ justifyContent: "center" }}
                    >
                      ðŸ“ Switch Workspace Folder...
                    </button>
                    <button
                      className="btn"
                      onClick={() => setRightDrawer("files")}
                      style={{ justifyContent: "center" }}
                    >
                      ðŸ“„ Browse Explorer ({files.length})
                    </button>
                    <button
                      className="btn"
                      onClick={() => setShowModelHubModal(true)}
                      style={{ justifyContent: "center" }}
                    >
                      ðŸ§  Open Models ({ollamaModels.length} Installed)
                    </button>
                  </div>
                </div>
              )}

              {rightDrawer === "files" && (
                <div className="ag-drawer-panel">
                  <div className="ag-overview-header">
                    <span>Explorer ({currentDir})</span>
                    <div style={{ display: "flex", gap: "0.3rem" }}>
                      {currentDir !== "." && (
                        <button
                          className="btn"
                          style={{ padding: "0.18rem 0.45rem" }}
                          onClick={async () => {
                            setCurrentDir(".");
                            setFiles(await oxideBridge.listWorkspaceFiles("."));
                          }}
                        >
                          â†‘ Root
                        </button>
                      )}
                      <button
                        className="btn"
                        style={{ padding: "0.18rem 0.45rem" }}
                        onClick={handleCreateNewFile}
                      >
                        + File
                      </button>
                    </div>
                  </div>
                  <div
                    style={{
                      flex: 1,
                      overflowY: "auto",
                      padding: "0.4rem",
                    }}
                  >
                    {files.map((entry) => (
                      <div
                        key={entry.relative_path}
                        className={`file-item ${
                          activeFile === entry.relative_path ? "active" : ""
                        }`}
                        onClick={() => handleOpenFileOrDir(entry)}
                      >
                        <span>
                          {entry.is_dir ? "ðŸ“" : "ðŸ“„"} {entry.name}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {rightDrawer === "editor" && (
                <div className="ag-drawer-panel">
                  <div className="ag-overview-header">
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {activeFile || "Untitled"}
                    </span>
                    <div style={{ display: "flex", gap: "0.3rem" }}>
                      <button
                        className="btn"
                        style={{ padding: "0.18rem 0.45rem" }}
                        onClick={() => setRightDrawer("files")}
                      >
                        â† Files
                      </button>
                      <button
                        className="btn btn-primary"
                        style={{ padding: "0.18rem 0.55rem" }}
                        onClick={handleSaveActiveFile}
                      >
                        Save
                      </button>
                    </div>
                  </div>
                  <textarea
                    className="code-editor"
                    value={activeFileContent}
                    onChange={(e) => setActiveFileContent(e.target.value)}
                    spellCheck={false}
                  />
                </div>
              )}

              {rightDrawer === "review" && (
                <div
                  className="ag-drawer-panel"
                  style={{ padding: "0.75rem", gap: "0.6rem" }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <strong style={{ fontSize: "0.8rem" }}>
                      Source Control ({gitStatus?.branch})
                    </strong>
                    <div style={{ display: "flex", gap: "0.3rem" }}>
                      <button
                        className="btn"
                        onClick={() => handleGitAction("pull")}
                      >
                        â†“ Pull
                      </button>
                      <button
                        className="btn"
                        onClick={() => handleGitAction("commit")}
                      >
                        âœ“ Commit
                      </button>
                      <button
                        className="btn btn-primary"
                        onClick={() => handleGitAction("push")}
                      >
                        â†‘ Push
                      </button>
                    </div>
                  </div>
                  <div style={{ flex: 1, overflowY: "auto" }}>
                    {gitStatus?.changed_files.length ? (
                      gitStatus.changed_files.map((f, i) => (
                        <div key={i} className="file-item">
                          {f}
                        </div>
                      ))
                    ) : (
                      <div
                        style={{
                          fontSize: "0.78rem",
                          color: "var(--text-muted)",
                        }}
                      >
                        Working tree is clean.
                      </div>
                    )}
                  </div>
                </div>
              )}

              {rightDrawer === "terminal" && (
                <div
                  className="ag-drawer-panel"
                  style={{ padding: "0.75rem", gap: "0.55rem" }}
                >
                  <div style={{ display: "flex", gap: "0.35rem" }}>
                    <input
                      className="workspace-input"
                      style={{ flex: 1 }}
                      value={quickCommand}
                      onChange={(e) => setQuickCommand(e.target.value)}
                      onKeyDown={async (e) => {
                        if (e.key === "Enter" && quickCommand.trim()) {
                          const res = await oxideBridge.executeBoundedCommand(
                            quickCommand.trim()
                          );
                          setTerminalLogs((prev) => [res, ...prev]);
                        }
                      }}
                      placeholder="Command..."
                    />
                  </div>
                  <div
                    style={{
                      flex: 1,
                      overflowY: "auto",
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.45rem",
                    }}
                  >
                    {terminalLogs.map((l, i) => (
                      <div key={i} className="terminal-log">
                        <div>
                          $ {l.program} {l.args.join(" ")} ({l.exit_code})
                        </div>
                        {l.stdout && <div>{l.stdout}</div>}
                        {l.stderr && (
                          <div className="stderr-text">{l.stderr}</div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </aside>
          )}
        </div>
      </main>

      {/* ==================== 1-CLICK AI MODEL STORE MODAL ==================== */}
      {showModelHubModal && (
        <div
          className="modal-backdrop"
          onClick={() => setShowModelHubModal(false)}
        >
          <div
            className="model-hub-card"
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div>
                <h3 style={{ margin: 0, fontSize: "1.05rem" }}>
                  ðŸ§  AI Models (Ollama &amp; HuggingFace 1-Click Installer)
                </h3>
                <div
                  style={{
                    fontSize: "0.78rem",
                    color: "var(--text-secondary)",
                    marginTop: "0.2rem",
                  }}
                >
                  Auto-matched to your PC hardware â€¢ Filter by Coding,
                  Uncensored, Reasoning &amp; Fast Subagents
                </div>
              </div>
              <button
                className="btn"
                onClick={() => setShowModelHubModal(false)}
              >
                âœ• Close
              </button>
            </div>

            <div
              className="hw-spec-box"
              style={{
                display: "flex",
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "0.75rem",
              }}
            >
              <div>
                <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                  ðŸ–¥ Detected PC Specs:{" "}
                  <span style={{ color: "var(--oxide-ember)" }}>
                    {hwSpecs
                      ? `${hwSpecs.total_ram_gb} GB RAM (${hwSpecs.available_ram_gb} GB free) â€¢ ${hwSpecs.gpu_name}${
                          hwSpecs.gpu_vram_gb > 0
                            ? ` (${hwSpecs.gpu_vram_gb} GB VRAM)`
                            : ""
                        }`
                      : "Inspecting hardware..."}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: "0.74rem",
                    color: "var(--text-secondary)",
                    marginTop: "0.18rem",
                  }}
                >
                  Local Ollama Engine:{" "}
                  <strong
                    style={{
                      color: ollamaOnline ? "#4ade80" : "#fbbf24",
                    }}
                  >
                    {ollamaOnline
                      ? `Online (${ollamaModels.length} installed)`
                      : "Not Running / Not Installed"}
                  </strong>
                  {" â€¢ "}
                  Agent:{" "}
                  <code>
                    {providerConfig.task_routing.architect_model || "None"}
                  </code>
                  {" â€¢ "}
                  Subagent:{" "}
                  <code>
                    {providerConfig.task_routing.coder_subagent_model || "None"}
                  </code>
                </div>
              </div>

              <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap" }}>
                {!ollamaOnline && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                    <button
                      className="btn btn-primary"
                      disabled={isInstallingOllama}
                      onClick={handleInstallOllama}
                    >
                      {isInstallingOllama ? "↻ Installing Ollama..." : "⚡ 1-Click Start / Install Ollama"}
                    </button>
                    {isInstallingOllama && (
                      <div style={{ width: "260px" }}>
                        <div className="oxide-progress-track">
                          <div
                            className="oxide-progress-fill"
                            style={{ width: "70%", animation: "pulse 1.5s infinite" }}
                          />
                        </div>
                        <div style={{ fontSize: "0.72rem", color: "#fde047", marginTop: "0.25rem" }}>
                          {ollamaInstallStep}
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {ollamaModels.length > 0 && (
                  <button
                    className="btn"
                    onClick={handleAutoAssignOptimalModels}
                  >
                    âœ¨ Auto-Assign Installed Models
                  </button>
                )}
              </div>
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "0.5rem",
              }}
            >
              <div className="model-filter-bar">
                {(
                  [
                    ["all", "All Models"],
                    ["coding", "ðŸ’» Coding"],
                    ["uncensored", "ðŸ”“ Uncensored"],
                    ["coding_uncensored", "ðŸ”¥ Coding + Uncensored"],
                    ["reasoning", "ðŸ§  Reasoning (R1)"],
                    ["subagent", "âš¡ Fast Subagents"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    className={`model-filter-pill ${
                      modelCategoryFilter === key ? "active" : ""
                    }`}
                    onClick={() => setModelCategoryFilter(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="model-filter-bar">
                {(
                  [
                    ["all", "All Sources"],
                    ["ollama", "ðŸ¦™ Ollama"],
                    ["huggingface", "ðŸ¤— HuggingFace"],
                  ] as const
                ).map(([srcKey, srcLabel]) => (
                  <button
                    key={srcKey}
                    className={`model-filter-pill ${
                      modelSourceFilter === srcKey ? "active" : ""
                    }`}
                    onClick={() => setModelSourceFilter(srcKey)}
                  >
                    {srcLabel}
                  </button>
                ))}

                <label
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.35rem",
                    fontSize: "0.76rem",
                    cursor: "pointer",
                    marginLeft: "0.35rem",
                    color: onlyFitsMyPc ? "#4ade80" : "var(--text-secondary)",
                    fontWeight: onlyFitsMyPc ? 600 : 400,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={onlyFitsMyPc}
                    onChange={(e) => setOnlyFitsMyPc(e.target.checked)}
                  />
                  âœ… Fits My PC Only
                </label>
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto auto",
                gap: "0.5rem",
              }}
            >
              <input
                className="workspace-input"
                placeholder="Search models (e.g. 'coder', 'uncensored', 'abliterated', 'dolphin', 'deepseek-r1')..."
                value={modelSearchQuery}
                onChange={(e) => setModelSearchQuery(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === "Enter" && modelSearchQuery.trim()) {
                    setIsSearchingHf(true);
                    try {
                      const res = await oxideBridge.searchHuggingfaceGguf(
                        modelSearchQuery.trim()
                      );
                      setHfSearchResults(res.map(hfEntryToCatalogEntry));
                    } finally {
                      setIsSearchingHf(false);
                    }
                  }
                }}
              />
              <button
                className="btn"
                disabled={isSearchingHf}
                onClick={async () => {
                  setIsSearchingHf(true);
                  try {
                    const q =
                      modelSearchQuery.trim() ||
                      (modelCategoryFilter === "uncensored" ||
                      modelCategoryFilter === "coding_uncensored"
                        ? "coder abliterated uncensored"
                        : "qwen2.5-coder gguf");
                    const res = await oxideBridge.searchHuggingfaceGguf(q);
                    setHfSearchResults(res.map(hfEntryToCatalogEntry));
                  } catch (err: any) {
                    setStatusBanner(
                      `HuggingFace search error: ${err?.message || String(err)}`
                    );
                  } finally {
                    setIsSearchingHf(false);
                  }
                }}
              >
                {isSearchingHf
                  ? "ðŸ¤— Searching HF..."
                  : "ðŸ¤— Search HuggingFace Live"}
              </button>
              {hfSearchResults.length > 0 && (
                <button
                  className="btn"
                  onClick={() => setHfSearchResults([])}
                >
                  Clear HF ({hfSearchResults.length})
                </button>
              )}
            </div>

            <div
              style={{
                display: "flex",
                gap: "0.5rem",
                alignItems: "center",
              }}
            >
              <input
                className="workspace-input"
                style={{ flex: 1 }}
                placeholder="Or paste any Ollama tag or HuggingFace GGUF repo (e.g. hf.co/bartowski/Qwen2.5-Coder-7B-Instruct-abliterated-GGUF)..."
                value={customInstallTag}
                onChange={(e) => setCustomInstallTag(e.target.value)}
              />
              <button
                className="btn btn-primary"
                disabled={
                  !customInstallTag.trim() || Boolean(installingModelId)
                }
                onClick={async () => {
                  const tag = customInstallTag.trim();
                  if (!tag) return;
                  setInstallingModelId(tag);
                  setStatusBanner(`Downloading & installing ${tag}...`);
                  try {
                    const res = await oxideBridge.installAiModel(tag);
                    setStatusBanner(res.message);
                    setCustomInstallTag("");
                    await refreshWorkspaceState(currentDir);
                  } catch (err: any) {
                    setStatusBanner(
                      `Install failed: ${err?.message || String(err)}`
                    );
                  } finally {
                    setInstallingModelId(null);
                  }
                }}
              >
                {installingModelId === customInstallTag.trim() &&
                customInstallTag.trim()
                  ? `${(modelProgressMap[customInstallTag.trim()]?.percent ?? 0) > 0 ? `${modelProgressMap[customInstallTag.trim()].percent.toFixed(0)}%` : "âŸ³"} Installing...`
                  : "â¬‡ Install Tag"}
              </button>
            </div>

            <div className="model-grid">
              {[
                ...hfSearchResults,
                ...CURATED_MODEL_CATALOG.filter(
                  (c) =>
                    !hfSearchResults.some(
                      (h) => h.install_id === c.install_id
                    )
                ),
              ]
                .filter((m) => {
                  if (
                    modelSourceFilter !== "all" &&
                    m.source !== modelSourceFilter
                  ) {
                    return false;
                  }
                  if (modelCategoryFilter === "coding" && !m.is_coding) {
                    return false;
                  }
                  if (
                    modelCategoryFilter === "uncensored" &&
                    !m.is_uncensored
                  ) {
                    return false;
                  }
                  if (
                    modelCategoryFilter === "coding_uncensored" &&
                    (!m.is_coding || !m.is_uncensored)
                  ) {
                    return false;
                  }
                  if (modelCategoryFilter === "reasoning" && !m.is_reasoning) {
                    return false;
                  }
                  if (
                    modelCategoryFilter === "subagent" &&
                    !m.is_fast_subagent
                  ) {
                    return false;
                  }
                  const fit = evaluateModelHardwareFit(m, hwSpecs);
                  if (onlyFitsMyPc && !fit.canRun) {
                    return false;
                  }
                  if (modelSearchQuery.trim()) {
                    const q = modelSearchQuery.toLowerCase();
                    const hay =
                      `${m.name} ${m.install_id} ${m.summary} ${m.author} ${
                        m.is_uncensored ? "uncensored abliterated" : ""
                      } ${m.is_coding ? "coding coder" : ""}`.toLowerCase();
                    if (!hay.includes(q)) return false;
                  }
                  return true;
                })
                .map((model) => {
                  const fit = evaluateModelHardwareFit(model, hwSpecs);
                  const isInstalled = ollamaModels.some(
                    (om) =>
                      om.toLowerCase() === model.install_id.toLowerCase() ||
                      om
                        .toLowerCase()
                        .startsWith(model.install_id.toLowerCase())
                  );
                  const isInstallingThis =
                    installingModelId === model.install_id;
                  const isLead =
                    providerConfig.task_routing.architect_model ===
                    model.install_id;
                  const isSubagent =
                    providerConfig.task_routing.coder_subagent_model ===
                    model.install_id;

                  return (
                    <div
                      key={model.install_id}
                      className={`model-item-card ${
                        isInstalled ? "installed" : ""
                      }`}
                    >
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "0.42rem",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "flex-start",
                            gap: "0.4rem",
                          }}
                        >
                          <div>
                            <div
                              style={{
                                fontWeight: 600,
                                fontSize: "0.86rem",
                                color: "var(--text-primary)",
                              }}
                            >
                              {model.name}
                            </div>
                            <div
                              style={{
                                fontSize: "0.7rem",
                                color: "var(--text-muted)",
                              }}
                            >
                              {model.source === "huggingface"
                                ? "ðŸ¤— HuggingFace GGUF"
                                : "ðŸ¦™ Ollama Registry"}{" "}
                              â€¢ <code>{model.params}</code> â€¢ {model.size_gb} GB
                            </div>
                          </div>

                          <span
                            className={`hw-fit-badge ${fit.tier}`}
                            title={fit.detail}
                          >
                            {fit.label}
                          </span>
                        </div>

                        <div
                          style={{
                            display: "flex",
                            gap: "0.35rem",
                            flexWrap: "wrap",
                          }}
                        >
                          {model.is_coding && (
                            <span className="model-badge coding">
                              ðŸ’» Coding
                            </span>
                          )}
                          {model.is_uncensored && (
                            <span className="model-badge uncensored">
                              ðŸ”“ Uncensored
                            </span>
                          )}
                          {model.is_reasoning && (
                            <span className="model-badge reasoning">
                              ðŸ§  Reasoning
                            </span>
                          )}
                          {model.is_fast_subagent && (
                            <span className="model-badge subagent">
                              âš¡ Fast Subagent
                            </span>
                          )}
                        </div>

                        <div
                          style={{
                            fontSize: "0.75rem",
                            color: "var(--text-secondary)",
                            lineHeight: 1.45,
                          }}
                        >
                          {model.summary}
                        </div>
                      </div>

                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: "0.4rem",
                          paddingTop: "0.35rem",
                          borderTop: "1px solid var(--border-subtle)",
                          flexWrap: "wrap",
                        }}
                      >
                        <code
                          style={{
                            fontSize: "0.68rem",
                            color: "var(--text-muted)",
                            maxWidth: "180px",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={model.install_id}
                        >
                          {model.install_id}
                        </code>

                        <div style={{ display: "flex", gap: "0.35rem" }}>
                          {!isInstalled ? (
                            <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", width: "100%" }}>
                            <button
                              className="btn btn-primary"
                              disabled={Boolean(installingModelId)}
                              onClick={async () => {
                                setInstallingModelId(model.install_id);
                                setStatusBanner(
                                  `Downloading & installing ${model.name} (${model.size_gb} GB)...`
                                );
                                try {
                                  const res =
                                    await oxideBridge.installAiModel(
                                      model.install_id
                                    );
                                  setStatusBanner(res.message);
                                  await refreshWorkspaceState(currentDir);
                                } catch (err: any) {
                                  setStatusBanner(
                                    `Install error: ${
                                      err?.message || String(err)
                                    }`
                                  );
                                } finally {
                                  setInstallingModelId(null);
                                }
                              }}
                            >
                              {isInstallingThis
                                ? `${(modelProgressMap[model.install_id]?.percent ?? 0) > 0 ? `${modelProgressMap[model.install_id].percent.toFixed(0)}%` : "âŸ³"} Installing...`
                                : "â¬‡ Install"}
                            </button>
                            {isInstallingThis && (
                              <div style={{ marginTop: "0.3rem", width: "100%" }}>
                                <div className="oxide-progress-track">
                                  <div
                                    className="oxide-progress-fill"
                                    style={{
                                      width: `${Math.max(6, modelProgressMap[model.install_id]?.percent ?? 8)}%`,
                                      transition: "width 0.2s ease",
                                    }}
                                  />
                                </div>
                                <div style={{ fontSize: "0.71rem", color: "#fde047", marginTop: "0.25rem", display: "flex", justifyContent: "space-between" }}>
                                  <span>
                                    {modelProgressMap[model.install_id]?.status || "Connecting & pulling layers..."}
                                  </span>
                                  <span>
                                    {(modelProgressMap[model.install_id]?.percent ?? 0) > 0
                                      ? `${modelProgressMap[model.install_id].percent.toFixed(1)}%`
                                      : "Starting..."}
                                  </span>
                                </div>
                              </div>
                            )}
                          </div>
                          ) : (
                            <>
                              <button
                                className={`btn ${
                                  isLead ? "btn-primary" : ""
                                }`}
                                onClick={async () => {
                                  const next: ProviderConfig = {
                                    ...providerConfig,
                                    active_provider: "ollama",
                                    ollama_model: model.install_id,
                                    task_routing: {
                                      ...providerConfig.task_routing,
                                      architect_model: model.install_id,
                                    },
                                  };
                                  const saved =
                                    await oxideBridge.updateProviderConfig(
                                      next
                                    );
                                  setProviderConfig(saved);
                                  setStatusBanner(
                                    `Set ${model.name} as Main Agent`
                                  );
                                }}
                              >
                                {isLead ? "âœ“ Agent" : "Set as Agent"}
                              </button>
                              <button
                                className={`btn ${
                                  isSubagent ? "btn-primary" : ""
                                }`}
                                onClick={async () => {
                                  const next: ProviderConfig = {
                                    ...providerConfig,
                                    enable_subagents: true,
                                    task_routing: {
                                      ...providerConfig.task_routing,
                                      coder_subagent_model: model.install_id,
                                      research_subagent_model: model.install_id,
                                      tester_subagent_model: model.install_id,
                                    },
                                  };
                                  const saved =
                                    await oxideBridge.updateProviderConfig(
                                      next
                                    );
                                  setProviderConfig(saved);
                                  setStatusBanner(
                                    `Set ${model.name} as Subagent`
                                  );
                                }}
                              >
                                {isSubagent
                                  ? "âœ“ Subagent"
                                  : "Set as Subagent"}
                              </button>
                              <button
                                className="btn"
                                title="Uninstall model"
                                onClick={async () => {
                                  await oxideBridge.deleteAiModel(
                                    model.install_id
                                  );
                                  await refreshWorkspaceState(currentDir);
                                }}
                              >
                                ðŸ—‘
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      )}

      {/* ==================== MULTI-TABBED SETTINGS WINDOW ==================== */}
      {showSettingsModal && (
        <div
          className="modal-backdrop"
          onClick={() => setShowSettingsModal(false)}
        >
          <div
            className="model-hub-card"
            style={{ width: "800px" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <h3 style={{ margin: 0 }}>âš™ Oxide Studio Settings</h3>
              <button
                className="btn"
                onClick={() => setShowSettingsModal(false)}
              >
                âœ• Close
              </button>
            </div>

            {/* Settings Navigation Tabs */}
            <div
              className="model-filter-bar"
              style={{
                borderBottom: "1px solid var(--border-subtle)",
                paddingBottom: "0.65rem",
              }}
            >
              {(
                [
                  ["general", "ðŸ“ General"],
                  ["hardware", "ðŸ–¥ Hardware & Acceleration"],
                  ["security", "🔒 Security & Sandbox"],
                  ["providers", "ðŸ”‘ AI Providers"],
                  ["agents", "âš¡ Agent Routing"],
                  ["mcp", "ðŸ”Œ MCP Servers"],
                  ["updates", "â†» Updates"],
                ] as const
              ).map(([tabKey, tabLabel]) => (
                <button
                  key={tabKey}
                  className={`model-filter-pill ${
                    settingsTab === tabKey ? "active" : ""
                  }`}
                  onClick={() => setSettingsTab(tabKey)}
                >
                  {tabLabel}
                </button>
              ))}
            </div>

            {/* TAB 1: GENERAL & WORKSPACE */}
            {settingsTab === "general" && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.85rem",
                }}
              >
                <div className="hw-spec-box">
                  <div style={{ fontWeight: 600 }}>Active Workspace Folder</div>
                  <div
                    style={{
                      fontSize: "0.78rem",
                      color: "var(--text-secondary)",
                    }}
                  >
                    <code>{activeProject?.path}</code>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: "0.5rem",
                      marginTop: "0.35rem",
                      flexWrap: "wrap",
                    }}
                  >
                    <button
                      className="btn btn-primary"
                      onClick={handlePickProjectFolder}
                    >
                      ðŸ“ Open Folder...
                    </button>
                    <button
                      className="btn"
                      onClick={async () => {
                        const info = await oxideBridge.setWorkspace(".");
                        const defaultProj: ProjectWorkspace = {
                          id: "proj-workspace",
                          name: getBaseName(info.canonical_path),
                          path: info.canonical_path,
                        };
                        const nextProjects = [
                          defaultProj,
                          ...projects.filter(
                            (p) => p.path !== info.canonical_path
                          ),
                        ];
                        setProjects(nextProjects);
                        setActiveProjectId(defaultProj.id);
                        await refreshWorkspaceState(".");
                        setStatusBanner(
                          `Opened default workspace: ${info.canonical_path}`
                        );
                      }}
                    >
                      Open Default Workspace Folder (`Programs/Oxide/workspace`)
                    </button>
                    <button
                      className="btn"
                      onClick={() =>
                        oxideBridge.openInVsCode(activeProject?.path)
                      }
                    >
                      Open in VS Code
                    </button>
                  </div>
                </div>

                <div className="hw-spec-box">
                  <div style={{ fontWeight: 600 }}>
                    Saved Conversations &amp; Session Storage
                  </div>
                  <div
                    style={{
                      fontSize: "0.76rem",
                      color: "var(--text-secondary)",
                    }}
                  >
                    Conversations are automatically saved to{" "}
                    <code>
                      %LOCALAPPDATA%/Programs/Oxide/studio_sessions.json
                    </code>
                    .
                  </div>
                  <div>
                    <button
                      className="btn"
                      onClick={async () => {
                        const freshConv: SavedConversation = {
                          id: `conv-${Date.now()}`,
                          projectId: activeProjectId,
                          title: "New Conversation",
                          updatedAt: "now",
                          turns: [],
                        };
                        setConversations([freshConv]);
                        setActiveConvId(freshConv.id);
                        await persistStudioSessions(
                          projects,
                          [freshConv],
                          activeProjectId,
                          freshConv.id
                        );
                        setStatusBanner("Cleared saved conversation history.");
                      }}
                    >
                      ðŸ—‘ Clear Conversation History
                    </button>
                  </div>
                </div>
              </div>
            )}

                        {/* TAB 2: HARDWARE & ACCELERATION */}
            {settingsTab === "hardware" && (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
                {hwSpecs && (
                  <div className="hw-spec-box">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <strong>ðŸ–¥ {hwSpecs.gpu_name}</strong>
                        <div style={{ fontSize: "0.74rem", color: "var(--text-secondary)", marginTop: "0.2rem" }}>
                          {hwSpecs.governor_tier} â€¢ {hwSpecs.cpu_brand} ({hwSpecs.cpu_cores} Cores)
                        </div>
                      </div>
                      <span className="hw-fit-badge gpu_fast">
                        âš¡ {hwSpecs.gpu_vram_gb > 0 ? `${hwSpecs.gpu_vram_gb} GB VRAM` : "System GPU"}
                      </span>
                    </div>

                    <div style={{ marginTop: "0.75rem" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.74rem" }}>
                        <span>System RAM Usage</span>
                        <span>{hwSpecs.available_ram_gb} GB free / {hwSpecs.total_ram_gb} GB ({hwSpecs.used_ram_percent}%)</span>
                      </div>
                      <div className="oxide-progress-track">
                        <div className="oxide-progress-fill" style={{ width: `${hwSpecs.used_ram_percent}%` }} />
                      </div>
                    </div>

                    <div style={{ fontSize: "0.74rem", color: "var(--text-secondary)", marginTop: "0.6rem" }}>
                      ðŸ’¡ {hwSpecs.governor_advice}
                    </div>
                  </div>
                )}

                <div className="routing-grid">
                  <div className="form-group">
                    <label>Hardware Acceleration Backend</label>
                    <select
                      className="select-control"
                      value={providerConfig.hardware_acceleration || "auto"}
                      onChange={(e) =>
                        setProviderConfig({
                          ...providerConfig,
                          hardware_acceleration:
                            e.target.value as HardwareAccelerationMode,
                        })
                      }
                    >
                      <option value="auto">Auto-Detect ({hwSpecs?.gpu_name || "GPU / DirectML"})</option>
                      <option value="amd_rocm">AMD Radeon (ROCm / DirectML GPU Acceleration)</option>
                      <option value="nvidia_cuda">NVIDIA GeForce / RTX (CUDA Acceleration)</option>
                      <option value="directml">DirectML / Windows ML (Universal GPU)</option>
                      <option value="cpu">CPU Only (Disable GPU Offloading)</option>
                    </select>
                  </div>

                  <div className="form-group">
                    <label>GPU Offload Policy (Hybrid Split Inference)</label>
                    <select
                      className="select-control"
                      value={providerConfig.gpu_offload_policy || "hybrid_split"}
                      onChange={(e) =>
                        setProviderConfig({
                          ...providerConfig,
                          gpu_offload_policy: e.target.value as GpuOffloadPolicy,
                        })
                      }
                    >
                      <option value="hybrid_split">⚡ Hybrid Split (Auto-calculate VRAM + System RAM split)</option>
                      <option value="full_gpu">🚀 Full GPU (Offload all layers to VRAM - Fastest)</option>
                      <option value="custom_layers">⚙️ Custom Layers (Use manual slider below)</option>
                      <option value="cpu_only">🖥️ CPU Only (0 layers on GPU)</option>
                    </select>
                  </div>
                </div>

                {providerConfig.gpu_offload_policy === "custom_layers" && (
                  <div className="form-group" style={{ marginTop: "0.4rem" }}>
                    <label>
                      Manual GPU Layers ({providerConfig.gpu_offload_layers ?? 48} layers)
                    </label>
                    <input
                      type="range"
                      min="0"
                      max="99"
                      value={providerConfig.gpu_offload_layers ?? 48}
                      onChange={(e) =>
                        setProviderConfig({
                          ...providerConfig,
                          gpu_offload_layers: parseInt(e.target.value, 10),
                        })
                      }
                    />
                  </div>
                )}

                {/* Hybrid Split Visualizer */}
                {(() => {
                  const policy = providerConfig.gpu_offload_policy || "hybrid_split";
                  const effectiveGpuLayers =
                    policy === "cpu_only"
                      ? 0
                      : policy === "full_gpu"
                      ? 99
                      : policy === "custom_layers"
                      ? (providerConfig.gpu_offload_layers ?? 48)
                      : (hwSpecs?.gpu_vram_gb && hwSpecs.gpu_vram_gb <= 12)
                      ? 36
                      : 48;
                  const gpuPercent = Math.min(100, Math.max(0, Math.round((effectiveGpuLayers / 99) * 100)));
                  const cpuPercent = 100 - gpuPercent;

                  return (
                    <div className="hw-spec-box" style={{ marginTop: "0.5rem" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.74rem", marginBottom: "0.25rem" }}>
                        <span style={{ color: "#34d399", fontWeight: 600 }}>
                          🎮 GPU VRAM Offload: {gpuPercent}% (~{effectiveGpuLayers} layers)
                        </span>
                        <span style={{ color: "#60a5fa", fontWeight: 600 }}>
                          🖥️ System RAM (CPU): {cpuPercent}% (~{Math.max(0, 99 - effectiveGpuLayers)} layers)
                        </span>
                      </div>
                      <div className="oxide-split-bar">
                        <div className="oxide-split-gpu" style={{ width: `${gpuPercent}%` }}>
                          {gpuPercent > 12 ? `GPU (${effectiveGpuLayers} Layers)` : ""}
                        </div>
                        <div className="oxide-split-cpu" style={{ width: `${cpuPercent}%` }}>
                          {cpuPercent > 12 ? `System RAM (${Math.max(0, 99 - effectiveGpuLayers)} Layers)` : ""}
                        </div>
                      </div>
                      <div style={{ fontSize: "0.72rem", color: "var(--text-secondary)", marginTop: "0.35rem", lineHeight: 1.4 }}>
                        💡 <strong>GPU Layer Offloading (Hybrid Split Inference):</strong> Oxide partitions transformer neural layers across your dedicated GPU VRAM and high-speed System RAM. This enables running heavyweight 14B, 32B, and 70B models that exceed physical VRAM without Out-Of-Memory (OOM) errors.
                      </div>
                    </div>
                  );
                })()}
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button
                    className="btn btn-primary"
                    onClick={async () => {
                      const saved = await oxideBridge.updateProviderConfig(providerConfig);
                      setProviderConfig(saved);
                      setStatusBanner("Saved Hardware Acceleration settings.");
                    }}
                  >
                    Save Hardware Settings
                  </button>
                </div>
              </div>
            )}

            {/* TAB: SECURITY & WORKSPACE SANDBOX */}
            {settingsTab === "security" && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.85rem",
                }}
              >
                {/* Active Workspace Sandbox Card */}
                <div className="hw-spec-box">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <strong>🔒 Active Workspace Sandbox Jail</strong>
                      <div style={{ fontSize: "0.74rem", color: "var(--text-secondary)", marginTop: "0.2rem" }}>
                        Restricts AI tools, file mutations, and terminal executions strictly to your active project folder
                      </div>
                    </div>
                    <span className="hw-fit-badge gpu_fast">
                      ✓ Sandbox Active
                    </span>
                  </div>
                  <div style={{ marginTop: "0.5rem", fontSize: "0.76rem", color: "var(--text-secondary)" }}>
                    Jailed Root: <code>{activeProject?.path}</code>
                  </div>
                  <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: "0.35rem", lineHeight: 1.4 }}>
                    Oxide canonicalizes all target paths and enforces strict boundary checks. Any attempt to traverse (<code>..</code>), access system directories (e.g. Windows/System32), or escape the project folder is blocked.
                  </div>
                </div>

                {/* Model Internet & Web Access */}
                <div className="hw-spec-box">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <strong>🌐 Model Internet Access &amp; Web Search</strong>
                      <div style={{ fontSize: "0.74rem", color: "var(--text-secondary)", marginTop: "0.2rem" }}>
                        Allows the AI model to search the web and fetch documentation from online URLs
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`btn ${providerConfig.allow_internet_access ? "btn-primary" : ""}`}
                      onClick={() =>
                        setProviderConfig({
                          ...providerConfig,
                          allow_internet_access: !providerConfig.allow_internet_access,
                        })
                      }
                    >
                      {providerConfig.allow_internet_access ? "✓ Internet Enabled" : "✕ Offline Mode"}
                    </button>
                  </div>
                  <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: "0.4rem", lineHeight: 1.4 }}>
                    {providerConfig.allow_internet_access
                      ? "The Lead Architect and subagents can use web_search and fetch_web_url to inspect documentation, public API references, and open-source repositories."
                      : "The AI is completely cut off from external network connections and operates in 100% offline air-gapped mode."}
                  </div>
                </div>

                {/* Execution Approval & Review Mode */}
                <div className="routing-grid">
                  <div className="form-group">
                    <label>Command Execution &amp; Review Mode</label>
                    <select
                      className="select-control"
                      value={providerConfig.security_mode || "turbo"}
                      onChange={(e) =>
                        setProviderConfig({
                          ...providerConfig,
                          security_mode: e.target.value as SecurityReviewMode,
                        })
                      }
                    >
                      <option value="turbo">⚡ Turbo (Run all commands without restrictions)</option>
                      <option value="auto">✨ Auto / Preview (Automatically evaluate command safety)</option>
                      <option value="default">🔒 Default (Ask before sensitive or destructive operations)</option>
                      <option value="request_review">🛡️ Request Review (Every command requires approval)</option>
                    </select>
                  </div>

                  <div className="form-group">
                    <label>Strict Workspace Jailing</label>
                    <select
                      className="select-control"
                      value={providerConfig.enforce_workspace_sandbox ? "true" : "false"}
                      onChange={(e) =>
                        setProviderConfig({
                          ...providerConfig,
                          enforce_workspace_sandbox: e.target.value === "true",
                        })
                      }
                    >
                      <option value="true">🔒 Strict Sandbox (Block all paths outside workspace)</option>
                      <option value="false">⚠️ Permissive (Allow read-only outside workspace)</option>
                    </select>
                  </div>
                </div>

                {/* Allowed Terminal Binaries */}
                <div className="hw-spec-box">
                  <div style={{ fontWeight: 600, fontSize: "0.82rem" }}>
                    Permitted Developer CLI Binaries
                  </div>
                  <div style={{ fontSize: "0.72rem", color: "var(--text-secondary)", marginTop: "0.2rem" }}>
                    The sandbox limits terminal command execution strictly to allowlisted developer tools:
                  </div>
                  <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap", marginTop: "0.45rem" }}>
                    {["cargo", "rustc", "npm", "npx", "node", "git", "python", "pytest", "ollama", "tsc", "vite"].map((b) => (
                      <span key={b} className="oxide-slash-badge" style={{ color: "#86efac", borderColor: "rgba(34, 197, 94, 0.3)" }}>
                        ✓ {b}
                      </span>
                    ))}
                  </div>
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button
                    className="btn btn-primary"
                    onClick={async () => {
                      const saved = await oxideBridge.updateProviderConfig(providerConfig);
                      setProviderConfig(saved);
                      setStatusBanner("Saved Security & Sandbox settings.");
                    }}
                  >
                    Save Security Settings
                  </button>
                </div>
              </div>
            )}

            {/* TAB 3: AI PROVIDERS & RUNTIME */}
            {settingsTab === "providers" && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.85rem",
                }}
              >
                <div className="hw-spec-box">
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <div>
                      <strong>Local Ollama Runtime</strong>:{" "}
                      <span
                        style={{
                          color: ollamaOnline ? "#4ade80" : "#fbbf24",
                        }}
                      >
                        {ollamaOnline
                          ? `Online (${ollamaModels.length} models installed)`
                          : "Offline / Not Installed"}
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: "0.4rem" }}>
                      {!ollamaOnline && (
                        <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                          <button
                            className="btn btn-primary"
                            disabled={isInstallingOllama}
                            onClick={handleInstallOllama}
                          >
                            {isInstallingOllama ? "↻ Installing Ollama..." : "⚡ Start / Install Ollama"}
                          </button>
                          {isInstallingOllama && (
                            <div style={{ width: "240px" }}>
                              <div className="oxide-progress-track">
                                <div
                                  className="oxide-progress-fill"
                                  style={{ width: "70%", animation: "pulse 1.5s infinite" }}
                                />
                              </div>
                              <div style={{ fontSize: "0.72rem", color: "#fde047", marginTop: "0.25rem" }}>
                                {ollamaInstallStep}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                      <button
                        className="btn"
                        onClick={() => {
                          setShowSettingsModal(false);
                          setShowModelHubModal(true);
                        }}
                      >
                        ðŸ§  Open Model Store
                      </button>
                    </div>
                  </div>
                </div>

                <div className="routing-grid">
                  <div className="form-group">
                    <label>Primary AI Provider</label>
                    <select
                      className="select-control"
                      value={providerConfig.active_provider}
                      onChange={(e) =>
                        setProviderConfig({
                          ...providerConfig,
                          active_provider: e.target.value as ProviderKind,
                        })
                      }
                    >
                      <option value="ollama">Ollama (Local Offline AI)</option>
                      <option value="anthropic">Anthropic Claude (Cloud)</option>
                      <option value="openai">OpenAI GPT (Cloud)</option>
                    </select>
                  </div>

                  <div className="form-group">
                    <label>Ollama Server URL</label>
                    <input
                      className="workspace-input"
                      value={providerConfig.ollama_base_url}
                      onChange={(e) =>
                        setProviderConfig({
                          ...providerConfig,
                          ollama_base_url: e.target.value,
                        })
                      }
                    />
                  </div>

                  <div className="form-group">
                    <label>Anthropic Model (if using Claude)</label>
                    <input
                      className="workspace-input"
                      value={providerConfig.anthropic_model}
                      onChange={(e) =>
                        setProviderConfig({
                          ...providerConfig,
                          anthropic_model: e.target.value,
                        })
                      }
                    />
                  </div>

                  <div className="form-group">
                    <label>OpenAI Model (if using OpenAI)</label>
                    <input
                      className="workspace-input"
                      value={providerConfig.openai_model}
                      onChange={(e) =>
                        setProviderConfig({
                          ...providerConfig,
                          openai_model: e.target.value,
                        })
                      }
                    />
                  </div>

                  <div className="form-group">
                    <label>
                      Sampling Temperature ({providerConfig.temperature})
                    </label>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={providerConfig.temperature}
                      onChange={(e) =>
                        setProviderConfig({
                          ...providerConfig,
                          temperature: parseFloat(e.target.value),
                        })
                      }
                    />
                  </div>

                  <div className="form-group" style={{ justifyContent: "end" }}>
                    <label
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.4rem",
                        cursor: "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={providerConfig.enable_cloud_fallback}
                        onChange={(e) =>
                          setProviderConfig({
                            ...providerConfig,
                            enable_cloud_fallback: e.target.checked,
                          })
                        }
                      />
                      Enable Cloud Fallback if Local Model Fails
                    </label>
                  </div>
                </div>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: "0.5rem",
                  }}
                >
                  <button
                    className="btn btn-primary"
                    onClick={async () => {
                      const saved = await oxideBridge.updateProviderConfig(
                        providerConfig
                      );
                      setProviderConfig(saved);
                      setStatusBanner("Saved Provider settings.");
                    }}
                  >
                    Save Provider Settings
                  </button>
                </div>
              </div>
            )}

            {/* TAB 3: AGENTS & HARDWARE GOVERNOR (Lists ONLY Installed Models) */}
            {settingsTab === "agents" && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.85rem",
                }}
              >
                {hwSpecs && (
                  <div className="hw-spec-box">
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <div>
                        <strong>
                          ðŸ–¥ {hwSpecs.governor_tier} ({hwSpecs.available_ram_gb}{" "}
                          GB Free / {hwSpecs.total_ram_gb} GB RAM â€¢{" "}
                          {hwSpecs.cpu_cores} Cores)
                        </strong>
                        <div
                          style={{
                            color: "var(--text-secondary)",
                            marginTop: "0.2rem",
                          }}
                        >
                          {hwSpecs.governor_advice}
                        </div>
                      </div>
                      <button
                        className="btn btn-primary"
                        onClick={handleAutoAssignOptimalModels}
                      >
                        âœ¨ Auto-Assign Installed Models
                      </button>
                    </div>
                  </div>
                )}

                {ollamaModels.length === 0 ? (
                  <div className="hw-spec-box">
                    <div style={{ color: "var(--oxide-ember)", fontWeight: 600 }}>
                      No Local Models Installed Yet
                    </div>
                    <div>
                      Install at least one model in the Model Store to assign
                      Agent and Subagent models.
                    </div>
                    <div>
                      <button
                        className="btn btn-primary"
                        onClick={() => {
                          setShowSettingsModal(false);
                          setShowModelHubModal(true);
                        }}
                      >
                        ðŸ§  Open Model Store
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="routing-grid">
                    <div className="form-group">
                      <label>ðŸ§  Main Agent (Lead Architect)</label>
                      <select
                        className="select-control"
                        value={
                          providerConfig.task_routing.architect_model ||
                          ollamaModels[0]
                        }
                        onChange={(e) =>
                          setProviderConfig({
                            ...providerConfig,
                            ollama_model: e.target.value,
                            task_routing: {
                              ...providerConfig.task_routing,
                              architect_model: e.target.value,
                            },
                          })
                        }
                      >
                        {ollamaModels.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="form-group">
                      <label>ðŸ’» Coder Subagent (Fast File Edits)</label>
                      <select
                        className="select-control"
                        value={
                          providerConfig.task_routing.coder_subagent_model ||
                          ollamaModels[0]
                        }
                        onChange={(e) =>
                          setProviderConfig({
                            ...providerConfig,
                            task_routing: {
                              ...providerConfig.task_routing,
                              coder_subagent_model: e.target.value,
                            },
                          })
                        }
                      >
                        {ollamaModels.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="form-group">
                      <label>ðŸ” Research Subagent (Fast Search)</label>
                      <select
                        className="select-control"
                        value={
                          providerConfig.task_routing.research_subagent_model ||
                          ollamaModels[0]
                        }
                        onChange={(e) =>
                          setProviderConfig({
                            ...providerConfig,
                            task_routing: {
                              ...providerConfig.task_routing,
                              research_subagent_model: e.target.value,
                            },
                          })
                        }
                      >
                        {ollamaModels.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="form-group">
                      <label>
                        Max Concurrent Subagents ({providerConfig.max_concurrent_subagents} Active Workers)
                      </label>
                      <input
                        type="range"
                        min="1"
                        max={16}
                        value={providerConfig.max_concurrent_subagents}
                        onChange={(e) =>
                          setProviderConfig({
                            ...providerConfig,
                            max_concurrent_subagents: parseInt(
                              e.target.value,
                              10
                            ),
                          })
                        }
                      />
                    </div>
                  </div>
                )}

                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: "0.5rem",
                  }}
                >
                  <button
                    className="btn btn-primary"
                    onClick={async () => {
                      const saved = await oxideBridge.updateProviderConfig(
                        providerConfig
                      );
                      setProviderConfig(saved);
                      setStatusBanner("Saved Agent & Subagent routing.");
                    }}
                  >
                    Save Agent Settings
                  </button>
                </div>
              </div>
            )}

            {/* TAB 4: MCP SERVERS */}
            {settingsTab === "mcp" && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.75rem",
                }}
              >
                {mcpServers.map((srv) => (
                  <div
                    key={srv.id}
                    style={{
                      background: "var(--bg-elevated)",
                      padding: "0.7rem",
                      borderRadius: 8,
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <div>
                      <strong>{srv.name}</strong>{" "}
                      <code style={{ fontSize: "0.72rem" }}>({srv.id})</code>
                      <div
                        style={{
                          fontSize: "0.72rem",
                          color: "var(--text-secondary)",
                        }}
                      >
                        Tools discovered: {srv.discovered_tools.length} â€¢
                        Status: {srv.status}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: "0.4rem" }}>
                      <button
                        className="btn"
                        onClick={async () => {
                          await oxideBridge.discoverMcpTools(srv.id);
                          setMcpServers(await oxideBridge.listMcpServers());
                        }}
                      >
                        Discover Tools
                      </button>
                      <button
                        className={`btn ${srv.enabled ? "btn-primary" : ""}`}
                        onClick={async () => {
                          const list = await oxideBridge.saveMcpServer({
                            ...srv,
                            enabled: !srv.enabled,
                          });
                          setMcpServers(list);
                        }}
                      >
                        {srv.enabled ? "Enabled" : "Disabled"}
                      </button>
                    </div>
                  </div>
                ))}

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr 1.4fr auto",
                    gap: "0.45rem",
                  }}
                >
                  <input
                    className="workspace-input"
                    placeholder="Server ID (e.g. memory)"
                    value={newMcpId}
                    onChange={(e) => setNewMcpId(e.target.value)}
                  />
                  <input
                    className="workspace-input"
                    placeholder="Command (e.g. npx)"
                    value={newMcpCommand}
                    onChange={(e) => setNewMcpCommand(e.target.value)}
                  />
                  <input
                    className="workspace-input"
                    placeholder="Args (e.g. -y @modelcontextprotocol/server-memory)"
                    value={newMcpArgs}
                    onChange={(e) => setNewMcpArgs(e.target.value)}
                  />
                  <button
                    className="btn btn-primary"
                    onClick={async () => {
                      if (!newMcpId.trim()) return;
                      const list = await oxideBridge.saveMcpServer({
                        id: newMcpId.trim(),
                        name: newMcpId.trim(),
                        transport: "stdio",
                        command: newMcpCommand.trim(),
                        args: newMcpArgs.split(/\s+/).filter(Boolean),
                        env: {},
                        url: null,
                        enabled: true,
                        status: "configured",
                        discovered_tools: [],
                      });
                      setMcpServers(list);
                      setNewMcpId("");
                    }}
                  >
                    + Add
                  </button>
                </div>
              </div>
            )}

            {/* TAB 5: UPDATES & ABOUT */}
            {settingsTab === "updates" && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.85rem",
                }}
              >
                <div className="hw-spec-box">
                  <div>
                    Installed Version:{" "}
                    <code>{updateStatus?.current_version || "v0.1.0"}</code>
                  </div>
                  <div>
                    Latest on GitHub:{" "}
                    <code>
                      {updateStatus?.latest_version || "Checking..."}
                    </code>
                  </div>
                  {updateStatus?.latest_commit_message && (
                    <div>
                      Latest Commit: {updateStatus.latest_commit_message}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <button
                    className="btn"
                    onClick={async () => {
                      const st = await oxideBridge.checkGithubUpdate();
                      setUpdateStatus(st);
                    }}
                  >
                    Check for Updates
                  </button>
                  <button
                    className="btn btn-primary"
                    disabled={isUpdating}
                    onClick={async () => {
                      setIsUpdating(true);
                      try {
                        const res = await oxideBridge.performGithubUpdate();
                        setStatusBanner(res.message);
                      } catch (err: any) {
                        setStatusBanner(`Update error: ${err?.message || String(err)}`);
                      } finally {
                        setIsUpdating(false);
                      }
                    }}
                  >
                    {isUpdating ? "Updating (Auto-replaces old version)..." : "Install Latest Update"}
                  </button>
                </div>

                {updateDownloadProgress && (
                  <div style={{ marginTop: "0.5rem" }}>
                    <div className="oxide-progress-track">
                      <div
                        className="oxide-progress-fill"
                        style={{ width: `${updateDownloadProgress.percent}%` }}
                      />
                    </div>
                    <div style={{ fontSize: "0.74rem", color: "var(--text-secondary)", marginTop: "0.25rem" }}>
                      {updateDownloadProgress.status}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ==================== SUBAGENT ARCHITECTURE & DELEGATION MODAL ==================== */}
      {showSubagentsGuide && (
        <div
          className="modal-backdrop"
          onClick={() => setShowSubagentsGuide(false)}
        >
          <div
            className="model-hub-card"
            style={{ width: "780px", maxHeight: "88vh", overflowY: "auto" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                borderBottom: "1px solid var(--border-subtle)",
                paddingBottom: "0.6rem",
              }}
            >
              <div>
                <h3 style={{ margin: 0, display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <span>🤖</span>
                  <span>Oxide Multi-Agent Architecture</span>
                </h3>
                <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: "0.2rem" }}>
                  Lead Architect executive reasoning &amp; specialized subagent delegation
                </div>
              </div>
              <button
                className="btn"
                onClick={() => setShowSubagentsGuide(false)}
              >
                ✕ Close
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "1rem", marginTop: "1rem" }}>
              {/* How it works banner */}
              <div
                style={{
                  background: "rgba(242, 108, 58, 0.08)",
                  border: "1px solid rgba(242, 108, 58, 0.3)",
                  borderRadius: "8px",
                  padding: "0.75rem 1rem",
                  fontSize: "0.78rem",
                  lineHeight: 1.5,
                }}
              >
                <strong>🧠 How Subagent Delegation Works in Oxide:</strong>
                <p style={{ margin: "0.35rem 0 0" }}>
                  Complex coding tasks overwhelm single-threaded LLMs with context pollution and hallucination. In Oxide, your <strong>Lead Architect</strong> reasons deeply inside <code>&lt;think&gt;</code> tags, breaks down the user request into concrete subtasks, and issues parallel orders to <strong>Specialized Subagents</strong>.
                </p>
              </div>

              {/* Roles Breakdown */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "0.75rem",
                }}
              >
                <div className="hw-spec-box" style={{ background: "rgba(255, 255, 255, 0.02)", border: "1px solid rgba(242, 108, 58, 0.3)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 600, color: "var(--oxide-ember)" }}>
                    <span>👑 Lead Architect (Main Agent)</span>
                  </div>
                  <div style={{ fontSize: "0.73rem", color: "var(--text-secondary)", marginTop: "0.3rem", lineHeight: 1.4 }}>
                    Analyzes user requests, forms multi-step plans, reasons about architecture, and synthesizes final deliverables. Emits <code>delegate_subagents</code> tool calls to trigger subagents.
                  </div>
                  <div style={{ fontSize: "0.7rem", marginTop: "0.5rem", color: "#fde047" }}>
                    Active Model: <code>{providerConfig.task_routing.architect_model || providerConfig.ollama_model}</code>
                  </div>
                </div>

                <div className="hw-spec-box" style={{ background: "rgba(255, 255, 255, 0.02)", border: "1px solid rgba(96, 165, 250, 0.3)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 600, color: "#60a5fa" }}>
                    <span>⚡ Coder Subagent</span>
                  </div>
                  <div style={{ fontSize: "0.73rem", color: "var(--text-secondary)", marginTop: "0.3rem", lineHeight: 1.4 }}>
                    Specialized in granular code mutations (<code>write_file</code>, <code>replace_in_file</code>). Performs fast, clean code edits across files concurrently without distracting the Lead Architect.
                  </div>
                  <div style={{ fontSize: "0.7rem", marginTop: "0.5rem", color: "#60a5fa" }}>
                    Active Model: <code>{providerConfig.task_routing.coder_subagent_model || providerConfig.ollama_model}</code>
                  </div>
                </div>

                <div className="hw-spec-box" style={{ background: "rgba(255, 255, 255, 0.02)", border: "1px solid rgba(167, 139, 250, 0.3)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 600, color: "#a78bfa" }}>
                    <span>🔍 Research Subagent</span>
                  </div>
                  <div style={{ fontSize: "0.73rem", color: "var(--text-secondary)", marginTop: "0.3rem", lineHeight: 1.4 }}>
                    Fast read-only exploration. Traverses project files, parses symbols, and checks dependencies using <code>search_codebase</code> and <code>read_file</code> to verify facts before changes.
                  </div>
                  <div style={{ fontSize: "0.7rem", marginTop: "0.5rem", color: "#a78bfa" }}>
                    Active Model: <code>{providerConfig.task_routing.research_subagent_model || providerConfig.ollama_model}</code>
                  </div>
                </div>

                <div className="hw-spec-box" style={{ background: "rgba(255, 255, 255, 0.02)", border: "1px solid rgba(52, 211, 153, 0.3)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 600, color: "#34d399" }}>
                    <span>🧪 Tester Subagent</span>
                  </div>
                  <div style={{ fontSize: "0.73rem", color: "var(--text-secondary)", marginTop: "0.3rem", lineHeight: 1.4 }}>
                    Executes test suites (<code>cargo test</code>, <code>npm test</code>, linters), parses terminal compiler errors, and reports exact diagnostics back to the Lead Architect.
                  </div>
                  <div style={{ fontSize: "0.7rem", marginTop: "0.5rem", color: "#34d399" }}>
                    Active Model: <code>{providerConfig.task_routing.tester_subagent_model || providerConfig.ollama_model}</code>
                  </div>
                </div>
              </div>

              {/* Multi-Agent Toggle */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "0.75rem",
                  background: "var(--bg-elevated)",
                  borderRadius: "8px",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>
                    Multi-Agent Delegation Status
                  </div>
                  <div style={{ fontSize: "0.73rem", color: "var(--text-secondary)" }}>
                    {providerConfig.enable_subagents
                      ? "Enabled — Lead Architect delegates subtasks to parallel subagents."
                      : "Disabled — Lead Architect handles all steps in a single thread."}
                  </div>
                </div>
                <button
                  className={`btn ${providerConfig.enable_subagents ? "btn-primary" : ""}`}
                  onClick={async () => {
                    const updated = {
                      ...providerConfig,
                      enable_subagents: !providerConfig.enable_subagents,
                    };
                    setProviderConfig(updated);
                    await oxideBridge.updateProviderConfig(updated);
                    setStatusBanner(
                      updated.enable_subagents
                        ? "Enabled Multi-Agent Delegation."
                        : "Disabled Multi-Agent Delegation."
                    );
                  }}
                >
                  {providerConfig.enable_subagents ? "✓ Enabled" : "Enable Multi-Agent"}
                </button>
              </div>

              {/* Slash Command Hint */}
              <div style={{ fontSize: "0.74rem", color: "var(--text-muted)" }}>
                💡 <strong>Tip:</strong> You can type <code>/subagents &lt;your request&gt;</code> in chat to explicitly demand multi-agent delegation, or <code>/plan</code> to have the Lead Architect draft a breakdown before execution.
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
