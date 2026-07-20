# Android build

CodexNest targets Android 10 (API 29) and newer. The app uses `http://localhost` as its
Capacitor origin. Network Security Configuration permits the user-selected LAN HTTP
deployment and trusts both system and user-installed CA certificates without disabling
normal TLS hostname/IP verification.

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

For personal FCM, place the private `google-services.json` at `app/google-services.json`
before `cap sync`/Gradle build. The file, keystore, passwords, and APKs are ignored.
