use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum OxideError {
    #[error("Security violation: {0}")]
    SecurityViolation(String),

    #[error("Workspace error: {0}")]
    WorkspaceError(String),

    #[error("Command execution failed: {0}")]
    ExecutionError(String),

    #[error("Command timed out after {0} seconds")]
    ExecutionTimeout(u64),

    #[error("LLM provider error ({provider}): {message}")]
    ProviderError { provider: String, message: String },

    #[error("Git orchestration error: {0}")]
    GitError(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("HTTP transport error: {0}")]
    Http(#[from] reqwest::Error),
}

impl Serialize for OxideError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        #[derive(Serialize)]
        struct ErrorPayload {
            kind: &'static str,
            message: String,
        }

        let kind = match self {
            OxideError::SecurityViolation(_) => "SECURITY_VIOLATION",
            OxideError::WorkspaceError(_) => "WORKSPACE_ERROR",
            OxideError::ExecutionError(_) => "EXECUTION_ERROR",
            OxideError::ExecutionTimeout(_) => "EXECUTION_TIMEOUT",
            OxideError::ProviderError { .. } => "PROVIDER_ERROR",
            OxideError::GitError(_) => "GIT_ERROR",
            OxideError::Io(_) => "IO_ERROR",
            OxideError::Serialization(_) => "SERIALIZATION_ERROR",
            OxideError::Http(_) => "HTTP_ERROR",
        };

        ErrorPayload {
            kind,
            message: self.to_string(),
        }
        .serialize(serializer)
    }
}

pub type OxideResult<T> = Result<T, OxideError>;
