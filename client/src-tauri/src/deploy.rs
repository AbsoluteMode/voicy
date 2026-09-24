//! Installs or removes a Voicy server on a VPS over SSH by running
//! `deploy/install.sh`, which is compiled into the app.

use std::{
    net::Ipv4Addr,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{anyhow, bail, Context, Result};
use russh::{
    client,
    keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate},
    ChannelMsg,
};
use serde::Deserialize;

const INSTALL_SH: &str = include_str!("../../../deploy/install.sh");
const REMOTE_SCRIPT: &str = "/tmp/voicy-install.sh";

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SshAuth {
    Password { password: String },
    Key { path: String, passphrase: Option<String> },
}

#[derive(Deserialize)]
pub struct SshCreds {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: SshAuth,
}

struct Handler {
    fingerprint: Arc<Mutex<Option<String>>>,
}

impl client::Handler for Handler {
    type Error = russh::Error;

    // Trust on first use: the fingerprint is shown in the log so the user can
    // compare it with what their hosting panel shows.
    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let key = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.key_data(),
            PublicKeyOrCertificate::Certificate(cert) => cert.public_key(),
        };
        *self.fingerprint.lock().unwrap() = Some(key.fingerprint(HashAlg::Sha256).to_string());
        Ok(true)
    }
}

pub fn default_key_path() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE")?;
    ["id_ed25519", "id_ecdsa", "id_rsa"]
        .iter()
        .map(|name| PathBuf::from(&home).join(".ssh").join(name))
        .find(|p| p.exists())
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

struct Session {
    handle: client::Handle<Handler>,
    creds: SshCreds,
}

