import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  AgentStreamEvent,
  CommandExecutionResult,
  GitCommitRecord,
  GitStatusSummary,
  ProviderConfig,
  ProviderHealthReport,
  WorkspaceInfo,
} from "../types/agent";

export const oxideBridge = {
  async setWorkspace(workspacePath: string): Promise<WorkspaceInfo> {
    return invoke<WorkspaceInfo>("set_workspace", { workspacePath });
  },

  async openInVsCode(workspacePath?: string): Promise<string> {
    return invoke<string>("open_in_vscode", {
      workspacePath: workspacePath ?? null,
    });
  },

  async getProviderHealth(): Promise<ProviderHealthReport> {
    return invoke<ProviderHealthReport>("get_provider_health");
  },

  async updateProviderConfig(config: ProviderConfig): Promise<ProviderConfig> {
    return invoke<ProviderConfig>("update_provider_config", { config });
  },

  async runAgentTask(prompt: string): Promise<string> {
    return invoke<string>("run_agent_task", { prompt });
  },

  async executeBoundedCommand(
    commandLine: string
  ): Promise<CommandExecutionResult> {
    return invoke<CommandExecutionResult>("execute_bounded_command", {
      commandLine,
    });
  },

  async getGitStatus(): Promise<GitStatusSummary> {
    return invoke<GitStatusSummary>("get_git_status");
  },

  async triggerGitMilestone(
    milestoneSummary: string
  ): Promise<GitCommitRecord | null> {
    return invoke<GitCommitRecord | null>("trigger_git_milestone", {
      milestoneSummary,
    });
  },

  async onAgentEvent(
    handler: (event: AgentStreamEvent) => void
  ): Promise<UnlistenFn> {
    return listen<AgentStreamEvent>("oxide://agent-event", (evt) => {
      handler(evt.payload);
    });
  },
};
