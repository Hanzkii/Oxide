import React, { useEffect, useState } from "react";
import { oxideBridge } from "./services/tauriBridge";
import {
  CommandExecutionResult,
  GitCommitRecord,
  GitStatusSummary,
  ProviderConfig,
  ProviderKind,
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
  const [providerConfig, setProviderConfig] = useState<ProviderConfig>({
    active_provider: "ollama",
    ollama_base_url: "http://localhost:11434",
    ollama_model: "qwen2.5-coder:latest",
    anthropic_model: "claude-3-5-sonnet-latest",
    openai_model: "gpt-4o",
    enable_cloud_fallback: false,
    temperature: 0.1,
  });
  const [ollamaModels, setOllamaModels] = useState<string[]>([
    "qwen2.5-coder:latest",
    "gemma2:latest",
    "deepseek-r1:latest",
  ]);
  const [ollamaOnline, setOllamaOnline] = useState<boolean>(false);

  // Live AI Thinking & Plan State
  const [liveThinking, setLiveThinking] = useState<string>(
    "Waiting for task dispatch. When active, the AI's live internal reasoning (<think>...) and step-by-step plan appear here in real time."
  );
  const [planChecklist, setPlanChecklist] = useState<string[]>([]);

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
    "Oxide GUI Ready — Local Ollama + Autonomous File/Terminal/Git Engine Active"
  );

  const refreshWorkspaceState = async (dir: string = currentDir) => {
    try {
      const [fileList, git, health] = await Promise.all([
        oxideBridge.listWorkspaceFiles(dir),
        oxideBridge.getGitStatus(),
        oxideBridge.getProviderHealth(),
      ]);
      setFiles(fileList);
      setGitStatus(git);
      setOllamaOnline(health.ollama_reachable);
      if (health.ollama_models.length > 0) {
        setOllamaModels(health.ollama_models);
      }
      setProviderConfig(health.config);
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

  const handleRunTask = async (customPrompt?: string) => {
    const taskPrompt = (customPrompt ?? prompt).trim();
    if (!taskPrompt || isRunning) return;
    if (!customPrompt) setPrompt("");
    setCenterTab("agent");
    setStreamingBuffer("");
    setLiveThinking(`Analyzing task: "${taskPrompt}"...`);
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
    setProviderConfig(updated);
    await oxideBridge.updateProviderConfig(updated);
    setShowSettingsModal(false);
    setStatusBanner(
      `Saved settings: ${updated.active_provider} / ${updated.ollama_model}`
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
            {ollamaOnline
              ? `Ollama: ${providerConfig.ollama_model}`
              : "Ollama Offline"}
          </span>

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
            title="Configure AI Models, Ollama URL & Settings"
          >
            ⚙ Models &amp; Settings
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
              🤖 Autonomous Agent &amp; Live Thinking
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
                🧠 AI Live Thinking &amp; Current Reasoning{" "}
                {isRunning ? "(ACTIVE...)" : "(IDLE)"}
              </span>
              <span style={{ fontSize: "0.7rem", opacity: 0.85 }}>
                {providerConfig.active_provider.toUpperCase()} •{" "}
                {providerConfig.ollama_model}
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
                    <strong>Oxide Autonomous Agent Studio</strong>
                    {"\n"}• Watch the purple <strong>AI Live Thinking</strong>{" "}
                    box above to see what the model is thinking in real time.
                    {"\n"}• The agent can autonomously list directories, search
                    code, read/create/edit/move/delete files, run terminal
                    commands, self-correct compiler errors, and commit/push/pull
                    with Git.
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
                        "List the workspace files, inspect package.json, and summarize the project architecture."
                      )
                    }
                  >
                    🔍 Inspect &amp; Summarize Project
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
                    placeholder="Ask Oxide to create/edit/move files, run terminal commands, or push/pull from Git..."
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
                    {isRunning ? "Thinking..." : "Run Agent"}
                  </button>
                </div>
                <div style={{ fontSize: "0.74rem", color: "#94a3b8" }}>
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

        {/* Right Pane: Workflow Status Cards & Interactive Terminal */}
        <aside className="right-pane">
          <div className="telemetry-section">
            <div className="section-title">
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

            <div className="section-title" style={{ marginTop: "0.4rem" }}>
              Live Agent Activity &amp; Self-Correction Steps
            </div>
            {workflowCards.map((card) => (
              <div key={card.id} className={`workflow-card ${card.status}`}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: "0.8rem",
                    fontWeight: 600,
                  }}
                >
                  <span>{card.title}</span>
                  <span style={{ fontSize: "0.7rem", opacity: 0.8 }}>
                    #{card.step} • {card.status.toUpperCase()}
                  </span>
                </div>
                <div style={{ fontSize: "0.75rem", color: "#94a3b8" }}>
                  {card.detail}
                </div>
              </div>
            ))}

            {commits.length > 0 && (
              <>
                <div className="section-title" style={{ marginTop: "0.4rem" }}>
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

            <div className="section-title" style={{ marginTop: "0.4rem" }}>
              Terminal Output Stream (stdout / stderr)
            </div>
            {terminalLogs.map((log, index) => (
              <div key={index} className="terminal-log">
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginBottom: "0.3rem",
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

      {/* Settings & Model Configuration Modal */}
      {showSettingsModal && (
        <div
          className="modal-backdrop"
          onClick={() => setShowSettingsModal(false)}
        >
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>⚙ AI Models &amp; Agent Settings</h3>

            <div className="form-group">
              <label>Active Inference Provider</label>
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
              <label>Local Ollama Model (Detected on localhost:11434)</label>
              <select
                className="select-control"
                value={providerConfig.ollama_model}
                onChange={(e) =>
                  setProviderConfig({
                    ...providerConfig,
                    ollama_model: e.target.value,
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
              <label>Or Enter Custom Ollama Model Tag</label>
              <input
                className="workspace-input"
                type="text"
                value={providerConfig.ollama_model}
                onChange={(e) =>
                  setProviderConfig({
                    ...providerConfig,
                    ollama_model: e.target.value,
                  })
                }
              />
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

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: "0.5rem",
                marginTop: "0.5rem",
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
                Save Settings
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
