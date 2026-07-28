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

### iPhone Home Screen app

Open the root HTTPS URL in Safari, choose **Share → Add to Home Screen**, and
leave **Open as Web App** enabled. CodexNest then runs in standalone mode, and
all session routes remain inside the Home Screen app.

When upgrading a Home Screen shortcut created before PWA metadata was available,
remove the old icon and add it again from the root URL. iOS may clear that
installation's local storage, so be prepared to enter the server URL and owner
token again.

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

Install the latest successful rolling build on Ubuntu or Debian (`amd64` or
`arm64`) as a regular user:

```bash
curl -fsSL https://github.com/petrovichest/codex-nest/releases/latest/download/install.sh | bash
```

The installer is pinned to the same tested commit as the release APK. It
provides its own pinned Node.js runtime, creates a versioned release, installs
user `systemd` services, generates the owner token, and prints the private LAN
URL. It never installs Codex CLI: when Codex is missing, CodexNest starts in
diagnostic mode and becomes ready after the user installs and signs in to
Codex, then runs `codexnest repair`.

Rolling versions are assigned automatically as `<package version>-<commit>`,
for example `0.1.6-73e1842`. The GitHub Release title, APK, manifest, and Linux
installer all use that same version.

The managed install listens on the private LAN by default. Keep port `4310`
inside the trusted LAN or private WireGuard/Tailscale network. HTTP is
intentionally supported for those private environments, while HTTPS
reverse-proxy examples remain available under `deploy/` for private LAN/VPN
deployments.

See the [deployment and update guide](./deploy/DEPLOYMENT.md) and
[Android build instructions](./apps/client/android/README.md). A normal local
build does not commit, push, deploy, use signing secrets, contact Firebase, or
produce a release APK.

## Contributing

External contributions are accepted through reviewed pull requests, not direct
writes to the upstream repository. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

CodexNest is licensed under the [Apache License 2.0](./LICENSE).
