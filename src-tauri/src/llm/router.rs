use crate::error::OxideResult;
use crate::llm::cloud::{AnthropicProvider, OpenAiProvider};
use crate::llm::ollama::OllamaProvider;
use crate::llm::{ChatMessage, LlmProvider, ProviderConfig, ProviderKind, TokenStreamCallback};
use std::sync::Arc;

/// Modular provider router that decouples core agent reasoning from specific LLM APIs.
/// Routes to local Ollama (`qwen2.5-coder` or `gemma2`) by default, and transparently
/// swaps or falls back to Anthropic Claude / OpenAI when configured.
pub struct HybridProviderRouter {
    config: ProviderConfig,
}

impl HybridProviderRouter {
    pub fn new(config: ProviderConfig) -> Self {
        Self { config }
    }

    pub fn config(&self) -> &ProviderConfig {
        &self.config
    }

    pub fn build_provider(&self, kind: ProviderKind) -> Arc<dyn LlmProvider> {
        match kind {
            ProviderKind::Ollama => Arc::new(OllamaProvider::new(
                &self.config.ollama_base_url,
                &self.config.ollama_model,
            )),
            ProviderKind::Anthropic => {
                Arc::new(AnthropicProvider::new(&self.config.anthropic_model))
            }
            ProviderKind::OpenAi => Arc::new(OpenAiProvider::new(&self.config.openai_model)),
        }
    }

    /// Executes a streaming chat completion using the primary configured provider,
    /// optionally falling back to cloud APIs if `enable_cloud_fallback` is true.
    pub async fn stream_with_fallback(
        &self,
        messages: &[ChatMessage],
        on_token: TokenStreamCallback,
    ) -> OxideResult<(String, String)> {
        let primary = self.build_provider(self.config.active_provider);
        let primary_id = primary.identifier();

        match primary
            .stream_chat(messages, self.config.temperature, on_token.clone())
            .await
        {
            Ok(response) => Ok((primary_id, response)),
            Err(primary_err) => {
                if !self.config.enable_cloud_fallback
                    || self.config.active_provider != ProviderKind::Ollama
                {
                    return Err(primary_err);
                }

                // Attempt Anthropic fallback first, then OpenAI if keys exist in environment
                for fallback_kind in [ProviderKind::Anthropic, ProviderKind::OpenAi] {
                    let candidate = self.build_provider(fallback_kind);
                    if candidate.health_check().await.unwrap_or(false) {
                        let fallback_id = candidate.identifier();
                        let response = candidate
                            .stream_chat(messages, self.config.temperature, on_token)
                            .await?;
                        return Ok((fallback_id, response));
                    }
                }

                Err(primary_err)
            }
        }
    }
}
