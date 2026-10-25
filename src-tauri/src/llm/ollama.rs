use crate::error::{OxideError, OxideResult};
use crate::llm::{ChatMessage, ChatRole, LlmProvider, TokenStreamCallback};
use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Local-first LLM provider communicating with an Ollama daemon (`http://localhost:11434`).
/// Optimized for `qwen2.5-coder` and `gemma2` with low-latency NDJSON token streaming.
pub struct OllamaProvider {
    client: Client,
    base_url: String,
    model: String,
    num_gpu: Option<i32>,
}

#[derive(Serialize)]
struct OllamaChatRequest<'a> {
    model: &'a str,
    messages: Vec<OllamaMessage<'a>>,
    stream: bool,
    options: OllamaOptions,
}

#[derive(Serialize)]
struct OllamaOptions {
    temperature: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    num_gpu: Option<i32>,
}

#[derive(Serialize)]
struct OllamaMessage<'a> {
    role: &'static str,
    content: &'a str,
}

#[derive(Deserialize)]
struct OllamaStreamChunk {
    message: Option<OllamaChunkMessage>,
    done: bool,
    error: Option<String>,
}

#[derive(Deserialize)]
struct OllamaChunkMessage {
    content: String,
}

impl OllamaProvider {
    pub fn new(base_url: impl Into<String>, model: impl Into<String>) -> Self {
        Self::with_num_gpu(base_url, model, None)
    }

    pub fn with_num_gpu(
        base_url: impl Into<String>,
        model: impl Into<String>,
        num_gpu: Option<i32>,
    ) -> Self {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(300))
            .build()
            .unwrap_or_default();

        Self {
            client,
            base_url: base_url.into().trim_end_matches('/').to_string(),
            model: model.into(),
            num_gpu,
        }
    }
}

#[async_trait]
impl LlmProvider for OllamaProvider {
    fn identifier(&self) -> String {
        format!("ollama/{}", self.model)
    }

    async fn health_check(&self) -> OxideResult<bool> {
        let url = format!("{}/api/tags", self.base_url);
        match self.client.get(&url).send().await {
            Ok(resp) => Ok(resp.status().is_success()),
            Err(_) => Ok(false),
        }
    }

    async fn stream_chat(
        &self,
        messages: &[ChatMessage],
        temperature: f32,
        on_token: TokenStreamCallback,
    ) -> OxideResult<String> {
        let url = format!("{}/api/chat", self.base_url);

        let payload_messages: Vec<OllamaMessage> = messages
            .iter()
            .map(|m| OllamaMessage {
                role: match m.role {
                    ChatRole::System => "system",
                    ChatRole::User | ChatRole::Tool => "user",
                    ChatRole::Assistant => "assistant",
                },
                content: &m.content,
            })
            .collect();

        let req_body = OllamaChatRequest {
            model: &self.model,
            messages: payload_messages,
            stream: true,
            options: OllamaOptions {
                temperature,
                num_gpu: self.num_gpu,
            },
        };

        let response = self
            .client
            .post(&url)
            .json(&req_body)
            .send()
            .await
            .map_err(|e| OxideError::ProviderError {
                provider: self.identifier(),
                message: format!(
                    "Failed to connect to local Ollama instance at {}: {}",
                    self.base_url, e
                ),
            })?;

        if !response.status().is_success() {
            let status = response.status();
            let err_text = response.text().await.unwrap_or_default();
            return Err(OxideError::ProviderError {
                provider: self.identifier(),
                message: format!("HTTP {}: {}", status, err_text),
            });
        }

        let mut stream = response.bytes_stream();
        let mut full_response = String::new();
        let mut line_buffer = String::new();

        while let Some(chunk_res) = stream.next().await {
            let bytes = chunk_res.map_err(|e| OxideError::ProviderError {
                provider: self.identifier(),
                message: format!("Stream read error: {}", e),
            })?;

            line_buffer.push_str(&String::from_utf8_lossy(&bytes));

            while let Some(newline_idx) = line_buffer.find('\n') {
                let raw_line = line_buffer[..newline_idx].trim().to_string();
                line_buffer.drain(..=newline_idx);

                if raw_line.is_empty() {
                    continue;
                }

                let parsed: OllamaStreamChunk =
                    serde_json::from_str(&raw_line).map_err(|e| OxideError::ProviderError {
                        provider: self.identifier(),
                        message: format!("Invalid NDJSON from Ollama: {} (line: {})", e, raw_line),
                    })?;

                if let Some(err_msg) = parsed.error {
                    return Err(OxideError::ProviderError {
                        provider: self.identifier(),
                        message: err_msg,
                    });
                }

                if let Some(msg) = parsed.message {
                    if !msg.content.is_empty() {
                        on_token(&msg.content);
                        full_response.push_str(&msg.content);
                    }
                }

                if parsed.done {
                    return Ok(full_response);
                }
            }
        }

        Ok(full_response)
    }
}
