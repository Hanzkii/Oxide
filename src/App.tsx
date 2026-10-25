import React, { useEffect, useState } from "react";
import { oxideBridge } from "./services/tauriBridge";
import {
  AgentRoleKind,
  CommandExecutionResult,
  GitCommitRecord,
  GitStatusSummary,
  HardwareSpecs,
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

interface ChatEntry {
  role: "user" | "assistant";
  content: string;
}

export const App: React.FC = () => {
  const [workspacePath, setWorkspacePath] = useState<string>(".");
  const [files, setFiles] = useState<WorkspaceFileEntry[]>([]);
  const [currentDir, setCurrentDir] = useState<string>(".");
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [activeFileContent, setActiveFileContent] = useState<string>("");
  const [centerTab, setCenterTab] = useState<"agent" | "editor">("agent");

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
  const [ollamaOnline, setOllamaOnline] = useState<boolean>(false);

  // Live AI Thinking, Plan & Subagents State
  const [liveThinking, setLiveThinking] = useState<string>(
    "Lead Architect AI ready. Dispatch a task to watch real-time reasoning (<think>...) and hardware-governed Subagent delegation."
  );
  const [planChecklist, setPlanChecklist] = useState<string[]>([]);
  const [subagents, setSubagents] = useState<SubagentItem[]>([]);

  // Modals
  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false);
  const [showUpdateModal, setShowUpdateModal] = useState<boolean>(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [isUpdating, setIsUpdating] = useState<boolean>(false);

  // Agent & Terminal State
  const [prompt, setPrompt] = useState<string>("");
  const [quickCommand, setQuickCommand] = useState<string>("git status");
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [chatHistory, setChatHistory] = useState<ChatEntry[]>([]);
  const [streamingBuffer, setStreamingBuffer] = useState<string>("");
  const [workflowCards, setWorkflowCards] = useState<WorkflowCardItem[]>([]);
  const [terminalLogs, setTerminalLogs] = useState<CommandExecutionResult[]>(
    []
  );
  const [commits, setCommits] = useState<GitCommitRecord[]>([]);
  const [statusBanner, setStatusBanner] = useState<string>(
    "Oxide Studio Ready — Hardware-Governed Subagents & Task Model Routing Active"
  );

  const refreshWorkspaceState = async (dir: string = currentDir) => {
    try {
      const [fileList, git, health, hw] = await Promise.all([
        oxideBridge.listWorkspaceFiles(dir),
        oxideBridge.getGitStatus(),
        oxideBridge.getProviderHealth(),
        oxideBridge.getHardwareSpecs(),
      ]);
      setFiles(fileList);
      setGitStatus(git);
      setHwSpecs(hw);
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
    oxideBridge
      .setWorkspace(".")
      .then((info) => {
        setWorkspacePath(info.canonical_path);
        setGitStatus(info.git);
      })
      .catch(() => {});

    refreshWorkspaceState(".");

    oxideBridge
      .checkGithubUpdate()
      .then((st) => setUpdateStatus(st))
      .catch(() => {});

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
          setWorkflowCards((prev) => [
            {
              id: `${event.step}-${Date.now()}-${Math.random()}`,
              step: event.step,
              title: event.title,
              detail: event.detail,
              status: event.status,
            },
            ...prev,
          ]);
          break;
        case "file_change":
          refreshWorkspaceState(currentDir);
          break;
        case "terminal_output":
          setTerminalLogs((prev) => [event.result, ...prev]);
          break;
        case "git_milestone":
          setCommits((prev) => [event.commit, ...prev]);
          refreshWorkspaceState(currentDir);
          break;
        case "task_completed":
          setStatusBanner(
            `Completed in ${event.steps_taken} step(s): ${event.summary}`
          );
          refreshWorkspaceState(currentDir);
          break;
        case "task_error":
          setStatusBanner(`Agent Error: ${event.message}`);
          break;
      }
    });

    return () => {
      clearInterval(hwTimer);
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const handleBindWorkspace = async () => {
    if (!workspacePath.trim()) return;
    try {
      const info = await oxideBridge.setWorkspace(workspacePath.trim());
      setWorkspacePath(info.canonical_path);
      setGitStatus(info.git);
      setCurrentDir(".");
      await refreshWorkspaceState(".");
      setStatusBanner(`Bound workspace sandbox to ${info.canonical_path}`);
    } catch (err: any) {
      setStatusBanner(`Workspace error: ${err?.message || String(err)}`);
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
      setCenterTab("editor");
      setStatusBanner(`Opened ${entry.relative_path} in GUI Editor`);
    }
  };

  const handleSaveActiveFile = async () => {
    if (!activeFile) return;
    try {
      await oxideBridge.saveWorkspaceFile(activeFile, activeFileContent);
      await refreshWorkspaceState(currentDir);
      setStatusBanner(`Saved changes to ${activeFile}`);
    } catch (err: any) {
      setStatusBanner(`Save failed: ${err?.message}`);
    }
  };

  const handleCreateNewFile = async () => {
    const name = window.prompt(
      "Enter new file path relative to workspace (e.g. src/newComponent.tsx):"
    );
    if (!name?.trim()) return;
    try {
      await oxideBridge.saveWorkspaceFile(name.trim(), "");
      await refreshWorkspaceState(currentDir);
      setActiveFile(name.trim());
      setActiveFileContent("");
      setCenterTab("editor");
      setStatusBanner(`Created file ${name.trim()}`);
    } catch (err: any) {
      setStatusBanner(`Create file error: ${err?.message}`);
    }
  };

  const handleMoveActiveFile = async () => {
    if (!activeFile) return;
    const dst = window.prompt(`Move/Rename '${activeFile}' to:`, activeFile);
    if (!dst?.trim() || dst.trim() === activeFile) return;
    try {
      await oxideBridge.moveWorkspaceFile(activeFile, dst.trim());
      setActiveFile(dst.trim());
      await refreshWorkspaceState(currentDir);
      setStatusBanner(`Moved ${activeFile} -> ${dst.trim()}`);
    } catch (err: any) {
      setStatusBanner(`Move failed: ${err?.message}`);
    }
  };

  const handleDeleteActiveFile = async () => {
    if (!activeFile) return;
    if (!window.confirm(`Delete '${activeFile}' from workspace?`)) return;
    try {
      await oxideBridge.deleteWorkspaceFile(activeFile);
      setActiveFile(null);
      setCenterTab("agent");
      await refreshWorkspaceState(currentDir);
      setStatusBanner(`Deleted ${activeFile}`);
    } catch (err: any) {
      setStatusBanner(`Delete failed: ${err?.message}`);
    }
  };

  const handleGitAction = async (op: "pull" | "push" | "commit") => {
    try {
      setStatusBanner(`Running git ${op}...`);
      if (op === "commit") {
        const msg =
          window.prompt(
            "Commit message (leave blank for AI auto-generated milestone message):"
          ) || "feat: update workspace milestone";
        const rec = await oxideBridge.triggerGitMilestone(msg);
        if (rec) {
          setCommits((prev) => [rec, ...prev]);
          setStatusBanner(`Committed [${rec.commit_hash}] ${rec.message}`);
        } else {
          setStatusBanner("Working tree is clean — nothing to commit.");
        }
      } else {
        const res = await oxideBridge.gitSyncAction(op);
        setTerminalLogs((prev) => [res, ...prev]);
        setStatusBanner(
          `git ${op} finished (exit=${res.exit_code}): ${
            res.stdout.trim() || res.stderr.trim() || "OK"
          }`
        );
      }
      await refreshWorkspaceState(currentDir);
    } catch (err: any) {
      setStatusBanner(`Git ${op} error: ${err?.message}`);
    }
  };

  const handleCheckUpdateModal = async () => {
    setShowUpdateModal(true);
    try {
      const latest = await oxideBridge.checkGithubUpdate();
      setUpdateStatus(latest);
    } catch (err: any) {
      setStatusBanner(`Update check failed: ${err?.message}`);
    }
  };

  const handlePerformUpdate = async () => {
    setIsUpdating(true);
    try {
      const res = await oxideBridge.performGithubUpdate();
      setStatusBanner(res.message);
      const refreshed = await oxideBridge.checkGithubUpdate();
      setUpdateStatus(refreshed);
    } catch (err: any) {
      setStatusBanner(`Update failed: ${err?.message}`);
    } finally {
      setIsUpdating(false);
    }
  };

  const handleAutoAssignOptimalModels = async () => {
    const hw = await oxideBridge.getHardwareSpecs();
    setHwSpecs(hw);

    // Choose optimal models based on PC RAM & VRAM
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
      ["gemma2:latest", "qwen2.5-coder:3b", "qwen2.5-coder:7b"],
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

    setProviderConfig(updated);
    setStatusBanner(
      `Auto-configured for ${hw.governor_tier}: Architect=${architect}, Subagents=${coder}/${research} (Max ${hw.recommended_max_subagents} concurrent)`
    );
  };

  const handleRunTask = async (customPrompt?: string) => {
    const taskPrompt = (customPrompt ?? prompt).trim();
    if (!taskPrompt || isRunning) return;
    if (!customPrompt) setPrompt("");
    setCenterTab("agent");
    setStreamingBuffer("");
    setLiveThinking(
      `Lead Architect (${providerConfig.task_routing.architect_model}) is analyzing "${taskPrompt}" and planning Subagent delegation...`
    );
    setIsRunning(true);
    setChatHistory((prev) => [...prev, { role: "user", content: taskPrompt }]);

    try {
      const finalReply = await oxideBridge.runAgentTask(taskPrompt);
      setChatHistory((prev) => [
        ...prev,
        { role: "assistant", content: finalReply },
      ]);
      setStreamingBuffer("");
      await refreshWorkspaceState(currentDir);
    } catch (err: any) {
      setStatusBanner(
        `Agent execution halted: ${err?.message || String(err)}`
      );
    } finally {
      setIsRunning(false);
    }
  };

  const handleQuickCommand = async () => {
    if (!quickCommand.trim()) return;
    try {
      const res = await oxideBridge.executeBoundedCommand(quickCommand.trim());
      setTerminalLogs((prev) => [res, ...prev]);
      await refreshWorkspaceState(currentDir);
      setStatusBanner(
        `Command '${res.program}' exited with code ${res.exit_code} (${res.duration_ms} ms)`
      );
    } catch (err: any) {
      setStatusBanner(`Command error: ${err?.message}`);
    }
  };

  const handleSaveSettings = async (updated: ProviderConfig) => {
    const saved = await oxideBridge.updateProviderConfig(updated);
    setProviderConfig(saved);
    setShowSettingsModal(false);
    setStatusBanner(
      `Saved Task Routing: Architect=${saved.task_routing.architect_model} | Max Concurrent Subagents=${saved.max_concurrent_subagents}`
    );
  };

  return (
    <div className="app-shell">
      {/* Top GUI Command Bar */}
      <header className="command-header">
        <div className="brand-group">
          <span className="brand-badge">OXIDE STUDIO</span>
          <span className="status-pill">
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                backgroundColor: ollamaOnline ? "#10b981" : "#f59e0b",
              }}
            />
            Arch: {providerConfig.task_routing.architect_model}
          </span>

          {hwSpecs && (
            <span
              className={`status-pill hw-pill ${
                hwSpecs.throttled_by_load ? "throttled" : ""
              }`}
              onClick={() => setShowSettingsModal(true)}
              title={`${hwSpecs.governor_tier}: ${hwSpecs.governor_advice}`}
            >
              🖥 RAM {hwSpecs.available_ram_gb}GB free / {hwSpecs.total_ram_gb}GB
              • CPU {hwSpecs.cpu_usage_percent}% • Max{" "}
              {Math.min(
                providerConfig.max_concurrent_subagents,
                hwSpecs.hard_limit_subagents
              )}{" "}
              Subagent(s)
            </span>
          )}

          {gitStatus && (
            <span className="status-pill">
              🌿 {gitStatus.branch}{" "}
              {gitStatus.is_clean
                ? "(clean)"
                : `(${gitStatus.changed_files.length} changed)`}
            </span>
          )}
        </div>

        <div className="workspace-bar">
          <input
            className="workspace-input"
            type="text"
            value={workspacePath}
            onChange={(e) => setWorkspacePath(e.target.value)}
            placeholder="Workspace path..."
          />
          <button className="btn" onClick={handleBindWorkspace}>
            Set Folder
          </button>
        </div>

        <div className="header-actions">
          <button
            className="btn"
            onClick={() => handleGitAction("pull")}
            title="Pull latest changes from Git remote"
          >
            ⬇ Git Pull
          </button>
          <button
            className="btn"
            onClick={() => handleGitAction("commit")}
            title="Stage all & commit milestone"
          >
            ✔ Commit
          </button>
          <button
            className="btn"
            onClick={() => handleGitAction("push")}
            title="Push commits to Git remote"
          >
            ⬆ Git Push
          </button>

          <button
            className="btn"
            onClick={() => setShowSettingsModal(true)}
            title="Configure Lead Architect AI, Subagent Task Models & PC Hardware Limits"
          >
            ⚙ Subagents &amp; Models
          </button>

          <button
            className={`btn btn-update ${
              updateStatus?.update_available ? "has-update" : ""
            }`}
            onClick={handleCheckUpdateModal}
            title="Check & install updates from GitHub (Hanzkii/Oxide)"
          >
            ↻ {updateStatus?.update_available ? "Update Available!" : "Update"}
          </button>

          <button
            className="btn btn-vscode"
            onClick={() => oxideBridge.openInVsCode(activeFile || undefined)}
            title="Open workspace or active file in Visual Studio Code"
          >
            Open in VS Code
          </button>
        </div>
      </header>

      {/* Main 3-Pane GUI Studio */}
      <div className="studio-grid">
        {/* Left Sidebar: Interactive Workspace File Explorer */}
        <aside className="sidebar-explorer">
          <div className="sidebar-header">
            <span>Files ({currentDir})</span>
            <div style={{ display: "flex", gap: "0.3rem" }}>
              {currentDir !== "." && (
                <button
                  className="btn"
                  style={{ padding: "0.15rem 0.4rem", fontSize: "0.7rem" }}
                  onClick={() => {
                    const parent =
                      currentDir.split("/").slice(0, -1).join("/") || ".";
                    setCurrentDir(parent);
                    oxideBridge.listWorkspaceFiles(parent).then(setFiles);
                  }}
                >
                  ↑ Up
                </button>
              )}
              <button
                className="btn"
                style={{ padding: "0.15rem 0.4rem", fontSize: "0.7rem" }}
                onClick={handleCreateNewFile}
                title="Create new file"
              >
                + File
              </button>
            </div>
          </div>

          <div className="file-list">
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
                {!f.is_dir && (
                  <span style={{ fontSize: "0.68rem", color: "#64748b" }}>
                    {Math.max(1, Math.round(f.size_bytes / 1024))}KB
                  </span>
                )}
              </div>
            ))}
          </div>
        </aside>

        {/* Center Pane: AI Thinking Box + Autonomous Chat / File Editor */}
        <section className="center-pane">
          <div className="center-tabs">
            <button
              className={`tab-btn ${centerTab === "agent" ? "active" : ""}`}
              onClick={() => setCenterTab("agent")}
            >
              🤖 Architect &amp; Subagents Studio
            </button>
            <button
              className={`tab-btn ${centerTab === "editor" ? "active" : ""}`}
              onClick={() => setCenterTab("editor")}
            >
              📝 File Editor {activeFile ? `(${activeFile})` : ""}
            </button>
          </div>

          {/* Real-Time AI Thinking & Task Plan Panel (Always Visible) */}
          <div className="thinking-box">
            <div className="thinking-header">
              <span>
                🧠 Lead Architect Live Thinking{" "}
                {isRunning ? "(ACTIVE...)" : "(IDLE)"}
              </span>
              <span style={{ fontSize: "0.7rem", opacity: 0.85 }}>
                Architect: {providerConfig.task_routing.architect_model} • Coder
                Sub: {providerConfig.task_routing.coder_subagent_model} •
                Research Sub:{" "}
                {providerConfig.task_routing.research_subagent_model}
              </span>
            </div>
            <div className="thinking-content">{liveThinking}</div>
            {planChecklist.length > 0 && (
              <div className="plan-checklist">
                {planChecklist.map((item, i) => (
                  <span key={i} className="plan-chip">
                    {i + 1}. {item}
                  </span>
                ))}
              </div>
            )}
          </div>

          {centerTab === "agent" ? (
            <>
              <div className="stream-viewport">
                {chatHistory.length === 0 && !streamingBuffer && (
                  <div className="message-card">
                    <strong>
                      Oxide Hierarchical AI Orchestrator + Hardware-Governed
                      Subagents
                    </strong>
                    {"\n"}• <strong>Lead Architect AI</strong> (
                    <code>{providerConfig.task_routing.architect_model}</code>)
                    handles complex thinking and instructs specialized{" "}
                    <strong>Subagents</strong>.
                    {"\n"}• <strong>Task-Specific Models</strong>: Coder
                    Subagent (
                    <code>
                      {providerConfig.task_routing.coder_subagent_model}
                    </code>
                    ), Research Subagent (
                    <code>
                      {providerConfig.task_routing.research_subagent_model}
                    </code>
                    ), Tester Subagent (
                    <code>
                      {providerConfig.task_routing.tester_subagent_model}
                    </code>
                    ).
                    {"\n"}• <strong>PC Hardware Governor</strong>:{" "}
                    {hwSpecs
                      ? `${hwSpecs.governor_tier} — Caps concurrent subagents to ${hwSpecs.hard_limit_subagents} based on your ${hwSpecs.total_ram_gb} GB RAM & ${hwSpecs.cpu_cores} CPU cores.`
                      : "Inspecting PC specs..."}
                  </div>
                )}

                {chatHistory.map((msg, idx) => (
                  <div key={idx} className={`message-card ${msg.role}`}>
                    {msg.content}
                  </div>
                ))}

                {streamingBuffer && (
                  <div className="message-card assistant">
                    {streamingBuffer}
                  </div>
                )}
              </div>

              <div className="composer-bar">
                <div className="preset-row">
                  <button
                    className="preset-chip"
                    onClick={() =>
                      handleRunTask(
                        "Use delegate_subagents to have research_subagent inspect package.json and coder_subagent review src/App.tsx, then summarize findings."
                      )
                    }
                  >
                    ⚡ Dispatch Subagent Team (Research + Coder)
                  </button>
                  <button
                    className="preset-chip"
                    onClick={() =>
                      handleRunTask(
                        "Run npm run build in the terminal, check if there are any errors, and fix them if needed."
                      )
                    }
                  >
                    🛠 Run Build &amp; Auto-Fix Errors
                  </button>
                  <button
                    className="preset-chip"
                    onClick={() =>
                      handleRunTask(
                        "Check git status, commit any modified files with a clean message, and push to origin."
                      )
                    }
                  >
                    🚀 Auto-Commit &amp; Push to Git
                  </button>
                </div>

                <div className="composer-row">
                  <textarea
                    className="prompt-textarea"
                    placeholder="Ask the Lead Architect AI to plan a task, delegate to Subagents, edit/move files, run terminal commands, or push/pull Git..."
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                        handleRunTask();
                      }
                    }}
                  />
                  <button
                    className="btn btn-primary"
                    onClick={() => handleRunTask()}
                    disabled={isRunning}
                  >
                    {isRunning ? "Running..." : "Run Agent"}
                  </button>
                </div>
                <div style={{ fontSize: "0.73rem", color: "#94a3b8" }}>
                  {statusBanner}
                </div>
              </div>
            </>
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                flex: 1,
                overflow: "hidden",
                marginTop: "0.6rem",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "0.45rem 1rem",
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border-subtle)",
                }}
              >
                <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>
                  {activeFile || "Select a file from the left sidebar"}
                </span>
                {activeFile && (
                  <div style={{ display: "flex", gap: "0.4rem" }}>
                    <button
                      className="btn btn-primary"
                      onClick={handleSaveActiveFile}
                    >
                      💾 Save File
                    </button>
                    <button className="btn" onClick={handleMoveActiveFile}>
                      ✏ Move / Rename
                    </button>
                    <button className="btn" onClick={handleDeleteActiveFile}>
                      🗑 Delete
                    </button>
                  </div>
                )}
              </div>
              <textarea
                className="code-editor"
                value={activeFileContent}
                onChange={(e) => setActiveFileContent(e.target.value)}
                placeholder="Click any file in the left File Explorer to view or edit its contents..."
              />
            </div>
          )}
        </section>

        {/* Right Pane: Subagent Pool, Workflow Status Cards & Interactive Terminal */}
        <aside className="right-pane">
          <div className="telemetry-section">
            <div className="section-title">
              Subagent Worker Pool{" "}
              {hwSpecs &&
                `(PC Safe Limit: Max ${Math.min(
                  providerConfig.max_concurrent_subagents,
                  hwSpecs.hard_limit_subagents
                )} Concurrent)`}
            </div>
            {subagents.length === 0 ? (
              <div
                style={{
                  fontSize: "0.75rem",
                  color: "#64748b",
                  background: "var(--bg-panel)",
                  padding: "0.55rem 0.75rem",
                  borderRadius: 6,
                  border: "1px solid var(--border-subtle)",
                }}
              >
                No subagents active. When the Lead Architect delegates tasks,
                specialized subagent workers and their live thoughts appear here.
              </div>
            ) : (
              subagents.map((sub) => (
                <div
                  key={sub.id}
                  className={`subagent-card ${sub.state}`}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: "0.78rem",
                      fontWeight: 700,
                    }}
                  >
                    <span>
                      🤖 {sub.title} ({sub.role})
                    </span>
                    <span style={{ color: "#38bdf8", fontSize: "0.7rem" }}>
                      {sub.model} • {sub.state.toUpperCase()}
                    </span>
                  </div>
                  <div style={{ fontSize: "0.74rem", color: "#d8b4fe" }}>
                    💭 {sub.thought}
                  </div>
                  {sub.output_preview && (
                    <div
                      style={{
                        fontSize: "0.72rem",
                        color: "#94a3b8",
                        fontFamily: "monospace",
                      }}
                    >
                      {sub.output_preview}
                    </div>
                  )}
                </div>
              ))
            )}

            <div className="section-title" style={{ marginTop: "0.35rem" }}>
              Interactive Terminal Runner
            </div>
            <div className="composer-row">
              <input
                className="workspace-input"
                type="text"
                value={quickCommand}
                onChange={(e) => setQuickCommand(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleQuickCommand();
                }}
                placeholder="Run terminal command (e.g. git status, npm run build)..."
              />
              <button className="btn" onClick={handleQuickCommand}>
                Run Cmd
              </button>
            </div>

            <div className="section-title" style={{ marginTop: "0.35rem" }}>
              Live Agent Activity &amp; Self-Correction Steps
            </div>
            {workflowCards.map((card) => (
              <div key={card.id} className={`workflow-card ${card.status}`}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: "0.79rem",
                    fontWeight: 600,
                  }}
                >
                  <span>{card.title}</span>
                  <span style={{ fontSize: "0.69rem", opacity: 0.8 }}>
                    #{card.step} • {card.status.toUpperCase()}
                  </span>
                </div>
                <div style={{ fontSize: "0.74rem", color: "#94a3b8" }}>
                  {card.detail}
                </div>
              </div>
            ))}

            {commits.length > 0 && (
              <>
                <div className="section-title" style={{ marginTop: "0.35rem" }}>
                  Git Milestones
                </div>
                {commits.map((c, i) => (
                  <div key={i} className="workflow-card succeeded">
                    <strong>
                      [{c.commit_hash}] {c.message}
                    </strong>
                  </div>
                ))}
              </>
            )}

            <div className="section-title" style={{ marginTop: "0.35rem" }}>
              Terminal Output Stream (stdout / stderr)
            </div>
            {terminalLogs.map((log, index) => (
              <div key={index} className="terminal-log">
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginBottom: "0.28rem",
                    color: log.succeeded ? "#10b981" : "#f59e0b",
                  }}
                >
                  <span>
                    $ {log.program} {log.args.join(" ")}
                  </span>
                  <span>
                    exit={log.exit_code} ({log.duration_ms}ms)
                  </span>
                </div>
                {log.stdout && <div>{log.stdout}</div>}
                {log.stderr && <div className="stderr-text">{log.stderr}</div>}
              </div>
            ))}
          </div>
        </aside>
      </div>

      {/* Subagents, Task-to-Model Routing & Hardware Governor Modal */}
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
              <h3>⚙ Subagents, Task Model Routing &amp; Hardware Governor</h3>
              <button
                className="btn btn-primary"
                onClick={handleAutoAssignOptimalModels}
              >
                ✨ Auto-Configure for My PC
              </button>
            </div>

            {hwSpecs && (
              <div className="hw-spec-box">
                <div style={{ fontWeight: 700, color: "#38bdf8" }}>
                  🖥 Detected PC Specs &amp; Live Resource Governor:{" "}
                  {hwSpecs.governor_tier}
                </div>
                <div>
                  • <strong>CPU:</strong> {hwSpecs.cpu_brand} (
                  {hwSpecs.cpu_cores} logical cores • Load:{" "}
                  {hwSpecs.cpu_usage_percent}%)
                </div>
                <div>
                  • <strong>System RAM:</strong> {hwSpecs.available_ram_gb} GB
                  Free / {hwSpecs.total_ram_gb} GB Total (
                  {hwSpecs.used_ram_percent}% used)
                </div>
                <div>
                  • <strong>GPU:</strong> {hwSpecs.gpu_name}{" "}
                  {hwSpecs.gpu_vram_gb > 0
                    ? `(${hwSpecs.gpu_vram_gb} GB VRAM)`
                    : ""}
                </div>
                <div style={{ color: "#fde68a", marginTop: "0.2rem" }}>
                  💡 <strong>Governor Advice:</strong> {hwSpecs.governor_advice}
                </div>
              </div>
            )}

            <div className="section-title">
              Choose Which AI Model Runs Each Task Role
            </div>

            <div className="routing-grid">
              <div className="form-group">
                <label>
                  🧠 Lead Architect AI (Complex Thinking &amp; Planning)
                </label>
                <input
                  className="workspace-input"
                  list="ollama-models-list"
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
                <label>💻 Coder Subagent (Fast Code Writing &amp; Edits)</label>
                <input
                  className="workspace-input"
                  list="ollama-models-list"
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
                <label>
                  🔍 Research Subagent (Fast File Search &amp; Reading)
                </label>
                <input
                  className="workspace-input"
                  list="ollama-models-list"
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
                  🧪 Tester Subagent (Terminal Verification &amp; Fixes)
                </label>
                <input
                  className="workspace-input"
                  list="ollama-models-list"
                  value={providerConfig.task_routing.tester_subagent_model}
                  onChange={(e) =>
                    setProviderConfig({
                      ...providerConfig,
                      task_routing: {
                        ...providerConfig.task_routing,
                        tester_subagent_model: e.target.value,
                      },
                    })
                  }
                />
              </div>
            </div>

            <datalist id="ollama-models-list">
              {ollamaModels.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>

            <div className="section-title">
              Hardware Concurrency Limits (Prevents PC Overload)
            </div>

            <div className="routing-grid">
              <div className="form-group">
                <label>
                  Max Concurrent Subagents (
                  {providerConfig.max_concurrent_subagents} / Hard PC Limit:{" "}
                  {hwSpecs?.hard_limit_subagents ?? 2})
                </label>
                <input
                  type="range"
                  min="1"
                  max={hwSpecs?.hard_limit_subagents ?? 4}
                  step="1"
                  value={Math.min(
                    providerConfig.max_concurrent_subagents,
                    hwSpecs?.hard_limit_subagents ?? 4
                  )}
                  onChange={(e) =>
                    setProviderConfig({
                      ...providerConfig,
                      max_concurrent_subagents: parseInt(e.target.value, 10),
                    })
                  }
                />
              </div>

              <div className="form-group">
                <label>Auto-Throttle When RAM &gt; 85% or CPU &gt; 88%</label>
                <select
                  className="select-control"
                  value={
                    providerConfig.auto_throttle_on_high_load ? "true" : "false"
                  }
                  onChange={(e) =>
                    setProviderConfig({
                      ...providerConfig,
                      auto_throttle_on_high_load: e.target.value === "true",
                    })
                  }
                >
                  <option value="true">
                    Enabled (Queue subagents 1-by-1 under high load)
                  </option>
                  <option value="false">Disabled</option>
                </select>
              </div>
            </div>

            <div className="routing-grid">
              <div className="form-group">
                <label>Primary Backend Provider</label>
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
                  <option value="ollama">
                    Local Ollama (Offline-First Default)
                  </option>
                  <option value="anthropic">
                    Anthropic Claude (ANTHROPIC_API_KEY)
                  </option>
                  <option value="openai">OpenAI (OPENAI_API_KEY)</option>
                </select>
              </div>

              <div className="form-group">
                <label>Ollama Endpoint URL</label>
                <input
                  className="workspace-input"
                  type="text"
                  value={providerConfig.ollama_base_url}
                  onChange={(e) =>
                    setProviderConfig({
                      ...providerConfig,
                      ollama_base_url: e.target.value,
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
                marginTop: "0.3rem",
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
                onClick={() => handleSaveSettings(providerConfig)}
              >
                Save Subagent &amp; Model Settings
              </button>
            </div>
          </div>
        </div>
      )}

      {/* GitHub Self-Updater Modal */}
      {showUpdateModal && (
        <div
          className="modal-backdrop"
          onClick={() => setShowUpdateModal(false)}
        >
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>↻ Update Oxide from GitHub</h3>
            <p style={{ fontSize: "0.82rem", color: "#94a3b8" }}>
              Repository: <code>https://github.com/Hanzkii/Oxide</code>
            </p>

            {updateStatus ? (
              <div
                style={{
                  background: "var(--bg-card)",
                  padding: "0.85rem",
                  borderRadius: 8,
                  fontSize: "0.82rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.4rem",
                }}
              >
                <div>
                  <strong>Installed Version:</strong>{" "}
                  <code>{updateStatus.current_version}</code>
                </div>
                <div>
                  <strong>Latest on GitHub:</strong>{" "}
                  <code>{updateStatus.latest_version}</code>
                </div>
                <div>
                  <strong>Latest Commit:</strong>{" "}
                  {updateStatus.latest_commit_message}
                </div>
                <div>
                  <strong>Status:</strong>{" "}
                  {updateStatus.update_available ? (
                    <span style={{ color: "#10b981", fontWeight: 700 }}>
                      New update available on GitHub!
                    </span>
                  ) : (
                    <span style={{ color: "#38bdf8" }}>
                      You are running the latest version.
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <div>Checking GitHub for updates...</div>
            )}

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginTop: "0.5rem",
              }}
            >
              <a
                href={
                  updateStatus?.release_url ||
                  "https://github.com/Hanzkii/Oxide/releases"
                }
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: "0.8rem", color: "#38bdf8" }}
              >
                Open GitHub Releases Page ↗
              </a>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button
                  className="btn"
                  onClick={() => setShowUpdateModal(false)}
                >
                  Close
                </button>
                <button
                  className="btn btn-primary"
                  onClick={handlePerformUpdate}
                  disabled={isUpdating}
                >
                  {isUpdating
                    ? "Updating from GitHub..."
                    : "Pull & Install Latest Update"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
