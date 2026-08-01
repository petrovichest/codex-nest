import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const RESTART_RECOVERY_PROTOCOL_VERSION = 1;

export type RecoveryState =
  "starting" | "syncing" | "recovering" | "ready" | "draining" | "unavailable" | "failed";

export interface RuntimeLifecycleParticipant {
  pause(): void | Promise<void>;
  resume(): void | Promise<void>;
}

export interface RuntimeLifecycleOptions {
  transport: "stdio" | "daemon";
  tokenPath: string;
  bridgeReady(): boolean;
  checkpoint(): Promise<void>;
  drainTimeoutMs?: number;
  drainLeaseMs?: number;
}

export class RestartTokenError extends Error {}

export class RuntimeLifecycle {
  private recoveryState: RecoveryState = "starting";
  private readonly participants = new Set<RuntimeLifecycleParticipant>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly restartToken = randomBytes(32).toString("hex");
  private leaseTimer?: NodeJS.Timeout;
  private pauseController?: AbortController;
  private pausePromise?: Promise<void>;
  private transitionQueue = Promise.resolve();
  private shuttingDown = false;

  constructor(private readonly options: RuntimeLifecycleOptions) {}

  get state(): RecoveryState {
    return this.recoveryState;
  }

  get transport(): "stdio" | "daemon" {
    return this.options.transport;
  }

  get acceptsMutations(): boolean {
    return this.recoveryState === "ready";
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.options.tokenPath), { recursive: true, mode: 0o700 });
    await writeFile(this.options.tokenPath, `${this.restartToken}\n`, { mode: 0o600 });
    await chmod(this.options.tokenPath, 0o600);
  }

  register(participant: RuntimeLifecycleParticipant): () => void {
    this.participants.add(participant);
    return () => this.participants.delete(participant);
  }

  track<T>(promise: Promise<T>): Promise<T> {
    this.inFlight.add(promise);
    const cleanup = () => this.inFlight.delete(promise);
    void promise.then(cleanup, cleanup);
    return promise;
  }

  syncing(): void {
    if (this.recoveryState !== "draining") this.recoveryState = "syncing";
  }

  recovering(): void {
    if (this.recoveryState !== "draining") this.recoveryState = "recovering";
  }

  ready(): void {
    if (this.recoveryState !== "draining" && this.options.bridgeReady()) {
      this.recoveryState = "ready";
    }
  }

  unavailable(): void {
    if (this.recoveryState !== "draining") this.recoveryState = "unavailable";
  }

  failed(): void {
    if (this.recoveryState !== "draining") this.recoveryState = "failed";
  }

  async prepare(token: string): Promise<void> {
    this.assertToken(token);
    await this.transition(async () => {
      if (this.shuttingDown) throw new Error("CodexNest shutdown is already in progress");
      if (!this.pausePromise) {
        this.recoveryState = "draining";
        this.pauseController = new AbortController();
        this.pausePromise = this.pauseAndCheckpoint(this.pauseController.signal);
      }
      try {
        await within(
          this.pausePromise,
          this.options.drainTimeoutMs ?? 60_000,
          "CodexNest restart preparation timed out",
        );
      } catch (error) {
        this.pauseController?.abort();
        await Promise.all(
          [...this.participants].map((participant) =>
            Promise.resolve(participant.resume()).catch(() => undefined),
          ),
        );
        this.pauseController = undefined;
        this.pausePromise = undefined;
        this.recoveryState = this.options.bridgeReady() ? "ready" : "unavailable";
        throw error;
      }
      this.armLease();
    });
  }

  async resume(token: string): Promise<void> {
    this.assertToken(token);
    await this.transition(async () => {
      if (this.shuttingDown || !this.pausePromise) return;
      this.clearLease();
      this.pauseController?.abort();
      let failed = false;
      try {
        await Promise.all([...this.participants].map((participant) => participant.resume()));
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        this.pauseController = undefined;
        this.pausePromise = undefined;
        this.recoveryState = failed
          ? "failed"
          : this.options.bridgeReady()
            ? "ready"
            : "unavailable";
      }
    });
  }

  async prepareShutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.transition(async () => {
      this.clearLease();
      this.recoveryState = "draining";
      if (!this.pausePromise) {
        this.pauseController = new AbortController();
        this.pausePromise = this.pauseAndCheckpoint(this.pauseController.signal);
      }
      await this.pausePromise;
    });
  }

  async close(): Promise<void> {
    this.clearLease();
    this.pauseController?.abort();
    await unlink(this.options.tokenPath).catch(() => undefined);
  }

  private async pauseAndCheckpoint(signal: AbortSignal): Promise<void> {
    await Promise.all([...this.participants].map((participant) => participant.pause()));
    while (!signal.aborted && this.inFlight.size) {
      await Promise.all([...this.inFlight].map((pending) => pending.catch(() => undefined)));
    }
    if (signal.aborted) return;
    await this.options.checkpoint();
  }

  private transition<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transitionQueue.then(operation, operation);
    this.transitionQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private armLease(): void {
    this.clearLease();
    this.leaseTimer = setTimeout(() => {
      void this.resume(this.restartToken).catch(() => undefined);
    }, this.options.drainLeaseMs ?? 120_000);
    this.leaseTimer.unref();
  }

  private clearLease(): void {
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = undefined;
  }

  private assertToken(value: string): void {
    const expected = Buffer.from(this.restartToken);
    const actual = Buffer.from(value.trim());
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new RestartTokenError("Invalid restart token");
    }
  }
}

function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
