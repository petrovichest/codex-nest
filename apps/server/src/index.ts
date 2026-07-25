import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

import { buildApp } from "./app";
import { AttentionManager } from "./attention";
import { AppManager } from "./app-management";
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
  activeTurnCount: () =>
    projection.snapshot().threads.filter((thread) => thread.currentTurnId !== null).length,
});
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
    void projection.sync().catch((error: Error) => {
      process.stderr.write(`CodexNest initial sync failed (${error.name})\n`);
    });
  } else if (state === "unavailable") {
    attention.expireAll();
  }
});
const pushedTerminal = new Map<string, string>();
projection.on("event", (_sequence, event) => {
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
  attention,
  push,
  codexManager,
  appManager,
  threadTitles,
  transcription,
});
await app.listen({ host: config.host, port: config.port });
void bridge.start();

async function shutdown(): Promise<void> {
  stateWatcher.close();
  if (authRefreshTimer) clearTimeout(authRefreshTimer);
  bridge.stop();
  await store.flushed();
  await app.close();
}

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
