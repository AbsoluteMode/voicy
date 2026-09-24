use serde::Serialize;

/// Error shape the frontend receives from every command.
#[derive(Debug, Serialize)]
pub struct CmdError {
    /// Machine-readable: `unauthorized`, `gone`, `forbidden`, `network`, `ssh`, `invalid`, `other`.
    pub code: &'static str,
    pub message: String,
}

impl CmdError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

impl From<anyhow::Error> for CmdError {
    fn from(e: anyhow::Error) -> Self {
        CmdError::new("other", format!("{e:#}"))
    }
}

impl From<reqwest::Error> for CmdError {
    fn from(e: reqwest::Error) -> Self {
        CmdError::new("network", format!("сервер недоступен: {e}"))
    }
}

pub type CmdResult<T> = Result<T, CmdError>;
