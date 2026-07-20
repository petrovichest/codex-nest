import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";

import type { AppServerState, AttentionRequest, AttentionResponse } from "@codexnest/protocol";

import { EXPECTED_CODEX_VERSION } from "../config";
import { safeError } from "../logging";
import type { InitializeResponse, ServerNotification, ServerRequest } from "./generated/index";
import { JsonlTransport, type JsonlProcess } from "./transport";

const execFileAsync = promisify(execFile);
const BACKOFF_SECONDS = [1, 2, 4, 8, 16, 30] as const;

export interface SpawnBridgeProcess {
  (): JsonlProcess;
}

export interface AttentionAdapter {
  receive(request: ServerRequest, transport: JsonlTransport): AttentionRequest | undefined;
  resolve(id: string, response: AttentionResponse): boolean;
  expireAll(): void;
}

export interface BridgeOptions {
  codexBin: string;
  spawnProcess: SpawnBridgeProcess;
  checkVersion?: () => Promise<string>;
  random?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export class CodexBridge extends EventEmitter {
  private transport?: JsonlTransport;
  private child?: JsonlProcess;
  private restartTimer?: NodeJS.Timeout;
  private stableTimer?: NodeJS.Timeout;
  private restartAttempt = 0;
  private stopping = false;
  private _state: AppServerState = "unavailable";
  private _actualVersion?: string;

  constructor(private readonly options: BridgeOptions) {
    super();
  }

  get state(): AppServerState {
    return this._state;
  }

  get actualVersion(): string | undefined {
    return this._actualVersion;
  }

  get ready(): boolean {
    return this._state === "ready" && !!this.transport;
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.setState("starting");
    const checkVersion =
      this.options.checkVersion ?? (() => readCodexVersion(this.options.codexBin));
    try {
      this._actualVersion = await checkVersion();
    } catch (error) {
      this.setState("unavailable", safeError(error));
      this.scheduleRestart();
      return;
    }
    if (this._actualVersion !== EXPECTED_CODEX_VERSION) {
      this.setState("incompatible");
      return;
    }
    await this.launch();
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.restartTimer = undefined;
    this.stableTimer = undefined;
    this.transport?.shutdown();
    this.transport = undefined;
    this.child?.kill("SIGTERM");
    this.child = undefined;
    this.setState("unavailable");
  }

  async request<T>(method: string, params: unknown, timeoutMs = 15_000): Promise<T> {
    if (!this.transport || !this.ready) {
      throw new BridgeUnavailableError(this._state);
    }
    return this.transport.request<T>(method, params, timeoutMs);
  }

  respond(id: number | string, result: unknown): void {
    if (!this.transport || !this.ready) throw new BridgeUnavailableError(this._state);
    this.transport.respond(id, result);
  }

  respondUnsupported(id: number | string, method: string): void {
    this.transport?.respondError(id, -32_601, `Method not supported: ${method}`);
  }

  private async launch(): Promise<void> {
    if (this.stopping) return;
    this.setState("starting");
    let child: JsonlProcess;
    try {
      child = this.options.spawnProcess();
    } catch (error) {
      this.setState("unavailable", safeError(error));
      this.scheduleRestart();
      return;
    }
    this.child = child;
    child.stderr?.resume();
    const transport = new JsonlTransport(child);
    this.transport = transport;
    transport.on("notification", (notification: ServerNotification) =>
      this.emit("notification", notification),
    );
    transport.on("request", (request: ServerRequest) => this.emit("request", request, transport));
    transport.on("unknownResponse", (id: number) => this.emit("unknownResponse", id));
    transport.on("protocolError", (error: Error) => this.emit("protocolError", error));
    transport.on("exit", () => {
      if (this.stableTimer) clearTimeout(this.stableTimer);
      this.stableTimer = undefined;
      if (this.transport === transport) this.transport = undefined;
      if (this.child === child) this.child = undefined;
      if (!this.stopping) {
        this.setState("unavailable");
        this.scheduleRestart();
      }
    });

    try {
      await transport.request<InitializeResponse>(
        "initialize",
        {
          clientInfo: { name: "codexnest", title: "CodexNest", version: "0.1.0" },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            mcpServerOpenaiFormElicitation: false,
          },
        },
        10_000,
      );
      transport.notify("initialized");
      this.setState("ready");
      this.stableTimer = setTimeout(() => {
        this.restartAttempt = 0;
      }, 60_000);
      this.stableTimer.unref();
    } catch (error) {
      transport.shutdown(error instanceof Error ? error : new Error(String(error)));
      child.kill("SIGTERM");
      this.setState("unavailable", safeError(error));
    }
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer || this._state === "incompatible") return;
    const index = Math.min(this.restartAttempt, BACKOFF_SECONDS.length - 1);
    const baseMs = (BACKOFF_SECONDS[index] ?? 30) * 1_000;
    this.restartAttempt += 1;
    const random = this.options.random ?? Math.random;
    const jitteredMs = Math.round(baseMs * (0.8 + random() * 0.4));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.start();
    }, jitteredMs);
    this.restartTimer.unref();
  }

  private setState(state: AppServerState, detail?: unknown): void {
    this._state = state;
    this.emit("state", state, detail);
  }
}

export class BridgeUnavailableError extends Error {
  constructor(public readonly bridgeState: AppServerState) {
    super(
      bridgeState === "incompatible"
        ? "The installed Codex CLI protocol version is incompatible"
        : "Codex app-server is unavailable",
    );
    this.name = "BridgeUnavailableError";
  }
}

async function readCodexVersion(codexBin: string): Promise<string> {
  const { stdout } = await execFileAsync(codexBin, ["--version"], { timeout: 10_000 });
  const match = /codex-cli\s+([^\s]+)/.exec(stdout);
  if (!match) throw new Error("Unable to parse Codex CLI version");
  return match[1]!;
}
