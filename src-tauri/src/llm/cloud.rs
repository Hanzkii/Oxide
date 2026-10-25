use crate::error::{OxideError, OxideResult};
use crate::llm::{ChatMessage, ChatRole, LlmProvider, TokenStreamCallback};
use async_trait::async_trait;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::env;
use std::time::Duration;

/// Cloud provider implementation for Anthropic Claude (`ANTHROPIC_API_KEY`).
pub struct AnthropicProvider {
    client: Client,
    model: String,
}

impl AnthropicProvider {
    pub fn new(model: impl Into<String>) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(180))
            .build()
            .unwrap_or_default();
        Self {
            client,
            model: model.into(),
        }
    }

    fn api_key(&self) -> OxideResult<String> {
        env::var("ANTHROPIC_API_KEY").map_err(|_| OxideError::ProviderError {
            provider: self.identifier(),
            message: "Missing ANTHROPIC_API_KEY environment variable".to_string(),
        })
    }
}

#[derive(Serialize)]
struct AnthropicRequest<'a> {
    model: &'a str,
    max_tokens: u32,
    temperature: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<&'a str>,
    messages: Vec<AnthropicMessage<'a>>,
}

#[derive(Serialize)]
struct AnthropicMessage<'a> {
    role: &'static str,
    content: &'a str,
}

#[derive(Deserialize)]
struct AnthropicResponse {
    content: Vec<AnthropicContentBlock>,
}

#[derive(Deserialize)]
struct AnthropicContentBlock {
    text: Option<String>,
}

#[async_trait]
impl LlmProvider for AnthropicProvider {
    fn identifier(&self) -> String {
        format!("anthropic/{}", self.model)
    }

    async fn health_check(&self) -> OxideResult<bool> {
        Ok(self.api_key().is_ok())
    }

    async fn stream_chat(
        &self,
        messages: &[ChatMessage],
        temperature: f32,
        on_token: TokenStreamCallback,
    ) -> OxideResult<String> {
        let api_key = self.api_key()?;
        let system_prompt = messages
            .iter()
            .find(|m| m.role == ChatRole::System)
            .map(|m| m.content.as_str());

        let chat_messages: Vec<AnthropicMessage> = messages
            .iter()
            .filter(|m| m.role != ChatRole::System)
            .map(|m| AnthropicMessage {
                role: match m.role {
                    ChatRole::Assistant => "assistant",
                    _ => "user",
                },
                content: &m.content,
            })
            .collect();

        let body = AnthropicRequest {
            model: &self.model,
            max_tokens: 4096,
            temperature,
            system: system_prompt,
            messages: chat_messages,
        };

        let resp = self
            .client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await
            .map_err(|e| OxideError::ProviderError {
                provider: self.identifier(),
                message: e.to_string(),
            })?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(OxideError::ProviderError {
                provider: self.identifier(),
                message: format!("HTTP {}: {}", status, text),
            });
        }

        let parsed: AnthropicResponse = resp.json().await.map_err(|e| OxideError::ProviderError {
            provider: self.identifier(),
            message: e.to_string(),
        })?;

        let mut combined = String::new();
        for block in parsed.content {
            if let Some(t) = block.text {
                on_token(&t);
                combined.push_str(&t);
            }
        }

        Ok(combined)
    }
}

/// Cloud provider implementation for OpenAI (`OPENAI_API_KEY`).
pub struct OpenAiProvider {
    client: Client,
    model: String,
}

impl OpenAiProvider {
    pub fn new(model: impl Into<String>) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(180))
            .build()
            .unwrap_or_default();
        Self {
            client,
            model: model.into(),
        }
    }

    fn api_key(&self) -> OxideResult<String> {
        env::var("OPENAI_API_KEY").map_err(|_| OxideError::ProviderError {
            provider: self.identifier(),
            message: "Missing OPENAI_API_KEY environment variable".to_string(),
        })
    }
}

#[derive(Serialize)]
struct OpenAiRequest<'a> {
    model: &'a str,
    temperature: f32,
    messages: Vec<OpenAiMessage<'a>>,
}

#[derive(Serialize)]
struct OpenAiMessage<'a> {
    role: &'static str,
    content: &'a str,
}

#[derive(Deserialize)]
struct OpenAiResponse {
    choices: Vec<OpenAiChoice>,
}

#[derive(Deserialize)]
struct OpenAiChoice {
    message: OpenAiChoiceMessage,
}

#[derive(Deserialize)]
struct OpenAiChoiceMessage {
    content: Option<String>,
}

#[async_trait]
impl LlmProvider for OpenAiProvider {
    fn identifier(&self) -> String {
        format!("openai/{}", self.model)
    }

    async fn health_check(&self) -> OxideResult<bool> {
        Ok(self.api_key().is_ok())
    }

    async fn stream_chat(
        &self,
        messages: &[ChatMessage],
        temperature: f32,
        on_token: TokenStreamCallback,
    ) -> OxideResult<String> {
        let api_key = self.api_key()?;

        let req_messages: Vec<OpenAiMessage> = messages
            .iter()
            .map(|m| OpenAiMessage {
                role: match m.role {
                    ChatRole::System => "system",
                    ChatRole::Assistant => "assistant",
                    ChatRole::User | ChatRole::Tool => "user",
                },
                content: &m.content,
            })
            .collect();

        let body = OpenAiRequest {
            model: &self.model,
            temperature,
            messages: req_messages,
        };

        let resp = self
            .client
            .post("https://api.openai.com/v1/chat/completions")
            .bearer_auth(api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| OxideError::ProviderError {
                provider: self.identifier(),
                message: e.to_string(),
            })?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(OxideError::ProviderError {
                provider: self.identifier(),
                message: format!("HTTP {}: {}", status, text),
            });
        }

        let parsed: OpenAiResponse = resp.json().await.map_err(|e| OxideError::ProviderError {
            provider: self.identifier(),
            message: e.to_string(),
        })?;

        let content = parsed
            .choices
            .into_iter()
            .next()
            .and_then(|c| c.message.content)
            .unwrap_or_default();

        if !content.is_empty() {
            on_token(&content);
        }

        Ok(content)
    }
}
