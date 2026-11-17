use crate::commands::agent::HuggingFaceModelEntry;
use crate::llm::AgentRoleKind;
use crate::orchestrator::{SubagentRunState, WorkflowStepStatus};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

/// Primary top-level navigation views
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MainView {
    CommandCenter,
    ModelHub,
    Settings,
    TerminalLogs,
}

/// Collapsible sidebar layout states
#[derive(Debug, Clone)]
pub struct SidebarState {
    pub left_collapsed: bool,
    pub left_tab: LeftSidebarTab,
    pub right_collapsed: bool,
    pub right_tab: RightSidebarTab,
    pub terminal_drawer_open: bool,
}

impl Default for SidebarState {
    fn default() -> Self {
        Self {
            left_collapsed: false,
            left_tab: LeftSidebarTab::Files,
            right_collapsed: false,
            right_tab: RightSidebarTab::Subagents,
            terminal_drawer_open: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeftSidebarTab {
    Files,
    Projects,
    History,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RightSidebarTab {
    Subagents,
    Telemetry,
}

// ---------------------------------------------------------------------------
// Studio Sessions DTOs (Multi-Project & Conversation History)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct ProjectWorkspace {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct SavedConversation {
    pub id: String,
    #[serde(alias = "projectId")]
    pub project_id: String,
    pub title: String,
    #[serde(alias = "updatedAt")]
    pub updated_at: String,
    #[serde(default)]
    pub turns: Vec<ConversationTurnDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct ConversationTurnDto {
    pub user_prompt: String,
    pub thought: String,
    pub thinking_metrics: Option<(f32, f32, usize, String, i32)>,
    #[serde(default)]
    pub plan: Vec<String>,
    #[serde(default)]
    pub workflow_steps: Vec<WorkflowCardDto>,
    pub assistant_reply: String,
    #[serde(default)]
    pub subagents: Vec<SubagentItemDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct WorkflowCardDto {
    pub step: usize,
    pub title: String,
    pub detail: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct SubagentItemDto {
    pub id: String,
    pub role: String,
    pub model: String,
    pub title: String,
    pub state: String,
    pub thought: String,
    pub output_preview: String,
    pub active_workers: usize,
    pub max_allowed_workers: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct StudioSessionsFile {
    #[serde(default)]
    pub projects: Vec<ProjectWorkspace>,
    #[serde(default)]
    pub conversations: Vec<SavedConversation>,
    #[serde(default, alias = "activeProjectId")]
    pub active_project_id: Option<String>,
    #[serde(default, alias = "activeConvId")]
    pub active_conv_id: Option<String>,
}

impl StudioSessionsFile {
    pub fn load_from_disk() -> Self {
        let install_dir = crate::commands::workspace::oxide_install_dir();
        let path = install_dir.join("studio_sessions.json");
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Ok(parsed) = serde_json::from_str::<StudioSessionsFile>(&content) {
                    return parsed;
                }
            }
        }
        Self::default()
    }

    pub fn save_to_disk(&self) {
        let install_dir = crate::commands::workspace::oxide_install_dir();
        let _ = std::fs::create_dir_all(&install_dir);
        let path = install_dir.join("studio_sessions.json");
        if let Ok(json) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write(path, json);
        }
    }
}

// ---------------------------------------------------------------------------
// In-Memory Chat & Turn Representations
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct SubagentItem {
    pub id: String,
    pub role: AgentRoleKind,
    pub model: String,
    pub title: String,
    pub state: SubagentRunState,
    pub thought: String,
    pub output_preview: String,
    pub active_workers: usize,
    pub max_allowed_workers: usize,
}

impl SubagentItem {
    pub fn to_dto(&self) -> SubagentItemDto {
        SubagentItemDto {
            id: self.id.clone(),
            role: format!("{:?}", self.role),
            model: self.model.clone(),
            title: self.title.clone(),
            state: format!("{:?}", self.state),
            thought: self.thought.clone(),
            output_preview: self.output_preview.clone(),
            active_workers: self.active_workers,
            max_allowed_workers: self.max_allowed_workers,
        }
    }

    pub fn from_dto(dto: &SubagentItemDto) -> Self {
        let role = match dto.role.to_lowercase().as_str() {
            "architect" => AgentRoleKind::Architect,
            "codersubagent" | "coder_subagent" | "coder" => AgentRoleKind::CoderSubagent,
            "researchsubagent" | "research_subagent" | "researcher" => AgentRoleKind::ResearchSubagent,
            "testersubagent" | "tester_subagent" | "tester" => AgentRoleKind::TesterSubagent,
            _ => AgentRoleKind::CoderSubagent,
        };

        let state = match dto.state.to_lowercase().as_str() {
            "queued" => SubagentRunState::Queued,
            "running" => SubagentRunState::Running,
            "completed" | "done" => SubagentRunState::Completed,
            "failed" => SubagentRunState::Failed,
            _ => SubagentRunState::Completed,
        };

        Self {
            id: dto.id.clone(),
            role,
            model: dto.model.clone(),
            title: dto.title.clone(),
            state,
            thought: dto.thought.clone(),
            output_preview: dto.output_preview.clone(),
            active_workers: dto.active_workers,
            max_allowed_workers: dto.max_allowed_workers,
        }
    }
}

#[derive(Clone, Debug)]
pub struct WorkflowCardItem {
    pub step: usize,
    pub title: String,
    pub detail: String,
    pub status: WorkflowStepStatus,
}

impl WorkflowCardItem {
    pub fn to_dto(&self) -> WorkflowCardDto {
        WorkflowCardDto {
            step: self.step,
            title: self.title.clone(),
            detail: self.detail.clone(),
            status: format!("{:?}", self.status),
        }
    }

    pub fn from_dto(dto: &WorkflowCardDto) -> Self {
        let status = match dto.status.to_lowercase().as_str() {
            "running" => WorkflowStepStatus::Running,
            "succeeded" | "completed" | "done" => WorkflowStepStatus::Succeeded,
            "selfcorrecting" | "self_correcting" => WorkflowStepStatus::SelfCorrecting,
            "failed" => WorkflowStepStatus::Failed,
            _ => WorkflowStepStatus::Succeeded,
        };

        Self {
            step: dto.step,
            title: dto.title.clone(),
            detail: dto.detail.clone(),
            status,
        }
    }
}

#[derive(Clone, Debug)]
pub struct ConversationTurn {
    pub user_prompt: String,
    pub thought: String,
    pub thinking_metrics: Option<(f32, f32, usize, String, i32)>,
    pub plan: Vec<String>,
    pub workflow_steps: Vec<WorkflowCardItem>,
    pub assistant_reply: String,
    pub subagents: Vec<SubagentItem>,
}

impl ConversationTurn {
    pub fn to_dto(&self) -> ConversationTurnDto {
        ConversationTurnDto {
            user_prompt: self.user_prompt.clone(),
            thought: self.thought.clone(),
            thinking_metrics: self.thinking_metrics.clone(),
            plan: self.plan.clone(),
            workflow_steps: self.workflow_steps.iter().map(|w| w.to_dto()).collect(),
            assistant_reply: self.assistant_reply.clone(),
            subagents: self.subagents.iter().map(|s| s.to_dto()).collect(),
        }
    }

    pub fn from_dto(dto: &ConversationTurnDto) -> Self {
        Self {
            user_prompt: dto.user_prompt.clone(),
            thought: dto.thought.clone(),
            thinking_metrics: dto.thinking_metrics.clone(),
            plan: dto.plan.clone(),
            workflow_steps: dto.workflow_steps.iter().map(WorkflowCardItem::from_dto).collect(),
            assistant_reply: dto.assistant_reply.clone(),
            subagents: dto.subagents.iter().map(SubagentItem::from_dto).collect(),
        }
    }
}

// ---------------------------------------------------------------------------
// Model Hub State & Streaming Progress Models
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelDownloadProgress {
    pub model_id: String,
    pub status: String,
    pub completed_bytes: u64,
    pub total_bytes: u64,
    pub percent: f32,
    pub speed_mb_s: f32,
    pub is_finished: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct InstalledModelItem {
    pub filename: String,
    pub path: PathBuf,
    pub size_gb: f32,
    pub is_active: bool,
}

pub struct ActiveDownloadTask {
    pub model_id: String,
    pub display_name: String,
    pub progress: ModelDownloadProgress,
    pub cancel_flag: Arc<AtomicBool>,
}

pub struct ModelHubState {
    pub search_query: String,
    pub is_searching: bool,
    pub search_results: Vec<HuggingFaceModelEntry>,
    pub active_download: Option<ActiveDownloadTask>,
    pub installed_models: Vec<InstalledModelItem>,
    pub status_message: Option<(String, bool)>, // (text, is_error)
}

impl Default for ModelHubState {
    fn default() -> Self {
        Self {
            search_query: String::new(),
            is_searching: false,
            search_results: Vec::new(),
            active_download: None,
            installed_models: Vec::new(),
            status_message: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_studio_sessions_file_serde_default() {
        let empty_json = "{}";
        let parsed: Result<StudioSessionsFile, _> = serde_json::from_str(empty_json);
        assert!(parsed.is_ok());
        let file = parsed.unwrap();
        assert!(file.projects.is_empty());
        assert!(file.conversations.is_empty());
        assert!(file.active_project_id.is_none());
        assert!(file.active_conv_id.is_none());

        let partial_json = r#"{"activeProjectId": "proj-1"}"#;
        let parsed_partial: StudioSessionsFile = serde_json::from_str(partial_json).unwrap();
        assert_eq!(parsed_partial.active_project_id.as_deref(), Some("proj-1"));
        assert!(parsed_partial.projects.is_empty());
        assert!(parsed_partial.conversations.is_empty());
    }
}
