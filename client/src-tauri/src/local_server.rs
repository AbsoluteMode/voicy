//! A loopback-only Voicy server for trying the app without a VPS.
//! The API runs as a bundled Windows executable; LiveKit runs in Docker Desktop.

use std::{
    fs,
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::{Child, Command},
    sync::{Mutex, OnceLock},
    thread,
    time::Duration,
};

use anyhow::{anyhow, bail, Context, Result};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tauri::{path::BaseDirectory, AppHandle, Manager};

pub const HOST: &str = "127.0.0.1:8080";
const LIVEKIT: &str = "voicy-app-livekit";
const LIVEKIT_IMAGE: &str = "livekit/livekit-server:v1.13";

#[derive(Clone, Deserialize, Serialize)]
pub struct LocalConfig {
    pub name: String,
    pub code: String,
}

static CHILD: OnceLock<Mutex<Option<Child>>> = OnceLock::new();

fn child() -> &'static Mutex<Option<Child>> {
    CHILD.get_or_init(|| Mutex::new(None))
}

fn config_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_config_dir()?;
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn config_file(app: &AppHandle) -> Result<PathBuf> {
    Ok(config_dir(app)?.join("local-server.json"))
}

fn load(app: &AppHandle) -> Result<LocalConfig> {
    let path = config_file(app)?;
    serde_json::from_slice(&fs::read(&path).with_context(|| format!("не найден локальный сервер: {}", path.display()))?)
        .context("повреждены настройки локального сервера")
}

pub fn prepare(app: &AppHandle, name: &str) -> Result<LocalConfig> {
    if config_file(app)?.exists() {
        return load(app);
    }
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 48 || name.chars().any(char::is_control) {
        bail!("название сервера должно содержать от 1 до 48 символов");
    }
    let mut bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    let code = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let cfg = LocalConfig { name: name.to_owned(), code };
    fs::write(config_file(app)?, serde_json::to_vec_pretty(&cfg)?)?;
    Ok(cfg)
}

fn docker(args: &[&str]) -> Result<String> {
    let output = Command::new("docker")
        .args(args)
        .output()
        .context("Docker Desktop не найден. Установи и запусти Docker Desktop")?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        bail!("Docker: {detail}");
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn port_ready(port: u16) -> bool {
    TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(250)).is_ok()
}

fn wait_port(port: u16, label: &str) -> Result<()> {
    for _ in 0..60 {
        if port_ready(port) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(500));
    }
    bail!("{label} не запустился на 127.0.0.1:{port}")
}

fn ensure_livekit(log: &impl Fn(&str)) -> Result<()> {
    docker(&["info", "--format", "{{.ServerVersion}}"])
        .context("запусти Docker Desktop и попробуй ещё раз")?;
    let inspect = Command::new("docker")
        .args(["container", "inspect", "--format", "{{.State.Running}}", LIVEKIT])
        .output()?;
    if inspect.status.success() {
        if String::from_utf8_lossy(&inspect.stdout).trim() != "true" {
            log("Запускаю LiveKit…");
            docker(&["start", LIVEKIT])?;
        }
    } else {
        log("Создаю локальный LiveKit в Docker…");
        docker(&[
            "run", "-d", "--name", LIVEKIT, "--restart", "unless-stopped",
            "-p", "127.0.0.1:7880:7880/tcp",
            "-p", "127.0.0.1:7881:7881/tcp",
            "-p", "127.0.0.1:7882:7882/udp",
            LIVEKIT_IMAGE, "--dev", "--bind", "0.0.0.0", "--node-ip", "127.0.0.1",
        ])?;
    }
    wait_port(7880, "LiveKit")
}

fn server_exe(app: &AppHandle) -> Result<PathBuf> {
    for path in ["resources/voicy-server.exe", "voicy-server.exe"] {
        let resource = app.path().resolve(path, BaseDirectory::Resource)?;
        if resource.is_file() {
            return Ok(resource);
        }
    }
    let sibling = std::env::current_exe()?.with_file_name("voicy-server.exe");
    if sibling.is_file() {
        return Ok(sibling);
    }
    bail!("voicy-server.exe не входит в эту сборку Voicy")
}

pub fn ensure(app: &AppHandle, log: impl Fn(&str)) -> Result<LocalConfig> {
    let cfg = load(app)?;
    let mut child = child().lock().map_err(|_| anyhow!("не удалось открыть локальный сервер"))?;
    if let Some(process) = child.as_mut() {
        if process.try_wait()?.is_none() && port_ready(8080) {
            return Ok(cfg);
        }
        *child = None;
    }

    ensure_livekit(&log)?;
    if port_ready(8080) {
        bail!("порт 8080 уже занят другой программой. Освободи его и попробуй снова");
    }
    let exe = server_exe(app)?;
    let db = config_dir(app)?.join("local-server.db");
    log("Запускаю локальный Voicy…");
    let process = Command::new(exe)
        .env("VOICY_BIND", HOST)
        .env("VOICY_DB", db)
        .env("VOICY_PUBLIC_HOST", HOST)
        .env("VOICY_SERVER_NAME", &cfg.name)
        .env("VOICY_BOOTSTRAP_CODE", &cfg.code)
        .env("LIVEKIT_API_URL", "http://127.0.0.1:7880")
        .env("LIVEKIT_API_KEY", "devkey")
        .env("LIVEKIT_API_SECRET", "secret")
        .spawn()
        .context("не удалось запустить voicy-server.exe")?;
    *child = Some(process);
    wait_port(8080, "Voicy")?;
    Ok(cfg)
}

pub fn stop() {
    if let Some(lock) = CHILD.get() {
        if let Ok(mut child) = lock.lock() {
            if let Some(mut process) = child.take() {
                let _ = process.kill();
                let _ = process.wait();
            }
        }
    }
}
