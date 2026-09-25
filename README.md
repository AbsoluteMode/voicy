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
forwards packets untouched (SFU, no mixing or transcoding). Before encoding, the mic goes through an automatic
level that brings every voice to the same loudness (slow, and only while someone talks, so pauses do not pump),
then DeepFilterNet, which gently turns the background down, and a gate that silences the pauses. A USB mic that
drops off for a moment is picked up again by itself.

## Diagnostics

Every app sends what happens to its mic and connection to the server it talks on, into `logs/<member id>.log`
next to the database: mic and device events, and every 10 seconds an `audio` event with how the voice leaves
(speech level, noise floor, automatic gain, clipping, gate, bitrate, loss, UDP or TCP) and how everyone else
arrives (loss, repaired audio, jitter buffer, loudness). The server adds its own CPU, network and dropped UDP
packets once a minute to `logs/_host.log`. To read all of it on one clock:

```bash
docker compose exec voicy voicy-server timeline 30 nick
```

The last 30 minutes, only members whose nickname contains `nick` (both optional), times in UTC.

## Screen sharing

One button, then the system picker chooses a screen or a window and whether to share system audio (Windows
gives sound only for a whole screen). The stream goes out at 1080p30 with 720p and 360p simulcast copies, so each
viewer gets what fits their connection and the size of the stream on their screen, and unwatched layers are not
encoded. Shared sound is stereo and leaves out everything voicy itself plays, so nobody hears the room echoed back.

## Local server for testing

On Windows, start Docker Desktop and choose **Add server → On this PC** in Voicy. The app starts a loopback-only LiveKit container and the bundled `voicy-server.exe`, then creates the owner account. This local server is reachable only from the same computer. Its data is kept in the app config directory and is reused on the next launch; joining a room starts the local services again when needed. The client installer builds and bundles the matching server executable.

## Room chat

The server-wide chat sits beside the room list. Its header button opens or closes the panel, and the divider can be dragged to resize it. This panel shows only the server chat. The paper-plane button at the top of the left rail opens a separate **Direct messages** page with a contact list and conversations; clicking a member shows a **Write a direct message** action that opens their conversation on that page. The speech bubble next to a room still opens that room's separate chat. Only the two participants can read a private conversation. Members can send messages without joining voice. Messages are stored by the Voicy server in its SQLite database; remote servers need this server version for chat to work. Enter sends a message, and Shift+Enter adds a line break.

The server chat, room chats, and direct messages accept one image or other file per message (up to 10 MB), with optional text. PNG, JPEG, WebP, and GIF images appear inline; other files can be downloaded from the message. Direct-message attachments are available only to the two participants. Both client and server must be updated to use attachments.

Shared screens in your voice room appear as cards. Choose **Watch** to subscribe to a screen and its audio, then **Leave viewing** to unsubscribe without leaving the voice room.

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
