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
    /// Fingerprint the user approved after seeing it.
    #[serde(default)]
    pub trust_fingerprint: Option<String>,
    /// The user confirmed that a changed server key is expected.
    #[serde(default)]
    pub replace_known: bool,
}

impl SshCreds {
    /// Key for the known-hosts store.
    pub fn endpoint(&self) -> String {
        format!("{}:{}", self.host.to_ascii_lowercase(), self.port)
    }
}

/// The server key was not accepted, so nothing was sent to the server.
#[derive(Debug)]
pub enum HostKeyError {
    Unknown { fingerprint: String },
    Changed { expected: String, got: String },
}

impl std::fmt::Display for HostKeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HostKeyError::Unknown { fingerprint } => write!(f, "{fingerprint}"),
            HostKeyError::Changed { expected, got } => write!(f, "ожидался {expected}, сервер показал {got}"),
        }
    }
}

impl std::error::Error for HostKeyError {}

struct Handler {
    expected: Option<String>,
    creds_trust: Option<String>,
    replace_known: bool,
    seen: Arc<Mutex<Option<String>>>,
}

impl Handler {
    fn accepts(&self, fp: &str) -> bool {
        let trusted = self.creds_trust.as_deref() == Some(fp);
        match &self.expected {
            Some(known) => known == fp || (self.replace_known && trusted),
            None => trusted,
        }
    }
}

impl client::Handler for Handler {
    type Error = russh::Error;

    // Pinned per host:port. An unknown key needs the user's approval and a
    // changed one an explicit override, both before any credential is sent.
    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let key = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.key_data(),
            PublicKeyOrCertificate::Certificate(cert) => cert.public_key(),
        };
        let fp = key.fingerprint(HashAlg::Sha256).to_string();
        let ok = self.accepts(&fp);
        *self.seen.lock().unwrap() = Some(fp);
        Ok(ok)
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
    /// The server key fingerprint this session was accepted with.
    fingerprint: String,
}

impl Session {
    async fn connect(creds: SshCreds, known: Option<String>, log: &impl Fn(String)) -> Result<Self> {
        log(format!("Подключаюсь к {}@{}:{}…", creds.user, creds.host, creds.port));
        let config = Arc::new(client::Config {
            inactivity_timeout: Some(Duration::from_secs(600)),
            ..Default::default()
        });
        let seen = Arc::new(Mutex::new(None));
        let handler = Handler {
            expected: known.clone(),
            creds_trust: creds.trust_fingerprint.clone(),
            replace_known: creds.replace_known,
            seen: seen.clone(),
        };
        let connected = tokio::time::timeout(
            Duration::from_secs(15),
            client::connect(config, (creds.host.as_str(), creds.port), handler),
        )
        .await
        .map_err(|_| anyhow!("сервер не отвечает на {}:{}", creds.host, creds.port))?;
        let seen = seen.lock().unwrap().clone();
        let mut handle = match connected {
            Ok(handle) => handle,
            Err(e) => {
                // A rejected key surfaces as a generic error; say why.
                if let Some(got) = seen {
                    match known {
                        Some(expected) if expected != got => return Err(HostKeyError::Changed { expected, got }.into()),
                        None if creds.trust_fingerprint.as_deref() != Some(&got) => {
                            return Err(HostKeyError::Unknown { fingerprint: got }.into())
                        }
                        _ => {}
                    }
                }
                return Err(anyhow::Error::new(e).context("не удалось подключиться по SSH"));
            }
        };
        let fingerprint = seen.unwrap_or_default();
        log(format!("Ключ сервера проверен: {fingerprint}"));

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
        Ok(Self { handle, creds, fingerprint })
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

pub struct Installed {
    /// Public `host[:port]` of the Voicy server.
    pub public_host: String,
    /// SSH key fingerprint to remember for this VPS.
    pub fingerprint: String,
}

/// Installs (or upgrades) the server. `known` is the pinned SSH key
/// fingerprint for this VPS, if any.
pub async fn install(
    creds: SshCreds,
    known: Option<String>,
    server_name: &str,
    bootstrap_code: &str,
    log: impl Fn(String),
) -> Result<Installed> {
    let public_ip = creds.host.parse::<Ipv4Addr>().ok();
    let session = Session::connect(creds, known, &log).await?;
    session.upload_script(&log).await?;
    log("Запускаю установку, это займёт пару минут…".into());
    let mut env = vec![
        ("VOICY_BOOTSTRAP_CODE", bootstrap_code.to_owned()),
        ("VOICY_SERVER_NAME", server_name.to_owned()),
    ];
    if let Some(ip) = public_ip {
        env.push(("VOICY_PUBLIC_IP", ip.to_string()));
    }
    let public_host = session.run_script(&env, "", &log).await?;
    Ok(Installed { public_host, fingerprint: session.fingerprint })
}

/// Returns the SSH key fingerprint to remember for this VPS.
pub async fn uninstall(creds: SshCreds, known: Option<String>, log: impl Fn(String)) -> Result<String> {
    let session = Session::connect(creds, known, &log).await?;
    session.upload_script(&log).await?;
    log("Удаляю контейнеры и данные…".into());
    session.run_script(&[], "uninstall", &log).await?;
    Ok(session.fingerprint)
}

#[cfg(test)]
mod tests {
    use super::Handler;
    use std::sync::{Arc, Mutex};

    fn handler(expected: Option<&str>, trust: Option<&str>, replace: bool) -> Handler {
        Handler {
            expected: expected.map(Into::into),
            creds_trust: trust.map(Into::into),
            replace_known: replace,
            seen: Arc::new(Mutex::new(None)),
        }
    }

    #[test]
    fn host_key_policy() {
        // Unknown host: only the fingerprint the user approved.
        assert!(!handler(None, None, false).accepts("A"));
        assert!(!handler(None, Some("B"), false).accepts("A"));
        assert!(handler(None, Some("A"), false).accepts("A"));
        // Known host: the pinned key, or a new one only with explicit override.
        assert!(handler(Some("A"), None, false).accepts("A"));
        assert!(!handler(Some("A"), Some("B"), false).accepts("B"));
        assert!(handler(Some("A"), Some("B"), true).accepts("B"));
        assert!(!handler(Some("A"), Some("C"), true).accepts("B"));
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;

    /// `VOICY_TEST_SSH_HOST=1.2.3.4 cargo test -- --ignored unknown_host_key`
    #[tokio::test]
    #[ignore]
    async fn unknown_host_key_is_refused_before_auth() {
        let host = std::env::var("VOICY_TEST_SSH_HOST").expect("VOICY_TEST_SSH_HOST");
        let creds = SshCreds {
            host,
            port: 22,
            user: "root".into(),
            auth: SshAuth::Password { password: "never-sent".into() },
            trust_fingerprint: None,
            replace_known: false,
        };
        let err = Session::connect(creds, None, &|_| {}).await.err().expect("must refuse");
        match err.downcast_ref::<HostKeyError>() {
            Some(HostKeyError::Unknown { fingerprint }) => println!("refused, fingerprint {fingerprint}"),
            other => panic!("unexpected: {other:?} / {err:#}"),
        }
    }
}
