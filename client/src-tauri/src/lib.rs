mod api;
mod deploy;
mod error;
mod permissions;
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

/// Parses `https://<host>/join/<code>` or `voicy://join/<host>/<code>`.
/// Surrounding text pasted from a chat is fine.
fn parse_invite(link: &str) -> CmdResult<(String, String)> {
    let bad = || CmdError::new("invalid", "это не похоже на ссылку-приглашение Voicy");
    let text = link.trim();
    let (host, code) = if let Some((_, rest)) = text.split_once("voicy://join/") {
        rest.split_once('/').ok_or_else(bad)?
    } else {
        let rest = text.split_once("https://").ok_or_else(bad)?.1;
        let (host, path) = rest.split_once('/').ok_or_else(bad)?;
        (host, path.strip_prefix("join/").ok_or_else(bad)?)
    };
    let code: String = code.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    if !api::valid_host(host) || code.len() < 16 {
        return Err(bad());
    }
    Ok((host.to_owned(), code))
}

/// An invite link from the clipboard for a server we have not joined yet.
/// This is how the download button on the invite page hands the link over.
#[tauri::command]
fn invite_from_clipboard(app: AppHandle) -> Option<String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let text = app.clipboard().read_text().ok()?;
    if text.len() > 2048 {
        return None;
    }
    let (host, code) = parse_invite(&text).ok()?;
    let saved = store::load(&app).ok()?;
    if saved.iter().any(|s| s.host == host) {
        return None;
    }
    Some(format!("https://{host}/join/{code}"))
}

/// Public info about the server an invite points to.
#[tauri::command]
async fn invite_info(link: String) -> CmdResult<Value> {
    let (host, _) = parse_invite(&link)?;
    let mut info = api::request(&host, None, Method::GET, "/api/info", None).await?;
    info["host"] = json!(host);
    Ok(info)
}

/// Writes a diagnostic recording to the user's Downloads folder and returns
/// the path.
#[tauri::command]
fn save_recording(name: String, wav: Vec<u8>, stats: String) -> CmdResult<String> {
    let safe: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '_' })
        .take(40)
        .collect();
    let dir = std::env::var_os("USERPROFILE")
        .map(|h| std::path::PathBuf::from(h).join("Downloads"))
        .filter(|d| d.is_dir())
        .ok_or_else(|| CmdError::new("other", "не нашёл папку «Загрузки»"))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    let base = dir.join(format!("voicy-{safe}-{stamp}"));
    let wav_path = base.with_extension("wav");
    std::fs::write(&wav_path, wav).map_err(|e| CmdError::new("other", e.to_string()))?;
    std::fs::write(base.with_extension("json"), stats).map_err(|e| CmdError::new("other", e.to_string()))?;
    Ok(wav_path.to_string_lossy().into_owned())
}

#[tauri::command]
fn os_username() -> Option<String> {
    std::env::var("USERNAME").ok().filter(|u| !u.is_empty())
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
    // Already a member: keep the invite unused for someone else.
    let saved = store::load(&app)?.into_iter().find(|s| s.host == host);
    if let (Some(saved), Some(token)) = (saved, store::token(&host)?) {
        match api::request(&host, Some(&token), Method::GET, "/api/me", None).await {
            Ok(_) => return Ok(saved),
            Err(e) if e.code == "unauthorized" => {} // kicked earlier; join anew
            Err(e) => return Err(e),
        }
    }
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

    // Keep the cached nickname, role and server name fresh so the sidebar is
    // right offline.
    let saved = || -> CmdResult<Option<SavedServer>> { Ok(store::load(&app)?.into_iter().find(|s| s.host == host)) };
    if path == "/api/me" && method != Method::DELETE {
        if let (Some(nick), Some(role)) = (result["nickname"].as_str(), result["role"].as_str()) {
            if let Some(mut s) = saved()? {
                if s.nickname != nick || s.role != role {
                    s.nickname = nick.to_owned();
                    s.role = role.to_owned();
                    store::upsert(&app, s, None)?;
                }
            }
        }
    }
    if path == "/api/info" || (path == "/api/server" && method == Method::PATCH) {
        if let Some(name) = result["name"].as_str() {
            if let Some(mut s) = saved()? {
                if s.name != name {
                    s.name = name.to_owned();
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

fn ssh_error(e: anyhow::Error) -> CmdError {
    match e.downcast_ref::<deploy::HostKeyError>() {
        Some(deploy::HostKeyError::Unknown { fingerprint }) => CmdError::new("hostkey_unknown", fingerprint.clone()),
        // The message is the new fingerprint, for the "trust it" override.
        Some(deploy::HostKeyError::Changed { got, .. }) => CmdError::new("hostkey_changed", got.clone()),
        None => CmdError::new("ssh", format!("{e:#}")),
    }
}

#[tauri::command]
async fn deploy_server(app: AppHandle, req: DeployReq, on_log: Channel<String>) -> CmdResult<SavedServer> {
    let mut code = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut code);
    let code: String = code.iter().map(|b| format!("{b:02x}")).collect();
    let log = |line: String| {
        let _ = on_log.send(line);
    };
    let endpoint = req.ssh.endpoint();
    let known = store::known_host(&app, &endpoint)?;
    let installed = deploy::install(req.ssh, known, &req.server_name, &code, log)
        .await
        .map_err(ssh_error)?;
    store::remember_host(&app, &endpoint, &installed.fingerprint)?;
    let host = installed.public_host;
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
async fn uninstall_server(app: AppHandle, ssh: deploy::SshCreds, on_log: Channel<String>) -> CmdResult<()> {
    let log = |line: String| {
        let _ = on_log.send(line);
    };
    let endpoint = ssh.endpoint();
    let known = store::known_host(&app, &endpoint)?;
    let fingerprint = deploy::uninstall(ssh, known, log).await.map_err(ssh_error)?;
    store::remember_host(&app, &endpoint, &fingerprint)?;
    Ok(())
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
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            use tauri::Manager;
            #[cfg(all(desktop, debug_assertions))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // Installed builds register the scheme in the installer.
                let _ = app.deep_link().register_all();
            }
            if let Some(window) = app.get_webview_window("main") {
                permissions::allow_microphone(&window);
            }
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
            invite_from_clipboard,
            invite_info,
            os_username,
            save_recording,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::parse_invite;

    #[test]
    fn invite_links() {
        const CODE: &str = "xNpdLBtxPcNVhfPTDyLshk5M7sPBZ16alG4pxte1RtY";
        let (h, c) = parse_invite(&format!("voicy://join/1-2-3-4.sslip.io:7443/{CODE}")).unwrap();
        assert_eq!((h.as_str(), c.as_str()), ("1-2-3-4.sslip.io:7443", CODE));
        let (h, c) = parse_invite(&format!("Заходи: https://1-2-3-4.sslip.io:7443/join/{CODE} ")).unwrap();
        assert_eq!((h.as_str(), c.as_str()), ("1-2-3-4.sslip.io:7443", CODE));
        assert!(parse_invite(&format!("<voicy://join/host.example/{CODE}/>")).is_ok());
        assert!(parse_invite("https://evil/join").is_err());
        assert!(parse_invite(&format!("https://host.example/other/{CODE}")).is_err());
        assert!(parse_invite("voicy://join/host.example/short").is_err());
        assert!(parse_invite(&format!("voicy://join/host:99999/{CODE}")).is_err());
        assert!(parse_invite(&format!("voicy://join/ho st/{CODE}")).is_err());
    }
}
