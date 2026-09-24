# Voicy client

Windows app: Tauri 2 (Rust) + React + livekit-client in WebView2.

- `src-tauri/` holds saved servers (tokens in Windows Credential Manager), the HTTP calls to voicy-server, and SSH deployment via `deploy/install.sh`.
- `src/` holds the UI and the voice session (`src/lib/voice.ts`).

```bash
npm install
npm run tauri dev
```

To build an installer, run `npm run tauri build`. It writes the NSIS setup to `src-tauri/target/release/bundle/nsis/`.
