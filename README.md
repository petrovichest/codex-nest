# CodexNest

CodexNest is an unofficial, self-hosted Android and browser client for managing
Codex CLI sessions on a private Linux machine. It is not affiliated with or
endorsed by OpenAI.

Production can connect through Codex's managed app-server daemon so active turns
survive a CodexNest server restart. Direct stdio remains the zero-setup default
for local development.

Read [START_HERE.md](./START_HERE.md) for the product brief and
[PLAN.md](./PLAN.md) for the implementation decisions.

## Security boundary

CodexNest is a single-owner, local-first application. The server is intended to
be reachable only from the host itself, a trusted private LAN, or the owner's
private WireGuard/Tailscale network. Remote access must stay inside that VPN
boundary.

Do not expose port `4310` to the public internet through router port forwarding,
UPnP, a public reverse proxy, a public tunnel, or a cloud firewall rule. The
owner token grants control over Codex, and CodexNest runs with the same Linux
user permissions as Codex CLI; leaking the token can therefore expose projects
and other files available to that user.

Plain HTTP is suitable only inside an encrypted WireGuard/Tailscale tunnel or a
fully trusted LAN. On a shared or untrusted network, connect through the private
VPN or use HTTPS that remains restricted to the private LAN/VPN.

## Requirements

- Node.js 24 LTS
- npm 10 or newer
- Codex CLI, already signed in on the server host
- For Android: Android Studio/JDK 21 and Android SDK

## Development

```bash
npm install
npm run protocol:generate
npm run dev
```

The browser UI is served by Vite on `http://localhost:5173`; the API listens on
`http://127.0.0.1:4310` by default.

Generate the single-owner access token before using protected endpoints:

```bash
npm run auth:generate -w @codexnest/server
```

Rotation prints a replacement once and disconnects authenticated WebSockets:

```bash
npm run auth:generate -w @codexnest/server -- --rotate
```

Normal verification never contacts OpenAI:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

The real app-server smoke test is opt-in:

```bash
RUN_CODEX_INTEGRATION=1 npm run test:integration -w @codexnest/server
```

The Claude Code smoke test is opt-in as well. `RUN_CLAUDE_INTEGRATION=1` runs
cheap real-CLI checks that make no model calls (a version probe and a transcript
projection read); adding `RUN_CLAUDE_INTEGRATION_TURN=1` also runs one tiny haiku
turn against the signed-in CLI:

```bash
RUN_CLAUDE_INTEGRATION=1 npm run test:integration:claude -w @codexnest/server
RUN_CLAUDE_INTEGRATION=1 RUN_CLAUDE_INTEGRATION_TURN=1 \
  npm run test:integration:claude -w @codexnest/server
```

CodexNest records the installed CLI version for diagnostics but does not require
an exact version at runtime. `npm run protocol:generate` remains pinned to
`apps/server/src/codex/PROTOCOL_VERSION` so generated TypeScript types stay
reproducible.

## Claude Code backend (optional)

CodexNest can run the Claude Code CLI as a second agent backend alongside Codex,
selected per session. It is optional: when Claude Code is absent, CodexNest runs
Codex exactly as before.

Requirement: install Claude Code on the server host and sign it in as the service
user (`claude login`, subscription OAuth), or provide `ANTHROPIC_API_KEY` in the
service environment. CodexNest never stores Anthropic credentials — it reuses the
CLI's own login — and the same single-owner token guards both backends.

Configuration is all optional environment variables:

| Variable                           | Purpose                                     | Default                |
| ---------------------------------- | ------------------------------------------- | ---------------------- |
| `CODEXNEST_CLAUDE_BIN`             | Path to the Claude Code CLI                 | `claude` (from `PATH`) |
| `CODEXNEST_CLAUDE_ENABLED`         | Backend gate: `auto`, `true`, or `false`    | `auto`                 |
| `CODEXNEST_CLAUDE_IDLE_TIMEOUT_MS` | Idle session eviction timeout (ms)          | `300000`               |
| `CODEXNEST_CLAUDE_MAX_SESSIONS`    | Max concurrent live Claude sessions         | `3`                    |
| `CODEXNEST_CLAUDE_MODELS`          | JSON array replacing the offered model list | built-in list          |

`CODEXNEST_CLAUDE_ENABLED=auto` probes for the CLI once at server startup. A CLI
installed **after** startup is not detected until the server restarts (or until
`CODEXNEST_CLAUDE_ENABLED=true`, which enables the backend and probes at startup);
`false` disables it entirely.

Limitations: Claude runs without a managed daemon, so an active Claude turn is
aborted if CodexNest restarts. The session stays resumable and the turn renders as
interrupted, but — unlike Codex's daemon transport, which keeps active turns alive
across a restart — the Claude turn does not survive it. Claude also has no mid-turn
steer: a message sent while a turn is running is queued and delivered at the next
turn boundary.

## Production

Install the latest stable release on Ubuntu or Debian (`amd64` or `arm64`) as a
regular user:

```bash
curl -fsSL https://github.com/petrovichest/codex-nest/releases/latest/download/install.sh | bash
```

The installer provides its own pinned Node.js runtime, creates a versioned
release, installs user `systemd` services, generates the owner token, and prints
the private LAN URL. It never installs Codex CLI: when Codex is missing,
CodexNest starts in diagnostic mode and becomes ready after the user installs
and signs in to Codex, then runs `codexnest repair`.

The managed install listens on the private LAN by default. Keep port `4310`
inside the trusted LAN or private WireGuard/Tailscale network. HTTP is
intentionally supported for those private environments, while HTTPS
reverse-proxy examples remain available under `deploy/` for private LAN/VPN
deployments.

See the [deployment and update guide](./deploy/DEPLOYMENT.md) and
[Android build instructions](./apps/client/android/README.md). No commit, push,
deployment, signing secret, Firebase credential, or release APK is produced by
the normal build.

## Contributing

External contributions are accepted through reviewed pull requests, not direct
writes to the upstream repository. See [CONTRIBUTING.md](./CONTRIBUTING.md).
