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

export const App: React.FC = () => {
  // Multi-Project & Saved Conversation State
  const [projects, setProjects] = useState<ProjectWorkspace[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string>("default");
  const [conversations, setConversations] = useState<SavedConversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string>("conv-1");
  const [expandedThoughts, setExpandedThoughts] = useState<
    Record<string, boolean>
  >({});

  // Right Overview & Drawer State ("none" | "files" | "review" | "terminal" | "editor")
  const [rightDrawer, setRightDrawer] = useState<
    "overview" | "files" | "review" | "terminal" | "editor"
  >("overview");
  const [showRightPanel, setShowRightPanel] = useState<boolean>(true);

  // Workspace Files & Built-in Editor State
  const [files, setFiles] = useState<WorkspaceFileEntry[]>([]);
  const [currentDir, setCurrentDir] = useState<string>(".");
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [activeFileContent, setActiveFileContent] = useState<string>("");

  const [gitStatus, setGitStatus] = useState<GitStatusSummary | null>(null);
  const [hwSpecs, setHwSpecs] = useState<HardwareSpecs | null>(null);

  const [providerConfig, setProviderConfig] = useState<ProviderConfig>({
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
  });

  const [ollamaModels, setOllamaModels] = useState<string[]>([
    "qwen2.5-coder:14b",
    "qwen2.5-coder:latest",
    "qwen2.5-coder:7b",
    "qwen2.5-coder:3b",
    "gemma2:latest",
    "deepseek-r1:latest",
  ]);

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

  // Modals
  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false);
  const [showModelHubModal, setShowModelHubModal] = useState<boolean>(false);
  const [showMcpModal, setShowMcpModal] = useState<boolean>(false);
  const [showUpdateModal, setShowUpdateModal] = useState<boolean>(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [isUpdating, setIsUpdating] = useState<boolean>(false);

  // 1-Click AI Model Hub (Ollama + HuggingFace GGUF) State
  const [ollamaOnline, setOllamaOnline] = useState<boolean>(false);
  const [modelCategoryFilter, setModelCategoryFilter] = useState<
    "all" | "coding" | "uncensored" | "coding_uncensored" | "reasoning" | "subagent"
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

  // MCP State
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);
  const [newMcpId, setNewMcpId] = useState<string>("");
  const [newMcpCommand, setNewMcpCommand] = useState<string>("npx");

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
      if (health.ollama_models.length > 0) {
        setOllamaModels(health.ollama_models);
      }
      setProviderConfig((prev) => ({
        ...prev,
        ...health.config,
        task_routing: health.config.task_routing || prev.task_routing,
      }));
    } catch {}
  };

  useEffect(() => {
    (async () => {
      // Load saved Projects & Conversations from disk or localStorage
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
            setProjects(parsed.projects);
            setConversations(parsed.conversations);
            const projId = parsed.activeProjectId || parsed.projects[0].id;
            setActiveProjectId(projId);
            setActiveConvId(
              parsed.activeConvId || parsed.conversations[0]?.id || "conv-1"
            );
            const proj =
              parsed.projects.find(
                (p: ProjectWorkspace) => p.id === projId
              ) || parsed.projects[0];
            await oxideBridge.setWorkspace(proj.path);
            restored = true;
          }
        }
      } catch {}

      if (!restored) {
        try {
          const info = await oxideBridge.setWorkspace(".");
          const defaultProj: ProjectWorkspace = {
            id: "proj-default",
            name: getBaseName(info.canonical_path),
            path: info.canonical_path,
          };
          const defaultConv: SavedConversation = {
            id: "conv-default",
            projectId: defaultProj.id,
            title: "Initial Workspace Session",
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

  // Open Native Windows Folder Picker to Add/Switch Project Folder!
  const handlePickProjectFolder = async () => {
    try {
      const picked = await oxideBridge.pickFolderDialog();
      const targetPath =
        picked ||
        window.prompt(
          "Enter project folder path:",
          activeProject?.path || "."
        );
      if (!targetPath?.trim()) return;

      const info = await oxideBridge.setWorkspace(targetPath.trim());
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

      // Create a fresh conversation inside this project if none exists
      let projConvs = conversations.filter((c) => c.projectId === targetProjId);
      let nextConvs = [...conversations];
      let targetConvId: string;

      if (projConvs.length === 0) {
        const firstConv: SavedConversation = {
          id: `conv-${Date.now()}`,
          projectId: targetProjId,
          title: "New Workspace Session",
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
      setStatusBanner(`Opened project '${getBaseName(info.canonical_path)}'`);
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

  const handleDeleteConversation = async (
    e: React.MouseEvent,
    convId: string
  ) => {
    e.stopPropagation();
    const remaining = conversations.filter((c) => c.id !== convId);
    if (remaining.length === 0) {
      await handleNewConversation();
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
      await refreshWorkspaceState(currentDir);
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
      "New file path relative to project folder (e.g. src/utils.ts):"
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
    const hw = await oxideBridge.getHardwareSpecs();
    setHwSpecs(hw);
    const isHighSpec = hw.total_ram_gb >= 28 || hw.gpu_vram_gb >= 12;
    const isMidSpec = hw.total_ram_gb >= 14;
    const firstAvailable = (candidates: string[], fallback: string) =>
      candidates.find((c) => ollamaModels.includes(c)) ||
      ollamaModels[0] ||
      fallback;

    const architect = isHighSpec
      ? firstAvailable(
          ["deepseek-r1:latest", "qwen2.5-coder:14b", "qwen2.5-coder:latest"],
          "qwen2.5-coder:latest"
        )
      : firstAvailable(
          ["qwen2.5-coder:latest", "qwen2.5-coder:7b"],
          "qwen2.5-coder:latest"
        );
    const coder = isMidSpec
      ? firstAvailable(
          ["qwen2.5-coder:7b", "qwen2.5-coder:latest"],
          "qwen2.5-coder:7b"
        )
      : firstAvailable(
          ["qwen2.5-coder:3b", "gemma2:latest"],
          "qwen2.5-coder:3b"
        );
    const research = firstAvailable(
      ["gemma2:latest", "qwen2.5-coder:3b"],
      "gemma2:latest"
    );

    const updated: ProviderConfig = {
      ...providerConfig,
      ollama_model: architect,
      max_concurrent_subagents: hw.recommended_max_subagents,
      auto_throttle_on_high_load: true,
      task_routing: {
        architect_model: architect,
        coder_subagent_model: coder,
        research_subagent_model: research,
        tester_subagent_model: coder,
      },
    };
    const saved = await oxideBridge.updateProviderConfig(updated);
    setProviderConfig(saved);
  };

  return (
    <div className="ag-shell">
      {/* ==================== LEFT SIDEBAR (Antigravity Style) ==================== */}
      <aside className="ag-sidebar">
        <div className="ag-sidebar-top">
          <div className="ag-brand">
            {/* Rusted Pipe Flange Mini SVG Emblem */}
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
              title="Open Project Folder (Native Folder Picker)"
            >
              📁+
            </button>
            <button
              className="ag-icon-btn"
              onClick={() => {
                setRightDrawer("files");
                setShowRightPanel(true);
              }}
              title="Browse Project Files"
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
            <span>📁 Project Files &amp; Editor</span>
            <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
              {files.length}
            </span>
          </button>
          <button
            className="ag-nav-item"
            onClick={() => setShowModelHubModal(true)}
          >
            <span>⬇ AI Model Hub (1-Click)</span>
            <span
              style={{
                fontSize: "0.7rem",
                color: ollamaOnline ? "#4ade80" : "var(--oxide-ember)",
                fontWeight: 600,
              }}
            >
              {ollamaModels.length} installed
            </span>
          </button>
          <button
            className="ag-nav-item"
            onClick={() => setShowSettingsModal(true)}
          >
            <span>⚡ Subagents &amp; Routing</span>
            <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
              Max {providerConfig.max_concurrent_subagents}
            </span>
          </button>
          <button
            className="ag-nav-item"
            onClick={() => setShowMcpModal(true)}
          >
            <span>🔌 Customizations (MCP)</span>
            <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
              {mcpServers.filter((s) => s.enabled).length} active
            </span>
          </button>
        </div>

        {/* Multi-Project & Saved Conversations Tree */}
        <div className="ag-projects-header">
          <span>Projects</span>
          <button
            className="ag-icon-btn"
            onClick={handlePickProjectFolder}
            title="Add / Open Another Project Folder"
            style={{ padding: "0.1rem 0.35rem", fontSize: "0.78rem" }}
          >
            + Folder
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
                  title={`${proj.path}\nClick to start a new conversation in ${proj.name}`}
                >
                  <span>📁 {proj.name}</span>
                  <span style={{ fontSize: "0.72rem", opacity: 0.6 }}>+</span>
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
                      <span
                        className="ag-conv-meta"
                        onClick={(e) => handleDeleteConversation(e, conv.id)}
                        title="Delete conversation"
                      >
                        {isActive && isRunning ? "⟳" : conv.updatedAt}
                      </span>
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
            onClick={() => setShowSettingsModal(true)}
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
            onClick={async () => {
              setShowUpdateModal(true);
              oxideBridge
                .checkGithubUpdate()
                .then(setUpdateStatus)
                .catch(() => {});
            }}
          >
            ↻ {updateStatus?.update_available ? "Update!" : "Update"}
          </button>
        </div>
      </aside>

      {/* ==================== CENTER MAIN WORKSPACE ==================== */}
      <main className="ag-main">
        {/* Top Breadcrumb Bar */}
        <header className="ag-topbar">
          <div className="ag-breadcrumbs">
            <span
              className="ag-breadcrumb-project"
              onClick={handlePickProjectFolder}
              title={`Current folder: ${activeProject?.path}\nClick to switch project folder`}
            >
              {activeProject?.name || "Workspace"}
            </span>
            <span>/</span>
            <span className="ag-breadcrumb-conv">
              {activeConversation?.title || "Session"}
            </span>
          </div>

          <div className="ag-topbar-right">
            {hwSpecs && (
              <button
                className="ag-pill-btn"
                onClick={() => setShowSettingsModal(true)}
                title={`${hwSpecs.governor_tier}: ${hwSpecs.governor_advice}`}
              >
                <span>🖥 {hwSpecs.available_ram_gb}GB free</span>
                <span>•</span>
                <span>
                  Max{" "}
                  {Math.min(
                    providerConfig.max_concurrent_subagents,
                    hwSpecs.hard_limit_subagents
                  )}{" "}
                  Subagents
                </span>
              </button>
            )}

            <button
              className="ag-pill-btn"
              onClick={() =>
                oxideBridge.openInVsCode(activeFile || activeProject?.path)
              }
              title="Open current project or file in Visual Studio Code"
            >
              Open IDE
            </button>

            <button
              className={`ag-pill-btn ${showRightPanel ? "active" : ""}`}
              onClick={() => setShowRightPanel((v) => !v)}
              title="Toggle Overview & Files Panel"
            >
              ▤
            </button>
          </div>
        </header>

        <div className="ag-workspace-body">
          {/* Center Conversation Column */}
          <div className="ag-center-column">
            <div className="ag-chat-scroll">
              <div className="ag-chat-container">
                {(!activeConversation ||
                  activeConversation.turns.length === 0) &&
                  !isRunning && (
                    <div
                      style={{
                        marginTop: "12vh",
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
                        {activeProject?.name || "Oxide Studio"}
                      </div>
                      <div
                        style={{
                          fontSize: "0.82rem",
                          color: "var(--text-secondary)",
                          maxWidth: "460px",
                        }}
                      >
                        Folder: <code>{activeProject?.path}</code>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          gap: "0.5rem",
                          flexWrap: "wrap",
                          justifyContent: "center",
                          marginTop: "0.4rem",
                        }}
                      >
                        <button
                          className="ag-pill-btn"
                          onClick={handlePickProjectFolder}
                        >
                          📁 Open Project Folder...
                        </button>
                        <button
                          className="ag-pill-btn"
                          onClick={() => {
                            setRightDrawer("files");
                            setShowRightPanel(true);
                          }}
                        >
                          📄 Browse Files ({files.length})
                        </button>
                        <button
                          className="ag-pill-btn"
                          onClick={() =>
                            handleRunTask(
                              "List the files in this project folder and give me a concise overview of its structure."
                            )
                          }
                        >
                          🔍 Analyze This Folder
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
                          <div className="ag-thought-box">{turn.thought}</div>
                        )}

                        {turn.steps.map((st) => (
                          <div key={st.id} className="ag-inline-step">
                            <span>
                              {st.status === "succeeded"
                                ? "✔"
                                : st.status === "self_correcting"
                                ? "⚠"
                                : "•"}
                            </span>
                            <span>{st.title}</span>
                            {st.detail && (
                              <span style={{ color: "var(--text-muted)" }}>
                                — {st.detail}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>

                      <div className="ag-assistant-reply">
                        {turn.assistantReply}
                      </div>
                    </div>
                  );
                })}

                {/* Active Streaming Turn */}
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
                        <span style={{ color: "var(--oxide-rust)" }}>
                          ⟳ Thinking ({providerConfig.task_routing.architect_model})...
                        </span>
                      </div>
                      {liveThinking && (
                        <div className="ag-thought-box">{liveThinking}</div>
                      )}
                      {planChecklist.length > 0 && (
                        <div
                          style={{
                            display: "flex",
                            gap: "0.35rem",
                            flexWrap: "wrap",
                          }}
                        >
                          {planChecklist.map((p, i) => (
                            <span
                              key={i}
                              style={{
                                fontSize: "0.72rem",
                                background: "var(--bg-elevated)",
                                padding: "0.15rem 0.5rem",
                                borderRadius: 5,
                                color: "var(--text-secondary)",
                              }}
                            >
                              {i + 1}. {p}
                            </span>
                          ))}
                        </div>
                      )}
                      {liveSteps.map((st) => (
                        <div key={st.id} className="ag-inline-step">
                          <span>•</span>
                          <span>{st.title}</span>
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

            {/* Bottom Floating Antigravity Composer Card */}
            <div className="ag-composer-wrap">
              <div className="ag-composer-card">
                <textarea
                  className="ag-composer-input"
                  placeholder="Ask Oxide anything, edit files, run terminal commands, or delegate to subagents..."
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
                  <div className="ag-toolbar-left">
                    <button
                      className="ag-icon-btn"
                      onClick={handlePickProjectFolder}
                      title="Open / Switch Project Folder"
                    >
                      +
                    </button>

                    <select
                      className="ag-model-picker-inline"
                      value={providerConfig.task_routing.architect_model}
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
                          style={{ background: "#1a1a1e", color: "#ececef" }}
                        >
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="ag-toolbar-right">
                    {statusBanner && (
                      <span
                        style={{
                          fontSize: "0.72rem",
                          color: "var(--text-muted)",
                        }}
                      >
                        {statusBanner}
                      </span>
                    )}
                    <button
                      className="ag-model-picker-inline"
                      onClick={() => setShowModelHubModal(true)}
                      title="Open 1-Click AI Model Hub (Ollama & HuggingFace)"
                    >
                      ⬇ + Install AI
                    </button>
                    <button
                      className="ag-model-picker-inline"
                      onClick={() => setShowSettingsModal(true)}
                      title="Configure Subagents & PC Governor"
                    >
                      ⚡ Turbo ({providerConfig.max_concurrent_subagents} Sub)
                    </button>

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

          {/* ==================== RIGHT FLOATING OVERVIEW CARD & DRAWER ==================== */}
          {showRightPanel && (
            <aside className="ag-right-dock">
              <div className="ag-overview-card">
                <div className="ag-overview-header">
                  <span>Overview</span>
                  <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
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
                    <span>📋 Review &amp; Git</span>
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
                    <span>📁 Files</span>
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
                    onClick={() => setShowMcpModal(true)}
                  >
                    <span>🔌 Extensions (MCP)</span>
                    <span style={{ fontSize: "0.72rem" }}>›</span>
                  </button>
                </div>

                {/* Subagents & Background Tasks */}
                <div className="ag-overview-section">
                  <div
                    style={{
                      fontSize: "0.72rem",
                      fontWeight: 600,
                      color: "var(--text-muted)",
                    }}
                  >
                    Background Tasks &amp; Subagents ({subagents.length})
                  </div>
                  {subagents.slice(0, 3).map((s) => (
                    <div
                      key={s.id}
                      style={{
                        fontSize: "0.75rem",
                        color: "var(--text-secondary)",
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <span>🤖 {s.title}</span>
                      <span style={{ color: "var(--oxide-rust)" }}>
                        {s.state}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Contextual Side Drawer Content (Files / Editor / Git Review / Terminal) */}
              {rightDrawer === "files" && (
                <div className="ag-drawer-panel">
                  <div className="ag-overview-header">
                    <span>Files ({currentDir})</span>
                    <div style={{ display: "flex", gap: "0.25rem" }}>
                      {currentDir !== "." && (
                        <button
                          className="ag-icon-btn"
                          onClick={() => {
                            const parent =
                              currentDir.split("/").slice(0, -1).join("/") ||
                              ".";
                            setCurrentDir(parent);
                            oxideBridge
                              .listWorkspaceFiles(parent)
                              .then(setFiles);
                          }}
                        >
                          ↑
                        </button>
                      )}
                      <button
                        className="ag-icon-btn"
                        onClick={handleCreateNewFile}
                        title="New File"
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
                    {files.map((f) => (
                      <div
                        key={f.relative_path}
                        className={`file-item ${
                          activeFile === f.relative_path ? "active" : ""
                        }`}
                        onClick={() => handleOpenFileOrDir(f)}
                      >
                        <span>
                          {f.is_dir ? "📁 " : "📄 "}
                          {f.name}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {rightDrawer === "editor" && activeFile && (
                <div className="ag-drawer-panel">
                  <div className="ag-overview-header">
                    <span>📄 {activeFile}</span>
                    <div style={{ display: "flex", gap: "0.3rem" }}>
                      <button
                        className="ag-icon-btn"
                        onClick={handleSaveActiveFile}
                        title="Save File"
                      >
                        💾
                      </button>
                      <button
                        className="ag-icon-btn"
                        onClick={() => setRightDrawer("files")}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                  <textarea
                    className="code-editor"
                    value={activeFileContent}
                    onChange={(e) => setActiveFileContent(e.target.value)}
                  />
                </div>
              )}

              {rightDrawer === "review" && (
                <div className="ag-drawer-panel" style={{ padding: "0.75rem" }}>
                  <div
                    style={{
                      display: "flex",
                      gap: "0.4rem",
                      marginBottom: "0.75rem",
                    }}
                  >
                    <button
                      className="btn"
                      onClick={() => handleGitAction("pull")}
                    >
                      ⬇ Pull
                    </button>
                    <button
                      className="btn btn-primary"
                      onClick={() => handleGitAction("commit")}
                    >
                      ✔ Commit
                    </button>
                    <button
                      className="btn"
                      onClick={() => handleGitAction("push")}
                    >
                      ⬆ Push
                    </button>
                  </div>
                  <div
                    style={{
                      fontSize: "0.75rem",
                      color: "var(--text-secondary)",
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.3rem",
                    }}
                  >
                    {gitStatus?.changed_files.length ? (
                      gitStatus.changed_files.map((f, i) => (
                        <div key={i}>• {f}</div>
                      ))
                    ) : (
                      <div>Working tree is clean.</div>
                    )}
                  </div>
                </div>
              )}

              {rightDrawer === "terminal" && (
                <div
                  className="ag-drawer-panel"
                  style={{ padding: "0.75rem", gap: "0.6rem" }}
                >
                  <div style={{ display: "flex", gap: "0.4rem" }}>
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

      {/* ==================== 1-CLICK AI MODEL HUB (OLLAMA + HUGGINGFACE) ==================== */}
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
                  ⬇ 1-Click AI Model Hub (Ollama &amp; HuggingFace GGUF)
                </h3>
                <div
                  style={{
                    fontSize: "0.78rem",
                    color: "var(--text-secondary)",
                    marginTop: "0.2rem",
                  }}
                >
                  Auto-matched to your PC hardware • Filter by Coding,
                  Uncensored/Abliterated, Reasoning &amp; Fast Subagents
                </div>
              </div>
              <button
                className="btn"
                onClick={() => setShowModelHubModal(false)}
              >
                ✕ Close
              </button>
            </div>

            {/* PC Specs & Ollama Runtime Banner */}
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
                      ? `Online (${ollamaModels.length} models ready)`
                      : "Not detected / Offline"}
                  </strong>
                  {" • "}
                  Active Lead AI:{" "}
                  <code>{providerConfig.task_routing.architect_model}</code>
                  {" • "}
                  Subagent:{" "}
                  <code>{providerConfig.task_routing.coder_subagent_model}</code>
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
                <button
                  className="btn"
                  onClick={handleAutoAssignOptimalModels}
                  title="Auto-assign installed models to Lead Architect and Subagents based on your PC RAM/VRAM"
                >
                  ✨ Auto-Assign Best Models for PC
                </button>
              </div>
            </div>

            {/* Category & Uncensored / Coding Filter Bar */}
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

            {/* Search & Live HuggingFace GGUF Lookup + Direct Tag Pull */}
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
                  : "🤗 Search HuggingFace Hub Live"}
              </button>
              {hfSearchResults.length > 0 && (
                <button
                  className="btn"
                  onClick={() => setHfSearchResults([])}
                >
                  Clear HF Results ({hfSearchResults.length})
                </button>
              )}
            </div>

            {/* Direct Custom Ollama / HuggingFace Repo 1-Click Pull */}
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
                  : "⬇ Pull Custom Model"}
              </button>
            </div>

            {/* Filtered Model Cards Grid */}
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
                              download
                            </div>
                          </div>

                          <span
                            className={`hw-fit-badge ${fit.tier}`}
                            title={fit.detail}
                          >
                            {fit.label}
                          </span>
                        </div>

                        {/* Capability Badges */}
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
                                  setOllamaModels((prev) =>
                                    prev.includes(model.install_id)
                                      ? prev
                                      : [model.install_id, ...prev]
                                  );
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
                                : "⬇ 1-Click Install"}
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
                                    `Set ${model.name} as Lead Architect AI`
                                  );
                                }}
                              >
                                {isLead ? "✓ Lead AI" : "🧠 Use as Lead"}
                              </button>
                              <button
                                className={`btn ${
                                  isSubagent ? "btn-primary" : ""
                                }`}
                                onClick={async () => {
                                  const next: ProviderConfig = {
                                    ...providerConfig,
                                    task_routing: {
                                      ...providerConfig.task_routing,
                                      coder_subagent_model: model.install_id,
                                      tester_subagent_model: model.install_id,
                                    },
                                  };
                                  const saved =
                                    await oxideBridge.updateProviderConfig(
                                      next
                                    );
                                  setProviderConfig(saved);
                                  setStatusBanner(
                                    `Set ${model.name} as Fast Subagent AI`
                                  );
                                }}
                              >
                                {isSubagent
                                  ? "✓ Subagent"
                                  : "⚡ Use as Subagent"}
                              </button>
                              <button
                                className="btn"
                                title="Uninstall model from disk"
                                onClick={async () => {
                                  await oxideBridge.deleteAiModel(
                                    model.install_id
                                  );
                                  setOllamaModels((prev) =>
                                    prev.filter((m) => m !== model.install_id)
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

      {/* ==================== SETTINGS & SUBAGENTS MODAL ==================== */}
      {showSettingsModal && (
        <div
          className="modal-backdrop"
          onClick={() => setShowSettingsModal(false)}
        >
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <h3>⚙ Subagents, Task Model Routing &amp; PC Governor</h3>
              <button
                className="btn btn-primary"
                onClick={handleAutoAssignOptimalModels}
              >
                ✨ Auto-Configure for My PC
              </button>
            </div>

            {hwSpecs && (
              <div className="hw-spec-box">
                <strong>
                  🖥 {hwSpecs.governor_tier} ({hwSpecs.available_ram_gb} GB Free
                  / {hwSpecs.total_ram_gb} GB RAM • {hwSpecs.cpu_cores} Cores)
                </strong>
                <div style={{ color: "var(--text-secondary)" }}>
                  {hwSpecs.governor_advice}
                </div>
              </div>
            )}

            <div className="routing-grid">
              <div className="form-group">
                <label>🧠 Lead Architect AI (Complex Thinking)</label>
                <input
                  className="workspace-input"
                  value={providerConfig.task_routing.architect_model}
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
                />
              </div>

              <div className="form-group">
                <label>💻 Coder Subagent (Fast File Edits)</label>
                <input
                  className="workspace-input"
                  value={providerConfig.task_routing.coder_subagent_model}
                  onChange={(e) =>
                    setProviderConfig({
                      ...providerConfig,
                      task_routing: {
                        ...providerConfig.task_routing,
                        coder_subagent_model: e.target.value,
                      },
                    })
                  }
                />
              </div>

              <div className="form-group">
                <label>🔍 Research Subagent (Fast Search)</label>
                <input
                  className="workspace-input"
                  value={providerConfig.task_routing.research_subagent_model}
                  onChange={(e) =>
                    setProviderConfig({
                      ...providerConfig,
                      task_routing: {
                        ...providerConfig.task_routing,
                        research_subagent_model: e.target.value,
                      },
                    })
                  }
                />
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
                      max_concurrent_subagents: parseInt(e.target.value, 10),
                    })
                  }
                />
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
                className="btn"
                onClick={() => setShowSettingsModal(false)}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={async () => {
                  const saved = await oxideBridge.updateProviderConfig(
                    providerConfig
                  );
                  setProviderConfig(saved);
                  setShowSettingsModal(false);
                }}
              >
                Save Settings
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== MCP HUB MODAL ==================== */}
      {showMcpModal && (
        <div
          className="modal-backdrop"
          onClick={() => setShowMcpModal(false)}
        >
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>🔌 Model Context Protocol (MCP) Servers</h3>
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

            <div className="routing-grid">
              <input
                className="workspace-input"
                placeholder="Server ID"
                value={newMcpId}
                onChange={(e) => setNewMcpId(e.target.value)}
              />
              <input
                className="workspace-input"
                placeholder="Command (e.g. npx)"
                value={newMcpCommand}
                onChange={(e) => setNewMcpCommand(e.target.value)}
              />
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
              }}
            >
              <button
                className="btn"
                onClick={async () => {
                  if (!newMcpId.trim()) return;
                  const list = await oxideBridge.saveMcpServer({
                    id: newMcpId.trim(),
                    name: newMcpId.trim(),
                    transport: "stdio",
                    command: newMcpCommand.trim(),
                    args: ["-y", "@modelcontextprotocol/server-memory"],
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
                + Add Server
              </button>
              <button
                className="btn btn-primary"
                onClick={() => setShowMcpModal(false)}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== GITHUB SELF-UPDATER MODAL ==================== */}
      {showUpdateModal && (
        <div
          className="modal-backdrop"
          onClick={() => setShowUpdateModal(false)}
        >
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>↻ Update Oxide from GitHub</h3>
            {updateStatus && (
              <div className="hw-spec-box">
                <div>
                  Installed: <code>{updateStatus.current_version}</code>
                </div>
                <div>
                  Latest on GitHub: <code>{updateStatus.latest_version}</code>
                </div>
                <div>Latest Commit: {updateStatus.latest_commit_message}</div>
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
                className="btn"
                onClick={() => setShowUpdateModal(false)}
              >
                Close
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
        </div>
      )}
    </div>
  );
};
