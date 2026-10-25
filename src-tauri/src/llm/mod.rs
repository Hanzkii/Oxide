pub mod cloud;
pub mod ollama;
pub mod router;

use crate::error::OxideResult;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    Ollama,
    Anthropic,
    OpenAi,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HardwareAccelerationMode {
    Auto,
    AmdRocm,
    NvidiaCuda,
    DirectMl,
    Cpu,
}

impl Default for HardwareAccelerationMode {
    fn default() -> Self {
        HardwareAccelerationMode::Auto
    }
}

/// GPU Layer Offloading (Hybrid Split Inference) Policy.
/// Controls how transformer layers are partitioned between GPU VRAM and CPU System RAM.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecurityReviewMode {
    /// Every command and mutation requires explicit user approval before execution
    RequestReview,
    /// Asks before sensitive operations (external network, destructive commands, file deletions)
    Default,
    /// Automatically decides if commands should run based on safety heuristics
    Auto,
    /// Runs all workspace commands and tools without interactive confirmation
    Turbo,
}

impl Default for SecurityReviewMode {
    fn default() -> Self {
        SecurityReviewMode::Turbo
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GpuOffloadPolicy {
    /// 100% GPU offload (num_gpu: 99) for maximum token/s inference
    FullGpu,
    /// Dynamic Hybrid Split: auto-calculates the layer split so massive models run without OOM
    HybridSplit,
    /// Explicit user-controlled layer count
    CustomLayers,
    /// 0 layers offloaded to GPU (forces CPU inference)
    CpuOnly,
}

impl Default for GpuOffloadPolicy {
    fn default() -> Self {
        GpuOffloadPolicy::FullGpu
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRoleKind {
    Architect,
    CoderSubagent,
    ResearchSubagent,
    TesterSubagent,
}

/// Task-specific AI model routing matrix: allows choosing which AI model handles
/// complex thinking/orchestration vs. fast specialized subagent tasks.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskModelRouting {
    pub architect_model: String,
    pub coder_subagent_model: String,
    pub research_subagent_model: String,
    pub tester_subagent_model: String,
}

impl Default for TaskModelRouting {
    fn default() -> Self {
        Self {
            architect_model: "qwen2.5-coder:latest".to_string(),
            coder_subagent_model: "qwen2.5-coder:7b".to_string(),
            research_subagent_model: "gemma2:latest".to_string(),
            tester_subagent_model: "qwen2.5-coder:7b".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub active_provider: ProviderKind,
    pub ollama_base_url: String,
    pub ollama_model: String,
    pub anthropic_model: String,
    pub openai_model: String,
    pub enable_cloud_fallback: bool,
    pub temperature: f32,
    #[serde(default)]
    pub task_routing: TaskModelRouting,
    #[serde(default = "default_true")]
    pub enable_subagents: bool,
    #[serde(default = "default_max_subagents")]
    pub max_concurrent_subagents: usize,
    #[serde(default = "default_true")]
    pub auto_throttle_on_high_load: bool,
    #[serde(default)]
    pub hardware_acceleration: HardwareAccelerationMode,
    #[serde(default)]
    pub gpu_offload_policy: GpuOffloadPolicy,
    #[serde(default = "default_gpu_layers")]
    pub gpu_offload_layers: i32,
    #[serde(default)]
    pub security_mode: SecurityReviewMode,
    #[serde(default = "default_true")]
    pub allow_internet_access: bool,
    #[serde(default = "default_true")]
    pub enforce_workspace_sandbox: bool,
}

fn default_gpu_layers() -> i32 {
    99
}

fn default_true() -> bool {
    true
}

fn default_max_subagents() -> usize {
    4
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            active_provider: ProviderKind::Ollama,
            ollama_base_url: "http://localhost:11434".to_string(),
            ollama_model: "qwen2.5-coder:latest".to_string(),
            anthropic_model: "claude-3-5-sonnet-latest".to_string(),
            openai_model: "gpt-4o".to_string(),
            enable_cloud_fallback: false,
            temperature: 0.1,
            task_routing: TaskModelRouting::default(),
            enable_subagents: true,
            max_concurrent_subagents: 4,
            auto_throttle_on_high_load: true,
            hardware_acceleration: HardwareAccelerationMode::Auto,
            gpu_offload_policy: GpuOffloadPolicy::FullGpu,
            gpu_offload_layers: 99,
            security_mode: SecurityReviewMode::Turbo,
            allow_internet_access: true,
            enforce_workspace_sandbox: true,
        }
    }
}

impl ProviderConfig {
    /// Resolves the specific model name configured for a given `AgentRoleKind`.
    pub fn model_for_role(&self, role: AgentRoleKind) -> &str {
        match role {
            AgentRoleKind::Architect => &self.task_routing.architect_model,
            AgentRoleKind::CoderSubagent => &self.task_routing.coder_subagent_model,
            AgentRoleKind::ResearchSubagent => &self.task_routing.research_subagent_model,
            AgentRoleKind::TesterSubagent => &self.task_routing.tester_subagent_model,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
}

impl ChatMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: ChatRole::System,
            content: content.into(),
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: ChatRole::User,
            content: content.into(),
        }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: ChatRole::Assistant,
            content: content.into(),
        }
    }

    pub fn tool(content: impl Into<String>) -> Self {
        Self {
            role: ChatRole::Tool,
            content: content.into(),
        }
    }
}

/// Callback invoked for each streamed token delta emitted by the active LLM provider.
pub type TokenStreamCallback = Arc<dyn Fn(&str) + Send + Sync>;

/// Unified trait abstracting Local (Ollama) and Cloud (Anthropic, OpenAI) inference backends.
#[async_trait]
pub trait LlmProvider: Send + Sync {
    fn identifier(&self) -> String;
    async fn health_check(&self) -> OxideResult<bool>;
    async fn stream_chat(
        &self,
        messages: &[ChatMessage],
        temperature: f32,
        on_token: TokenStreamCallback,
    ) -> OxideResult<String>;
}
