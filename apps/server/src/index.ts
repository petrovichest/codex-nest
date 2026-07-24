import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

import { buildApp } from "./app";
import { AttentionManager } from "./attention";
import { AppManager } from "./app-management";
import { CodexBackend } from "./backends/codex";
import { SessionHub } from "./backends/hub";
import { ClaudeBackend } from "./claude/backend";
import { ClaudeManager } from "./claude/manager";
import { resolveClaudeModels } from "./claude/models";
import { loadRealSdk, readClaudeVersion } from "./claude/sdk";
import { CodexBridge } from "./codex/bridge";
import { connectUnixWebSocket, type JsonlProcess } from "./codex/transport";
import { CodexManager } from "./codex-management";
import { childProcessEnvironment, loadConfig, SERVER_VERSION } from "./config";
import { AppProjection } from "./projection";
import { PushNotifier } from "./push";
import { StateStore } from "./state/store";
import { ThreadTitleGenerator } from "./thread-title";
import { TranscriptionService } from "./transcription";
import { TranscriptRefiner } from "./transcript-refiner";

const config = loadConfig();
const store = new StateStore(config.statePath);
await store.load();
let authRefreshTimer: NodeJS.Timeout | undefined;
const stateWatcher = watch(dirname(config.statePath), { persistent: false }, (_event, filename) => {
  if (filename && filename !== basename(config.statePath)) return;
  if (authRefreshTimer) clearTimeout(authRefreshTimer);
  authRefreshTimer = setTimeout(() => {
    authRefreshTimer = undefined;
    void store.refreshAuthVerifier().catch(() => undefined);
  }, 50);
});

const attention = new AttentionManager();
const bridge = new CodexBridge({
  codexBin: config.codexBin,
  spawnProcess: () =>
    config.codexTransport === "daemon"
      ? connectUnixWebSocket(
          resolve(
            process.env.CODEX_HOME?.trim() || resolve(homedir(), ".codex"),
            "app-server-control/app-server-control.sock",
          ),
        )
      : (spawn(config.codexBin, ["app-server", "--listen", "stdio://"], {
          stdio: ["pipe", "pipe", "pipe"],
          env: childProcessEnvironment(),
        }) as unknown as JsonlProcess),
});
const push = new PushNotifier(store, config.firebaseCredentialPath, config.firebaseProjectId);
const projection = new AppProjection(bridge, store, attention, push.configured);
const threadTitles = new ThreadTitleGenerator(bridge);
const transcriptRefiner = new TranscriptRefiner(bridge);
const transcription = new TranscriptionService({
  provider: config.sttProvider,
  localUrl: config.sttLocalUrl,
  openAiApiKey: config.sttOpenAiApiKey,
  openAiModel: config.sttOpenAiModel,
  language: config.sttLanguage,
  refineLocal: config.sttRefineLocal,
  refinementModel: config.sttRefinementModel,
  timeoutMs: config.sttTimeoutMs,
  proxyEnvFile: config.codexProxyEnvFile,
  settingsEnvFile: config.serverEnvFile,
  cwd: process.cwd(),
  refiner: transcriptRefiner,
});
const codexManager = new CodexManager({
  codexBin: config.codexBin,
  managementBin: config.codexManagementBin,
  proxyEnvFile: config.codexProxyEnvFile,
  transport: config.codexTransport,
  activeTurnCount: () =>
    projection.snapshot().threads.filter((thread) => thread.currentTurnId !== null).length,
  bridgeState: () => bridge.state,
  bridgeVersion: () => bridge.actualVersion,
});
const appManager = new AppManager({
  currentVersion: SERVER_VERSION,
  managedInstall: config.managedInstall,
  statusPath: config.updateStatusPath,
  managementCli: config.managementCli,
});
const codexBackend = new CodexBackend({
  projection,
  bridge,
  store,
  codexManager,
  threadTitles,
});

// Claude backend: constructed for `true` (always, surfacing unavailable state) and
// for `auto` only when a startup version probe succeeds; skipped entirely for `false`.
const claudeLog = {
  warn: (payload: Record<string, unknown>, message: string) =>
    process.stderr.write(`${message} ${JSON.stringify(payload)}\n`),
};
let claudeBackend: ClaudeBackend | undefined;
let claudeManager: ClaudeManager | undefined;
if (config.claudeEnabled !== "false") {
  const enabled =
    config.claudeEnabled === "true" ||
    (await readClaudeVersion(config.claudeBin).then(
      () => true,
      () => false,
    ));
  if (enabled) {
    claudeBackend = new ClaudeBackend({
      store,
      sdk: await loadRealSdk(),
      models: resolveClaudeModels(config.claudeModels, claudeLog),
      bin: config.claudeBin,
    });
    const backend = claudeBackend;
    claudeManager = new ClaudeManager({
      path: config.claudeBin,
      currentStatus: () => backend.currentProbe(),
      probe: () => backend.probe(),
    });
  }
}

const hub = new SessionHub(
  claudeBackend ? [codexBackend, claudeBackend] : [codexBackend],
  store,
  attention,
  push.configured,
);
projection.on("projectionError", (error: Error) => {
  process.stderr.write(`CodexNest projection update failed (${error.name})\n`);
});

bridge.on("request", (request, transport) => {
  try {
    attention.receive(request, transport);
  } catch {
    transport.respondError(request.id, -32_602, "Invalid request parameters");
  }
});
bridge.on("state", (state) => {
  if (state === "ready") {
    void codexBackend.sync().catch((error: Error) => {
      process.stderr.write(`CodexNest initial sync failed (${error.name})\n`);
    });
  } else if (state === "unavailable") {
    attention.expireAgent("codex");
  }
});
const pushedTerminal = new Map<string, string>();
hub.on("event", (_sequence, event) => {
  if (event.type === "attention.upserted" && event.attention.threadId) {
    void push.send(event.attention.threadId, "attention").catch(() => undefined);
  }
  if (
    event.type === "thread.upserted" &&
    event.thread.queuedMessageCount === 0 &&
    (event.thread.state === "completed" || event.thread.state === "failed")
  ) {
    const pushKey = `${event.thread.state}:${event.thread.updatedAt}`;
    if (pushedTerminal.get(event.thread.id) !== pushKey) {
      pushedTerminal.set(event.thread.id, pushKey);
      void push.send(event.thread.id, event.thread.state).catch(() => undefined);
    }
  }
});

const app = await buildApp(config, {
  bridge,
  store,
  projection,
  hub,
  codexBackend,
  attention,
  push,
  codexManager,
  claudeManager,
  appManager,
  transcription,
});
codexBackend.setLogger(app.log);
claudeBackend?.setLogger(app.log);
await app.listen({ host: config.host, port: config.port });
void codexBackend.start();
if (claudeBackend) void claudeBackend.start();

async function shutdown(): Promise<void> {
  stateWatcher.close();
  if (authRefreshTimer) clearTimeout(authRefreshTimer);
  codexBackend.stop();
  claudeBackend?.stop();
  await store.flushed();
  await app.close();
}

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
