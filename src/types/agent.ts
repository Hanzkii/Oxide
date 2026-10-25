export type ProviderKind = "ollama" | "anthropic" | "openai";

export interface ProviderConfig {
  active_provider: ProviderKind;
  ollama_base_url: string;
  ollama_model: string;
  anthropic_model: string;
  openai_model: string;
  enable_cloud_fallback: boolean;
  temperature: number;
}

export interface ProviderHealthReport {
  active_provider: string;
  ollama_reachable: boolean;
  anthropic_key_present: boolean;
  openai_key_present: boolean;
  config: ProviderConfig;
}

export interface GitStatusSummary {
  initialized: boolean;
  branch: string;
  is_clean: boolean;
  changed_files: string[];
  last_commit: string | null;
}

export interface GitCommitRecord {
  commit_hash: string;
  message: string;
  files_changed: number;
}

export interface WorkspaceInfo {
  canonical_path: string;
  git: GitStatusSummary;
  allowed_binaries: string[];
}

export interface CommandExecutionResult {
  program: string;
  args: string[];
  working_dir: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  succeeded: boolean;
  truncated: boolean;
}

export type WorkflowStepStatus =
  | "running"
  | "succeeded"
  | "self_correcting"
  | "failed";

export type AgentStreamEvent =
  | {
      type: "token_delta";
      step: number;
      provider: string;
      token: string;
    }
  | {
      type: "workflow_card";
      step: number;
      title: string;
      detail: string;
      status: WorkflowStepStatus;
    }
  | {
      type: "terminal_output";
      step: number;
      result: CommandExecutionResult;
    }
  | {
      type: "git_milestone";
      step: number;
      commit: GitCommitRecord;
    }
  | {
      type: "task_completed";
      steps_taken: number;
      summary: string;
    }
  | {
      type: "task_error";
      message: string;
    };
