mod api;
mod auth;
mod db;
mod error;
mod livekit;

use std::{env, net::SocketAddr, sync::Arc};

use anyhow::{Context, Result};
use tracing_subscriber::EnvFilter;

/// Single voice room for now; channels come later.
pub const ROOM: &str = "main";

pub struct Config {
    pub bind: SocketAddr,
    pub db_path: String,
    /// Public `host[:port]` clients reach this server at, e.g. `1-2-3-4.sslip.io:8443`.
    pub public_host: String,
    pub server_name: String,
    pub max_participants: u32,
    pub bootstrap_code: Option<String>,
    pub livekit_api_url: String,
    pub livekit_key: String,
    pub livekit_secret: String,
}

impl Config {
    fn from_env() -> Result<Self> {
        let var = |k: &str| env::var(k).ok().filter(|v| !v.trim().is_empty());
        let required = |k: &str| var(k).with_context(|| format!("{k} is not set"));
        Ok(Self {
            bind: var("VOICY_BIND")
                .unwrap_or_else(|| "127.0.0.1:8080".into())
                .parse()
                .context("VOICY_BIND")?,
            db_path: var("VOICY_DB").unwrap_or_else(|| "/data/voicy.db".into()),
            public_host: required("VOICY_PUBLIC_HOST")?,
            server_name: var("VOICY_SERVER_NAME").unwrap_or_else(|| "Voicy".into()),
            max_participants: var("VOICY_MAX_PARTICIPANTS")
                .map(|v| v.parse())
                .transpose()
                .context("VOICY_MAX_PARTICIPANTS")?
                .unwrap_or(10),
            bootstrap_code: var("VOICY_BOOTSTRAP_CODE"),
            livekit_api_url: var("LIVEKIT_API_URL").unwrap_or_else(|| "http://127.0.0.1:7880".into()),
            livekit_key: required("LIVEKIT_API_KEY")?,
            livekit_secret: required("LIVEKIT_API_SECRET")?,
        })
    }

    pub fn livekit_url(&self) -> String {
        format!("wss://{}", self.public_host)
    }

    pub fn invite_link(&self, code: &str) -> String {
        format!("voicy://join/{}/{}", self.public_host, code)
    }
}

pub struct AppState {
    pub cfg: Config,
    pub db: db::Db,
    pub lk: livekit::LiveKit,
}

pub type SharedState = Arc<AppState>;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let cfg = Config::from_env()?;
    let db = db::Db::open(&cfg.db_path)?;
    if let Some(code) = &cfg.bootstrap_code {
        if db.ensure_owner_invite(&auth::hash(code), db::now())? {
            tracing::info!("owner invite created from VOICY_BOOTSTRAP_CODE");
        }
    }
    let lk = livekit::LiveKit::new(&cfg.livekit_api_url, &cfg.livekit_key, &cfg.livekit_secret);

    let bind = cfg.bind;
    let state = Arc::new(AppState { cfg, db, lk });
    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!("voicy-server listening on {bind}");
    axum::serve(listener, api::router(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
