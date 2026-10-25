use crate::error::OxideResult;
use crate::llm::cloud::{AnthropicProvider, OpenAiProvider};
use crate::llm::ollama::OllamaProvider;
use crate::llm::{
    AgentRoleKind, ChatMessage, LlmProvider, ProviderConfig, ProviderKind, TokenStreamCallback,
};
use std::sync::Arc;

/// Modular provider router that decouples core agent reasoning from specific LLM APIs.
/// Supports role-specific model routing (e.g., Large Architect model for complex planning vs.
/// fast lightweight Ollama models for Subagents).
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
        self.build_provider_for_role(kind, AgentRoleKind::Architect)
    }

    pub fn build_provider_for_role(
        &self,
        kind: ProviderKind,
        role: AgentRoleKind,
    ) -> Arc<dyn LlmProvider> {
        let role_model = self.config.model_for_role(role);
        match kind {
            ProviderKind::Ollama => {
                let num_gpu = if self.config.hardware_acceleration
                    == crate::llm::HardwareAccelerationMode::Cpu
                    || self.config.gpu_offload_policy == crate::llm::GpuOffloadPolicy::CpuOnly
                {
                    Some(0)
                } else {
                    match self.config.gpu_offload_policy {
                        crate::llm::GpuOffloadPolicy::CpuOnly => Some(0),
                        crate::llm::GpuOffloadPolicy::FullGpu => Some(99),
                        crate::llm::GpuOffloadPolicy::CustomLayers => {
                            Some(self.config.gpu_offload_layers)
                        }
                        crate::llm::GpuOffloadPolicy::HybridSplit => {
                            let lower = role_model.to_lowercase();
                            let layers = if lower.contains("70b") {
                                24
                            } else if lower.contains("32b") || lower.contains("30b") {
                                36
                            } else if lower.contains("14b") {
                                48
                            } else {
                                99
                            };
                            Some(layers)
                        }
                    }
                };
                Arc::new(OllamaProvider::with_num_gpu(
                    &self.config.ollama_base_url,
                    role_model,
                    num_gpu,
                ))
            }
            ProviderKind::Anthropic => {
                Arc::new(AnthropicProvider::new(&self.config.anthropic_model))
            }
            ProviderKind::OpenAi => Arc::new(OpenAiProvider::new(&self.config.openai_model)),
        }
    }

    pub async fn stream_with_fallback(
        &self,
        messages: &[ChatMessage],
        on_token: TokenStreamCallback,
    ) -> OxideResult<(String, String)> {
        self.stream_for_role(AgentRoleKind::Architect, messages, on_token)
            .await
    }

    /// Streams a completion using the model specifically assigned to `role` in `TaskModelRouting`.
    pub async fn stream_for_role(
        &self,
        role: AgentRoleKind,
        messages: &[ChatMessage],
        on_token: TokenStreamCallback,
    ) -> OxideResult<(String, String)> {
        let primary = self.build_provider_for_role(self.config.active_provider, role);
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

                for fallback_kind in [ProviderKind::Anthropic, ProviderKind::OpenAi] {
                    let candidate = self.build_provider_for_role(fallback_kind, role);
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
