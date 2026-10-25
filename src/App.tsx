import React, { useEffect, useState } from "react";
import { oxideBridge } from "./services/tauriBridge";
import {
  CommandExecutionResult,
  GitCommitRecord,
  GitStatusSummary,
  ProviderConfig,
  ProviderKind,
  WorkflowStepStatus,
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
  const [workspacePath, setWorkspacePath] = useState<string>("");
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
  const [ollamaOnline, setOllamaOnline] = useState<boolean>(false);

  const [prompt, setPrompt] = useState<string>("");
  const [quickCommand, setQuickCommand] = useState<string>("cargo check");
  const [isRunning, setIsRunning] = useState<boolean>(false);

  const [chatHistory, setChatHistory] = useState<ChatEntry[]>([]);
  const [streamingBuffer, setStreamingBuffer] = useState<string>("");
  const [workflowCards, setWorkflowCards] = useState<WorkflowCardItem[]>([]);
  const [terminalLogs, setTerminalLogs] = useState<CommandExecutionResult[]>(
    []
  );
  const [commits, setCommits] = useState<GitCommitRecord[]>([]);
  const [statusBanner, setStatusBanner] = useState<string>(
    "Ready — Local Ollama inference configured (localhost:11434)"
  );

  useEffect(() => {
    oxideBridge
      .getProviderHealth()
      .then((report) => {
        setOllamaOnline(report.ollama_reachable);
        setProviderConfig(report.config);
      })
      .catch(() => {});

    oxideBridge
      .getGitStatus()
      .then((status) => setGitStatus(status))
      .catch(() => {});

    const unlistenPromise = oxideBridge.onAgentEvent((event) => {
      switch (event.type) {
        case "token_delta":
          setStreamingBuffer((prev) => prev + event.token);
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
        case "terminal_output":
          setTerminalLogs((prev) => [event.result, ...prev]);
          break;
        case "git_milestone":
          setCommits((prev) => [event.commit, ...prev]);
          oxideBridge.getGitStatus().then(setGitStatus).catch(() => {});
          break;
        case "task_completed":
          setStatusBanner(
            `Task completed in ${event.steps_taken} step(s): ${event.summary}`
          );
          break;
        case "task_error":
          setStatusBanner(`Error: ${event.message}`);
          break;
      }
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const handleSetWorkspace = async () => {
    if (!workspacePath.trim()) return;
    try {
      const info = await oxideBridge.setWorkspace(workspacePath.trim());
      setWorkspacePath(info.canonical_path);
      setGitStatus(info.git);
      setStatusBanner(`Locked workspace sandbox to ${info.canonical_path}`);
    } catch (err: any) {
      setStatusBanner(
        `Workspace error: ${err?.message || JSON.stringify(err)}`
      );
    }
  };

  const handleOpenInVsCode = async () => {
    try {
      const openedPath = await oxideBridge.openInVsCode(
        workspacePath.trim() || undefined
      );
      setStatusBanner(`Opened ${openedPath} in Visual Studio Code`);
    } catch (err: any) {
      setStatusBanner(
        `VS Code launch error: ${err?.message || JSON.stringify(err)}`
      );
    }
  };

  const handleProviderModelChange = async (value: string) => {
    const [kind, model] = value.split("/") as [ProviderKind, string];
    const updated: ProviderConfig = {
      ...providerConfig,
      active_provider: kind,
      ollama_model: kind === "ollama" ? model : providerConfig.ollama_model,
    };
    setProviderConfig(updated);
    try {
      await oxideBridge.updateProviderConfig(updated);
      setStatusBanner(`Switched active LLM provider to ${kind} (${model})`);
    } catch (err: any) {
      setStatusBanner(`Provider update error: ${err?.message}`);
    }
  };

  const handleRunTask = async () => {
    if (!prompt.trim() || isRunning) return;
    const taskPrompt = prompt.trim();
    setPrompt("");
    setStreamingBuffer("");
    setIsRunning(true);
    setChatHistory((prev) => [...prev, { role: "user", content: taskPrompt }]);

    try {
      const finalReply = await oxideBridge.runAgentTask(taskPrompt);
      setChatHistory((prev) => [
        ...prev,
        { role: "assistant", content: finalReply },
      ]);
      setStreamingBuffer("");
      const latestGit = await oxideBridge.getGitStatus();
      setGitStatus(latestGit);
    } catch (err: any) {
      setStatusBanner(
        `Agent execution halted: ${err?.message || JSON.stringify(err)}`
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
      setStatusBanner(
        `Command '${res.program}' exited with code ${res.exit_code} (${res.duration_ms} ms)`
      );
    } catch (err: any) {
      setStatusBanner(
        `Security Sandbox Blocked Command: ${
          err?.message || JSON.stringify(err)
        }`
      );
    }
  };

  return (
    <div className="app-shell">
      {/* Sticky Top Command Bar with Prominent "Open in VS Code" Action */}
      <header className="command-header">
        <div className="brand-group">
          <span className="brand-badge">OXIDE v0.1</span>
          <span className="status-pill">
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                backgroundColor: ollamaOnline ? "#10b981" : "#f59e0b",
              }}
            />
            {ollamaOnline ? "Ollama Local Online" : "Local Standby"}
          </span>
          {gitStatus && (
            <span className="status-pill">
              git:{gitStatus.branch}{" "}
              {gitStatus.is_clean
                ? "(clean)"
                : `(${gitStatus.changed_files.length} modified)`}
            </span>
          )}
        </div>

        <div className="workspace-bar">
          <input
            className="workspace-input"
            type="text"
            placeholder="Target workspace directory (e.g. C:\projects\my-app)"
            value={workspacePath}
            onChange={(e) => setWorkspacePath(e.target.value)}
          />
          <button className="btn-secondary" onClick={handleSetWorkspace}>
            Bind Sandbox
          </button>
        </div>

        <div className="header-actions">
          <select
            className="select-control"
            value={`${providerConfig.active_provider}/${providerConfig.ollama_model}`}
            onChange={(e) => handleProviderModelChange(e.target.value)}
          >
            <option value="ollama/qwen2.5-coder:latest">
              Local: Ollama / qwen2.5-coder
            </option>
            <option value="ollama/gemma2:latest">
              Local: Ollama / gemma2
            </option>
            <option value="anthropic/claude-3-5-sonnet-latest">
              Cloud Fallback: Claude 3.5 Sonnet
            </option>
            <option value="openai/gpt-4o">Cloud Fallback: OpenAI GPT-4o</option>
          </select>

          <button
            className="btn-vscode"
            onClick={handleOpenInVsCode}
            title="Launch active workspace directly in Visual Studio Code (code -- <path>)"
          >
            <span>Open in VS Code</span>
          </button>
        </div>
      </header>

      {/* Main Split Command Center */}
      <div className="workspace-grid">
        {/* Left Pane: Autonomous Chat & Streaming Output */}
        <section className="pane-left">
          <div className="stream-viewport">
            {chatHistory.length === 0 && !streamingBuffer && (
              <div className="message-card">
                <strong>Oxide Autonomous Coding Agent</strong>
                {"\n"}• Local-first inference routed to{" "}
                <code>localhost:11434</code> (<code>qwen2.5-coder</code> /{" "}
                <code>gemma2</code>).
                {"\n"}• Bounded terminal sandbox blocks shell chaining,
                credential leaks, and path traversal outside the workspace.
                {"\n"}• Non-zero exit codes (<code>stderr</code>) automatically
                trigger the self-correction loop.
              </div>
            )}

            {chatHistory.map((msg, idx) => (
              <div key={idx} className={`message-card ${msg.role}`}>
                {msg.content}
              </div>
            ))}

            {streamingBuffer && (
              <div className="message-card assistant">{streamingBuffer}</div>
            )}
          </div>

          <div className="composer-bar">
            <div className="composer-row">
              <textarea
                className="prompt-textarea"
                placeholder="Describe an autonomous coding task (e.g., 'Add unit tests for the parser module, run cargo test, fix any compiler errors, and commit')..."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
              <button
                className="btn-primary"
                onClick={handleRunTask}
                disabled={isRunning}
              >
                {isRunning ? "Running Loop..." : "Dispatch Agent"}
              </button>
            </div>

            <div className="composer-row">
              <input
                className="workspace-input"
                type="text"
                placeholder="Bounded sandbox command (e.g. cargo test)"
                value={quickCommand}
                onChange={(e) => setQuickCommand(e.target.value)}
              />
              <button className="btn-secondary" onClick={handleQuickCommand}>
                Run Bounded Cmd
              </button>
            </div>
            <div style={{ fontSize: "0.75rem", color: "#94a3b8" }}>
              {statusBanner}
            </div>
          </div>
        </section>

        {/* Right Pane: Workflow Status Cards, Self-Correction Loop & Terminal Logs */}
        <aside className="pane-right">
          <div className="telemetry-section">
            <div className="section-title">
              Workflow Status & Self-Correction Loop
            </div>
            {workflowCards.map((card) => (
              <div
                key={card.id}
                className={`workflow-card ${card.status}`}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: "0.84rem",
                    fontWeight: 600,
                  }}
                >
                  <span>{card.title}</span>
                  <span style={{ fontSize: "0.72rem", opacity: 0.8 }}>
                    Step #{card.step} • {card.status.toUpperCase()}
                  </span>
                </div>
                <div style={{ fontSize: "0.78rem", color: "#94a3b8" }}>
                  {card.detail}
                </div>
              </div>
            ))}

            {commits.length > 0 && (
              <>
                <div className="section-title" style={{ marginTop: "0.75rem" }}>
                  Automated Git Milestones
                </div>
                {commits.map((c, i) => (
                  <div key={i} className="workflow-card succeeded">
                    <strong>
                      [{c.commit_hash}] {c.message}
                    </strong>
                    <span style={{ fontSize: "0.75rem", color: "#94a3b8" }}>
                      {c.files_changed} file(s) staged & committed automatically
                    </span>
                  </div>
                ))}
              </>
            )}

            <div className="section-title" style={{ marginTop: "0.75rem" }}>
              Sandboxed Terminal Telemetry (stdout / stderr)
            </div>
            {terminalLogs.map((log, index) => (
              <div key={index} className="terminal-log">
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginBottom: "0.35rem",
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
    </div>
  );
};
