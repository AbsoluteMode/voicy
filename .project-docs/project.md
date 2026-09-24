---
id: voicy-project
type: project
title: Project overview
summary: Self-hosted voice chat for friends and family, with a Windows client and a Rust control plane.
status: confirmed
tags: [voicy, voice, self-hosting, architecture]
canonical_for: [project-overview]
verified_at: 2026-09-24
sources:
  - type: user-confirmed
    reference: User request on 2026-09-24 to review Voicy, an open-source Discord alternative focused on audio quality and self-hosting for friends and family.
    confirmed_at: 2026-09-24
  - type: commit
    reference: 7ee47774932f5e6483495a50776e716ce58bd395
    confirmed_at: 2026-09-24
related: [bugs/review-2026-09-24.md]
---

# Project overview

Voicy aims to be an open-source, self-hosted alternative to Discord for
friends and family, with audio quality as a primary goal. This is the user's
stated direction; full Discord feature parity is not an implemented capability.

At the reviewed commit, the repository contains:

- `client/`: a Windows Tauri 2 application with React and LiveKit client audio.
- `server/`: a Rust/Axum control plane for membership, roles, invitations and
  LiveKit tokens, backed by SQLite. There is one voice room, `main`.
- `deploy/install.sh`: a Debian/Ubuntu VPS installer using Docker Compose,
  Caddy and LiveKit, also invoked over SSH from the client.
- `LICENSE`: an MIT license.

See the [initial review](bugs/review-2026-09-24.md) for findings, verification
limits and recommended release work. Product and operational decisions that
remain unspecified are listed in [open questions](open-questions.md).
