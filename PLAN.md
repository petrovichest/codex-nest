# CodexNest MVP implementation record

This document is the implementation authority when it differs from
`START_HERE.md`.

## Decisions

- One owner, one high-entropy bearer token, no accounts or roles.
- LAN-only access. The client accepts HTTP with a persistent warning and HTTPS
  with normal hostname verification plus Android system/user CAs.
- One long-lived `codex app-server --listen stdio://` child; raw app-server
  messages never cross the public API boundary.
- Codex CLI `0.144.6` and the generated experimental TypeScript protocol are
  version-pinned. Experimental methods are isolated to user-input and cold
  last-turn reconciliation.
- Codex owns threads, turns, and history. CodexNest stores only projects,
  authentication verifier, read/pin/outcome metadata, and device registrations
  in one atomic JSON file.
- No polling loop. Full pagination runs at startup and explicit foreground/manual
  sync; notifications drive the live projection.
- React/Vite is shared by browser and Capacitor Android. Russian is the first
  release language; system/light/dark themes are supported.
- The APK is sideloaded and signed with a user-owned key. Optional background
  push uses a personal Firebase project with build-time client config and a
  server-side credential outside the repository.

## Delivery gates

1. Foundation and a tested JSONL app-server bridge with health and exact thread
   count.
2. Token auth, atomic state, project/session projection, public API/WebSocket,
   full browser chat, approvals, permissions, and user input.
3. Capacitor Android setup, secure token storage, LAN HTTP/HTTPS handling, and a
   signed installable APK.
4. Optional FCM, deep-link handling, systemd/reverse-proxy artifacts, Raspberry
   Pi ARM64 and Pixel 10 smoke tests.

Normal tests use fake app-server fixtures and must not contact OpenAI. Actual
deployment, commit, and push require separate explicit authorization.

## Implemented layout

```text
apps/server/       Fastify HTTP/WS, Codex JSONL bridge, state/projection, FCM
apps/client/       React/Vite UI and generated Capacitor Android project
packages/protocol/ normalized public DTOs and frame guards
deploy/            systemd, Nginx/Caddy, backup and release guidance
```

The generated experimental app-server contract lives under
`apps/server/src/codex/generated`. `PROTOCOL_VERSION` and the regeneration
script fail closed unless the installed CLI is exactly `0.144.6`.

## Operational boundaries

- The normal suite is fake-only. The real CLI smoke is opt-in and performs only
  initialize plus a single read-only `thread/list`; it never starts a model turn.
- Android debug/release Gradle builds require JDK 21 and an Android SDK. A signed
  release additionally requires the four external keystore environment values.
- Personal FCM is dormant unless both the untracked Android client config and an
  external server service-account path are supplied.
- Pixel 10, private-CA, background push, upgrade install, and signed checksum
  acceptance remain physical release gates rather than repository unit tests.
