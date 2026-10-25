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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub active_provider: ProviderKind,
    pub ollama_base_url: String,
    pub ollama_model: String,
    pub anthropic_model: String,
    pub openai_model: String,
    pub enable_cloud_fallback: bool,
    pub temperature: f32,
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
    /// Human-readable identifier for logging and UI telemetry (e.g., `"ollama:qwen2.5-coder"`).
    fn identifier(&self) -> String;

    /// Checks whether the provider is reachable / has valid credentials configured.
    async fn health_check(&self) -> OxideResult<bool>;

    /// Streams a completion for the given conversation history, invoking `on_token` as chunks arrive
    /// and returning the complete aggregated assistant message upon completion.
    async fn stream_chat(
        &self,
        messages: &[ChatMessage],
        temperature: f32,
        on_token: TokenStreamCallback,
    ) -> OxideResult<String>;
}
