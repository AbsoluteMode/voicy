//! Servers this user belongs to. Metadata lives in a JSON file in the app
//! config dir; member tokens live in the Windows Credential Manager.

use std::{fs, path::PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SavedServer {
    /// `host[:port]`, also the key.
    pub host: String,
    pub name: String,
    pub member_id: String,
    pub nickname: String,
    pub role: String,
}

fn file(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_config_dir()?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join("servers.json"))
}

pub fn load(app: &AppHandle) -> Result<Vec<SavedServer>> {
    let path = file(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&path)?;
    serde_json::from_str(&text).with_context(|| format!("повреждён {}", path.display()))
}

fn save_all(app: &AppHandle, servers: &[SavedServer]) -> Result<()> {
    let path = file(app)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(servers)?)?;
    fs::rename(tmp, path)?;
    Ok(())
}

fn entry(host: &str) -> Result<keyring::Entry> {
    Ok(keyring::Entry::new("voicy", host)?)
}

pub fn token(host: &str) -> Result<Option<String>> {
    match entry(host)?.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn upsert(app: &AppHandle, server: SavedServer, token: Option<&str>) -> Result<()> {
    if let Some(token) = token {
        entry(&server.host)?.set_password(token)?;
    }
    let mut all = load(app)?;
    match all.iter_mut().find(|s| s.host == server.host) {
        Some(existing) => *existing = server,
        None => all.push(server),
    }
    save_all(app, &all)
}

pub fn remove(app: &AppHandle, host: &str) -> Result<()> {
    let mut all = load(app)?;
    all.retain(|s| s.host != host);
    save_all(app, &all)?;
    match entry(host)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
