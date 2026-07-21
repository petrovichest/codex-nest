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
- Codex CLI `0.144.6`, already signed in on the server host
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

## Production

The server binds to loopback by default. Set `CODEXNEST_HOST=0.0.0.0` only for
intentional direct LAN HTTP access, or keep loopback and use the reverse-proxy
examples under `deploy/`. Never expose CodexNest directly to the public
internet.

See the step-by-step [deployment and launch guide](./deploy/DEPLOYMENT.md) and
[Android build instructions](./apps/client/android/README.md). No commit, push,
deployment, signing secret, Firebase credential, or release APK is produced by
the normal build.
