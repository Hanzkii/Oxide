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
    return repo.length > 20 ? repo.slice(0, 18) + "..." : repo;
  }
  if (modelId.includes(":")) {
    const clean = modelId.replace(":latest", "");
    return clean.length > 20 ? clean.slice(0, 18) + "..." : clean;
  }
  return modelId.length > 20 ? modelId.slice(0, 18) + "..." : modelId;
}

function getStepIcon(title: string): string {
  const t = title.toLowerCase();
  if (t.includes("read") || t.includes("search") || t.includes("list")) return "[Search]";
  if (t.includes("wrote") || t.includes("write") || t.includes("edit") || t.includes("modify")) return "[Edit]";
  if (t.includes("command") || t.includes("execut") || t.includes("terminal")) return ">";
  if (t.includes("git") || t.includes("commit") || t.includes("push") || t.includes("pull")) return "[Git]";
  if (t.includes("subagent") || t.includes("delegat") || t.includes("worker")) return "[Subagent]";
  if (t.includes("mcp") || t.includes("tool")) return "[MCP]";
  return "[File]";
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

  // Oxide Native Engine State (Standalone llama.cpp & GGUF models)
  const [nativeModels, setNativeModels] = useState<string[]>([]);
  const [nativeOnline, setNativeOnline] = useState<boolean>(false);
  const [nativeInstalled, setNativeInstalled] = useState<boolean>(false);
  const [isStartingNative, setIsStartingNative] = useState<boolean>(false);

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
  const [selectedSlashIndex, setSelectedSlashIndex] = useState<number>(0);

  // Deletion Confirmation Modal State
  const [confirmDelete, setConfirmDelete] = useState<{
    type: string;
    name: string;
    onConfirm: () => Promise<void> | void;
  } | null>(null);

  // Open Folder & Workspace Navigation Modal State
  const [showOpenFolderModal, setShowOpenFolderModal] = useState<boolean>(false);
  const [folderPathInput, setFolderPathInput] = useState<string>("");

  // Create New File / Folder Modal State
  const [createItemModal, setCreateItemModal] = useState<{
    isOpen: boolean;
    type: "file" | "folder";
    name: string;
  } | null>(null);

  // API Key & Connection Testing State
  const [showApiKeys, setShowApiKeys] = useState<{
    anthropic: boolean;
    openai: boolean;
    gemini: boolean;
    deepseek: boolean;
  }>({ anthropic: false, openai: false, gemini: false, deepseek: false });
  const [testConnStatus, setTestConnStatus] = useState<{
    testing: boolean;
    success?: boolean;
    message?: string;
  }>({ testing: false });
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
      setNativeOnline(Boolean(health.oxide_native_running));
      setNativeInstalled(Boolean(health.oxide_native_installed));
      setNativeModels(health.oxide_native_models || []);

      const nativeList = health.oxide_native_models || [];
      const ollamaList = health.ollama_models || [];
      const allInstalledLocal = Array.from(new Set([...nativeList, ...ollamaList]));
      setNativeModels(nativeList);
      setOllamaModels(allInstalledLocal);

      setProviderConfig((prev) => {
        const merged = {
          ...prev,
          ...health.config,
          task_routing: {
            ...prev.task_routing,
            ...(health.config.task_routing || {}),
          },
        };
        // Auto-heal local models if using local engine
        if (allInstalledLocal.length > 0) {
          if (!merged.ollama_model || !allInstalledLocal.includes(merged.ollama_model)) {
            merged.ollama_model = allInstalledLocal[0];
          }
          if (!merged.task_routing.architect_model) {
            merged.task_routing.architect_model = allInstalledLocal[0];
          }
          if (!merged.task_routing.coder_subagent_model) {
            merged.task_routing.coder_subagent_model =
              allInstalledLocal[allInstalledLocal.length - 1] || allInstalledLocal[0];
          }
          if (!merged.task_routing.research_subagent_model) {
            merged.task_routing.research_subagent_model =
              allInstalledLocal[allInstalledLocal.length - 1] || allInstalledLocal[0];
          }
          if (!merged.task_routing.tester_subagent_model) {
            merged.task_routing.tester_subagent_model =
              allInstalledLocal[allInstalledLocal.length - 1] || allInstalledLocal[0];
          }
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

  const openWorkspaceDirectory = async (folderPath: string) => {
    try {
      const cleanPath = folderPath.trim();
      if (!cleanPath) return;

      const info = await oxideBridge.setWorkspace(cleanPath);
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
      setShowOpenFolderModal(false);
    } catch (err: any) {
      setStatusBanner(`Folder error: ${err?.message || String(err)}`);
    }
  };

  const handlePickProjectFolder = () => {
    const active = projects.find((p) => p.id === activeProjectId);
    setFolderPathInput(active?.path || "");
    setShowOpenFolderModal(true);
  };

  const handleBrowseWithWindowsExplorer = async () => {
    try {
      setStatusBanner("Opening Windows Explorer folder picker...");
      const picked = await oxideBridge.pickFolderDialog();
      if (picked?.trim()) {
        await openWorkspaceDirectory(picked.trim());
      }
    } catch (err: any) {
      setStatusBanner(`Picker error: ${err?.message || String(err)}`);
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

  const handleDeleteProject = (
    e: React.MouseEvent,
    projectId: string
  ) => {
    e.stopPropagation();
    const proj = projects.find((p) => p.id === projectId);
    const projName = proj ? proj.name : projectId;
    setConfirmDelete({
      type: "project workspace",
      name: projName,
      onConfirm: async () => {
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
      },
    });
  };

  const handleDeleteConversation = (
    e: React.MouseEvent,
    convId: string
  ) => {
    e.stopPropagation();
    const conv = conversations.find((c) => c.id === convId);
    const convTitle = conv ? conv.title : convId;
    setConfirmDelete({
      type: "conversation",
      name: convTitle,
      onConfirm: async () => {
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
      },
    });
  };

  const handleRunTask = async (customPrompt?: string) => {
    const taskPrompt = (customPrompt ?? prompt).trim();
    if (!taskPrompt || isRunning) return;

    // Validate Provider Prerequisites
    if (providerConfig.active_provider === "anthropic" && !providerConfig.anthropic_api_key) {
      setStatusBanner("Please enter your Anthropic API Key in Settings -> AI Providers first.");
      setSettingsTab("providers");
      setShowSettingsModal(true);
      return;
    }
    if (providerConfig.active_provider === "openai" && !providerConfig.openai_api_key) {
      setStatusBanner("Please enter your OpenAI API Key in Settings -> AI Providers first.");
      setSettingsTab("providers");
      setShowSettingsModal(true);
      return;
    }
    if (providerConfig.active_provider === "gemini" && !providerConfig.gemini_api_key) {
      setStatusBanner("Please enter your Google Gemini API Key in Settings -> AI Providers first.");
      setSettingsTab("providers");
      setShowSettingsModal(true);
      return;
    }
    if (providerConfig.active_provider === "deepseek" && !providerConfig.deepseek_api_key) {
      setStatusBanner("Please enter your DeepSeek API Key in Settings -> AI Providers first.");
      setSettingsTab("providers");
      setShowSettingsModal(true);
      return;
    }
    if (providerConfig.active_provider === "oxide_native" && nativeModels.length === 0) {
      setStatusBanner("No GGUF models installed for Native Engine - install one from Models below.");
      setShowModelHubModal(true);
      return;
    }
    if (providerConfig.active_provider === "ollama" && ollamaModels.length === 0) {
      setStatusBanner("No Ollama models installed yet - install a model from Models below.");
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

  const handleOpenCreateFileModal = () => {
    setCreateItemModal({ isOpen: true, type: "file", name: "" });
  };

  const handleOpenCreateFolderModal = () => {
    setCreateItemModal({ isOpen: true, type: "folder", name: "" });
  };

  const handleConfirmCreateItem = async (type: "file" | "folder", name: string) => {
    const clean = name.trim();
    if (!clean) return;
    try {
      if (type === "file") {
        await oxideBridge.saveWorkspaceFile(clean, "");
        await refreshWorkspaceState(currentDir);
        setActiveFile(clean);
        setActiveFileContent("");
        setRightDrawer("editor");
        setStatusBanner(`Created file '${clean}'`);
      } else {
        await oxideBridge.createWorkspaceFolder(clean);
        await refreshWorkspaceState(currentDir);
        setStatusBanner(`Created folder '${clean}'`);
      }
      setCreateItemModal(null);
    } catch (err: any) {
      setStatusBanner(`Create error: ${err?.message || String(err)}`);
    }
  };

  const handleGitAction = async (op: "pull" | "push" | "commit") => {
    try {
      setStatusBanner(`Running git ${op}...`);
      if (op === "commit") {
        const msg = `feat: update project workspace milestone (${new Date().toLocaleTimeString()})`;
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
      `Assigned Agent: ${mainModel} | Subagent: ${subModel}`
    );
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
              + Folder
            </button>
            <button
              className="ag-icon-btn"
              onClick={() => {
                setRightDrawer("files");
                setShowRightPanel(true);
              }}
              title="Open Explorer"
            >
              [Search]
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
            <span>Explorer</span>
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
            <span>AI Models</span>
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
            <span>Agents &amp; Subagents</span>
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
            <span>MCP Servers</span>
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
                    [Dir] {proj.name}
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
                      x
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
                          {isActive && isRunning ? "..." : conv.updatedAt}
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
                          x
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
            Settings
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
            {updateStatus?.update_available ? "Update Available" : "Updates"}
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
                title={`PC Hardware Specs:\nGPU: ${hwSpecs.gpu_name} (${hwSpecs.gpu_vram_gb} GB VRAM)\nCPU: ${hwSpecs.cpu_brand} (${hwSpecs.cpu_cores} Cores)\nRAM: ${hwSpecs.available_ram_gb} GB Free / ${hwSpecs.total_ram_gb} GB Total\nGovernor Tier: ${hwSpecs.governor_tier}\nClick to configure hardware acceleration & layer offloading.`}
              >
                <span className="hw-pill-gpu">
                  {hwSpecs.gpu_name} {hwSpecs.gpu_vram_gb > 0 ? `(${hwSpecs.gpu_vram_gb}GB)` : ""}
                </span>
                <span className="hw-pill-sep">|</span>
                <span className="hw-pill-ram">
                  RAM: {hwSpecs.available_ram_gb}/{hwSpecs.total_ram_gb}GB
                </span>
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
              AI Models ({ollamaModels.length} Installed)
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
              title="Toggle Right Sidebar Drawer"
            >
              Sidebar
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
                            No Local AI Model Installed Yet
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
                              Open Models (1-Click Install)
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
                          Open Folder...
                        </button>
                        <button
                          className="ag-pill-btn"
                          onClick={() => setShowModelHubModal(true)}
                        >
                          AI Models ({ollamaModels.length} Installed)
                        </button>
                        <button
                          className="ag-pill-btn"
                          onClick={() => {
                            setRightDrawer("files");
                            setShowRightPanel(true);
                          }}
                        >
                          Explorer ({files.length})
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
                        <span style={{ fontSize: "0.9rem" }}>[AI]</span>
                        <span style={{ fontWeight: 600 }}>
                          {liveMetrics.phase === "reasoning" ? "Deep Reasoning" : "Executing Code"}
                        </span>
                        <span>|</span>
                        <span>Turn Step {liveMetrics.step}</span>
                        <span>|</span>
                        <span className="oxide-token-speed">
                           {liveMetrics.tokens_generated} tokens ({liveMetrics.tokens_per_second.toFixed(1)} tok/s)
                        </span>
                        {liveMetrics.gpu_layers && liveMetrics.gpu_layers > 0 && (
                          <>
                            <span>|</span>
                            <span style={{ color: "#34d399", fontWeight: 600 }}>
                              GPU: {liveMetrics.gpu_layers} layers
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
                            {isExpanded ? "v" : ">"}
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
                          Thinking... {liveThoughtExpanded ? "v" : ">"}
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
                          <span className="ag-tool-step-icon">&gt;</span>
                          <span className="ag-tool-step-label">
                            [{sub.role.toUpperCase()}] {sub.title}
                          </span>
                          <span className="ag-tool-step-badge">
                            {sub.model} | {sub.state}
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
              {statusBanner && (
                <div className="ag-composer-status-banner">
                  <span>{statusBanner}</span>
                  <button
                    type="button"
                    className="status-dismiss"
                    onClick={() => setStatusBanner("")}
                  >
                    x
                  </button>
                </div>
              )}

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
                      <span>/ Slash Commands</span>
                      <span>Tab / Enter to select | Esc to dismiss</span>
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
                  {/* Left: Model Pill & Subagent Pill */}
                  <div className="ag-toolbar-left">
                    {/* Main Agent Pill */}
                    <div className="ag-pill-container" title="Select Lead Architect Model">
                      <span className="ag-pill-label">Agent:</span>
                      {["anthropic", "openai", "gemini", "deepseek"].includes(providerConfig.active_provider) ? (
                        <button
                          className="ag-pill-select"
                          style={{ color: "#60a5fa", fontWeight: 600 }}
                          onClick={() => {
                            setSettingsTab("providers");
                            setShowSettingsModal(true);
                          }}
                          title={`Cloud Model (${providerConfig.active_provider.toUpperCase()}) - Click to configure`}
                        >
                          {providerConfig.active_provider === "anthropic" && (providerConfig.anthropic_model || "Claude 3.5 Sonnet")}
                          {providerConfig.active_provider === "openai" && (providerConfig.openai_model || "GPT-4o")}
                          {providerConfig.active_provider === "gemini" && (providerConfig.gemini_model || "Gemini 2.0 Flash")}
                          {providerConfig.active_provider === "deepseek" && (providerConfig.deepseek_model || "DeepSeek-V3")}
                        </button>
                      ) : ollamaModels.length > 0 ? (
                        <select
                          className="ag-pill-select"
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
                            <option key={m} value={m} title={m}>
                              {formatModelDisplayName(m)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <button
                          className="ag-pill-select"
                          onClick={() => setShowModelHubModal(true)}
                        >
                          + Install Model
                        </button>
                      )}
                    </div>

                    {/* Subagents Pill */}
                    <div
                      className={`ag-pill-container ${
                        providerConfig.enable_subagents ? "active-subagent" : ""
                      }`}
                      title="Subagents: click label to configure roles"
                    >
                      <span
                        className="ag-pill-label clickable"
                        onClick={() => setShowSubagentsGuide(true)}
                      >
                        Subagent:
                      </span>
                      {ollamaModels.length > 0 ? (
                        <select
                          className="ag-pill-select"
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
                            <option key={m} value={m} title={m}>
                              {formatModelDisplayName(m)}
                            </option>
                          ))}
                          <option value="__off__">Off</option>
                        </select>
                      ) : (
                        <span className="ag-pill-value">Off</span>
                      )}
                    </div>

                    {/* Models Store Button */}
                    <button
                      type="button"
                      className="ag-toolbar-icon-btn"
                      onClick={() => setShowModelHubModal(true)}
                      title="Install & manage AI models"
                    >
                      + Models
                    </button>
                  </div>

                  {/* Right: Security Mode & Send Button */}
                  <div className="ag-toolbar-right">
                    {/* Security Review Mode Dropdown */}
                    <div className="oxide-security-wrapper">
                      <button
                        type="button"
                        className="oxide-security-btn"
                        onClick={() => setShowSecurityMenu((v) => !v)}
                        title="Command Execution Security Mode"
                      >
                        <span>
                          {providerConfig.security_mode === "request_review"
                            ? "Review"
                            : providerConfig.security_mode === "default"
                            ? "Default"
                            : providerConfig.security_mode === "auto"
                            ? "Auto"
                            : "Turbo"}
                        </span>
                        <span style={{ fontSize: "0.62rem", color: "var(--text-muted)" }}>
                          {showSecurityMenu ? "^" : "v"}
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
                              providerConfig.security_mode === "request_review"
                                ? "active"
                                : ""
                            }`}
                            onClick={async () => {
                              const updated: ProviderConfig = {
                                ...providerConfig,
                                security_mode: "request_review",
                              };
                              setProviderConfig(updated);
                              setShowSecurityMenu(false);
                              await oxideBridge.updateProviderConfig(updated);
                              setStatusBanner("Execution mode: Request Review");
                            }}
                          >
                            <div className="oxide-security-item-body">
                              <span className="oxide-security-item-title">
                                Request Review
                              </span>
                              <span className="oxide-security-item-desc">
                                Every command requires approval.
                              </span>
                            </div>
                            {providerConfig.security_mode ===
                              "request_review" && (
                              <span className="oxide-security-item-check">OK</span>
                            )}
                          </button>

                          <button
                            type="button"
                            className={`oxide-security-item ${
                              providerConfig.security_mode === "default"
                                ? "active"
                                : ""
                            }`}
                            onClick={async () => {
                              const updated: ProviderConfig = {
                                ...providerConfig,
                                security_mode: "default",
                              };
                              setProviderConfig(updated);
                              setShowSecurityMenu(false);
                              await oxideBridge.updateProviderConfig(updated);
                              setStatusBanner("Execution mode: Default");
                            }}
                          >
                            <div className="oxide-security-item-body">
                              <span className="oxide-security-item-title">
                                Default
                              </span>
                              <span className="oxide-security-item-desc">
                                Ask before sensitive operations.
                              </span>
                            </div>
                            {providerConfig.security_mode === "default" && (
                              <span className="oxide-security-item-check">OK</span>
                            )}
                          </button>

                          <button
                            type="button"
                            className={`oxide-security-item ${
                              providerConfig.security_mode === "auto"
                                ? "active"
                                : ""
                            }`}
                            onClick={async () => {
                              const updated: ProviderConfig = {
                                ...providerConfig,
                                security_mode: "auto",
                              };
                              setProviderConfig(updated);
                              setShowSecurityMenu(false);
                              await oxideBridge.updateProviderConfig(updated);
                              setStatusBanner("Execution mode: Auto (Preview)");
                            }}
                          >
                            <div className="oxide-security-item-body">
                              <span className="oxide-security-item-title">
                                Auto (Preview)
                              </span>
                              <span className="oxide-security-item-desc">
                                Automatically decide if commands run.
                              </span>
                            </div>
                            {providerConfig.security_mode === "auto" && (
                              <span className="oxide-security-item-check">OK</span>
                            )}
                          </button>

                          <button
                            type="button"
                            className={`oxide-security-item ${
                              providerConfig.security_mode === "turbo" ||
                              !providerConfig.security_mode
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
                              setStatusBanner("Execution mode: Turbo (Fast)");
                            }}
                          >
                            <div className="oxide-security-item-body">
                              <span className="oxide-security-item-title">
                                Turbo
                              </span>
                              <span className="oxide-security-item-desc">
                                Run all commands without restrictions.
                              </span>
                            </div>
                            {(providerConfig.security_mode === "turbo" ||
                              !providerConfig.security_mode) && (
                              <span className="oxide-security-item-check">OK</span>
                            )}
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Send Button */}
                    <button
                      type="button"
                      className="ag-composer-send-btn"
                      disabled={isRunning || !prompt.trim()}
                      onClick={() => handleRunTask()}
                      title="Send Prompt (Enter)"
                    >
                      -&gt;
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
                    <span>Source Control</span>
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
                    <span>Explorer</span>
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
                    <span>MCP Servers</span>
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
                      Switch Workspace Folder...
                    </button>
                    <button
                      className="btn"
                      onClick={() => setRightDrawer("files")}
                      style={{ justifyContent: "center" }}
                    >
                      Browse Explorer ({files.length})
                    </button>
                    <button
                      className="btn"
                      onClick={() => setShowModelHubModal(true)}
                      style={{ justifyContent: "center" }}
                    >
                      Open Models ({ollamaModels.length} Installed)
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
                          Root
                        </button>
                      )}
                      <button
                        className="btn"
                        style={{ padding: "0.18rem 0.45rem" }}
                        onClick={handleOpenCreateFileModal}
                        title="Create new file in workspace"
                      >
                        + File
                      </button>
                      <button
                        className="btn"
                        style={{ padding: "0.18rem 0.45rem" }}
                        onClick={handleOpenCreateFolderModal}
                        title="Create new folder in workspace"
                      >
                        + Folder
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
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          cursor: "pointer",
                        }}
                        onClick={() => handleOpenFileOrDir(entry)}
                      >
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                          {entry.is_dir ? "[Dir]" : "[File]"} {entry.name}
                        </span>
                        <button
                          type="button"
                          className="status-dismiss"
                          style={{
                            padding: "0 0.35rem",
                            fontSize: "0.75rem",
                            color: "var(--text-muted)",
                            opacity: 0.6,
                          }}
                          title={`Delete ${entry.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmDelete({
                              type: entry.is_dir ? "folder" : "file",
                              name: entry.name,
                              onConfirm: async () => {
                                await oxideBridge.deleteWorkspaceFile(entry.relative_path);
                                setFiles(await oxideBridge.listWorkspaceFiles(currentDir));
                                setStatusBanner(`Deleted ${entry.name}`);
                              },
                            });
                          }}
                        >
                          x
                        </button>
                      </div>
                    ))}
                    {files.length === 0 && (
                      <div style={{ fontSize: "0.76rem", color: "var(--text-muted)", padding: "1rem", textAlign: "center" }}>
                        Workspace folder is empty. Click <strong>+ File</strong> above to create a file.
                      </div>
                    )}
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
                        &lt; Files
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
                        Pull
                      </button>
                      <button
                        className="btn"
                        onClick={() => handleGitAction("commit")}
                      >
                        Commit
                      </button>
                      <button
                        className="btn btn-primary"
                        onClick={() => handleGitAction("push")}
                      >
                        Push
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
                  AI Models &amp; Direct GGUF Installer
                </h3>
                <div
                  style={{
                    fontSize: "0.78rem",
                    color: "var(--text-secondary)",
                    marginTop: "0.2rem",
                  }}
                >
                  Direct 1-Click download to your Oxide library | Standalone execution on AMD Radeon &amp; CPU
                </div>
              </div>
              <button
                className="btn"
                onClick={() => setShowModelHubModal(false)}
              >
                Close
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
                  Detected PC Specs:{" "}
                  <span style={{ color: "var(--oxide-ember)" }}>
                    {hwSpecs
                      ? `${hwSpecs.total_ram_gb} GB RAM (${hwSpecs.available_ram_gb} GB free) | ${hwSpecs.gpu_name}${
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
                  Native Engine:{" "}
                  <strong
                    style={{
                      color: nativeOnline ? "#4ade80" : "#60a5fa",
                    }}
                  >
                    {nativeOnline
                      ? `Online (Port ${providerConfig.oxide_native_port || 11435})`
                      : nativeInstalled
                      ? "Ready (AMD Vulkan & CPU)"
                      : "Installed"}
                  </strong>
                  {" | "}
                  Library: <strong>{nativeModels.length} GGUF models</strong>
                  {" | "}
                  Agent:{" "}
                  <code>
                    {providerConfig.task_routing.architect_model || "None"}
                  </code>
                  {" | "}
                  Subagent:{" "}
                  <code>
                    {providerConfig.task_routing.coder_subagent_model || "None"}
                  </code>
                </div>
              </div>

              <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap" }}>
                <button
                  className="btn"
                  onClick={() => oxideBridge.openNativeModelsFolder()}
                  title="Open folder where .gguf models are stored on disk"
                >
                  Open Models Folder
                </button>
                {!nativeOnline && nativeModels.length > 0 && (
                  <button
                    className="btn btn-primary"
                    onClick={async () => {
                      const chosen = providerConfig.oxide_native_model || nativeModels[0];
                      await oxideBridge.startNativeEngine(chosen);
                      await refreshWorkspaceState();
                      setStatusBanner(`Started Native Engine with ${chosen}!`);
                    }}
                  >
                    Start Native Engine
                  </button>
                )}
                {(nativeModels.length > 0 || ollamaModels.length > 0) && (
                  <button
                    className="btn"
                    onClick={handleAutoAssignOptimalModels}
                  >
                    Auto-Assign Installed Models
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
                    ["coding", "Coding"],
                    ["uncensored", "Uncensored"],
                    ["coding_uncensored", "Coding + Uncensored"],
                    ["reasoning", "Reasoning (R1)"],
                    ["subagent", "Fast Subagents"],
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
                    ["ollama", "Ollama"],
                    ["huggingface", "HuggingFace"],
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
                  Fits My PC Only
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
                  ? "Searching HF..."
                  : "Search HuggingFace Live"}
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
                  ? `${(modelProgressMap[customInstallTag.trim()]?.percent ?? 0) > 0 ? `${modelProgressMap[customInstallTag.trim()].percent.toFixed(0)}%` : "..."} Installing...`
                  : "Install Tag"}
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
                  const isInstalled =
                    nativeModels.some(
                      (nm) =>
                        model.install_id.toLowerCase().includes(nm.toLowerCase()) ||
                        nm.toLowerCase().includes(model.params.toLowerCase()) ||
                        nm.toLowerCase().includes(model.name.split(" ")[0].toLowerCase())
                    ) ||
                    ollamaModels.some(
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
                                ? "HuggingFace GGUF"
                                : "Ollama Registry"}{" "}
                              | <code>{model.params}</code> | {model.size_gb} GB
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
                              Coding
                            </span>
                          )}
                          {model.is_uncensored && (
                            <span className="model-badge uncensored">
                              Uncensored
                            </span>
                          )}
                          {model.is_reasoning && (
                            <span className="model-badge reasoning">
                              Reasoning
                            </span>
                          )}
                          {model.is_fast_subagent && (
                            <span className="model-badge subagent">
                              Fast Subagent
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
                                ? `${(modelProgressMap[model.install_id]?.percent ?? 0) > 0 ? `${modelProgressMap[model.install_id].percent.toFixed(0)}%` : "..."} Installing...`
                                : "Install"}
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
                                {isLead ? "[Agent]" : "Set as Agent"}
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
                                  ? "[Subagent]"
                                  : "Set as Subagent"}
                              </button>
                              <button
                                className="btn"
                                title="Uninstall model"
                                onClick={() => {
                                  setConfirmDelete({
                                    type: "AI model",
                                    name: model.name || model.install_id,
                                    onConfirm: async () => {
                                      await oxideBridge.deleteAiModel(
                                        model.install_id
                                      );
                                      await refreshWorkspaceState(currentDir);
                                    },
                                  });
                                }}
                              >
                                Delete
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
              <h3 style={{ margin: 0 }}>Oxide Studio Settings</h3>
              <button
                className="btn"
                onClick={() => setShowSettingsModal(false)}
              >
                Close
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
                  ["general", "General"],
                  ["hardware", "Hardware & Acceleration"],
                  ["security", "Security & Sandbox"],
                  ["providers", "AI Providers"],
                  ["agents", "Agent Routing"],
                  ["mcp", "MCP Servers"],
                  ["updates", "Updates"],
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
                      Open Folder...
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
                      Clear Conversation History
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
                        <strong>[GPU] {hwSpecs.gpu_name}</strong>
                        <div style={{ fontSize: "0.74rem", color: "var(--text-secondary)", marginTop: "0.2rem" }}>
                          {hwSpecs.governor_tier} | {hwSpecs.cpu_brand} ({hwSpecs.cpu_cores} Cores)
                        </div>
                      </div>
                      <span className="hw-fit-badge gpu_fast">
                        [GPU] {hwSpecs.gpu_vram_gb > 0 ? `${hwSpecs.gpu_vram_gb} GB VRAM` : "System GPU"}
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
                      Note: {hwSpecs.governor_advice}
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
                      <option value="hybrid_split">Hybrid Split (Auto-calculate VRAM + System RAM split)</option>
                      <option value="full_gpu">Full GPU (Offload all layers to VRAM - Fastest)</option>
                      <option value="custom_layers">Custom Layers (Use manual slider below)</option>
                      <option value="cpu_only">CPU Only (0 layers on GPU)</option>
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
                          GPU VRAM Offload: {gpuPercent}% (~{effectiveGpuLayers} layers)
                        </span>
                        <span style={{ color: "#60a5fa", fontWeight: 600 }}>
                          System RAM (CPU): {cpuPercent}% (~{Math.max(0, 99 - effectiveGpuLayers)} layers)
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
                        <strong>GPU Layer Offloading (Hybrid Split Inference):</strong> Oxide partitions transformer neural layers across your dedicated GPU VRAM and high-speed System RAM. This enables running heavyweight 14B, 32B, and 70B models that exceed physical VRAM without Out-Of-Memory (OOM) errors.
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
                      <strong style={{ fontSize: "0.88rem" }}>Active Workspace Boundary &amp; Terminal Sandbox</strong>
                      <div style={{ fontSize: "0.74rem", color: "var(--text-secondary)", marginTop: "0.2rem" }}>
                        Restricts AI tools, file mutations, and terminal executions strictly to your active project folder
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                      <span style={{ fontSize: "0.75rem", fontWeight: 600, color: providerConfig.enforce_workspace_sandbox !== false ? "#4ade80" : "var(--text-muted)" }}>
                        {providerConfig.enforce_workspace_sandbox !== false ? "Sandbox Active" : "Sandbox Disabled"}
                      </span>
                      <label className="ag-switch" title="Toggle Workspace Sandbox">
                        <input
                          type="checkbox"
                          checked={providerConfig.enforce_workspace_sandbox !== false}
                          onChange={(e) =>
                            setProviderConfig({
                              ...providerConfig,
                              enforce_workspace_sandbox: e.target.checked,
                            })
                          }
                        />
                        <span className="ag-switch-slider" />
                      </label>
                    </div>
                  </div>
                  <div style={{ marginTop: "0.5rem", fontSize: "0.76rem", color: "var(--text-secondary)" }}>
                    Jailed Root: <code>{activeProject?.path}</code>
                  </div>
                  <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: "0.35rem", lineHeight: 1.4 }}>
                    When enabled, Oxide canonicalizes all target paths and enforces strict boundary checks. Any attempt to traverse (<code>..</code>), access root/system directories, or escape the project folder is blocked. Terminal command executions are strictly limited to the permitted developer CLI binaries configured below.
                  </div>
                </div>

                {/* Model Internet & Web Access */}
                <div className="hw-spec-box">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <strong style={{ fontSize: "0.88rem" }}>Model Internet Access &amp; Web Search</strong>
                      <div style={{ fontSize: "0.74rem", color: "var(--text-secondary)", marginTop: "0.2rem" }}>
                        Allows the AI model to search the web and fetch documentation from online URLs
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                      <span style={{ fontSize: "0.75rem", fontWeight: 600, color: providerConfig.allow_internet_access ? "#4ade80" : "var(--text-muted)" }}>
                        {providerConfig.allow_internet_access ? "Internet Allowed" : "Offline / Air-Gapped"}
                      </span>
                      <label className="ag-switch" title="Toggle Model Internet Access">
                        <input
                          type="checkbox"
                          checked={Boolean(providerConfig.allow_internet_access)}
                          onChange={(e) =>
                            setProviderConfig({
                              ...providerConfig,
                              allow_internet_access: e.target.checked,
                            })
                          }
                        />
                        <span className="ag-switch-slider" />
                      </label>
                    </div>
                  </div>
                  <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: "0.4rem", lineHeight: 1.4 }}>
                    {providerConfig.allow_internet_access
                      ? "The Lead Architect and subagents can use web_search and fetch_web_url to inspect documentation, public API references, and open-source repositories."
                      : "The AI is completely cut off from external network connections and operates in 100% offline air-gapped mode."}
                  </div>
                </div>

                {/* Autonomous Execution & Review Mode */}
                <div className="hw-spec-box">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.4rem" }}>
                    <div>
                      <strong style={{ fontSize: "0.88rem" }}>Command Execution &amp; Review Mode</strong>
                      <div style={{ fontSize: "0.74rem", color: "var(--text-secondary)", marginTop: "0.2rem" }}>
                        Choose whether the AI runs terminal commands and file edits autonomously or prompts for review
                      </div>
                    </div>
                  </div>
                  <select
                    className="select-control"
                    style={{ width: "100%", marginTop: "0.2rem" }}
                    value={providerConfig.security_mode || "turbo"}
                    onChange={(e) =>
                      setProviderConfig({
                        ...providerConfig,
                        security_mode: e.target.value as SecurityReviewMode,
                      })
                    }
                  >
                    <option value="turbo">Turbo (Run all commands and edits autonomously without prompt)</option>
                    <option value="auto">Auto / Preview (Automatically evaluate command safety before running)</option>
                    <option value="default">Default (Prompt for confirmation before sensitive or destructive operations)</option>
                    <option value="request_review">Request Review (Every command and edit requires approval)</option>
                  </select>
                </div>

                {/* Allowed Terminal Binaries */}
                <div className="hw-spec-box">
                  <div style={{ fontWeight: 600, fontSize: "0.82rem" }}>
                    Permitted Developer CLI Binaries
                  </div>
                  <div style={{ fontSize: "0.72rem", color: "var(--text-secondary)", marginTop: "0.2rem" }}>
                    When Sandbox is active, terminal commands outside this allowlist are immediately blocked:
                  </div>
                  <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap", marginTop: "0.6rem" }}>
                    {[
                      "cargo",
                      "rustc",
                      "npm",
                      "npx",
                      "node",
                      "git",
                      "python",
                      "pytest",
                      "tsc",
                      "vite",
                    ].map((b) => {
                      const currentList = providerConfig.permitted_terminal_binaries || [
                        "cargo",
                        "rustc",
                        "npm",
                        "npx",
                        "node",
                        "git",
                        "python",
                        "pytest",
                        "tsc",
                        "vite",
                      ];
                      const isAllowed = currentList.includes(b);
                      return (
                        <label
                          key={b}
                          className={`cli-checkbox-pill ${isAllowed ? "active" : ""}`}
                          style={{
                            cursor: "pointer",
                            userSelect: "none",
                            background: isAllowed ? "rgba(242, 108, 58, 0.2)" : "rgba(255, 255, 255, 0.05)",
                            borderColor: isAllowed ? "var(--oxide-ember)" : "rgba(255, 255, 255, 0.15)",
                            color: isAllowed ? "#ff8555" : "var(--text-muted)",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={isAllowed}
                            onChange={(e) => {
                              const next = e.target.checked
                                ? [...currentList, b]
                                : currentList.filter((x) => x !== b);
                              setProviderConfig({
                                ...providerConfig,
                                permitted_terminal_binaries: next,
                              });
                            }}
                          />
                          <span>{b}</span>
                        </label>
                      );
                    })}
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
                      flexWrap: "wrap",
                      gap: "0.5rem",
                    }}
                  >
                    <div>
                      <strong>Engine Status</strong>:{" "}
                      <span
                        style={{
                          color: nativeOnline ? "#4ade80" : "#60a5fa",
                        }}
                      >
                        {nativeOnline
                          ? `Native Engine Running (Port ${providerConfig.oxide_native_port || 11435})`
                          : `Native Engine Ready (${nativeModels.length} GGUF models)`}
                      </span>
                      {ollamaOnline && (
                        <span style={{ fontSize: "0.74rem", color: "var(--text-secondary)", marginLeft: "0.5rem" }}>
                          | Ollama Online ({ollamaModels.length} models)
                        </span>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: "0.4rem" }}>
                      <button
                        className="btn"
                        onClick={() => {
                          setShowSettingsModal(false);
                          setShowModelHubModal(true);
                        }}
                      >
                        Open AI Model Hub
                      </button>
                    </div>
                  </div>
                </div>

                <div className="routing-grid">
                  <div className="form-group" style={{ gridColumn: "1 / -1" }}>
                    <label>Active AI Provider / Inference Engine</label>
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
                      <option value="oxide_native">
                        Oxide Native Engine (Local GGUF - Direct AMD Radeon &amp; CPU)
                      </option>
                      <option value="anthropic">Anthropic Claude (Cloud API - Sonnet 3.5, 3.7, Opus)</option>
                      <option value="openai">OpenAI GPT (Cloud API - GPT-4o, o1, o3-mini)</option>
                      <option value="gemini">Google Gemini (Cloud API - Gemini 2.0 Flash, 1.5 Pro)</option>
                      <option value="deepseek">DeepSeek API (Cloud API - DeepSeek-V3, DeepSeek-R1)</option>
                      <option value="custom_openai">
                        Custom OpenAI-Compatible (LM Studio / vLLM / llama-server)
                      </option>
                      <option value="ollama">Ollama Local Engine (http://localhost:11434)</option>
                    </select>
                  </div>

                  {/* ANTHROPIC CLAUDE */}
                  {providerConfig.active_provider === "anthropic" && (
                    <div
                      style={{
                        gridColumn: "1 / -1",
                        background: "rgba(242, 108, 58, 0.05)",
                        border: "1px solid rgba(242, 108, 58, 0.3)",
                        borderRadius: "8px",
                        padding: "1rem",
                        display: "flex",
                        flexDirection: "column",
                        gap: "0.75rem",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div>
                          <strong style={{ color: "var(--oxide-ember)" }}>Anthropic Claude Configuration</strong>
                          <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: "0.15rem" }}>
                            Enter your Anthropic API Key (from console.anthropic.com) to use Claude models
                          </div>
                        </div>
                        <button
                          type="button"
                          className="btn"
                          disabled={testConnStatus.testing || !providerConfig.anthropic_api_key}
                          onClick={async () => {
                            setTestConnStatus({ testing: true });
                            const res = await oxideBridge.testProviderConnection(providerConfig);
                            setTestConnStatus({ testing: false, success: res.success, message: res.message });
                          }}
                        >
                          {testConnStatus.testing ? "Testing..." : "Test Connection"}
                        </button>
                      </div>

                      {testConnStatus.message && (
                        <div style={{ fontSize: "0.74rem", color: testConnStatus.success ? "#4ade80" : "#f87171" }}>
                          {testConnStatus.message}
                        </div>
                      )}

                      <div className="form-group">
                        <label>Anthropic API Key</label>
                        <div className="api-key-input-row">
                          <input
                            type={showApiKeys.anthropic ? "text" : "password"}
                            className="workspace-input"
                            style={{ flex: 1 }}
                            placeholder="sk-ant-api03-..."
                            value={providerConfig.anthropic_api_key || ""}
                            onChange={(e) =>
                              setProviderConfig({
                                ...providerConfig,
                                anthropic_api_key: e.target.value.trim(),
                              })
                            }
                          />
                          <button
                            type="button"
                            className="btn"
                            onClick={() =>
                              setShowApiKeys((prev) => ({
                                ...prev,
                                anthropic: !prev.anthropic,
                              }))
                            }
                          >
                            {showApiKeys.anthropic ? "Hide" : "Show"}
                          </button>
                        </div>
                      </div>

                      <div className="form-group">
                        <label>Claude Model Selection</label>
                        <select
                          className="select-control"
                          value={providerConfig.anthropic_model || "claude-3-5-sonnet-20241022"}
                          onChange={(e) =>
                            setProviderConfig({
                              ...providerConfig,
                              anthropic_model: e.target.value,
                            })
                          }
                        >
                          <option value="claude-3-5-sonnet-20241022">Claude 3.5 Sonnet (Recommended)</option>
                          <option value="claude-3-7-sonnet">Claude 3.7 Sonnet</option>
                          <option value="claude-3-5-haiku-20241022">Claude 3.5 Haiku (Fast Subagent)</option>
                          <option value="claude-3-opus-20240229">Claude 3 Opus</option>
                        </select>
                      </div>
                    </div>
                  )}

                  {/* OPENAI GPT */}
                  {providerConfig.active_provider === "openai" && (
                    <div
                      style={{
                        gridColumn: "1 / -1",
                        background: "rgba(16, 185, 129, 0.05)",
                        border: "1px solid rgba(16, 185, 129, 0.3)",
                        borderRadius: "8px",
                        padding: "1rem",
                        display: "flex",
                        flexDirection: "column",
                        gap: "0.75rem",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div>
                          <strong style={{ color: "#34d399" }}>OpenAI GPT Configuration</strong>
                          <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: "0.15rem" }}>
                            Enter your OpenAI API Key (from platform.openai.com) to use GPT-4o and reasoning models
                          </div>
                        </div>
                        <button
                          type="button"
                          className="btn"
                          disabled={testConnStatus.testing || !providerConfig.openai_api_key}
                          onClick={async () => {
                            setTestConnStatus({ testing: true });
                            const res = await oxideBridge.testProviderConnection(providerConfig);
                            setTestConnStatus({ testing: false, success: res.success, message: res.message });
                          }}
                        >
                          {testConnStatus.testing ? "Testing..." : "Test Connection"}
                        </button>
                      </div>

                      {testConnStatus.message && (
                        <div style={{ fontSize: "0.74rem", color: testConnStatus.success ? "#4ade80" : "#f87171" }}>
                          {testConnStatus.message}
                        </div>
                      )}

                      <div className="form-group">
                        <label>OpenAI API Key</label>
                        <div className="api-key-input-row">
                          <input
                            type={showApiKeys.openai ? "text" : "password"}
                            className="workspace-input"
                            style={{ flex: 1 }}
                            placeholder="sk-proj-..."
                            value={providerConfig.openai_api_key || ""}
                            onChange={(e) =>
                              setProviderConfig({
                                ...providerConfig,
                                openai_api_key: e.target.value.trim(),
                              })
                            }
                          />
                          <button
                            type="button"
                            className="btn"
                            onClick={() =>
                              setShowApiKeys((prev) => ({
                                ...prev,
                                openai: !prev.openai,
                              }))
                            }
                          >
                            {showApiKeys.openai ? "Hide" : "Show"}
                          </button>
                        </div>
                      </div>

                      <div className="form-group">
                        <label>OpenAI Model Selection</label>
                        <select
                          className="select-control"
                          value={providerConfig.openai_model || "gpt-4o"}
                          onChange={(e) =>
                            setProviderConfig({
                              ...providerConfig,
                              openai_model: e.target.value,
                            })
                          }
                        >
                          <option value="gpt-4o">GPT-4o (Recommended)</option>
                          <option value="gpt-4o-mini">GPT-4o-mini (Fast &amp; Cheap)</option>
                          <option value="o1">o1 (Deep Reasoning)</option>
                          <option value="o3-mini">o3-mini (High-Speed Reasoning)</option>
                        </select>
                      </div>
                    </div>
                  )}

                  {/* GOOGLE GEMINI */}
                  {providerConfig.active_provider === "gemini" && (
                    <div
                      style={{
                        gridColumn: "1 / -1",
                        background: "rgba(59, 130, 246, 0.05)",
                        border: "1px solid rgba(59, 130, 246, 0.3)",
                        borderRadius: "8px",
                        padding: "1rem",
                        display: "flex",
                        flexDirection: "column",
                        gap: "0.75rem",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div>
                          <strong style={{ color: "#60a5fa" }}>Google Gemini Configuration</strong>
                          <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: "0.15rem" }}>
                            Enter your Google Gemini API Key (from aistudio.google.com)
                          </div>
                        </div>
                        <button
                          type="button"
                          className="btn"
                          disabled={testConnStatus.testing || !providerConfig.gemini_api_key}
                          onClick={async () => {
                            setTestConnStatus({ testing: true });
                            const res = await oxideBridge.testProviderConnection(providerConfig);
                            setTestConnStatus({ testing: false, success: res.success, message: res.message });
                          }}
                        >
                          {testConnStatus.testing ? "Testing..." : "Test Connection"}
                        </button>
                      </div>

                      {testConnStatus.message && (
                        <div style={{ fontSize: "0.74rem", color: testConnStatus.success ? "#4ade80" : "#f87171" }}>
                          {testConnStatus.message}
                        </div>
                      )}

                      <div className="form-group">
                        <label>Google Gemini API Key</label>
                        <div className="api-key-input-row">
                          <input
                            type={showApiKeys.gemini ? "text" : "password"}
                            className="workspace-input"
                            style={{ flex: 1 }}
                            placeholder="AIzaSy..."
                            value={providerConfig.gemini_api_key || ""}
                            onChange={(e) =>
                              setProviderConfig({
                                ...providerConfig,
                                gemini_api_key: e.target.value.trim(),
                              })
                            }
                          />
                          <button
                            type="button"
                            className="btn"
                            onClick={() =>
                              setShowApiKeys((prev) => ({
                                ...prev,
                                gemini: !prev.gemini,
                              }))
                            }
                          >
                            {showApiKeys.gemini ? "Hide" : "Show"}
                          </button>
                        </div>
                      </div>

                      <div className="form-group">
                        <label>Gemini Model Selection</label>
                        <select
                          className="select-control"
                          value={providerConfig.gemini_model || "gemini-2.0-flash"}
                          onChange={(e) =>
                            setProviderConfig({
                              ...providerConfig,
                              gemini_model: e.target.value,
                            })
                          }
                        >
                          <option value="gemini-2.0-flash">Gemini 2.0 Flash (Next-Gen, High Speed)</option>
                          <option value="gemini-1.5-pro">Gemini 1.5 Pro (2M Context Window)</option>
                          <option value="gemini-1.5-flash">Gemini 1.5 Flash</option>
                        </select>
                      </div>
                    </div>
                  )}

                  {/* DEEPSEEK API */}
                  {providerConfig.active_provider === "deepseek" && (
                    <div
                      style={{
                        gridColumn: "1 / -1",
                        background: "rgba(167, 139, 250, 0.05)",
                        border: "1px solid rgba(167, 139, 250, 0.3)",
                        borderRadius: "8px",
                        padding: "1rem",
                        display: "flex",
                        flexDirection: "column",
                        gap: "0.75rem",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div>
                          <strong style={{ color: "#a78bfa" }}>DeepSeek Cloud API Configuration</strong>
                          <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: "0.15rem" }}>
                            Enter your DeepSeek API Key (from platform.deepseek.com)
                          </div>
                        </div>
                        <button
                          type="button"
                          className="btn"
                          disabled={testConnStatus.testing || !providerConfig.deepseek_api_key}
                          onClick={async () => {
                            setTestConnStatus({ testing: true });
                            const res = await oxideBridge.testProviderConnection(providerConfig);
                            setTestConnStatus({ testing: false, success: res.success, message: res.message });
                          }}
                        >
                          {testConnStatus.testing ? "Testing..." : "Test Connection"}
                        </button>
                      </div>

                      {testConnStatus.message && (
                        <div style={{ fontSize: "0.74rem", color: testConnStatus.success ? "#4ade80" : "#f87171" }}>
                          {testConnStatus.message}
                        </div>
                      )}

                      <div className="form-group">
                        <label>DeepSeek API Key</label>
                        <div className="api-key-input-row">
                          <input
                            type={showApiKeys.deepseek ? "text" : "password"}
                            className="workspace-input"
                            style={{ flex: 1 }}
                            placeholder="sk-..."
                            value={providerConfig.deepseek_api_key || ""}
                            onChange={(e) =>
                              setProviderConfig({
                                ...providerConfig,
                                deepseek_api_key: e.target.value.trim(),
                              })
                            }
                          />
                          <button
                            type="button"
                            className="btn"
                            onClick={() =>
                              setShowApiKeys((prev) => ({
                                ...prev,
                                deepseek: !prev.deepseek,
                              }))
                            }
                          >
                            {showApiKeys.deepseek ? "Hide" : "Show"}
                          </button>
                        </div>
                      </div>

                      <div className="form-group">
                        <label>DeepSeek Model Selection</label>
                        <select
                          className="select-control"
                          value={providerConfig.deepseek_model || "deepseek-chat"}
                          onChange={(e) =>
                            setProviderConfig({
                              ...providerConfig,
                              deepseek_model: e.target.value,
                            })
                          }
                        >
                          <option value="deepseek-chat">DeepSeek-V3 (deepseek-chat)</option>
                          <option value="deepseek-reasoner">DeepSeek-R1 (deepseek-reasoner)</option>
                        </select>
                      </div>
                    </div>
                  )}

                  {/* OXIDE NATIVE ENGINE */}
                  {providerConfig.active_provider === "oxide_native" && (
                    <div
                      style={{
                        gridColumn: "1 / -1",
                        background: "var(--bg-secondary)",
                        border: "1px solid var(--border-color)",
                        borderRadius: "8px",
                        padding: "1rem",
                        display: "flex",
                        flexDirection: "column",
                        gap: "0.75rem",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                        }}
                      >
                        <div>
                          <strong>Oxide Native Engine (Standalone llama.cpp)</strong>
                          <div
                            style={{
                              fontSize: "0.76rem",
                              color: "var(--text-secondary)",
                              marginTop: "0.2rem",
                            }}
                          >
                            Zero external dependencies. Runs direct .gguf models with AMD Radeon (Vulkan) &amp; CPU acceleration.
                          </div>
                        </div>
                        <span
                          className={`hw-fit-badge ${
                            nativeOnline ? "gpu_fast" : "tight_fit"
                          }`}
                        >
                          {nativeOnline
                            ? `Running on :${providerConfig.oxide_native_port || 11435}`
                            : "Ready (Stopped)"}
                        </span>
                      </div>

                      <div className="form-group">
                        <label>Active Native GGUF Model</label>
                        <select
                          className="select-control"
                          value={
                            providerConfig.oxide_native_model ||
                            nativeModels[0] ||
                            ""
                          }
                          onChange={(e) =>
                            setProviderConfig({
                              ...providerConfig,
                              oxide_native_model: e.target.value,
                            })
                          }
                        >
                          {nativeModels.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                          {nativeModels.length === 0 && (
                            <option value="">(No .gguf models found in models folder - click Models to install)</option>
                          )}
                        </select>
                      </div>

                      <div
                        style={{
                          display: "flex",
                          gap: "0.5rem",
                          flexWrap: "wrap",
                          marginTop: "0.25rem",
                        }}
                      >
                        <button
                          className="oxide-btn-primary"
                          disabled={isStartingNative || nativeModels.length === 0}
                          onClick={async () => {
                            setIsStartingNative(true);
                            try {
                              const chosen =
                                providerConfig.oxide_native_model ||
                                nativeModels[0];
                              await oxideBridge.startNativeEngine(
                                chosen,
                                providerConfig.gpu_offload_layers ?? 99
                              );
                              setStatusBanner(
                                `Started Native Engine with ${chosen} on port 11435!`
                              );
                              await refreshWorkspaceState();
                            } catch (e: any) {
                              setStatusBanner(`Failed to start native engine: ${e.message}`);
                            } finally {
                              setIsStartingNative(false);
                            }
                          }}
                        >
                          {isStartingNative
                            ? "Starting..."
                            : nativeOnline
                            ? "Restart Engine"
                            : "Start Native Engine"}
                        </button>

                        {nativeOnline && (
                          <button
                            className="oxide-btn-secondary"
                            onClick={async () => {
                              try {
                                await oxideBridge.stopNativeEngine();
                                setStatusBanner("Native Engine stopped.");
                                await refreshWorkspaceState();
                              } catch (e: any) {
                                setStatusBanner(`Stop error: ${e.message}`);
                              }
                            }}
                          >
                            Stop Engine
                          </button>
                        )}

                        <button
                          className="oxide-btn-secondary"
                          onClick={() => oxideBridge.openNativeModelsFolder()}
                        >
                          Open Models Folder
                        </button>
                      </div>
                    </div>
                  )}

                  {providerConfig.active_provider === "custom_openai" && (
                    <div
                      style={{
                        gridColumn: "1 / -1",
                        background: "var(--bg-secondary)",
                        border: "1px solid var(--border-color)",
                        borderRadius: "8px",
                        padding: "1rem",
                        display: "flex",
                        flexDirection: "column",
                        gap: "0.75rem",
                      }}
                    >
                      <strong>OpenAI-Compatible Local Endpoint (LM Studio / vLLM / LocalAI)</strong>
                      <div className="form-group">
                        <label>Endpoint URL</label>
                        <input
                          className="workspace-input"
                          placeholder="http://127.0.0.1:1234/v1"
                          value={
                            providerConfig.custom_openai_url ||
                            "http://127.0.0.1:1234/v1"
                          }
                          onChange={(e) =>
                            setProviderConfig({
                              ...providerConfig,
                              custom_openai_url: e.target.value,
                            })
                          }
                        />
                      </div>
                      <div className="form-group">
                        <label>Model Identifier</label>
                        <input
                          className="workspace-input"
                          placeholder="local-model"
                          value={
                            providerConfig.custom_openai_model || "local-model"
                          }
                          onChange={(e) =>
                            setProviderConfig({
                              ...providerConfig,
                              custom_openai_model: e.target.value,
                            })
                          }
                        />
                      </div>
                    </div>
                  )}

                  {providerConfig.active_provider === "ollama" && (
                    <div className="form-group" style={{ gridColumn: "1 / -1" }}>
                      <label>
                        Ollama Server URL ({ollamaOnline ? "Online" : "Offline"})
                      </label>
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
                  )}

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

                  <div className="form-group" style={{ justifyContent: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "0.5rem 0" }}>
                      <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                        Cloud Fallback on Local Failure
                      </span>
                      <label className="ag-switch" title="Toggle Cloud Fallback">
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
                        <span className="ag-switch-slider" />
                      </label>
                    </div>
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
                          [GPU] {hwSpecs.governor_tier} ({hwSpecs.available_ram_gb}{" "}
                          GB Free / {hwSpecs.total_ram_gb} GB RAM |{" "}
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
                        Auto-Assign Installed Models
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
                        Open Model Store
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="routing-grid">
                    <div className="form-group">
                      <label>Main Agent (Lead Architect)</label>
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
                      <label>Coder Subagent (Fast File Edits)</label>
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
                      <label>Research Subagent (Fast Search)</label>
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
                        Tools discovered: {srv.discovered_tools.length} |
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

      {/* ==================== DELETE CONFIRMATION MODAL ==================== */}
      {confirmDelete && (
        <div
          className="modal-backdrop"
          onClick={() => setConfirmDelete(null)}
        >
          <div
            className="confirm-modal-box"
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
              <span style={{ color: "#f87171", fontWeight: 700, fontSize: "1.05rem" }}>Confirm Deletion</span>
            </div>
            <div style={{ fontSize: "0.84rem", color: "var(--text-secondary)", lineHeight: 1.5, marginBottom: "1.25rem" }}>
              Are you sure you want to delete {confirmDelete.type} <strong style={{ color: "var(--text-primary)" }}>"{confirmDelete.name}"</strong>? This action cannot be undone.
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
              <button
                className="btn"
                onClick={() => setConfirmDelete(null)}
              >
                Cancel
              </button>
              <button
                className="btn"
                style={{ background: "#dc2626", color: "#ffffff", borderColor: "#dc2626", fontWeight: 600 }}
                onClick={async () => {
                  const fn = confirmDelete.onConfirm;
                  setConfirmDelete(null);
                  await fn();
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== OPEN WORKSPACE FOLDER MODAL ==================== */}
      {showOpenFolderModal && (
        <div
          className="modal-backdrop"
          onClick={() => setShowOpenFolderModal(false)}
        >
          <div
            className="model-hub-card"
            style={{ width: "620px" }}
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
                <h3 style={{ margin: 0, fontSize: "1.05rem" }}>
                  Open Project Workspace
                </h3>
                <div
                  style={{
                    fontSize: "0.75rem",
                    color: "var(--text-secondary)",
                    marginTop: "0.15rem",
                  }}
                >
                  Select or enter the folder path to use as the active project workspace
                </div>
              </div>
              <button
                className="btn"
                onClick={() => setShowOpenFolderModal(false)}
              >
                Close
              </button>
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "1rem",
                marginTop: "1rem",
              }}
            >
              {/* Option 1: Native Windows Explorer Dialog */}
              <div
                style={{
                  padding: "0.85rem",
                  background: "var(--bg-elevated)",
                  borderRadius: "8px",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <div
                  style={{
                    fontWeight: 600,
                    fontSize: "0.86rem",
                    marginBottom: "0.25rem",
                  }}
                >
                  Option 1: Windows Explorer Folder Picker
                </div>
                <div
                  style={{
                    fontSize: "0.74rem",
                    color: "var(--text-secondary)",
                    marginBottom: "0.6rem",
                  }}
                >
                  Open the native Windows folder browser dialog to select a folder on your computer
                </div>
                <button
                  className="btn btn-primary"
                  onClick={handleBrowseWithWindowsExplorer}
                >
                  Browse with Windows Explorer...
                </button>
              </div>

              {/* Option 2: Direct Folder Path Input */}
              <div
                style={{
                  padding: "0.85rem",
                  background: "var(--bg-elevated)",
                  borderRadius: "8px",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <div
                  style={{
                    fontWeight: 600,
                    fontSize: "0.86rem",
                    marginBottom: "0.25rem",
                  }}
                >
                  Option 2: Enter or Paste Folder Path
                </div>
                <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.4rem" }}>
                  <input
                    className="workspace-input"
                    style={{ flex: 1 }}
                    placeholder="e.g. C:\Users\hannu\.gemini\antigravity\scratch"
                    value={folderPathInput}
                    onChange={(e) => setFolderPathInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && folderPathInput.trim()) {
                        openWorkspaceDirectory(folderPathInput.trim());
                      }
                    }}
                  />
                  <button
                    className="btn btn-primary"
                    disabled={!folderPathInput.trim()}
                    onClick={() => openWorkspaceDirectory(folderPathInput.trim())}
                  >
                    Open Folder
                  </button>
                </div>
              </div>

              {/* Quick Presets */}
              <div>
                <div
                  style={{
                    fontSize: "0.74rem",
                    color: "var(--text-muted)",
                    marginBottom: "0.4rem",
                    fontWeight: 600,
                  }}
                >
                  Quick Preset Workspaces:
                </div>
                <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                  <button
                    className="ag-pill-btn"
                    onClick={() =>
                      openWorkspaceDirectory(
                        "C:\\Users\\hannu\\.gemini\\antigravity\\scratch"
                      )
                    }
                  >
                    Antigravity Scratch
                  </button>
                  <button
                    className="ag-pill-btn"
                    onClick={() =>
                      openWorkspaceDirectory(
                        "C:\\Users\\hannu\\AppData\\Local\\Programs\\Oxide\\workspace"
                      )
                    }
                  >
                    Oxide Workspace
                  </button>
                  <button
                    className="ag-pill-btn"
                    onClick={() =>
                      openWorkspaceDirectory("C:\\Users\\hannu")
                    }
                  >
                    User Home (~/)
                  </button>
                  <button
                    className="ag-pill-btn"
                    onClick={() =>
                      openWorkspaceDirectory("C:\\Users\\hannu\\Desktop")
                    }
                  >
                    Desktop
                  </button>
                  <button
                    className="ag-pill-btn"
                    onClick={() =>
                      openWorkspaceDirectory("C:\\Users\\hannu\\Downloads")
                    }
                  >
                    Downloads
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ==================== CREATE NEW FILE / FOLDER MODAL ==================== */}
      {createItemModal && createItemModal.isOpen && (
        <div
          className="modal-backdrop"
          onClick={() => setCreateItemModal(null)}
        >
          <div
            className="confirm-modal-box"
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                fontWeight: 700,
                fontSize: "1.05rem",
                color: "var(--text-primary)",
                marginBottom: "0.35rem",
              }}
            >
              Create New {createItemModal.type === "file" ? "File" : "Folder"}
            </div>
            <div
              style={{
                fontSize: "0.78rem",
                color: "var(--text-secondary)",
                marginBottom: "0.85rem",
              }}
            >
              {createItemModal.type === "file"
                ? "Enter file path relative to workspace (e.g. src/index.ts, app.py, notes.md):"
                : "Enter folder name or path (e.g. components, src/utils):"}
            </div>
            <input
              autoFocus
              className="workspace-input"
              style={{ width: "100%", marginBottom: "1rem" }}
              placeholder={
                createItemModal.type === "file" ? "src/main.rs" : "my_folder"
              }
              value={createItemModal.name}
              onChange={(e) =>
                setCreateItemModal({ ...createItemModal, name: e.target.value })
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" && createItemModal.name.trim()) {
                  handleConfirmCreateItem(
                    createItemModal.type,
                    createItemModal.name.trim()
                  );
                } else if (e.key === "Escape") {
                  setCreateItemModal(null);
                }
              }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
              <button
                className="btn"
                onClick={() => setCreateItemModal(null)}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={!createItemModal.name.trim()}
                onClick={() =>
                  handleConfirmCreateItem(
                    createItemModal.type,
                    createItemModal.name.trim()
                  )
                }
              >
                Create {createItemModal.type === "file" ? "File" : "Folder"}
              </button>
            </div>
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
            style={{ width: "820px", maxHeight: "88vh", overflowY: "auto" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                borderBottom: "1px solid var(--border-subtle)",
                paddingBottom: "0.75rem",
              }}
            >
              <div>
                <h3 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 600 }}>
                  Subagent Delegation &amp; Worker Roles
                </h3>
                <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: "0.2rem" }}>
                  Configure role assignment and model routing across primary and subagent execution
                </div>
              </div>
              <button
                className="btn"
                onClick={() => setShowSubagentsGuide(false)}
              >
                Close
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "1rem", marginTop: "1rem" }}>
              {/* Delegation Toggle Banner */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "0.85rem 1rem",
                  background: "var(--bg-elevated)",
                  borderRadius: "8px",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>
                    Autonomous Delegation
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: "0.15rem" }}>
                    {providerConfig.enable_subagents
                      ? "Enabled - Primary agent breaks down complex tasks and delegates to specialized subagents."
                      : "Disabled - Primary agent handles all execution steps sequentially."}
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
                  {providerConfig.enable_subagents ? "Delegation Active" : "Enable Delegation"}
                </button>
              </div>

              {/* Roles Breakdown Grid */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "0.85rem",
                }}
              >
                {/* 1. Lead Architect */}
                <div className="hw-spec-box" style={{ background: "rgba(255, 255, 255, 0.02)", border: "1px solid rgba(242, 108, 58, 0.35)", padding: "0.85rem" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 600, color: "var(--oxide-ember)" }}>
                      <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "var(--oxide-ember)", display: "inline-block" }} />
                      <span>Primary Agent (Architect)</span>
                    </div>
                    <span style={{ fontSize: "0.68rem", padding: "1px 6px", borderRadius: "4px", background: "rgba(242, 108, 58, 0.15)", color: "var(--oxide-ember)" }}>Coordinator</span>
                  </div>
                  <div style={{ fontSize: "0.74rem", color: "var(--text-secondary)", marginTop: "0.4rem", lineHeight: 1.4 }}>
                    Analyzes objectives, reasons about code changes, schedules subtasks, and reviews deliverables before presenting.
                  </div>
                  <div style={{ marginTop: "0.6rem" }}>
                    <label style={{ fontSize: "0.68rem", color: "var(--text-muted)", display: "block", marginBottom: "0.2rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Assigned Model</label>
                    <select
                      className="select-control"
                      style={{ width: "100%", fontSize: "0.75rem", padding: "0.3rem 0.5rem" }}
                      value={providerConfig.task_routing.architect_model || providerConfig.ollama_model}
                      onChange={async (e) => {
                        const val = e.target.value;
                        const updated = {
                          ...providerConfig,
                          ollama_model: val,
                          task_routing: { ...providerConfig.task_routing, architect_model: val },
                        };
                        setProviderConfig(updated);
                        await oxideBridge.updateProviderConfig(updated);
                      }}
                    >
                      {ollamaModels.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* 2. Coder Subagent */}
                <div className="hw-spec-box" style={{ background: "rgba(255, 255, 255, 0.02)", border: "1px solid rgba(96, 165, 250, 0.35)", padding: "0.85rem" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 600, color: "#60a5fa" }}>
                      <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#60a5fa", display: "inline-block" }} />
                      <span>Coder Subagent</span>
                    </div>
                    <span style={{ fontSize: "0.68rem", padding: "1px 6px", borderRadius: "4px", background: "rgba(96, 165, 250, 0.15)", color: "#60a5fa" }}>Worker</span>
                  </div>
                  <div style={{ fontSize: "0.74rem", color: "var(--text-secondary)", marginTop: "0.4rem", lineHeight: 1.4 }}>
                    Specialized in focused code mutations, file edits, and refactoring without polluting architect context.
                  </div>
                  <div style={{ marginTop: "0.6rem" }}>
                    <label style={{ fontSize: "0.68rem", color: "var(--text-muted)", display: "block", marginBottom: "0.2rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Assigned Model</label>
                    <select
                      className="select-control"
                      style={{ width: "100%", fontSize: "0.75rem", padding: "0.3rem 0.5rem" }}
                      value={providerConfig.task_routing.coder_subagent_model || providerConfig.ollama_model}
                      onChange={async (e) => {
                        const val = e.target.value;
                        const updated = {
                          ...providerConfig,
                          task_routing: { ...providerConfig.task_routing, coder_subagent_model: val },
                        };
                        setProviderConfig(updated);
                        await oxideBridge.updateProviderConfig(updated);
                      }}
                    >
                      {ollamaModels.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* 3. Research Subagent */}
                <div className="hw-spec-box" style={{ background: "rgba(255, 255, 255, 0.02)", border: "1px solid rgba(167, 139, 250, 0.35)", padding: "0.85rem" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 600, color: "#a78bfa" }}>
                      <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#a78bfa", display: "inline-block" }} />
                      <span>Research Subagent</span>
                    </div>
                    <span style={{ fontSize: "0.68rem", padding: "1px 6px", borderRadius: "4px", background: "rgba(167, 139, 250, 0.15)", color: "#a78bfa" }}>Worker</span>
                  </div>
                  <div style={{ fontSize: "0.74rem", color: "var(--text-secondary)", marginTop: "0.4rem", lineHeight: 1.4 }}>
                    Fast read-only exploration: searches codebase symbols, analyzes documentation, and cross-references dependencies.
                  </div>
                  <div style={{ marginTop: "0.6rem" }}>
                    <label style={{ fontSize: "0.68rem", color: "var(--text-muted)", display: "block", marginBottom: "0.2rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Assigned Model</label>
                    <select
                      className="select-control"
                      style={{ width: "100%", fontSize: "0.75rem", padding: "0.3rem 0.5rem" }}
                      value={providerConfig.task_routing.research_subagent_model || providerConfig.ollama_model}
                      onChange={async (e) => {
                        const val = e.target.value;
                        const updated = {
                          ...providerConfig,
                          task_routing: { ...providerConfig.task_routing, research_subagent_model: val },
                        };
                        setProviderConfig(updated);
                        await oxideBridge.updateProviderConfig(updated);
                      }}
                    >
                      {ollamaModels.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* 4. Tester Subagent */}
                <div className="hw-spec-box" style={{ background: "rgba(255, 255, 255, 0.02)", border: "1px solid rgba(52, 211, 153, 0.35)", padding: "0.85rem" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 600, color: "#34d399" }}>
                      <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#34d399", display: "inline-block" }} />
                      <span>Tester &amp; Diagnostics</span>
                    </div>
                    <span style={{ fontSize: "0.68rem", padding: "1px 6px", borderRadius: "4px", background: "rgba(52, 211, 153, 0.15)", color: "#34d399" }}>Worker</span>
                  </div>
                  <div style={{ fontSize: "0.74rem", color: "var(--text-secondary)", marginTop: "0.4rem", lineHeight: 1.4 }}>
                    Executes test commands, inspects terminal logs, parses compiler diagnostics, and verifies build integrity.
                  </div>
                  <div style={{ marginTop: "0.6rem" }}>
                    <label style={{ fontSize: "0.68rem", color: "var(--text-muted)", display: "block", marginBottom: "0.2rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Assigned Model</label>
                    <select
                      className="select-control"
                      style={{ width: "100%", fontSize: "0.75rem", padding: "0.3rem 0.5rem" }}
                      value={providerConfig.task_routing.tester_subagent_model || providerConfig.ollama_model}
                      onChange={async (e) => {
                        const val = e.target.value;
                        const updated = {
                          ...providerConfig,
                          task_routing: { ...providerConfig.task_routing, tester_subagent_model: val },
                        };
                        setProviderConfig(updated);
                        await oxideBridge.updateProviderConfig(updated);
                      }}
                    >
                      {ollamaModels.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {/* Tips Footer */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  fontSize: "0.74rem",
                  color: "var(--text-muted)",
                  paddingTop: "0.4rem",
                  borderTop: "1px solid var(--border-subtle)",
                }}
              >
                <div>
                  Use <code>/subagents &lt;task&gt;</code> to trigger parallel worker execution or <code>/plan</code> for staged verification.
                </div>
                <button
                  className="btn btn-primary"
                  onClick={() => setShowSubagentsGuide(false)}
                >
                  Save &amp; Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
