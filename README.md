# voicy

Open-source voice chat for friends. Lightweight, self-hosted, focused on sound quality. Windows client.

> 🚧 Early stage — work in progress.

## How it works

- Someone runs **Create server** in the app and enters SSH credentials for their VPS. The app installs everything there and makes them the **owner**.
- The owner and **admins** generate personal single-use invite links (`voicy://join/...`) and send them to friends.
- Friends paste the link into the app and talk.

| Role | Can |
|---|---|
| owner | everything below, promote/demote admins, delete the server |
| admin | create invite links, kick members |
| member | talk |

## Audio

Opus at 48 kHz fullband and 128 kbit/s, packet-loss protection (RED + in-band FEC), no DTX, and the server
forwards packets untouched (SFU, no mixing or transcoding). Noise suppression, echo cancellation and AGC are
off by default, because they are built for laptop speakers and hurt the sound on headphones. Each one can be
turned on.

## Screen sharing

Connected members can share a display or an application window at 720p, 1080p, 1440p (2K), or 2160p (4K), targeting 30 fps. The Windows source picker makes the final selection. Optional screen audio is published when WebView2 provides an audio track for the selected source; the client shows a notice if it starts video without audio.

## Layout

```
server/   voicy-server: invites, roles, LiveKit tokens (Rust, axum, SQLite)
deploy/   install.sh: sets up Caddy + LiveKit + voicy-server with docker compose
client/   Windows app (Tauri)
```

On the VPS:

```
Caddy :443 (or 7443…)  ── /api/* ──►  voicy-server 127.0.0.1:8080
   (Let's Encrypt via   ── /rtc   ──►  LiveKit     127.0.0.1:7880
    <ip>.sslip.io)
LiveKit media: 7881/tcp, 7882/udp
```

## Manual server install

```bash
sudo VOICY_BOOTSTRAP_CODE=$(openssl rand -hex 24) bash deploy/install.sh
```

Needs a Debian/Ubuntu VPS with a public IPv4. Open TCP 80, the HTTPS port it prints, 7881/tcp and 7882/udp in
your hosting firewall. The installer skips ports that are already taken or forwarded by NAT rules, such as a proxy
on 443.

## License

[MIT](LICENSE)
