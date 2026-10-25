export type ProviderKind =
  | "oxide_native"
  | "anthropic"
  | "openai"
  | "gemini"
  | "deepseek"
  | "custom_openai"
  | "ollama";

export type HardwareAccelerationMode =
  | "auto"
  | "amd_rocm"
  | "nvidia_cuda"
  | "directml"
  | "cpu";

export type GpuOffloadPolicy =
  | "full_gpu"
  | "hybrid_split"
  | "custom_layers"
  | "cpu_only";

export type SecurityReviewMode =
  | "request_review"
  | "default"
  | "auto"
  | "turbo";

export type AgentRoleKind =
  | "architect"
  | "coder_subagent"
  | "research_subagent"
  | "tester_subagent";

export type SubagentRunState =
  | "queued"
  | "throttled_waiting_for_hardware"
  | "running"
  | "completed"
  | "failed";

export type McpTransportKind = "builtin" | "stdio" | "http";

export interface McpToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransportKind;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  enabled: boolean;
  status: string;
  discovered_tools: McpToolSchema[];
}

export interface McpToolCallResult {
  server_id: string;
  tool_name: string;
  succeeded: boolean;
  content: string;
}

export interface TaskModelRouting {
  architect_model: string;
  coder_subagent_model: string;
  research_subagent_model: string;
  tester_subagent_model: string;
}

export interface ProviderConfig {
  active_provider: ProviderKind;
  ollama_base_url: string;
  ollama_model: string;
  anthropic_model: string;
  anthropic_api_key?: string;
  openai_model: string;
  openai_api_key?: string;
  gemini_model?: string;
  gemini_api_key?: string;
  deepseek_model?: string;
  deepseek_api_key?: string;
  enable_cloud_fallback: boolean;
  temperature: number;
  task_routing: TaskModelRouting;
  enable_subagents: boolean;
  max_concurrent_subagents: number;
  auto_throttle_on_high_load: boolean;
  hardware_acceleration?: HardwareAccelerationMode;
  gpu_offload_policy?: GpuOffloadPolicy;
  gpu_offload_layers?: number;
  security_mode?: SecurityReviewMode;
  allow_internet_access?: boolean;
  enforce_workspace_sandbox?: boolean;
  permitted_terminal_binaries?: string[];
  oxide_native_port?: number;
  oxide_native_model?: string;
  custom_openai_url?: string;
  custom_openai_model?: string;
}

export interface ModelDownloadProgress {
  model_id: string;
  status: string;
  completed: number;
  total: number;
  percent: number;
}

export interface UpdateDownloadProgress {
  bytes_downloaded: number;
  total_bytes: number;
  percent: number;
  status: string;
}

export interface HardwareSpecs {
  cpu_brand: string;
  cpu_cores: number;
  cpu_usage_percent: number;
  total_ram_gb: number;
  available_ram_gb: number;
  used_ram_percent: number;
  gpu_name: string;
  gpu_vram_gb: number;
  recommended_max_subagents: number;
  hard_limit_subagents: number;
  governor_tier: string;
  governor_advice: string;
  throttled_by_load: boolean;
}

export interface ProviderHealthReport {
  active_provider: string;
  ollama_reachable: boolean;
  ollama_models: string[];
  oxide_native_running?: boolean;
  oxide_native_models?: string[];
  oxide_native_installed?: boolean;
  anthropic_key_present: boolean;
  openai_key_present: boolean;
  config: ProviderConfig;
}

export interface GitStatusSummary {
  initialized: boolean;
  branch: string;
  remote_url?: string | null;
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

export interface WorkspaceFileEntry {
  name: string;
  relative_path: string;
  is_dir: boolean;
  size_bytes: number;
}

export interface UpdateStatus {
  current_version: string;
  latest_version: string;
  latest_commit_sha: string;
  latest_commit_message: string;
  latest_commit_date: string;
  update_available: boolean;
  installer_download_url: string | null;
  installer_name: string | null;
  release_url: string;
  release_notes: string;
}

export interface UpdateInstallResult {
  method: string;
  message: string;
  restart_required: boolean;
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
      type: "thinking_update";
      step: number;
      thought: string;
    }
  | {
      type: "plan_update";
      step: number;
      items: string[];
    }
  | {
      type: "thinking_metrics";
      step: number;
      tokens_generated: number;
      tokens_per_second: number;
      elapsed_seconds: number;
      phase: string;
      gpu_layers: number;
    }
  | {
      type: "subagent_status";
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
  | {
      type: "workflow_card";
      step: number;
      title: string;
      detail: string;
      status: WorkflowStepStatus;
    }
  | {
      type: "file_change";
      step: number;
      operation: string;
      path: string;
      detail: string;
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

export interface ModelInstallResult {
  model_id: string;
  success: boolean;
  message: string;
}

export interface HuggingFaceModelEntry {
  id: string;
  install_id: string;
  name: string;
  author: string;
  downloads: number;
  likes: number;
  params: string;
  size_gb: number;
  min_ram_gb: number;
  recommended_vram_gb: number;
  is_coding: boolean;
  is_uncensored: boolean;
  is_reasoning: boolean;
  is_fast_subagent: boolean;
  summary: string;
}
