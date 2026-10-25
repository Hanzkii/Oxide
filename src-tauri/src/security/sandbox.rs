use crate::error::{OxideError, OxideResult};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

/// Maximum stdout/stderr bytes captured per command to prevent memory exhaustion attacks.
pub const MAX_OUTPUT_BYTES: usize = 128 * 1024; // 128 KiB

/// Default timeout for any single agent terminal tool invocation.
pub const DEFAULT_COMMAND_TIMEOUT_SECS: u64 = 60;

/// Environment variables scrubbed from all agent-spawned child processes to prevent
/// credential leakage via prompt injection or malicious build scripts.
const SCRUBBED_ENV_VARS: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GITLAB_TOKEN",
    "NPM_TOKEN",
    "CARGO_REGISTRY_TOKEN",
    "SSH_AUTH_SOCK",
    "SSH_AGENT_PID",
];

/// Default allowlist of developer binaries permitted inside the workspace sandbox.
const DEFAULT_ALLOWED_BINARIES: &[&str] = &[
    "cargo",
    "rustc",
    "rustfmt",
    "rustup",
    "npm",
    "npx",
    "pnpm",
    "yarn",
    "node",
    "tsc",
    "vite",
    "vitest",
    "jest",
    "python",
    "python3",
    "pytest",
    "pip",
    "uv",
    "git",
    "go",
    "make",
    "cmake",
    "rg",
    "grep",
    "find",
    "ls",
    "dir",
    "cat",
    "head",
    "tail",
    "wc",
    "mkdir",
    "touch",
    "cp",
    "mv",
    "echo",
    "pwd",
    "test",
];

/// Explicitly prohibited binaries and privilege escalation utilities.
const BLOCKED_BINARIES: &[&str] = &[
    "sudo",
    "su",
    "doas",
    "runas",
    "rm",
    "rmdir",
    "del",
    "erase",
    "format",
    "mkfs",
    "fdisk",
    "dd",
    "shutdown",
    "reboot",
    "halt",
    "poweroff",
    "chmod",
    "chown",
    "chgrp",
    "icacls",
    "takeown",
    "curl",
    "wget",
    "nc",
    "netcat",
    "ncat",
    "ssh",
    "scp",
    "sftp",
    "ftp",
    "telnet",
    "powershell",
    "pwsh",
    "cmd",
    "bash",
    "sh",
    "zsh",
    "reg",
    "regedit",
    "sc",
    "netsh",
    "wmic",
];