impl Session {
    async fn connect(creds: SshCreds, log: &impl Fn(String)) -> Result<Self> {
        log(format!("Подключаюсь к {}@{}:{}…", creds.user, creds.host, creds.port));
        let config = Arc::new(client::Config {
            inactivity_timeout: Some(Duration::from_secs(600)),
            ..Default::default()
        });
        let fingerprint = Arc::new(Mutex::new(None));
        let handler = Handler { fingerprint: fingerprint.clone() };
        let mut handle = tokio::time::timeout(
            Duration::from_secs(15),
            client::connect(config, (creds.host.as_str(), creds.port), handler),
        )
        .await
        .map_err(|_| anyhow!("сервер не отвечает на {}:{}", creds.host, creds.port))?
        .context("не удалось подключиться по SSH")?;
        if let Some(fp) = fingerprint.lock().unwrap().as_ref() {
            log(format!("Ключ сервера: {fp}"));
        }

        let ok = match &creds.auth {
            SshAuth::Password { password } => handle.authenticate_password(&creds.user, password).await?.success(),
            SshAuth::Key { path, passphrase } => {
                let key = load_secret_key(path, passphrase.as_deref().filter(|p| !p.is_empty()))
                    .with_context(|| format!("не удалось прочитать ключ {path}"))?;
                let hash = handle.best_supported_rsa_hash().await?.flatten();
                handle
                    .authenticate_publickey(&creds.user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                    .await?
                    .success()
            }
        };
        if !ok {
            bail!("SSH отклонил логин или пароль/ключ");
        }
        log("Вход выполнен".into());
        Ok(Self { handle, creds })
    }

    /// Runs `cmd`, feeding it `stdin`, and streams its output line by line.
    /// Returns the exit status and the full output.
    async fn run(&self, cmd: &str, stdin: &[u8], log: &impl Fn(String)) -> Result<(u32, String)> {
        let mut ch = self.handle.channel_open_session().await?;
        ch.exec(true, cmd).await?;
        if !stdin.is_empty() {
            ch.data(stdin).await?;
        }
        ch.eof().await?;

        let mut out = String::new();
        let mut partial = Vec::new();
        let mut status = None;
        while let Some(msg) = ch.wait().await {
            match msg {
                ChannelMsg::Data { ref data } | ChannelMsg::ExtendedData { ref data, .. } => {
                    partial.extend_from_slice(data);
                    while let Some(i) = partial.iter().position(|&b| b == b'\n') {
                        let line: Vec<u8> = partial.drain(..=i).collect();
                        let line = String::from_utf8_lossy(&line).trim_end().to_owned();
                        out.push_str(&line);
                        out.push('\n');
                        if !line.is_empty() {
                            log(line);
                        }
                    }
                }
                ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                _ => {}
            }
        }
        if !partial.is_empty() {
            let line = String::from_utf8_lossy(&partial).trim_end().to_owned();
            out.push_str(&line);
            log(line);
        }
        Ok((status.unwrap_or(255), out))
    }

    /// Wraps a command so it runs as root, and returns what to send on stdin.
    fn as_root(&self, cmd: &str) -> (String, Vec<u8>) {
        if self.creds.user == "root" {
            return (cmd.to_owned(), Vec::new());
        }
        match &self.creds.auth {
            SshAuth::Password { password } => (format!("sudo -S -p '' {cmd}"), format!("{password}\n").into_bytes()),
            SshAuth::Key { .. } => (format!("sudo -n {cmd}"), Vec::new()),
        }
    }

    async fn upload_script(&self, log: &impl Fn(String)) -> Result<()> {
        log("Загружаю установщик…".into());
        let (status, out) = self
            .run(&format!("umask 077 && cat > {REMOTE_SCRIPT}"), INSTALL_SH.as_bytes(), &|_| {})
            .await?;
        if status != 0 {
            bail!("не удалось загрузить установщик: {}", out.trim());
        }
        Ok(())
    }

    async fn run_script(&self, env: &[(&str, String)], args: &str, log: &impl Fn(String)) -> Result<String> {
        let env: Vec<String> = env.iter().map(|(k, v)| format!("{k}={}", shell_quote(v))).collect();
        let (cmd, stdin) = self.as_root(&format!("env {} bash {REMOTE_SCRIPT} {args}", env.join(" ")));
        let (status, out) = self.run(&cmd, &stdin, log).await?;
        let _ = self.run(&format!("rm -f {REMOTE_SCRIPT}"), &[], &|_| {}).await;
        if let Some(err) = out.lines().find_map(|l| l.strip_prefix("VOICY_ERROR ")) {
            bail!("{err}");
        }
        if status != 0 {
            let tail: Vec<&str> = out.lines().rev().take(3).collect();
            bail!("установка завершилась с кодом {status}: {}", tail.into_iter().rev().collect::<Vec<_>>().join(" / "));
        }
        out.lines()
            .find_map(|l| l.strip_prefix("VOICY_OK "))
            .map(|s| s.trim().to_owned())
            .ok_or_else(|| anyhow!("установщик не сообщил результат"))
    }
}

/// Installs (or upgrades) the server. Returns its public `host[:port]`.
pub async fn install(creds: SshCreds, server_name: &str, bootstrap_code: &str, log: impl Fn(String)) -> Result<String> {
    let public_ip = creds.host.parse::<Ipv4Addr>().ok();
    let session = Session::connect(creds, &log).await?;
    session.upload_script(&log).await?;
    log("Запускаю установку, это займёт пару минут…".into());
    let mut env = vec![
        ("VOICY_BOOTSTRAP_CODE", bootstrap_code.to_owned()),
        ("VOICY_SERVER_NAME", server_name.to_owned()),
    ];
    if let Some(ip) = public_ip {
        env.push(("VOICY_PUBLIC_IP", ip.to_string()));
    }
    session.run_script(&env, "", &log).await
}

pub async fn uninstall(creds: SshCreds, log: impl Fn(String)) -> Result<()> {
    let session = Session::connect(creds, &log).await?;
    session.upload_script(&log).await?;
    log("Удаляю контейнеры и данные…".into());
    session.run_script(&[], "uninstall", &log).await?;
    Ok(())
}
