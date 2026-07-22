# Android build

CodexNest targets Android 10 (API 29) and newer. The app uses `http://localhost` as its
Capacitor origin. Network Security Configuration permits the user-selected LAN HTTP
deployment and trusts both system and user-installed CA certificates without disabling
normal TLS hostname/IP verification.

LAN HTTP does not encrypt the bearer token, session contents, command output, or approval
decisions. Use it only on a fully trusted private network; do not expose port `4310` to the
internet or use it on guest/public Wi-Fi. A captured token grants owner-level CodexNest
access until it is rotated. See the complete HTTP threat model in
[`deploy/DEPLOYMENT.md`](../../../deploy/DEPLOYMENT.md#вариант-a-http-внутри-доверенной-lan).

Run from the repository root:

```bash
npm run build
npm run android:sync -w @codexnest/client
cd apps/client/android
./gradlew assembleDebug
```

For a signed release, provide all four values outside the repository:

```bash
export CODEXNEST_KEYSTORE_PATH=/absolute/path/codexnest.jks
export CODEXNEST_KEY_ALIAS=codexnest
export CODEXNEST_KEYSTORE_PASSWORD=...
export CODEXNEST_KEY_PASSWORD=...
./gradlew assembleRelease
```

Notifications do not use Firebase, Google Play Services, or a third-party push provider.
The Android app starts a `remoteMessaging` foreground service that keeps an authenticated
WebSocket connection to the configured CodexNest server. Android displays a permanent,
low-priority connection notification while this service is active; this is required for
reliable real-time delivery when the app is in the background.

The service reads the existing server URL and encrypted bearer token from the same native
storage as the UI, reconnects after network loss and device reboot, and emits local
notifications for completed/failed tasks and attention requests. No additional account or
server credential is required. The signing keystore, passwords, and APKs remain ignored.