/// Shell metacharacters rejected in direct argv execution to prevent command chaining
/// and subshell injection (`;`, `&&`, `||`, `` ` ``, `$()`, `|`, `>`, `<`).
const FORBIDDEN_SHELL_TOKENS: &[&str] = &["&&", "||", ";", "|", "`", "$(", "${", ">", ">>", "<"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityAuditEntry {
    pub timestamp: String,
    pub workspace_root: String,
    pub requested_command: String,
    pub allowed: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandPolicy {
    pub allowed_binaries: HashSet<String>,
    pub timeout_secs: u64,
    pub max_output_bytes: usize,
    pub allow_network_commands: bool,
}

impl Default for CommandPolicy {
    fn default() -> Self {
        Self {
            allowed_binaries: DEFAULT_ALLOWED_BINARIES
                .iter()
                .map(|s| (*s).to_string())
                .collect(),
            timeout_secs: DEFAULT_COMMAND_TIMEOUT_SECS,
            max_output_bytes: MAX_OUTPUT_BYTES,
            allow_network_commands: false,
        }
    }
}

/// Validated, canonicalized command ready for bounded execution via `tokio::process::Command`.
#[derive(Debug, Clone)]
pub struct SanitizedCommand {
    pub program: String,
    pub args: Vec<String>,
    pub working_dir: PathBuf,
    pub scrubbed_env_keys: Vec<&'static str>,
    pub timeout: Duration,
    pub max_output_bytes: usize,
}

/// Enforces strict filesystem and process execution boundaries for a target workspace.
#[derive(Debug, Clone)]
pub struct WorkspaceSandbox {
    canonical_root: PathBuf,
    policy: CommandPolicy,
}

impl WorkspaceSandbox {
    /// Creates a new sandbox anchored to `workspace_path`.
    /// Rejects non-existent paths, files (must be a directory), or dangerous system roots.
    pub fn new(workspace_path: impl AsRef<Path>, policy: CommandPolicy) -> OxideResult<Self> {
        let raw_path = workspace_path.as_ref();
        if !raw_path.exists() {
            return Err(OxideError::WorkspaceError(format!(
                "Workspace directory does not exist: {}",
                raw_path.display()
            )));
        }

        let canonical_root = dunce::canonicalize(raw_path).map_err(|e| {
            OxideError::WorkspaceError(format!(
                "Failed to canonicalize workspace path '{}': {}",
                raw_path.display(),
                e
            ))
        })?;

        if !canonical_root.is_dir() {
            return Err(OxideError::WorkspaceError(format!(
                "Workspace path is not a directory: {}",
                canonical_root.display()
            )));
        }

        Self::reject_system_root(&canonical_root)?;

        Ok(Self {
            canonical_root,
            policy,
        })
    }

    pub fn canonical_root(&self) -> &Path {
        &self.canonical_root
    }

    pub fn policy(&self) -> &CommandPolicy {
        &self.policy
    }

    /// Prevents mounting the root filesystem, OS directories, or shallow drive roots as an agent workspace.
    fn reject_system_root(path: &Path) -> OxideResult<()> {
        let component_count = path.components().count();
        if component_count <= 2 {
            return Err(OxideError::SecurityViolation(format!(
                "Refusing to bind workspace to filesystem root or top-level directory: {}",
                path.display()
            )));
        }

        let lower = path.to_string_lossy().to_lowercase();
        let forbidden_prefixes = [
            "c:\\windows",
            "c:\\program files",
            "c:\\program files (x86)",
            "c:\\system32",
            "/etc",
            "/usr",
            "/bin",
            "/sbin",
            "/var",
            "/proc",
            "/sys",
            "/dev",
        ];

        for prefix in forbidden_prefixes {
            if lower == prefix || lower.starts_with(&format!("{}\\", prefix)) || lower.starts_with(&format!("{}/", prefix)) {
                return Err(OxideError::SecurityViolation(format!(
                    "Workspace path '{}' lies inside protected system directory '{}'",
                    path.display(),
                    prefix
                )));
            }
        }

        Ok(())
    }

    /// Resolves a candidate path (relative or absolute) and verifies it stays strictly inside `canonical_root`.
    /// Prevents `../` path traversal and symlink escapes outside the workspace jail.
    pub fn validate_path_in_workspace(&self, candidate: impl AsRef<Path>) -> OxideResult<PathBuf> {
        let candidate_ref = candidate.as_ref();

        // Check lexical traversal components before touching the filesystem
        let joined = if candidate_ref.is_absolute() {
            candidate_ref.to_path_buf()
        } else {
            self.canonical_root.join(candidate_ref)
        };

        let normalized = Self::lexical_normalize(&joined)?;
        if !normalized.starts_with(&self.canonical_root) {
            return Err(OxideError::SecurityViolation(format!(
                "Path traversal blocked: '{}' resolves outside workspace root '{}'",
                candidate_ref.display(),
                self.canonical_root.display()
            )));
        }

        // If the target exists on disk, canonicalize it to catch symlink escapes
        if normalized.exists() {
            let real_path = dunce::canonicalize(&normalized).map_err(|e| {
                OxideError::SecurityViolation(format!(
                    "Failed to canonicalize target path '{}': {}",
                    normalized.display(),
                    e
                ))
            })?;

            if !real_path.starts_with(&self.canonical_root) {
                return Err(OxideError::SecurityViolation(format!(
                    "Symlink escape blocked: '{}' points to '{}' outside workspace root '{}'",
                    candidate_ref.display(),
                    real_path.display(),
                    self.canonical_root.display()
                )));
            }
            return Ok(real_path);
        }

        // If the target does not exist yet (e.g. creating a new file), canonicalize its nearest existing ancestor
        let mut ancestor = normalized.as_path();
        while let Some(parent) = ancestor.parent() {
            if parent.exists() {
                let real_parent = dunce::canonicalize(parent).map_err(|e| {
                    OxideError::SecurityViolation(format!(
                        "Failed to canonicalize parent path '{}': {}",
                        parent.display(),
                        e
                    ))
                })?;
                if !real_parent.starts_with(&self.canonical_root) {
                    return Err(OxideError::SecurityViolation(format!(
                        "Ancestor symlink escape blocked: '{}' resolves outside workspace root",
                        parent.display()
                    )));
                }
                break;
            }
            ancestor = parent;
        }

        Ok(normalized)
    }

    /// Parses, audits, and sanitizes a command string or argv array into a `SanitizedCommand`.
    /// Note: Commands are executed directly via OS `Command::new(program).args(args)` without
    /// invoking an intermediate shell (`sh -c` or `cmd /C`), eliminating shell injection vectors.
    pub fn sanitize_command(
        &self,
        command_line: &str,
        sub_dir: Option<&Path>,
    ) -> OxideResult<SanitizedCommand> {
        let trimmed = command_line.trim();
        if trimmed.is_empty() {
            return Err(OxideError::SecurityViolation(
                "Empty command is not permitted".to_string(),
            ));
        }

        // Reject raw shell metacharacters / command chaining tokens
        for forbidden in FORBIDDEN_SHELL_TOKENS {
            if trimmed.contains(forbidden) {
                return Err(OxideError::SecurityViolation(format!(
                    "Shell chaining/redirection token '{}' is prohibited inside bounded agent commands. Execute single atomic tool commands instead.",
                    forbidden
                )));
            }
        }

        let tokens = Self::split_command_tokens(trimmed)?;
        if tokens.is_empty() {
            return Err(OxideError::SecurityViolation(
                "No executable token found in command".to_string(),
            ));
        }

        let raw_program = &tokens[0];
        let args = tokens[1..].to_vec();

        // Extract base executable name (strip any path or `.exe` suffix for policy check)
        let program_path = Path::new(raw_program);
        if program_path.components().count() > 1 {
            return Err(OxideError::SecurityViolation(format!(
                "Executable must be a bare binary name on PATH, not a path ('{}')",
                raw_program
            )));
        }

        let normalized_bin = program_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(raw_program)
            .to_lowercase();

        if BLOCKED_BINARIES.contains(&normalized_bin.as_str()) {
            return Err(OxideError::SecurityViolation(format!(
                "Binary '{}' is explicitly blocked by Oxide security policy",
                normalized_bin
            )));
        }

        if !self.policy.allowed_binaries.contains(&normalized_bin) {
            return Err(OxideError::SecurityViolation(format!(
                "Binary '{}' is not in the workspace CommandPolicy allowlist",
                normalized_bin
            )));
        }

        // Audit arguments for path traversal or dangerous flags
        self.audit_arguments(&normalized_bin, &args)?;

        let working_dir = match sub_dir {
            Some(dir) => self.validate_path_in_workspace(dir)?,
            None => self.canonical_root.clone(),
        };

        Ok(SanitizedCommand {
            program: normalized_bin,
            args,
            working_dir,
            scrubbed_env_keys: SCRUBBED_ENV_VARS.to_vec(),
            timeout: Duration::from_secs(self.policy.timeout_secs),
            max_output_bytes: self.policy.max_output_bytes,
        })
    }

    fn audit_arguments(&self, binary: &str, args: &[String]) -> OxideResult<()> {
        for arg in args {
            // Check if any argument looks like a path or contains `..`
            if arg.contains("..") || arg.starts_with('/') || arg.starts_with('\\') || arg.contains(":\\") {
                // Allow standard flags like `--out-dir=../dist` only if the path part resolves inside workspace
                let path_part = if let Some((_flag, val)) = arg.split_once('=') {
                    val
                } else {
                    arg.as_str()
                };
                self.validate_path_in_workspace(Path::new(path_part))?;
            }
        }

        // Git-specific guardrails: block global config modifications or arbitrary hooks execution
        if binary == "git" {
            for arg in args {
                let lower = arg.to_lowercase();
                if lower == "--global" || lower == "--system" || lower.starts_with("-c") || lower.contains("core.sshcommand") || lower.contains("core.fsmonitor") {
                    return Err(OxideError::SecurityViolation(format!(
                        "Git flag '{}' is restricted inside the autonomous sandbox",
                        arg
                    )));
                }
            }
        }

        Ok(())
    }

    fn lexical_normalize(path: &Path) -> OxideResult<PathBuf> {
        let mut out = PathBuf::new();
        for comp in path.components() {
            match comp {
                Component::Prefix(p) => out.push(p.as_os_str()),
                Component::RootDir => out.push(comp.as_os_str()),
                Component::CurDir => {}
                Component::ParentDir => {
                    if !out.pop() {
                        return Err(OxideError::SecurityViolation(
                            "Path traversal attempted above root".to_string(),
                        ));
                    }
                }
                Component::Normal(c) => out.push(c),
            }
        }
        Ok(out)
    }

    /// Minimal POSIX-style quote-aware tokenizer that never evaluates variable expansion or backticks.
    fn split_command_tokens(input: &str) -> OxideResult<Vec<String>> {
        let mut tokens = Vec::new();
        let mut current = String::new();
        let mut in_single_quote = false;
        let mut in_double_quote = false;
        let mut chars = input.chars().peekable();

        while let Some(ch) = chars.next() {
            match ch {
                '\'' if !in_double_quote => {
                    in_single_quote = !in_single_quote;
                }
                '"' if !in_single_quote => {
                    in_double_quote = !in_double_quote;
                }
                '\\' if in_double_quote => {
                    if let Some(&next_ch) = chars.peek() {
                        if next_ch == '"' || next_ch == '\\' {
                            current.push(chars.next().unwrap());
                        } else {
                            current.push(ch);
                        }
                    } else {
                        current.push(ch);
                    }
                }
                c if c.is_whitespace() && !in_single_quote && !in_double_quote => {
                    if !current.is_empty() {
                        tokens.push(std::mem::take(&mut current));
                    }
                }
                c => current.push(c),
            }
        }

        if in_single_quote || in_double_quote {
            return Err(OxideError::SecurityViolation(
                "Unterminated quote in command string".to_string(),
            ));
        }

        if !current.is_empty() {
            tokens.push(current);
        }

        Ok(tokens)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn blocks_shell_chaining_and_disallowed_binaries() {
        let temp_dir = env::temp_dir().join("oxide_sandbox_test");
        let _ = std::fs::create_dir_all(&temp_dir);
        let sandbox = WorkspaceSandbox::new(&temp_dir, CommandPolicy::default()).unwrap();

        assert!(sandbox.sanitize_command("cargo check", None).is_ok());
        assert!(sandbox
            .sanitize_command("cargo test && rm -rf /", None)
            .is_err());
        assert!(sandbox.sanitize_command("sudo cargo build", None).is_err());
        assert!(sandbox
            .sanitize_command("cat ../../etc/passwd", None)
            .is_err());
    }
}
