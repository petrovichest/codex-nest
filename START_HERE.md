# CodexNest — Start Here

CodexNest is an unofficial, self-hosted mobile client for managing Codex CLI
sessions on a remote machine. The first supported client is Android. The server
is intended to run on a small always-on Linux host such as a Raspberry Pi.

> Unofficial client for OpenAI Codex. CodexNest is not affiliated with or
> endorsed by OpenAI.

This document is the implementation brief and decision record for the first
development sessions. Keep it current when a decision below changes.

## Product goal

Build a dependable, app-like interface that lets one user:

- register server-side folders as projects;
- see projects and their Codex sessions on one screen;
- distinguish sessions that are running, need attention, finished, failed, or
  interrupted;
- create, open, continue, steer, and interrupt sessions;
- run multiple sessions concurrently;
- read streamed agent output and activity;
- receive an Android notification when a session finishes or needs attention;
- open the relevant session directly from a notification.

The primary deployment is private: the server is reachable only on the local
network or through the user's VPN. Public internet exposure is not required.

## MVP user experience

### Navigation

- Desktop/tablet: persistent project and session sidebar with the active chat on
  the right.
- Phone: slide-out project/session drawer with the active chat taking the full
  screen.
- Projects are configured server-side folders. Sessions are grouped under the
  configured project whose path is the longest prefix of the session `cwd`.
- Preserve a small "Ungrouped" section for sessions outside configured projects.

### Session order

Within each project, sort sessions in this order:

1. Needs attention
2. Running
3. Completed and unread
4. Recently active
5. Older sessions by update time

Do not hide a running session merely because the phone disconnected. Codex work
runs on the server and must continue independently from the client connection.

### Chat

The first version needs:

- user messages;
- streamed agent messages;
- compact activity cards for commands, file changes, and tool activity;
- a composer with Enter-to-send, a persistent queue while running, immediate
  steer for a selected queued message, and interrupt actions;
- live plan steps, elapsed time, and turn diff statistics above the composer;
- clear connection, running, completed, failed, and interrupted states.

Raw terminal emulation is not part of the MVP.

## Architecture

```text
Android app (React + TypeScript + Capacitor)
        |
        | HTTPS + authenticated WebSocket
        v
CodexNest server (Node.js + TypeScript on Linux)
        |
        | JSONL over stdio
        v
codex app-server
        |
        v
Existing Codex login, configuration, files, tools, and network environment
```

Use one repository with npm workspaces:

```text
apps/
  server/   # HTTP/WebSocket API and the Codex app-server bridge
  client/   # React UI and Capacitor Android project
```

Do not introduce a shared package until both applications actually need shared
runtime code. Prefer the smallest dependency set that solves the current task.

### Server

- Run as a persistent system service.
- Bind to loopback by default and place the service behind the user's existing
  HTTPS reverse proxy.
- In production, connect over WebSocket through the managed daemon's local Unix
  socket so CodexNest restarts do not stop active turns.
- Keep direct `codex app-server --listen stdio://` as the zero-setup development
  fallback. The bridge uses JSONL for direct stdio and WebSocket frames for the
  daemon's Unix socket.
- Expose a small authenticated HTTP API and a WebSocket event stream to clients.
- Keep Codex as the source of truth for threads, turns, and history.
- Store only CodexNest-owned state: configured project paths, display names,
  pins, read markers, device registrations, and notification preferences.
- Be event-driven. Do not poll Codex or add network requests on the hot path when
  an app-server notification already provides the state change.
- Reconnect the socket or restart the direct app-server child with bounded
  exponential backoff. Rejoin active threads after reconnect and surface a
  clear unavailable state to clients rather than silently losing requests.

### Android client

- Build the UI with React and TypeScript, package it as an APK with Capacitor.
- Bundle the UI in the APK; do not load application code from a remote website.
- Store the server URL and device credential in platform-protected storage.
- Support system and dark themes from the start.
- Use native Android notifications and deep links into a specific session.
- Configure Android Network Security Configuration so locally installed user CAs
  are trusted for the selected private deployment domain. Never disable TLS
  verification and never install an accept-all certificate handler.

The web UI may remain usable in a regular browser for development and optional
desktop access, but Android is the primary product surface.

## Codex integration contract

Use the official Codex app-server protocol instead of parsing terminal output.
Reference: <https://developers.openai.com/codex/app-server/>

Important rules:

- Keep the daemon WebSocket on its local Unix socket and use stdio JSONL only in
  direct mode. Do not expose an app-server WebSocket listener to the network.
- The CodexNest server is the only process that talks directly to app-server.
- Initialize once per app-server connection with a distinct client identity,
  then send the `initialized` notification.
- Generate TypeScript protocol definitions with the installed Codex CLI:

  ```bash
  codex app-server generate-ts --out <generated-directory>
  ```

- Generated schemas are version-specific. Record the Codex CLI version used to
  generate them and regenerate deliberately during upgrades.
- Stay on stable protocol methods for the MVP unless a required capability is
  documented as experimental and isolated behind an adapter.

