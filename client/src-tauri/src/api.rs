//! HTTP calls to a voicy-server. The member token never leaves the Rust side;
//! the frontend only sees short-lived LiveKit tokens.

use std::{sync::OnceLock, time::Duration};

use reqwest::{Method, StatusCode};
use serde::Deserialize;
use serde_json::Value;

use crate::error::{CmdError, CmdResult};

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent(concat!("voicy/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("http client")
    })
}

/// Host part of an invite link or a typed address: `name[:port]`.
pub fn valid_host(host: &str) -> bool {
    let (name, port) = match host.rsplit_once(':') {
        Some((n, p)) => (n, Some(p)),
        None => (host, None),
    };
    !name.is_empty()
        && name.len() <= 253
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        && port.is_none_or(|p| p.parse::<u16>().is_ok_and(|p| p > 0))
}

pub async fn request(host: &str, token: Option<&str>, method: Method, path: &str, body: Option<Value>) -> CmdResult<Value> {
    if !path.starts_with("/api/") || path.contains("..") {
        return Err(CmdError::new("invalid", "bad api path"));
    }
    // Plain HTTP is allowed only for the built-in server bound to this PC.
    let scheme = if host == "127.0.0.1:8080" { "http" } else { "https" };
    let mut req = client().request(method, format!("{scheme}://{host}{path}"));
    if body.as_ref().and_then(|value| value.get("attachment")).is_some_and(|file| !file.is_null())
        || path.starts_with("/api/attachments/")
    {
        req = req.timeout(Duration::from_secs(90));
    }
    if let Some(token) = token {
        req = req.bearer_auth(token);
    }
    if let Some(body) = body {
        req = req.json(&body);
    }
    let res = req.send().await?;
    let status = res.status();
    let text = res.text().await?;
    if status.is_success() {
        return Ok(if text.is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or(Value::Null) });
    }
    #[derive(Deserialize)]
    struct ErrBody {
        error: String,
    }
    let message = serde_json::from_str::<ErrBody>(&text).map(|b| b.error).unwrap_or_else(|_| status.to_string());
    let code = match status {
        StatusCode::UNAUTHORIZED => "unauthorized",
        StatusCode::GONE => "gone",
        StatusCode::FORBIDDEN => "forbidden",
        StatusCode::BAD_REQUEST => "invalid",
        _ => "other",
    };
    Err(CmdError::new(code, message))
}
