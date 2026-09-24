mod api;
mod deploy;
mod error;
mod store;

use rand::RngCore;
use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{ipc::Channel, AppHandle};

use error::{CmdError, CmdResult};
use store::SavedServer;

#[tauri::command]
fn list_servers(app: AppHandle) -> CmdResult<Vec<SavedServer>> {
    Ok(store::load(&app)?)
}

/// Parses `voicy://join/<host>/<code>` (surrounding junk from chats is fine).
fn parse_invite(link: &str) -> CmdResult<(String, String)> {
    let bad = || CmdError::new("invalid", "это не похоже на ссылку-приглашение voicy://join/…");
    let rest = link.trim().trim_matches(|c| c == '<' || c == '>' || c == '"');
    let rest = rest.split_once("voicy://join/").ok_or_else(bad)?.1;
    let (host, code) = rest.split_once('/').ok_or_else(bad)?;
    let code = code.trim_end_matches('/');
    if !api::valid_host(host) || code.is_empty() || !code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(bad());
    }
    Ok((host.to_owned(), code.to_owned()))
}

async fn redeem(app: &AppHandle, host: &str, code: &str, nickname: &str) -> CmdResult<SavedServer> {
    let resp = api::request(host, None, Method::POST, "/api/join", Some(json!({ "code": code, "nickname": nickname }))).await?;
    #[derive(Deserialize)]
    struct Member {
        id: String,
        nickname: String,
        role: String,
    }
    #[derive(Deserialize)]
    struct Join {
        token: String,
        member: Member,
        server_name: String,
    }
    let join: Join = serde_json::from_value(resp).map_err(|e| CmdError::new("other", e.to_string()))?;
    let server = SavedServer {
        host: host.to_owned(),
        name: join.server_name,
        member_id: join.member.id,
        nickname: join.member.nickname,
        role: join.member.role,
    };
    store::upsert(app, server.clone(), Some(&join.token))?;
    Ok(server)
}

#[tauri::command]
async fn join_server(app: AppHandle, link: String, nickname: String) -> CmdResult<SavedServer> {
    let (host, code) = parse_invite(&link)?;
    redeem(&app, &host, &code, &nickname).await
}

/// Removes the server from this app only.
#[tauri::command]
fn forget_server(app: AppHandle, host: String) -> CmdResult<()> {
    Ok(store::remove(&app, &host)?)
}

/// Authenticated call to `https://<host>/api/...` on behalf of the saved member.
#[tauri::command]
async fn api_request(app: AppHandle, host: String, method: String, path: String, body: Option<Value>) -> CmdResult<Value> {
    let token = store::token(&host)?.ok_or_else(|| CmdError::new("unauthorized", "нет сохранённого входа для этого сервера"))?;
    let method = Method::from_bytes(method.as_bytes()).map_err(|_| CmdError::new("invalid", "bad method"))?;
    let result = api::request(&host, Some(&token), method.clone(), &path, body).await?;

    // Keep the cached nickname/role fresh so the sidebar is right offline.
    if path == "/api/me" && method != Method::DELETE {
        if let (Some(nick), Some(role)) = (result["nickname"].as_str(), result["role"].as_str()) {
            if let Some(mut s) = store::load(&app)?.into_iter().find(|s| s.host == host) {
                if s.nickname != nick || s.role != role {
                    s.nickname = nick.to_owned();
                    s.role = role.to_owned();
                    store::upsert(&app, s, None)?;
                }
            }
        }
    }
    Ok(result)
}

#[derive(Deserialize)]
struct DeployReq {
    ssh: deploy::SshCreds,
    server_name: String,
    nickname: String,
}

#[tauri::command]
async fn deploy_server(app: AppHandle, req: DeployReq, on_log: Channel<String>) -> CmdResult<SavedServer> {
    let mut code = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut code);
    let code: String = code.iter().map(|b| format!("{b:02x}")).collect();
    let log = |line: String| {
        let _ = on_log.send(line);
    };
    let host = deploy::install(req.ssh, &req.server_name, &code, log)
        .await
        .map_err(|e| CmdError::new("ssh", format!("{e:#}")))?;
    let _ = on_log.send(format!("Сервер работает: https://{host}"));
    redeem(&app, &host, &code, &req.nickname).await.map_err(|e| {
        if e.code == "forbidden" {
            CmdError::new("forbidden", "на этом сервере уже есть владелец: попроси у него ссылку-приглашение")
        } else {
            e
        }
    })
}

#[tauri::command]
async fn uninstall_server(ssh: deploy::SshCreds, on_log: Channel<String>) -> CmdResult<()> {
    let log = |line: String| {
        let _ = on_log.send(line);
    };
    deploy::uninstall(ssh, log)
        .await
        .map_err(|e| CmdError::new("ssh", format!("{e:#}")))
}

#[tauri::command]
fn default_ssh_key() -> Option<String> {
    deploy::default_key_path().map(|p| p.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be first: a second launch (e.g. from a voicy:// link) hands its
        // URL to the running window instead of opening another one.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            #[cfg(all(desktop, debug_assertions))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // Installed builds register the scheme in the installer.
                let _ = app.deep_link().register_all();
            }
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_servers,
            join_server,
            forget_server,
            api_request,
            deploy_server,
            uninstall_server,
            default_ssh_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::parse_invite;

    #[test]
    fn invite_links() {
        let (h, c) = parse_invite("voicy://join/1-2-3-4.sslip.io:7443/abc_DEF-1").unwrap();
        assert_eq!((h.as_str(), c.as_str()), ("1-2-3-4.sslip.io:7443", "abc_DEF-1"));
        assert!(parse_invite("  <voicy://join/host.example/code/>  ").is_ok());
        assert!(parse_invite("https://evil/join").is_err());
        assert!(parse_invite("voicy://join/host:99999/code").is_err());
        assert!(parse_invite("voicy://join/ho st/code").is_err());
    }
}
