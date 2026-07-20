# Deployment and release checklist

CodexNest is LAN-only. Keep the server on loopback behind an existing HTTPS reverse
proxy, or explicitly bind `0.0.0.0` for trusted-LAN HTTP. Do not expose port 4310 to
the public internet.

## Raspberry Pi OS 64-bit / ARM64

1. Install Node.js 24 LTS and Codex CLI `0.144.6` for the same Linux user that will
   run the service. Sign in with Codex CLI as that user. The supplied systemd unit
   expects a per-user Node 24 installation at `~/.local/node-v24`.
2. Clone the repository and run `npm ci`, `npm run lint`, `npm run typecheck`,
   `npm test`, and `npm run build`.
3. Run `npm run protocol:generate` and confirm the generated directory has no diff.
4. Generate the owner token once with
   `npm run auth:generate -w @codexnest/server`. To revoke every client and print a
   replacement, rerun with `-- --rotate`.
5. Copy the systemd examples to `~/.config/systemd/user/` and
   `~/.config/codexnest/`, replace placeholders, and set the env file to `0600`.
6. Enable linger (`loginctl enable-linger USER`), then enable the user service.
7. Check `/api/v1/health`, browser authentication, WebSocket reconnect, a service
   restart, and one manual real turn only after explicitly accepting quota/network use.

Deployment updates are Git-only: commit locally, push, pull on the Pi, rebuild, and
restart only `codexnest.service`. Never copy application files directly to the Pi.

## Direct LAN HTTP

Set `CODEXNEST_HOST=0.0.0.0` and list the exact web/APK origins in
`CODEXNEST_ALLOWED_ORIGINS`. The UI intentionally shows a permanent warning because
the bearer token and session content are observable on the LAN.

## HTTPS

Leave CodexNest on loopback and adapt the Nginx or Caddy example. Put the public web
origin in `CODEXNEST_ALLOWED_ORIGINS`. Android accepts normal public/system CAs and
user-installed private CAs, but still performs hostname/IP validation.

## State backup

Back up the single `CODEXNEST_STATE_PATH` file while the service is stopped or after
an atomic snapshot. It contains the token verifier, project paths, read/pin/outcome
metadata, and FCM registrations—not prompts, turns, or command output. Codex history
remains under the existing `~/.codex` data and needs its normal independent backup.

## Android / Firebase release

Follow `apps/client/android/README.md`. A personal `google-services.json`, Firebase
service account, signing keystore, and passwords stay outside Git. After a signed
release build:

```bash
apksigner verify --verbose app/build/outputs/apk/release/app-release.apk
shasum -a 256 app/build/outputs/apk/release/app-release.apk > CodexNest-1.0.apk.sha256
```

Verify fresh install and upgrade on Pixel 10 over LAN HTTP, public HTTPS, and private
user-CA HTTPS. Test FCM for completed, failed, and attention events in foreground,
background, and normal process termination. Android force-stop remains a platform
limit until the user launches the app again.
