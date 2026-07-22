# CodexNest

CodexNest is an unofficial, self-hosted Android and browser client for managing
Codex CLI sessions on a private Linux machine. It is not affiliated with or
endorsed by OpenAI.

Production can connect through Codex's managed app-server daemon so active turns
survive a CodexNest server restart. Direct stdio remains the zero-setup default
for local development.

Read [START_HERE.md](./START_HERE.md) for the product brief and
[PLAN.md](./PLAN.md) for the implementation decisions.

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

CodexNest records the installed CLI version for diagnostics but does not require
an exact version at runtime. `npm run protocol:generate` remains pinned to
`apps/server/src/codex/PROTOCOL_VERSION` so generated TypeScript types stay
reproducible.

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

The managed install listens on the private LAN by default. Never forward port
`4310` to the public internet. HTTP is intentionally supported for trusted home
networks and private WireGuard/Tailscale links, while HTTPS reverse-proxy
examples remain available under `deploy/`.

See the [deployment and update guide](./deploy/DEPLOYMENT.md) and
[Android build instructions](./apps/client/android/README.md). No commit, push,
deployment, signing secret, Firebase credential, or release APK is produced by
the normal build.
