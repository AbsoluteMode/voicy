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

One button, then the system picker chooses a screen or a window and whether to share system audio (Windows
gives sound only for a whole screen). The stream goes out at 1080p30 with 720p and 360p simulcast copies, so each
viewer gets what fits their connection and the size of the stream on their screen, and unwatched layers are not
encoded. Shared sound is stereo and leaves out everything voicy itself plays, so nobody hears the room echoed back.

## Local server for testing

On Windows, start Docker Desktop and choose **Add server → On this PC** in Voicy. The app starts a loopback-only LiveKit container and the bundled `voicy-server.exe`, then creates the owner account. This local server is reachable only from the same computer. Its data is kept in the app config directory and is reused on the next launch; joining a room starts the local services again when needed. The client installer builds and bundles the matching server executable.

## Room chat

Click the speech bubble next to a room to open its text chat. Members can send messages without joining voice. Messages are stored by the Voicy server in its SQLite database; remote servers need this server version for chat to work. Enter sends a message, and Shift+Enter adds a line break.

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
