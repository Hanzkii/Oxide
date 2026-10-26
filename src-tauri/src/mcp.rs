use crate::error::{OxideError, OxideResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpTransportKind {
    Builtin,
    Stdio,
    Http,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolSchema {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    pub transport: McpTransportKind,
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub url: Option<String>,
    pub enabled: bool,
    pub status: String,
    pub discovered_tools: Vec<McpToolSchema>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolCallResult {
    pub server_id: String,
    pub tool_name: String,
    pub succeeded: bool,
    pub content: String,
}

/// Built-in in-memory Knowledge Graph / Notes store for the `oxide-memory` builtin MCP server.
static BUILTIN_MEMORY_NOTES: std::sync::LazyLock<Mutex<Vec<(String, String)>>> =
    std::sync::LazyLock::new(|| {
        Mutex::new(vec![(
            "project_overview".to_string(),
            "Oxide Studio is a Tauri v2 + Rust + React autonomous AI coding agent with Subagents, Hardware Governor, and MCP support.".to_string(),
        )])
    });

pub struct McpRegistry {
    pub servers: Vec<McpServerConfig>,
}

impl Default for McpRegistry {
    fn default() -> Self {
        Self {
            servers: vec![
                McpServerConfig {
                    id: "oxide-memory".to_string(),
                    name: "Oxide Knowledge Graph & Memory (Built-in)".to_string(),
                    transport: McpTransportKind::Builtin,
                    command: "builtin:memory".to_string(),
                    args: vec![],
                    env: HashMap::new(),
                    url: None,
                    enabled: true,
                    status: "ready".to_string(),
                    discovered_tools: vec![
                        McpToolSchema {
                            name: "store_memory".to_string(),
                            description: "Store a key-value architectural note or memory for future agent tasks".to_string(),
                            input_schema: json!({
                                "type": "object",
                                "properties": {
                                    "key": { "type": "string", "description": "Memory key identifier" },
                                    "value": { "type": "string", "description": "Detailed note or fact to remember" }
                                },
                                "required": ["key", "value"]
                            }),
                        },
                        McpToolSchema {
                            name: "recall_memories".to_string(),
                            description: "List or search stored architectural memories and project notes".to_string(),
                            input_schema: json!({
                                "type": "object",
                                "properties": {
                                    "query": { "type": "string", "description": "Optional search filter" }
                                }
                            }),
                        },
                    ],
                },
                McpServerConfig {
                    id: "filesystem".to_string(),
                    name: "MCP Filesystem Server (@modelcontextprotocol/server-filesystem)".to_string(),
                    transport: McpTransportKind::Stdio,
                    command: "npx".to_string(),
                    args: vec![
                        "-y".to_string(),
                        "@modelcontextprotocol/server-filesystem".to_string(),
                        ".".to_string(),
                    ],
                    env: HashMap::new(),
                    url: None,
                    enabled: false,
                    status: "configured".to_string(),
                    discovered_tools: vec![],
                },
                McpServerConfig {
                    id: "sequential-thinking".to_string(),
                    name: "MCP Sequential Thinking (@modelcontextprotocol/server-sequential-thinking)".to_string(),
                    transport: McpTransportKind::Stdio,
                    command: "npx".to_string(),
                    args: vec![
                        "-y".to_string(),
                        "@modelcontextprotocol/server-sequential-thinking".to_string(),
                    ],
                    env: HashMap::new(),
                    url: None,
                    enabled: false,
                    status: "configured".to_string(),
                    discovered_tools: vec![],
                },
            ],
        }
    }
}

impl McpRegistry {
    /// Formats a prompt summary of all enabled MCP servers and their discovered tools
    /// so the Lead Architect AI and Subagents know how to invoke them.
    pub fn format_tools_for_agent_prompt(&self) -> String {
        let mut lines = Vec::new();
        for srv in self.servers.iter().filter(|s| s.enabled) {
            for tool in &srv.discovered_tools {
                lines.push(format!(
                    "- Server `{}` -> Tool `{}`: {} | Schema: {}",
                    srv.id, tool.name, tool.description, tool.input_schema
                ));
            }
        }
        if lines.is_empty() {
            "No MCP tools currently enabled.".to_string()
        } else {
            lines.join("\n")
        }
    }

    /// Probes an MCP server via JSON-RPC 2.0 (`initialize` -> `tools/list`) and updates its discovered tools.
    pub async fn discover_server_tools(&mut self, server_id: &str) -> OxideResult<McpServerConfig> {
        let idx = self
            .servers
            .iter()
            .position(|s| s.id == server_id)
            .ok_or_else(|| OxideError::ExecutionError(format!("MCP server '{}' not found", server_id)))?;

        let server = self.servers[idx].clone();
        if server.transport == McpTransportKind::Builtin {
            self.servers[idx].status = "ready".to_string();
            return Ok(self.servers[idx].clone());
        }

        let response = run_mcp_jsonrpc_request(
            &server,
            "tools/list",
            json!({}),
        )
        .await;

        match response {
            Ok(val) => {
                let mut tools = Vec::new();
                if let Some(arr) = val.get("tools").and_then(|t| t.as_array()) {
                    for item in arr {
                        let name = item
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown")
                            .to_string();
                        let description = item
                            .get("description")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let input_schema = item
                            .get("inputSchema")
                            .cloned()
                            .unwrap_or_else(|| json!({"type": "object"}));
                        tools.push(McpToolSchema {
                            name,
                            description,
                            input_schema,
                        });
                    }
                }
                self.servers[idx].discovered_tools = tools;
                self.servers[idx].status = "ready".to_string();
                self.servers[idx].enabled = true;
                Ok(self.servers[idx].clone())
            }
            Err(e) => {
                self.servers[idx].status = format!("error: {}", e);
                Err(e)
            }
        }
    }

    /// Invokes a tool on an enabled MCP server via JSON-RPC 2.0 `tools/call`.
    pub async fn call_tool(
        &self,
        server_id: &str,
        tool_name: &str,
        arguments: Value,
    ) -> OxideResult<McpToolCallResult> {
        let server = self
            .servers
            .iter()
            .find(|s| s.id == server_id)
            .ok_or_else(|| OxideError::ExecutionError(format!("MCP server '{}' not found", server_id)))?;

        if server.transport == McpTransportKind::Builtin {
            return execute_builtin_memory_tool(server_id, tool_name, &arguments);
        }

        let res = run_mcp_jsonrpc_request(
            server,
            "tools/call",
            json!({
                "name": tool_name,
                "arguments": arguments
            }),
        )
        .await?;

        let content_str = if let Some(arr) = res.get("content").and_then(|c| c.as_array()) {
            let mut parts = Vec::new();
            for block in arr {
                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                    parts.push(text.to_string());
                } else {
                    parts.push(block.to_string());
                }
            }
            parts.join("\n")
        } else {
            serde_json::to_string_pretty(&res).unwrap_or_default()
        };

        let is_err = res
            .get("isError")
            .and_then(|b| b.as_bool())
            .unwrap_or(false);

        Ok(McpToolCallResult {
            server_id: server_id.to_string(),
            tool_name: tool_name.to_string(),
            succeeded: !is_err,
            content: content_str,
        })
    }
}

fn execute_builtin_memory_tool(
    server_id: &str,
    tool_name: &str,
    arguments: &Value,
) -> OxideResult<McpToolCallResult> {
    let mut store = BUILTIN_MEMORY_NOTES.lock().unwrap();
    match tool_name {
        "store_memory" => {
            let key = arguments
                .get("key")
                .and_then(|v| v.as_str())
                .unwrap_or("note")
                .to_string();
            let value = arguments
                .get("value")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if let Some(existing) = store.iter_mut().find(|(k, _)| k == &key) {
                existing.1 = value.clone();
            } else {
                store.push((key.clone(), value.clone()));
            }
            Ok(McpToolCallResult {
                server_id: server_id.to_string(),
                tool_name: tool_name.to_string(),
                succeeded: true,
                content: format!("Stored memory '{}' ({} chars).", key, value.len()),
            })
        }
        "recall_memories" => {
            let query = arguments
                .get("query")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_lowercase();
            let filtered: Vec<String> = store
                .iter()
                .filter(|(k, v)| {
                    query.is_empty()
                        || k.to_lowercase().contains(&query)
                        || v.to_lowercase().contains(&query)
                })
                .map(|(k, v)| format!("• [{}]: {}", k, v))
                .collect();
            Ok(McpToolCallResult {
                server_id: server_id.to_string(),
                tool_name: tool_name.to_string(),
                succeeded: true,
                content: if filtered.is_empty() {
                    "No matching memories found.".to_string()
                } else {
                    filtered.join("\n")
                },
            })
        }
        other => Err(OxideError::ExecutionError(format!(
            "Unknown tool '{}' on builtin MCP server",
            other
        ))),
    }
}

async fn run_mcp_jsonrpc_request(
    server: &McpServerConfig,
    method: &str,
    params: Value,
) -> OxideResult<Value> {
    if server.transport == McpTransportKind::Http {
        let endpoint = server.url.as_deref().ok_or_else(|| {
            OxideError::ExecutionError("HTTP MCP server requires a valid URL".to_string())
        })?;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()?;
        let resp = client
            .post(endpoint)
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": method,
                "params": params
            }))
            .send()
            .await?;
        let body: Value = resp.json().await?;
        if let Some(err) = body.get("error") {
            return Err(OxideError::ExecutionError(format!(
                "MCP JSON-RPC error: {}",
                err
            )));
        }
        return Ok(body.get("result").cloned().unwrap_or(body));
    }

    // Stdio JSON-RPC 2.0 MCP Transport
    let bin = if cfg!(target_os = "windows") {
        if server.command == "npx" {
            "npx.cmd".to_string()
        } else if server.command == "npm" {
            "npm.cmd".to_string()
        } else if server.command == "pnpm" {
            "pnpm.cmd".to_string()
        } else if server.command == "yarn" {
            "yarn.cmd".to_string()
        } else {
            server.command.clone()
        }
    } else {
        server.command.clone()
    };

    let mut cmd = Command::new(&bin);
    cmd.args(&server.args)
        .envs(&server.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| {
        OxideError::ExecutionError(format!(
            "Failed to spawn MCP server '{}': {}",
            server.command, e
        ))
    })?;

    let mut stdin = child.stdin.take().ok_or_else(|| {
        OxideError::ExecutionError("Failed to open stdin for MCP server".to_string())
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        OxideError::ExecutionError("Failed to open stdout for MCP server".to_string())
    })?;

    let mut reader = BufReader::new(stdout).lines();

    let io_future = async {
        // 1. Send initialize request
        let init_req = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {
                    "name": "oxide-studio",
                    "version": "0.1.0"
                }
            }
        });
        stdin
            .write_all(format!("{}\n", init_req).as_bytes())
            .await?;
        stdin.flush().await?;

        // Wait for initialize response (id == 1)
        while let Some(line) = reader.next_line().await? {
            if let Ok(val) = serde_json::from_str::<Value>(&line) {
                if val.get("id").and_then(|v| v.as_i64()) == Some(1) {
                    break;
                }
            }
        }

        // 2. Send notifications/initialized + target method request (id == 2)
        let initialized_notif = json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {}
        });
        let target_req = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": method,
            "params": params
        });
        stdin
            .write_all(format!("{}\n{}\n", initialized_notif, target_req).as_bytes())
            .await?;
        stdin.flush().await?;

        while let Some(line) = reader.next_line().await? {
            if let Ok(val) = serde_json::from_str::<Value>(&line) {
                if val.get("id").and_then(|v| v.as_i64()) == Some(2) {
                    if let Some(err) = val.get("error") {
                        return Err(OxideError::ExecutionError(format!(
                            "MCP error response: {}",
                            err
                        )));
                    }
                    return Ok(val.get("result").cloned().unwrap_or(val));
                }
            }
        }

        Err(OxideError::ExecutionError(
            "MCP server closed stream before responding".to_string(),
        ))
    };

    tokio::time::timeout(Duration::from_secs(25), io_future)
        .await
        .map_err(|_| OxideError::ExecutionTimeout(25))?
}
