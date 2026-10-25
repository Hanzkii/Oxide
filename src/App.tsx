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

function getBaseName(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function isAppInstallDir(p: string): boolean {
  const lower = p.replace(/[\\/]+$/, "").toLowerCase();
  return (
    lower.endsWith("\\appdata\\local\\oxide") ||
    lower.endsWith("/appdata/local/oxide")
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
    "general" | "providers" | "agents" | "mcp" | "updates"
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
            // Migrate any old AppData\Local\Oxide binary dir to the default `.oxide/scratch` folder
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
          // "." automatically resolves to C:\Users\<user>\.oxide\scratch when run from installer
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

    return () => {
      clearInterval(hwTimer);
      unlistenPromise.then((unlisten) => unlisten());
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
        "No AI model installed yet — install a local AI model below first."
      );
      setShowModelHubModal(true);
      return;
    }

    if (!customPrompt) setPrompt("");

    const startTime = Date.now();
    setIsRunning(true);
    setStreamingBuffer("");
    setLiveThinking(`Analyzing request and planning next actions...`);
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
              📁+
            </button>
            <button
              className="ag-icon-btn"
              onClick={() => {
                setRightDrawer("files");
                setShowRightPanel(true);
              }}
              title="Open Explorer"
            >
              🔍
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
            <span>📁 Explorer</span>
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
            <span>🧠 Models</span>
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
            <span>⚡ Agents &amp; Subagents</span>
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
            <span>🔌 MCP Servers</span>
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
                    📁 {proj.name}
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
                      ✕
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
                          {isActive && isRunning ? "⟳" : conv.updatedAt}
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
                          ✕
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
            ⚙ Settings
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
            ↻ {updateStatus?.update_available ? "Update Available" : "Updates"}
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
              {activeProject?.name || "scratch"}
            </span>
            <span>/</span>
            <span className="ag-breadcrumb-conv">
              {activeConversation?.title || "New Conversation"}
            </span>
          </div>

          <div className="ag-topbar-right">
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
              🧠 Models ({ollamaModels.length} Installed)
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
              ▤
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
                        {activeProject?.name || "scratch"}
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
                            ⚡ No Local AI Model Installed Yet
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
                              🧠 Open Models (1-Click Install)
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
                          📁 Open Folder...
                        </button>
                        <button
                          className="ag-pill-btn"
                          onClick={() => setShowModelHubModal(true)}
                        >
                          🧠 Models ({ollamaModels.length} Installed)
                        </button>
                        <button
                          className="ag-pill-btn"
                          onClick={() => {
                            setRightDrawer("files");
                            setShowRightPanel(true);
                          }}
                        >
                          📄 Explorer ({files.length})
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
                            {isExpanded ? "▾" : "›"}
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
                            <span className="ag-tool-step-icon">
                              {s.title.toLowerCase().includes("command") ||
                              s.title.toLowerCase().includes("terminal")
                                ? ">_"
                                : "📄"}
                            </span>
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
                      <div className="ag-thought-toggle">
                        <span style={{ color: "var(--oxide-ember)" }}>
                          ⟳ Thinking...
                        </span>
                      </div>
                      <div className="ag-thought-body">
                        {liveThinking}
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

                      {subagents.slice(0, 3).map((sub) => (
                        <div key={sub.id} className="ag-tool-step">
                          <span className="ag-tool-step-icon">⚡</span>
                          <span className="ag-tool-step-label">
                            [{sub.role.toUpperCase()}] {sub.title}
                          </span>
                          <span className="ag-tool-step-badge">
                            {sub.model} • {sub.state}
                          </span>
                        </div>
                      ))}

                      {liveSteps.map((s) => (
                        <div key={s.id} className="ag-tool-step">
                          <span className="ag-tool-step-icon">📄</span>
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
              <div className="ag-composer-card">
                <textarea
                  className="ag-composer-textarea"
                  placeholder="Ask Oxide to write code, edit files, or run commands..."
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
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
                              style={{ background: "#18181b", color: "#ececef" }}
                            >
                              {m}
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

                    <button
                      className="ag-send-btn"
                      disabled={isRunning || !prompt.trim()}
                      onClick={() => handleRunTask()}
                      title="Send (Enter)"
                    >
                      →
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
                    <span>📋 Source Control</span>
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
                    <span>📁 Explorer</span>
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
                    <span>🔌 MCP Servers</span>
                    <span style={{ fontSize: "0.72rem" }}>
                      {mcpServers.filter((s) => s.enabled).length} active
                    </span>
                  </button>
                </div>
              </div>

              {/* Dedicated 🖥 PC HARDWARE GOVERNOR Card (Matches Docs Showcase) */}
              <div
                className="ag-overview-card"
                style={{ padding: "0.8rem 0.9rem" }}
              >
                <div
                  style={{
                    fontSize: "0.7rem",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    color: "var(--text-secondary)",
                    marginBottom: "0.35rem",
                    display: "flex",
                    justifyContent: "space-between",
                  }}
                >
                  <span>🖥 PC HARDWARE GOVERNOR</span>
                  <span
                    style={{
                      color: ollamaOnline ? "#4ade80" : "var(--text-muted)",
                    }}
                  >
                    {ollamaOnline ? "● Ollama Online" : "○ Ollama Offline"}
                  </span>
                </div>
                <div
                  style={{
                    fontWeight: 600,
                    fontSize: "0.82rem",
                    color: hwSpecs?.throttled_by_load ? "#fbbf24" : "#4ade80",
                  }}
                >
                  ⚡ {hwSpecs?.governor_tier || "Inspecting PC Specs..."}
                </div>
                {hwSpecs && (
                  <div
                    style={{
                      fontSize: "0.74rem",
                      color: "var(--text-secondary)",
                      marginTop: "0.25rem",
                      lineHeight: 1.45,
                    }}
                  >
                    <div>
                      {hwSpecs.total_ram_gb} GB RAM ({hwSpecs.available_ram_gb}{" "}
                      GB free) • {hwSpecs.gpu_name}
                    </div>
                    <div>
                      Max{" "}
                      {Math.min(
                        providerConfig.max_concurrent_subagents,
                        hwSpecs.hard_limit_subagents
                      )}{" "}
                      Concurrent Subagents (Hard Limit:{" "}
                      {hwSpecs.hard_limit_subagents})
                    </div>
                  </div>
                )}
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
                      📁 Switch Workspace Folder...
                    </button>
                    <button
                      className="btn"
                      onClick={() => setRightDrawer("files")}
                      style={{ justifyContent: "center" }}
                    >
                      📄 Browse Explorer ({files.length})
                    </button>
                    <button
                      className="btn"
                      onClick={() => setShowModelHubModal(true)}
                      style={{ justifyContent: "center" }}
                    >
                      🧠 Open Models ({ollamaModels.length} Installed)
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
                          ↑ Root
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
                          {entry.is_dir ? "📁" : "📄"} {entry.name}
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
                        ← Files
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
                        ↓ Pull
                      </button>
                      <button
                        className="btn"
                        onClick={() => handleGitAction("commit")}
                      >
                        ✓ Commit
                      </button>
                      <button
                        className="btn btn-primary"
                        onClick={() => handleGitAction("push")}
                      >
                        ↑ Push
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
                  🧠 AI Models (Ollama &amp; HuggingFace 1-Click Installer)
                </h3>
                <div
                  style={{
                    fontSize: "0.78rem",
                    color: "var(--text-secondary)",
                    marginTop: "0.2rem",
                  }}
                >
                  Auto-matched to your PC hardware • Filter by Coding,
                  Uncensored, Reasoning &amp; Fast Subagents
                </div>
              </div>
              <button
                className="btn"
                onClick={() => setShowModelHubModal(false)}
              >
                ✕ Close
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
                  🖥 Detected PC Specs:{" "}
                  <span style={{ color: "var(--oxide-ember)" }}>
                    {hwSpecs
                      ? `${hwSpecs.total_ram_gb} GB RAM (${hwSpecs.available_ram_gb} GB free) • ${hwSpecs.gpu_name}${
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
                  {" • "}
                  Agent:{" "}
                  <code>
                    {providerConfig.task_routing.architect_model || "None"}
                  </code>
                  {" • "}
                  Subagent:{" "}
                  <code>
                    {providerConfig.task_routing.coder_subagent_model || "None"}
                  </code>
                </div>
              </div>

              <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap" }}>
                {!ollamaOnline && (
                  <button
                    className="btn btn-primary"
                    onClick={async () => {
                      setStatusBanner(
                        "Starting / Installing Ollama local AI engine..."
                      );
                      try {
                        const msg = await oxideBridge.ensureOllamaEngine();
                        setStatusBanner(msg);
                        await refreshWorkspaceState(currentDir);
                      } catch (err: any) {
                        setStatusBanner(
                          `Ollama setup error: ${err?.message || String(err)}`
                        );
                      }
                    }}
                  >
                    ⚡ 1-Click Start / Install Ollama
                  </button>
                )}
                {ollamaModels.length > 0 && (
                  <button
                    className="btn"
                    onClick={handleAutoAssignOptimalModels}
                  >
                    ✨ Auto-Assign Installed Models
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
                    ["coding", "💻 Coding"],
                    ["uncensored", "🔓 Uncensored"],
                    ["coding_uncensored", "🔥 Coding + Uncensored"],
                    ["reasoning", "🧠 Reasoning (R1)"],
                    ["subagent", "⚡ Fast Subagents"],
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
                    ["ollama", "🦙 Ollama"],
                    ["huggingface", "🤗 HuggingFace"],
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
                  ✅ Fits My PC Only
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
                  ? "🤗 Searching HF..."
                  : "🤗 Search HuggingFace Live"}
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
                  ? "⟳ Installing..."
                  : "⬇ Install Tag"}
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
                                ? "🤗 HuggingFace GGUF"
                                : "🦙 Ollama Registry"}{" "}
                              • <code>{model.params}</code> • {model.size_gb} GB
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
                              💻 Coding
                            </span>
                          )}
                          {model.is_uncensored && (
                            <span className="model-badge uncensored">
                              🔓 Uncensored
                            </span>
                          )}
                          {model.is_reasoning && (
                            <span className="model-badge reasoning">
                              🧠 Reasoning
                            </span>
                          )}
                          {model.is_fast_subagent && (
                            <span className="model-badge subagent">
                              ⚡ Fast Subagent
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
                                ? "⟳ Installing..."
                                : "⬇ Install"}
                            </button>
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
                                {isLead ? "✓ Agent" : "Set as Agent"}
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
                                  ? "✓ Subagent"
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
                                🗑
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
              <h3 style={{ margin: 0 }}>⚙ Oxide Studio Settings</h3>
              <button
                className="btn"
                onClick={() => setShowSettingsModal(false)}
              >
                ✕ Close
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
                  ["general", "📁 General & Workspace"],
                  ["providers", "🔑 AI Providers & Runtime"],
                  ["agents", "⚡ Agents & Hardware Governor"],
                  ["mcp", "🔌 MCP Servers"],
                  ["updates", "↻ Updates & About"],
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
                      📁 Open Folder...
                    </button>
                    <button
                      className="btn"
                      onClick={async () => {
                        const info = await oxideBridge.setWorkspace(".");
                        const defaultProj: ProjectWorkspace = {
                          id: "proj-scratch",
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
                          `Opened default scratch workspace: ${info.canonical_path}`
                        );
                      }}
                    >
                      Open Default Scratch Folder (`.oxide/scratch`)
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
                      %LOCALAPPDATA%/OxideStudio/studio_sessions.json
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
                      🗑 Clear Conversation History
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 2: AI PROVIDERS & RUNTIME */}
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
                        <button
                          className="btn btn-primary"
                          onClick={async () => {
                            const msg = await oxideBridge.ensureOllamaEngine();
                            setStatusBanner(msg);
                            await refreshWorkspaceState(currentDir);
                          }}
                        >
                          ⚡ Start / Install Ollama
                        </button>
                      )}
                      <button
                        className="btn"
                        onClick={() => {
                          setShowSettingsModal(false);
                          setShowModelHubModal(true);
                        }}
                      >
                        🧠 Open Model Store
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
                          🖥 {hwSpecs.governor_tier} ({hwSpecs.available_ram_gb}{" "}
                          GB Free / {hwSpecs.total_ram_gb} GB RAM •{" "}
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
                        ✨ Auto-Assign Installed Models
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
                        🧠 Open Model Store
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="routing-grid">
                    <div className="form-group">
                      <label>🧠 Main Agent (Lead Architect)</label>
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
                      <label>💻 Coder Subagent (Fast File Edits)</label>
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
                      <label>🔍 Research Subagent (Fast Search)</label>
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
                        Max Concurrent Subagents (
                        {providerConfig.max_concurrent_subagents} / Hard Limit:{" "}
                        {hwSpecs?.hard_limit_subagents ?? 2})
                      </label>
                      <input
                        type="range"
                        min="1"
                        max={hwSpecs?.hard_limit_subagents ?? 4}
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
                        Tools discovered: {srv.discovered_tools.length} •
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
                      } finally {
                        setIsUpdating(false);
                      }
                    }}
                  >
                    {isUpdating ? "Updating..." : "Install Latest Update"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
