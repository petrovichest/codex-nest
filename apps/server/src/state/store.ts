import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import type { Project, QueuedMessage, SessionSettings, ThreadOutcome } from "@codexnest/protocol";

export interface ThreadMetaState {
  pinned: boolean;
  lastReadUpdatedAt: number;
  lastOutcome?: ThreadOutcome;
  outcomeUpdatedAt?: number;
  settings?: SessionSettings;
  inheritCodexSettings?: boolean;
}

export interface DeviceState {
  fcmToken: string;
  updatedAt: number;
}

export interface CodexNestState {
  schemaVersion: 1;
  auth: { tokenSha256?: string };
  projects: Project[];
  threadMeta: Record<string, ThreadMetaState>;
  devices: Record<string, DeviceState>;
  defaultReasoningEffort?: string;
  messageQueues?: Record<string, QueuedMessage[]>;
}

export function emptyState(): CodexNestState {
  return {
    schemaVersion: 1,
    auth: {},
    projects: [],
    threadMeta: {},
    devices: {},
    messageQueues: {},
  };
}

export class StateStore extends EventEmitter {
  private state = emptyState();
  private writeQueue: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(public readonly path: string) {
    super();
  }

  async load(): Promise<CodexNestState> {
    try {
      const serialized = await readFile(this.path, "utf8");
      const parsed: unknown = JSON.parse(serialized);
      this.state = validateState(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = emptyState();
      await this.persist(this.state);
    }
    this.loaded = true;
    return this.snapshot();
  }

  snapshot(): CodexNestState {
    if (!this.loaded) throw new Error("StateStore.load() must be called first");
    return structuredClone(this.state);
  }

  update(mutator: (draft: CodexNestState) => void | Promise<void>): Promise<CodexNestState> {
    const task = this.writeQueue.then(async () => {
      if (!this.loaded) throw new Error("StateStore.load() must be called first");
      const draft = structuredClone(this.state);
      const originalVerifier = this.state.auth.tokenSha256;
      await mutator(draft);
      if (draft.auth.tokenSha256 === originalVerifier) {
        try {
          const disk = validateState(JSON.parse(await readFile(this.path, "utf8")) as unknown);
          if (disk.auth.tokenSha256 !== originalVerifier) draft.auth = structuredClone(disk.auth);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      const validated = validateState(draft);
      await this.persist(validated);
      const verifierChanged = validated.auth.tokenSha256 !== this.state.auth.tokenSha256;
      this.state = validated;
      if (verifierChanged) this.emit("authRotated");
    });
    this.writeQueue = task.catch(() => undefined);
    return task.then(() => this.snapshot());
  }

  async flushed(): Promise<void> {
    await this.writeQueue;
  }

  async refreshAuthVerifier(): Promise<boolean> {
    await this.writeQueue;
    const parsed = validateState(JSON.parse(await readFile(this.path, "utf8")) as unknown);
    if (parsed.auth.tokenSha256 === this.state.auth.tokenSha256) return false;
    this.state.auth = structuredClone(parsed.auth);
    this.emit("authRotated");
    return true;
  }

  private async persist(next: CodexNestState): Promise<void> {
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.path);
      const target = await open(this.path, "r+");
      try {
        await target.chmod(0o600);
        await target.sync();
      } finally {
        await target.close();
      }
      const directory = await open(parent, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

function validateState(value: unknown): CodexNestState {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Unsupported or corrupt CodexNest state schema");
  }
  if (!isRecord(value.auth) || !Array.isArray(value.projects)) {
    throw new Error("Corrupt CodexNest state");
  }
  if (!isRecord(value.threadMeta) || !isRecord(value.devices)) {
    throw new Error("Corrupt CodexNest state");
  }
  if (value.messageQueues !== undefined && !isRecord(value.messageQueues)) {
    throw new Error("Corrupt message queues in CodexNest state");
  }
  if (
    value.defaultReasoningEffort !== undefined &&
    (typeof value.defaultReasoningEffort !== "string" || !value.defaultReasoningEffort.trim())
  ) {
    throw new Error("Corrupt default reasoning effort in CodexNest state");
  }
  for (const project of value.projects) {
    if (!isProject(project)) throw new Error("Corrupt project in CodexNest state");
  }
  for (const meta of Object.values(value.threadMeta)) {
    if (
      !isRecord(meta) ||
      typeof meta.pinned !== "boolean" ||
      typeof meta.lastReadUpdatedAt !== "number" ||
      (meta.lastOutcome !== undefined &&
        !["completed", "failed", "interrupted"].includes(String(meta.lastOutcome))) ||
      (meta.outcomeUpdatedAt !== undefined && typeof meta.outcomeUpdatedAt !== "number") ||
      (meta.settings !== undefined && !isSessionSettings(meta.settings)) ||
      (meta.inheritCodexSettings !== undefined && typeof meta.inheritCodexSettings !== "boolean")
    ) {
      throw new Error("Corrupt thread metadata in CodexNest state");
    }
  }
  for (const device of Object.values(value.devices)) {
    if (
      !isRecord(device) ||
      typeof device.fcmToken !== "string" ||
      typeof device.updatedAt !== "number"
    ) {
      throw new Error("Corrupt device registration in CodexNest state");
    }
  }
  for (const [threadId, messages] of Object.entries(value.messageQueues ?? {})) {
    if (
      !Array.isArray(messages) ||
      messages.some((message) => !isQueuedMessage(message, threadId))
    ) {
      throw new Error("Corrupt queued message in CodexNest state");
    }
  }
  const verifier = value.auth.tokenSha256;
  if (
    verifier !== undefined &&
    (typeof verifier !== "string" || !/^[a-f\d]{64}$/i.test(verifier))
  ) {
    throw new Error("Corrupt token verifier in CodexNest state");
  }
  return value as unknown as CodexNestState;
}

function isQueuedMessage(value: unknown, threadId: string): value is QueuedMessage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.threadId === threadId &&
    typeof value.text === "string" &&
    Boolean(value.text.trim()) &&
    typeof value.createdAt === "number" &&
    ["queued", "dispatching"].includes(String(value.status))
  );
}

function isSessionSettings(value: unknown): value is SessionSettings {
  if (!isRecord(value) || !["default", "plan"].includes(String(value.collaborationMode))) {
    return false;
  }
  for (const key of ["model", "reasoningEffort", "serviceTier", "personality"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") return false;
  }
  if (
    value.sandboxMode !== undefined &&
    !["read-only", "workspace-write", "danger-full-access"].includes(String(value.sandboxMode))
  ) {
    return false;
  }
  if (
    value.approvalsReviewer !== undefined &&
    !["user", "auto_review"].includes(String(value.approvalsReviewer))
  ) {
    return false;
  }
  return (
    value.approvalPolicy === undefined ||
    ["untrusted", "on-request", "granular", "never"].includes(String(value.approvalPolicy))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isProject(value: unknown): value is Project {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.displayName === "string" &&
    typeof value.path === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}
