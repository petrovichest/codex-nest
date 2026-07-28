# Android build

CodexNest targets Android 10 (API 29) and newer. The app uses `http://localhost` as its
Capacitor origin. Network Security Configuration permits the user-selected LAN/VPN HTTP
deployment and trusts system CA certificates plus CA certificates explicitly installed
by the device owner, without disabling normal TLS hostname/IP verification. Install only
a private CA that you control and use it only for trusted LAN/VPN services.

LAN HTTP does not encrypt the bearer token, session contents, command output, or approval
decisions. Prefer HTTP inside a private WireGuard/Tailscale tunnel, or use it only on a
fully trusted LAN. Do not expose port `4310` to the internet or use direct HTTP on
guest/public Wi-Fi. A captured token grants owner-level CodexNest access until it is
rotated. See the complete HTTP threat model in
[`deploy/DEPLOYMENT.md`](../../../deploy/DEPLOYMENT.md#вариант-a-http-внутри-приватного-vpn-или-доверенной-lan).

Run from the repository root:

```bash
npm run build
npm run android:sync -w @codexnest/client
cd apps/client/android
./gradlew assembleDebug
```

Android updates must always be signed with the same key as the installed APK.
CodexNest's existing signing key can continue to be used as long as it has not
been disclosed. Keep the keystore readable only by its owner (`chmod 600`) and
store an encrypted offline backup together with its passwords. Losing or
replacing the key prevents direct updates to existing installations.

For a new distribution that does not already have an established signing key,
generate a dedicated key once:

```bash
install -d -m 700 "$HOME/.config/codexnest-signing"
keytool -genkeypair \
  -keystore "$HOME/.config/codexnest-signing/codexnest-release.jks" \
  -alias codexnest \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000
chmod 600 "$HOME/.config/codexnest-signing/codexnest-release.jks"
```

For a signed release, provide all four values outside the repository:

```bash
export CODEXNEST_KEYSTORE_PATH=/absolute/path/codexnest.jks
export CODEXNEST_KEY_ALIAS=codexnest
export CODEXNEST_KEYSTORE_PASSWORD=...
export CODEXNEST_KEY_PASSWORD=...
./gradlew assembleRelease
```

Every successful push to `codex/mvp` updates the GitHub `Latest` release with
`CodexNest-latest.apk`, `CodexNest-latest.json`, and `install.sh`. The manifest
and installer pin Android and Linux installations to the same tested commit.

Notifications do not use Firebase, Google Play Services, or a third-party push provider.
The Android app starts a `remoteMessaging` foreground service that keeps an authenticated
WebSocket connection to the configured CodexNest server. Android displays a permanent,
low-priority connection notification while this service is active; this is required for
reliable real-time delivery when the app is in the background.

The service reads the existing server URL and encrypted bearer token from the same native
storage as the UI, reconnects after network loss and device reboot, and emits local
notifications for completed/failed tasks and attention requests. No additional account or
server credential is required. The signing keystore, passwords, and APKs remain ignored.
