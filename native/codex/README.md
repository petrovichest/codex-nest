# CodexNest durable receiver

This patch series pins the native receiver to the upstream revision in
`upstream.json`. Nest requires `initialize.durableDeliveryVersion == 1` before
submitting saved messages. An ordinary Codex update does not satisfy this contract.

## Build

Install the pinned Rust toolchain and the native build prerequisites required by
upstream Codex. Then run from the Nest checkout:

```sh
native/codex/build.sh
```

The script loads the configured Codex proxy environment without displaying it,
creates an isolated checkout, verifies the upstream revision and applied patches,
and builds with the locked dependency graph. Its output includes the binary path
and SHA-256. Nothing is installed or restarted. `CODEXNEST_NATIVE_PROFILE=dev`
selects a development build; release is the default.

When deploying this change, set the Nest server's `CODEXNEST_CODEX_BIN` to the
produced binary. Deploy Nest and its compatible receiver together: the sender
keeps messages queued if the configured receiver lacks the required capability.

The release tag's Cargo manifest uses 0.154.0 while its lockfile still identifies
workspace packages as 0.0.0. The packaging patch normalizes those workspace entries;
it does not upgrade external dependencies.

## Delivery contract

- `thread/start.clientCreationId` reserves one thread identity and returns the
  original result on replay, including after a lost response or process restart.
  An empty thread is persisted before its creation receipt is returned.
- `turn/start` and `turn/steer` with `clientUserMessageId` reserve the exact native
  request. Reusing an identity with different parameters is rejected. Receipt
  version 1 is returned only after the model-visible input and matching user item
  are persisted and the receipt is committed. Model sampling follows that barrier.
- Question answers use `turn/steer.userInputResponse` with the original turn and
  question identities and the complete user input. The tool result, text and
  attachments cross the same persistence barrier. Disconnecting does not fabricate
  an empty answer.
- Native queue insertion and its replay record are atomic. A delayed insertion
  replay cannot resurrect an entry already consumed or canceled. Editing or
  canceling an entry after native input admission is prevented. Definitively
  rejected input remains queued and can be canceled; replay returns the original
  rejection without rerunning its hook.
- The RPC command queue is released after admission. Waiting for persistence
  cannot block an interrupt or an answer needed by the active turn.

Receipts confirm durable input acceptance, not completion of the model's work.
Recovery does not restart a turn whose input already crossed the barrier. If an
interrupted turn never consumed a steer, the receiver reports a definitive
rejection; Nest retains its queued text for a fresh submission. Pending legacy
operations without a versioned receipt remain available for review and are not
silently resubmitted. This contract does not provide exactly-once side effects for
external tools or hooks, or protect against loss of the underlying storage.

## Verification

The process tests use a temporary `CODEX_HOME`, a local mock model endpoint, and
only their own child processes. They neither access accounts nor stop user sessions.

```sh
NODE_ENV=test CODEXNEST_DURABLE_CODEX_BIN=/absolute/path/to/codex \
  npm run test -w apps/server -- src/codex/durable.integration.test.ts
```

For a standalone `codex-app-server` build, also set
`CODEXNEST_DURABLE_CODEX_KIND=app-server`. The Node process-crash test is
`apps/server/src/message-queue-crash.test.ts`; browser storage and first-message
recovery run in Chromium and WebKit via the existing Playwright projects.

Run the upstream scoped Rust tests and regenerate both stable and experimental
app-server schema exports when changing the native patch. Generated Nest protocol
types must come from the same patched receiver. Installing this receiver and
switching the running Nest instance to it are separate deployment steps.