Expected stable operations include:

- `thread/list`, `thread/read`, `thread/start`, `thread/resume`;
- `thread/name/set`, `thread/archive`;
- `turn/start`, `turn/steer`, `turn/interrupt`;
- streamed `thread/*`, `turn/*`, and `item/*` notifications.

The adapter must correlate JSON-RPC request IDs, enforce timeouts, reject pending
requests if the child exits, and forward typed domain events to connected
clients. UI code must not depend directly on raw app-server payloads.

Codex authentication and OpenAI network routing belong to the installed Codex
CLI environment on the server. CodexNest must preserve the configured child
environment, must not implement a second OpenAI login, and must never log tokens,
proxy credentials, or the complete process environment.

## Authentication and network security

Even on a private network, require client authentication.

MVP authentication:

1. The administrator generates a high-entropy device token on the server.
2. The token is transferred manually to the Android app during setup.
3. The server stores only a verifier or hashed form where practical.
4. The app stores the credential using Android-protected storage.
5. Every HTTP and WebSocket connection is authenticated.

One-time pairing codes can replace manual token transfer later. They are not
required for the first vertical slice.

Deployment requirements:

- HTTPS only outside loopback;
- LAN/VPN access only by default;
- no router port forwarding required;
- origin validation for WebSockets;
- strict project path validation and canonicalization;
- no server URL, IP address, personal CA certificate, access token, Firebase
  credential, OpenAI credential, proxy URL, or proxy credential committed to the
  public repository.

Provide `.example` configuration files containing placeholders when runtime
configuration is introduced.

## Notifications

Use Firebase Cloud Messaging for reliable Android delivery when the app is in
the background or terminated. Notification payloads must contain no prompts,
agent responses, command output, file paths, or secrets. Send only the minimum
metadata required to show a generic notification and open the relevant session.

Initial notification events:

- turn completed;
- turn failed;
- session needs user attention.

Do not suppress notifications merely because the user was recently active. Add
per-event preferences later if needed. If FCM is not configured, the rest of the
application must continue to work without push notifications.

References:

- <https://firebase.google.com/docs/cloud-messaging/android/receive-messages>
- <https://developer.android.com/privacy-and-security/security-config>
- <https://capacitorjs.com/docs>

## Explicit non-goals for the first release

- Public hosted relay or cloud account service
- Multi-user organizations and permissions
- Full terminal emulator or source-code editor
- Git worktree orchestration
- Voice transcription beyond the Android keyboard
- iOS packaging
- Reimplementation of Codex authentication
- A duplicate database containing complete Codex conversation history
- Automatic approval bypass inside CodexNest

The installed Codex configuration controls sandboxing and approvals. CodexNest
may add approval UI later, but should not silently weaken the server policy.

## Delivery stages

### Stage 1 — Protocol spike and repository foundation

- Scaffold npm workspaces, TypeScript, linting, formatting, and tests.
- Add `apps/server` and `apps/client` with minimal runnable entry points.
- Implement a typed app-server stdio transport adapter.
- Implement initialization, request correlation, child-exit handling, and event
  parsing.
- Prove `thread/list` against a locally installed Codex CLI.
- Add unit tests using a fake child process; normal tests must not contact OpenAI.
- Add a minimal browser page showing server health and the number of threads.

### Stage 2 — Projects, session list, and chat

- Add project configuration and safe path handling.
- Implement grouped/sorted session navigation.
- Implement thread history, streamed turns, composer, steer, and interrupt.
- Add reconnection and unread-state behavior.

### Stage 3 — Android packaging and private TLS

- Add Capacitor Android packaging.
- Add server setup and credential storage UI.
- Add private-CA trust configuration without disabling verification.
- Add notification deep links and release APK generation.

### Stage 4 — Push notifications and deployment

- Add optional FCM device registration and minimal notification payloads.
- Add persistent Linux service and reverse-proxy deployment examples.
- Verify operation on LAN and through VPN with no public inbound route.

## Acceptance criteria for the first development session

The next development session should implement **Stage 1 only**. It is complete
when all of the following are true:

- a fresh clone has documented install, development, test, and build commands;
- both workspace applications start locally;
- the server health endpoint reports whether the app-server child is ready;
- the server can initialize app-server and return a typed thread list;
- the browser page displays connection health and thread count;
- adapter tests cover a successful response, an app-server error, malformed
  JSON, timeout, and child termination;
- no real credentials or host-specific values are committed;
- lint, typecheck, tests, and production builds pass.

Before coding, inspect the current repository and the locally installed Codex
version. Generate protocol types from that binary rather than copying examples
from this document. If the current official schema contradicts this brief, keep
the product behavior and update the adapter plan to match the schema.

Suggested opening prompt for the next session:

> Read `START_HERE.md` completely. Implement Stage 1 and verify every acceptance
> criterion. Keep the architecture small, do not add unrelated features, do not
> commit or deploy unless explicitly asked, and report any app-server schema
> mismatch before working around it.
