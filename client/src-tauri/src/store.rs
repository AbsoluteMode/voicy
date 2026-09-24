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
        // A new membership never silently destroys the previous login: it
        // may be the owner's, which cannot be reissued.
        if let Some(old) = self::token(&server.host)?.filter(|old| old != token) {
            keyring::Entry::new("voicy", &format!("{}#previous", server.host))?.set_password(&old)?;
        }
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

/// SSH key fingerprints of VPSes this app has deployed to, by `host:port`.
fn known_hosts_file(app: &AppHandle) -> Result<PathBuf> {
    Ok(file(app)?.with_file_name("known_hosts.json"))
}

fn known_hosts(app: &AppHandle) -> Result<std::collections::BTreeMap<String, String>> {
    let path = known_hosts_file(app)?;
    if !path.exists() {
        return Ok(Default::default());
    }
    Ok(serde_json::from_str(&fs::read_to_string(path)?)?)
}

pub fn known_host(app: &AppHandle, endpoint: &str) -> Result<Option<String>> {
    Ok(known_hosts(app)?.remove(endpoint))
}

pub fn remember_host(app: &AppHandle, endpoint: &str, fingerprint: &str) -> Result<()> {
    let mut all = known_hosts(app)?;
    if all.get(endpoint).map(String::as_str) == Some(fingerprint) {
        return Ok(());
    }
    all.insert(endpoint.to_owned(), fingerprint.to_owned());
    let path = known_hosts_file(app)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(&all)?)?;
    fs::rename(tmp, path)?;
    Ok(())
}
