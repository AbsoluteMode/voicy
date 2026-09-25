//! Diagnostics on disk, next to the database in `logs/`: what every app
//! reports about its mic and connection (`<member id>.log`), the load of
//! the machine itself (`_host.log`), and `voicy-server timeline` to read
//! them all together on one clock.

use std::{
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::Context;
use serde_json::{json, Value};

/// A log file past this size is moved to `*.old.log`, replacing the older one.
const LOG_FILE_MAX: u64 = 16 << 20;
const HOST_LOG: &str = "_host.log";
const HOST_EVERY: Duration = Duration::from_secs(60);

pub fn logs_dir(db_path: &str) -> PathBuf {
    Path::new(db_path).with_file_name("logs")
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

pub fn append(dir: &Path, name: &str, text: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(name);
    if std::fs::metadata(&path)
        .map(|md| md.len() > LOG_FILE_MAX)
        .unwrap_or(false)
    {
        std::fs::rename(&path, path.with_extension("old.log"))?;
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?
        .write_all(text.as_bytes())
}

/// Kernel counters of the whole VPS. The containers share the host network,
/// so these are LiveKit's packets too.
#[derive(Clone, Copy)]
struct HostCounters {
    at: i64,
    busy: u64,
    steal: u64,
    total: u64,
    rx: u64,
    tx: u64,
    rx_drop: u64,
    udp_in_err: u64,
    udp_rcvbuf_err: u64,
}

impl HostCounters {
    fn read() -> Option<Self> {
        let stat = std::fs::read_to_string("/proc/stat").ok()?;
        // cpu user nice system idle iowait irq softirq steal
        let cpu: Vec<u64> = stat
            .lines()
            .next()?
            .split_whitespace()
            .skip(1)
            .take(8)
            .filter_map(|v| v.parse().ok())
            .collect();
        if cpu.len() < 8 {
            return None;
        }
        let total: u64 = cpu.iter().sum();
        let idle = cpu[3] + cpu[4];

        let (mut rx, mut tx, mut rx_drop) = (0, 0, 0);
        for line in std::fs::read_to_string("/proc/net/dev")
            .ok()?
            .lines()
            .skip(2)
        {
            let Some((name, rest)) = line.split_once(':') else {
                continue;
            };
            let name = name.trim();
            if name == "lo"
                || name.starts_with("docker")
                || name.starts_with("veth")
                || name.starts_with("br-")
            {
                continue;
            }
            let f: Vec<u64> = rest
                .split_whitespace()
                .filter_map(|v| v.parse().ok())
                .collect();
            if f.len() >= 9 {
                rx += f[0];
                rx_drop += f[3];
                tx += f[8];
            }
        }

        let snmp = std::fs::read_to_string("/proc/net/snmp").ok()?;
        let mut udp = snmp.lines().filter(|l| l.starts_with("Udp:"));
        let (names, values) = (udp.next()?, udp.next()?);
        let udp_field = |key: &str| {
            names
                .split_whitespace()
                .position(|n| n == key)
                .and_then(|i| values.split_whitespace().nth(i))
                .and_then(|v| v.parse().ok())
                .unwrap_or(0)
        };

        Some(Self {
            at: now_ms(),
            busy: total - idle,
            steal: cpu[7],
            total,
            rx,
            tx,
            rx_drop,
            udp_in_err: udp_field("InErrors"),
            udp_rcvbuf_err: udp_field("RcvbufErrors"),
        })
    }

    fn since(&self, prev: &Self) -> Value {
        let ms = (self.at - prev.at).max(1) as f64;
        let ticks = self.total.saturating_sub(prev.total).max(1) as f64;
        let pct = |v: u64| (v as f64 / ticks * 1000.0).round() / 10.0;
        let kbps = |v: u64| (v as f64 * 8.0 / ms).round();
        let load = std::fs::read_to_string("/proc/loadavg")
            .ok()
            .and_then(|l| l.split_whitespace().next()?.parse::<f64>().ok());
        json!({
            "ev": "host",
            "t": self.at,
            "cpu": pct(self.busy.saturating_sub(prev.busy)),
            // Time the hypervisor gave our vCPUs to other tenants: shows up
            // as jitter even when our own load is low.
            "steal": pct(self.steal.saturating_sub(prev.steal)),
            "load": load,
            "rxKbps": kbps(self.rx.saturating_sub(prev.rx)),
            "txKbps": kbps(self.tx.saturating_sub(prev.tx)),
            "rxDrop": self.rx_drop.saturating_sub(prev.rx_drop),
            "udpInErr": self.udp_in_err.saturating_sub(prev.udp_in_err),
            // Packets the kernel threw away because a socket buffer was full.
            "udpRcvbufErr": self.udp_rcvbuf_err.saturating_sub(prev.udp_rcvbuf_err),
        })
    }
}

/// Once a minute, how busy the VPS and its network are. A voice that breaks
/// up for everyone at once points here rather than at anyone's internet.
pub fn spawn_host_sampler(dir: PathBuf) {
    tokio::spawn(async move {
        let mut prev = HostCounters::read();
        let mut tick = tokio::time::interval(HOST_EVERY);
        tick.tick().await;
        loop {
            tick.tick().await;
            let cur = HostCounters::read();
            if let (Some(p), Some(c)) = (prev, cur) {
                let e = c.since(&p);
                let line = json!({ "at": c.at / 1000, "ts": c.at, "who": "server", "v": env!("CARGO_PKG_VERSION"), "e": e }).to_string() + "\n";
                let dir = dir.clone();
                if let Ok(Err(err)) =
                    tokio::task::spawn_blocking(move || append(&dir, HOST_LOG, &line)).await
                {
                    tracing::warn!("host log: {err}");
                }
            }
            prev = cur;
        }
    });
}

/// `voicy-server timeline [minutes] [name]`: events of every app and the
/// host samples from the last minutes (30 by default), merged and sorted on
/// the server clock, one per line. `name` keeps only members whose nickname
/// contains it (the host samples stay).
pub fn timeline(args: &[String]) -> anyhow::Result<()> {
    let minutes: i64 = args
        .first()
        .map(|a| a.parse())
        .transpose()
        .context("minutes must be a number")?
        .unwrap_or(30);
    let who_filter = args.get(1).map(|s| s.to_lowercase());
    let db = std::env::var("VOICY_DB").unwrap_or_else(|_| "/data/voicy.db".into());
    let dir = logs_dir(&db);
    let since = now_ms() - minutes * 60_000;

    let mut rows: Vec<(i64, String, String, String)> = Vec::new();
    for entry in std::fs::read_dir(&dir).with_context(|| format!("reading {}", dir.display()))? {
        let path = entry?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("log") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        for line in text.lines() {
            let Ok(v) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let e = &v["e"];
            // Server clock when the app sent it; older lines only have the
            // app's own clock, or the second the batch arrived.
            let Some(ts) = v["ts"]
                .as_i64()
                .or_else(|| e["t"].as_i64())
                .or_else(|| v["at"].as_i64().map(|s| s * 1000))
            else {
                continue;
            };
            if ts < since {
                continue;
            }
            let who = v["who"].as_str().unwrap_or("?").to_owned();
            if who != "server" {
                if let Some(f) = &who_filter {
                    if !who.to_lowercase().contains(f) {
                        continue;
                    }
                }
            }
            let ev = e["ev"].as_str().unwrap_or("?").to_owned();
            let mut rest = e.clone();
            if let Some(obj) = rest.as_object_mut() {
                obj.remove("ev");
                obj.remove("t");
            }
            rows.push((ts, who, ev, rest.to_string()));
        }
    }
    rows.sort_by_key(|r| r.0);

    let mut out = std::io::stdout().lock();
    for (ts, who, ev, rest) in rows {
        let who: String = who.chars().take(14).collect();
        writeln!(out, "{} {who:<14} {ev:<18} {rest}", clock(ts))?;
    }
    Ok(())
}

/// `HH:MM:SS.mmm` in UTC.
fn clock(ms: i64) -> String {
    let s = ms.div_euclid(1000).rem_euclid(86_400);
    format!(
        "{:02}:{:02}:{:02}.{:03}",
        s / 3600,
        s / 60 % 60,
        s % 60,
        ms.rem_euclid(1000)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clock_is_utc_time_of_day() {
        assert_eq!(clock(1_790_327_069_123), "09:04:29.123");
    }

    #[test]
    fn host_counters_read_here() {
        // Only Linux has /proc; elsewhere there is nothing to sample.
        if cfg!(target_os = "linux") {
            let a = HostCounters::read().expect("counters");
            let e = a.since(&a);
            assert_eq!(e["ev"], "host");
        }
    }
}
