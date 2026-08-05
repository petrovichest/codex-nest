import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, normalize, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ActivityItem,
  CommandReceipt as ProtocolCommandReceipt,
  CommandReceiptStatus as ProtocolCommandReceiptStatus,
  Project,
  QueuedMessage,
  SessionSettings,
  TaskDefaults,
  ThreadDraft,
  ThreadDetail,
  ThreadOutcome,
  ServerEvent,
  UiLanguage,
  VoiceTranscriptionMode,
  VoiceTranscriptionStatus,
} from "@codexnest/protocol";

export type TimelineArtifact = Extract<
  ActivityItem,
  { type: "userInputResponse" | "planChecklist" | "orchestrationNotice" }
>;

export type ManagedTeamTaskStatus = "queued" | "starting" | "running" | ThreadOutcome;

export type ManagedTeamTaskAccessMode = "readOnly" | "isolatedWrite" | "sharedWrite";

export interface ManagedTeamTaskAccessState {
  mode: ManagedTeamTaskAccessMode;
  writePaths?: string[];
  network?: boolean;
}

export type ManagedTeamTaskResultOutcome = "success" | "partial" | "blocked" | "failed";

export interface ManagedTeamTaskResultCheck {
  name: string;
  outcome: "passed" | "failed" | "notRun";
  details?: string;
}

export interface ManagedTeamTaskResultArtifact {
  label: string;
  path?: string;
  url?: string;
}

export type ManagedTeamTaskBudgetReason = "timeout" | "tokenBudget";

export type ManagedTeamTaskWorkspaceLifecycle =
  | "creating"
  | "ready"
  | "integrating"
  | "integrated"
  | "discarding"
  | "discarded"
  | "conflicted"
  | "recoveryRequired";

export type ManagedTeamTaskWorkspaceFileState =
  | {
      type: "file";
      mode: number;
      digest: string;
    }
  | {
      type: "symlink";
      target: string;
    };

export interface ManagedTeamTaskWorkspaceState {
  lifecycle: ManagedTeamTaskWorkspaceLifecycle;
  repositoryRoot: string;
  gitCommonDir: string;
  worktreePath: string;
  head: string;
  baseline: Record<string, ManagedTeamTaskWorkspaceFileState>;
  createdAt: number;
  updatedAt: number;
  changedPaths?: string[];
  conflictPaths?: string[];
  error?: string;
}

export interface ManagedTeamTaskResultFields {
  outcome?: ManagedTeamTaskResultOutcome;
  checks?: ManagedTeamTaskResultCheck[];
  risks?: string[];
  artifacts?: ManagedTeamTaskResultArtifact[];
}

export interface ManagedTeamTaskResult extends ManagedTeamTaskResultFields {
  summary: string;
  details?: string;
  source: "submitted" | "final_answer" | "agent_message" | "status";
}

export interface ManagedTeamTaskResultCandidate extends ManagedTeamTaskResultFields {
  summary: string;
  details?: string;
  submittedAt: number;
  callId: string;
}

export interface ManagedTeamTaskState {
  id: string;
  childThreadId: string;
  childThreadSource?: string;
  childTurnId?: string;
  startMessageId?: string;
  title: string;
  prompt: string;
  status: ManagedTeamTaskStatus;
  dependsOn?: string[];
  predecessorTaskId?: string;
  access?: ManagedTeamTaskAccessState;
  resolvedModel?: string;
  resolvedReasoningEffort?: string | null;
  resolvedServiceTier?: string | null;
  timeoutMinutes?: number;
  tokenBudget?: number;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  failureReason?: string;
  budgetReason?: ManagedTeamTaskBudgetReason;
  workspace?: ManagedTeamTaskWorkspaceState;
  createdAt: number;
  startedAt?: number;
  lastActivityAt: number;
  recoveryMisses?: number;
  expectedWakeAt?: number;
  lastWatchdogAt?: number;
  watchdog?: {
    status: "pending" | "claimed";
    triggeredAt: number;
    claimId?: string;
    markerId?: string;
    dispatchStartedAt?: number;
    contextHash?: string;
  };
  terminalTurnId?: string;
  resultCandidate?: ManagedTeamTaskResultCandidate;
  result?: ManagedTeamTaskResult;
  delivery?: {
    status: "claimed" | "delivered";
    claimId: string;
    parentTurnId?: string;
    markerId?: string;
    dispatchStartedAt?: number;
    contextHash?: string;
  };
}

export interface TeamOrchestrationState {
  tasks: Record<string, ManagedTeamTaskState>;
}

export interface TeamToolOperationState {
  threadId: string;
  turnId: string;
  callId: string;
  tool:
    | "spawn_task"
    | "followup_task"
    | "steer_task"
    | "cancel_task"
    | "submit_result"
    | "integrate_task"
    | "discard_task_changes";
  argumentsHash: string;
  status: "prepared" | "applied";
  createdAt: number;
  updatedAt: number;
  taskId?: string;
  childThreadSource?: string;
  response?: {
    contentItems: Array<
      { type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }
    >;
    success: boolean;
  };
}

export interface ThreadMetaState {
  pinned: boolean;
  lastReadUpdatedAt: number;
  lastViewedUpdatedAt?: number;
  lastOutcome?: ThreadOutcome;
  outcomeUpdatedAt?: number;
  settings?: SessionSettings;
  inheritCodexSettings?: boolean;
  awaitingPlanResponse?: boolean;
  timelineArtifacts?: Record<string, TimelineArtifact[]>;
  teamOrchestration?: TeamOrchestrationState;
  teamToolsVersion?: 1 | 2;
  managedParent?: {
    parentThreadId: string;
    taskId: string;
  };
  unmaterialized?: boolean;
  draft?: ThreadDraft;
}

export interface DeviceState {
  fcmToken: string;
  updatedAt: number;
}

export interface TranscriptionTimingSampleState {
  audioDurationMs: number;
  processingMs: number;
}

export interface VoiceTranscriptionState {
  id: string;
  threadId: string;
  mode: VoiceTranscriptionMode;
  status: VoiceTranscriptionStatus;
  createdAt: number;
  startedAt: number | null;
  audioDurationMs: number;
  estimatedTotalSeconds: number | null;
  error: string | null;
  contentType: "audio/webm" | "audio/mp4";
  audioFile?: string;
  audioBytes: number;
  selectionStart: number;
  selectionEnd: number;
  timingProfile?: string;
  transcript?: string;
  attempts?: number;
  nextAttemptAt?: number;
}

export interface VoiceReceiptState {
  threadId: string;
  createdAt: number;
}

export interface MessageReceiptState {
  threadId: string;
  turnId: string | null;
  contentHash: string;
  createdAt: number;
}

export interface CodexNestState {
  schemaVersion: 1;
  auth: { tokenSha256?: string };
  projects: Project[];
  dismissedProjectPaths?: string[];
  threadMeta: Record<string, ThreadMetaState>;
  devices: Record<string, DeviceState>;
  transcriptionTimings?: Record<string, TranscriptionTimingSampleState[]>;
  uiLanguage: UiLanguage;
  defaultReasoningEffort?: string;
  taskDefaults?: TaskDefaults;
  messageQueues?: Record<string, QueuedMessage[]>;
  messageReceipts?: Record<string, MessageReceiptState>;
  teamToolOperations?: Record<string, TeamToolOperationState>;
  voiceTranscriptions?: Record<string, VoiceTranscriptionState>;
  voiceReceipts?: Record<string, VoiceReceiptState>;
}

export function emptyState(): CodexNestState {
  return {
    schemaVersion: 1,
    auth: {},
    projects: [],
    threadMeta: {},
    devices: {},
    uiLanguage: "en",
    messageQueues: {},
    messageReceipts: {},
    teamToolOperations: {},
    voiceTranscriptions: {},
    voiceReceipts: {},
  };
}

export interface ProjectionCursor {
  epoch: string;
  revision: number;
}

export interface PersistedProjection<T = unknown> extends ProjectionCursor {
  snapshot: T | null;
  updatedAt: number | null;
}

export interface PersistedProjectionEvent<T = unknown> extends ProjectionCursor {
  createdAt: number;
  patch: T;
}

export interface ProjectionDiagnostics extends ProjectionCursor {
  lastEventAt: number | null;
  lastReconciledAt: number | null;
  projectionQueueDepth: number;
  oldestPendingCommandAgeMs: number | null;
  lastReceiveToCommitMs: number | null;
  lastCommitToSendMs: number | null;
}

export type CommandReceiptStatus = ProtocolCommandReceiptStatus;

export type CommandReceipt<T = unknown> = ProtocolCommandReceipt<T>;

const PROJECTION_EVENT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const PROJECTION_EVENT_RETENTION_REVISIONS = 50_000;
const MAX_REPLAY_PATCH_BYTES = 1_500_000;
const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const RECEIPT_RETENTION_COUNT = 50_000;
const SQLITE_HEADER = "SQLite format 3\0";

export class StateStore extends EventEmitter {
  private state = emptyState();
  private writeQueue: Promise<void> = Promise.resolve();
  private loaded = false;
  private database: DatabaseSync | null = null;

  constructor(public readonly path: string) {
    super();
  }

  async load(): Promise<CodexNestState> {
    if (this.loaded) return this.snapshot();
    const parent = dirname(this.path);
    const rotateEpochMarker = `${this.path}.rotate-epoch`;
    const rotateEpoch = await pathExists(rotateEpochMarker);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const targetExisted = await pathExists(this.path);
    const legacy = await this.readLegacyState();
    if (legacy) await this.migrateLegacyState(legacy);

    const database = new DatabaseSync(this.path);
    try {
      this.configureDatabase(database);
      if (targetExisted && !legacy && !sqliteTableExists(database, "app_state")) {
        throw new Error("Existing CodexNest SQLite state is missing app_state");
      }
      this.database = database;
      this.createSchema(database);
      if (rotateEpoch) {
        this.transaction(() => {
          const epoch = randomUUID();
          database.prepare("UPDATE projection_meta SET epoch = ? WHERE id = 1").run(epoch);
          const row = database
            .prepare("SELECT snapshot FROM projection_snapshot WHERE id = 1")
            .get() as { snapshot: string } | undefined;
          if (row) {
            const snapshot = JSON.parse(row.snapshot) as unknown;
            const revision = this.projectionCursor().revision;
            database
              .prepare("UPDATE projection_snapshot SET snapshot = ?, updated_at = ? WHERE id = 1")
              .run(JSON.stringify(withProjectionCursor(snapshot, epoch, revision)), Date.now());
          }
        });
        await unlink(rotateEpochMarker).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
      database.prepare("UPDATE projection_meta SET projection_queue_depth = 0 WHERE id = 1").run();
      await chmod(this.path, 0o600);

      const row = database.prepare("SELECT json FROM app_state WHERE id = 1").get() as
        { json: string } | undefined;
      if (row) {
        this.state = validateState(JSON.parse(row.json) as unknown);
      } else {
        if (targetExisted || legacy) {
          throw new Error("Existing CodexNest SQLite state is missing application data");
        }
        this.state = emptyState();
        this.transaction(() => {
          database
            .prepare("INSERT INTO app_state (id, json, updated_at) VALUES (1, ?, ?)")
            .run(JSON.stringify(this.state), Date.now());
        });
      }
      this.loaded = true;
      return this.snapshot();
    } catch (error) {
      if (this.database === database) this.database = null;
      database.close();
      if (!targetExisted && !legacy) await removeMigrationFiles(this.path);
      throw error;
    }
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
      pruneStateReceipts(draft, Date.now());
      if (draft.auth.tokenSha256 === originalVerifier) {
        const row = this.requireDatabase()
          .prepare("SELECT json FROM app_state WHERE id = 1")
          .get() as { json: string } | undefined;
        if (row) {
          const disk = validateState(JSON.parse(row.json) as unknown);
          if (disk.auth.tokenSha256 !== originalVerifier) draft.auth = structuredClone(disk.auth);
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

  async checkpoint(): Promise<void> {
    const task = this.writeQueue.then(async () => {
      if (!this.loaded) throw new Error("StateStore.load() must be called first");
      await this.persist(this.state);
      this.requireDatabase().exec("PRAGMA wal_checkpoint(TRUNCATE)");
    });
    this.writeQueue = task.catch(() => undefined);
    await task;
  }

  async refreshAuthVerifier(): Promise<boolean> {
    await this.writeQueue;
    const row = this.requireDatabase().prepare("SELECT json FROM app_state WHERE id = 1").get() as
      { json: string } | undefined;
    if (!row) throw new Error("CodexNest state is missing from SQLite");
    const parsed = validateState(JSON.parse(row.json) as unknown);
    if (parsed.auth.tokenSha256 === this.state.auth.tokenSha256) return false;
    this.state.auth = structuredClone(parsed.auth);
    this.emit("authRotated");
    return true;
  }

  projection<T = unknown>(): PersistedProjection<T> {
    const database = this.requireDatabase();
    const cursor = this.projectionCursor();
    const row = database
      .prepare("SELECT snapshot, updated_at AS updatedAt FROM projection_snapshot WHERE id = 1")
      .get() as { snapshot: string; updatedAt: number } | undefined;
    return {
      ...cursor,
      snapshot: row ? (JSON.parse(row.snapshot) as T) : null,
      updatedAt: row?.updatedAt ?? null,
    };
  }

  projectionCursor(): ProjectionCursor {
    const row = this.requireDatabase()
      .prepare("SELECT epoch, revision FROM projection_meta WHERE id = 1")
      .get() as { epoch: string; revision: number } | undefined;
    if (!row) throw new Error("Projection metadata is missing from SQLite");
    if (!row.epoch || !Number.isSafeInteger(row.revision) || row.revision < 0) {
      throw new Error("Projection cursor is corrupt in SQLite");
    }
    return row;
  }

  commitProjection<TSnapshot, TPatch>(
    snapshot: TSnapshot,
    patch: TPatch,
    receivedAt = Date.now(),
    queueDepth?: number,
  ): PersistedProjectionEvent<TPatch> {
    const database = this.requireDatabase();
    const committedAt = Date.now();
    let committed!: PersistedProjectionEvent<TPatch>;
    this.transaction(() => {
      const cursor = this.projectionCursor();
      const revision = cursor.revision + 1;
      const persistedSnapshot = withProjectionCursor(snapshot, cursor.epoch, revision);
      database
        .prepare(
          "UPDATE projection_meta SET revision = ?, last_event_at = ?, last_receive_to_commit_ms = ?, projection_queue_depth = COALESCE(?, projection_queue_depth) WHERE id = 1",
        )
        .run(
          revision,
          committedAt,
          Math.max(0, committedAt - receivedAt),
          queueDepth === undefined ? null : Math.max(0, queueDepth),
        );
      database
        .prepare(
          "INSERT INTO projection_snapshot (id, snapshot, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET snapshot = excluded.snapshot, updated_at = excluded.updated_at",
        )
        .run(JSON.stringify(persistedSnapshot), committedAt);
      database
        .prepare(
          "INSERT INTO projection_events (epoch, revision, created_at, patch) VALUES (?, ?, ?, ?)",
        )
        .run(cursor.epoch, revision, committedAt, JSON.stringify(patch));
      reduceThreadProjection(database, patch);
      database
        .prepare("DELETE FROM projection_events WHERE created_at < ? AND revision <= ?")
        .run(
          committedAt - PROJECTION_EVENT_RETENTION_MS,
          Math.max(0, revision - PROJECTION_EVENT_RETENTION_REVISIONS),
        );
      committed = {
        epoch: cursor.epoch,
        revision,
        createdAt: committedAt,
        patch,
      };
    });
    return committed;
  }

  replayProjection<T = unknown>(cursor: ProjectionCursor): PersistedProjectionEvent<T>[] | null {
    const current = this.projectionCursor();
    if (
      cursor.epoch !== current.epoch ||
      cursor.revision < 0 ||
      cursor.revision > current.revision
    ) {
      return null;
    }
    if (cursor.revision === current.revision) return [];
    const size = this.requireDatabase()
      .prepare(
        "SELECT COALESCE(SUM(length(patch)), 0) AS bytes FROM projection_events WHERE epoch = ? AND revision > ?",
      )
      .get(current.epoch, cursor.revision) as { bytes: number };
    if (size.bytes > MAX_REPLAY_PATCH_BYTES) return null;
    const first = this.requireDatabase()
      .prepare("SELECT MIN(revision) AS revision FROM projection_events WHERE epoch = ?")
      .get(current.epoch) as { revision: number | null };
    if (first.revision === null || cursor.revision + 1 < first.revision) return null;
    const rows = this.requireDatabase()
      .prepare(
        "SELECT epoch, revision, created_at AS createdAt, patch FROM projection_events WHERE epoch = ? AND revision > ? ORDER BY revision ASC",
      )
      .all(current.epoch, cursor.revision) as Array<{
      epoch: string;
      revision: number;
      createdAt: number;
      patch: string;
    }>;
    if (rows.length !== current.revision - cursor.revision) return null;
    return rows.map((row) => ({ ...row, patch: JSON.parse(row.patch) as T }));
  }

  saveThreadProjection(threadId: string, detail: ThreadDetail): void {
    const database = this.requireDatabase();
    const previous = this.threadProjection<ThreadDetail>(threadId);
    writeThreadProjection(database, threadId, mergeThreadProjection(previous, detail));
    database.prepare("DELETE FROM metadata WHERE key = ?").run(threadTombstoneKey(threadId));
  }

  saveThreadItems(threadId: string, turnId: string, items: ActivityItem[]): void {
    const detail = this.threadProjection<ThreadDetail>(threadId);
    if (!detail) return;
    const turn = detail.turns.find((candidate) => candidate.id === turnId);
    if (!turn) return;
    turn.items = structuredClone(items);
    turn.itemsLoaded = true;
    writeThreadProjection(this.requireDatabase(), threadId, detail);
  }

  threadProjection<T = unknown>(threadId: string): T | null {
    const row = this.requireDatabase()
      .prepare("SELECT detail FROM thread_projections WHERE thread_id = ?")
      .get(threadId) as { detail: string } | undefined;
    return row ? (JSON.parse(row.detail) as T) : null;
  }

  acceptCommand<T>(
    receipt: Omit<CommandReceipt<T>, "status" | "result" | "createdAt" | "updatedAt">,
  ): {
    receipt: CommandReceipt<T>;
    accepted: boolean;
  } {
    const database = this.requireDatabase();
    const existing = this.commandReceipt<T>(receipt.commandId);
    if (existing) return { receipt: existing, accepted: false };
    const now = Date.now();
    database
      .prepare(
        "INSERT INTO command_receipts (command_id, kind, status, thread_id, turn_id, expected_thread_id, expected_revision, payload, result, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, NULL, ?, ?)",
      )
      .run(
        receipt.commandId,
        receipt.kind,
        receipt.threadId,
        receipt.turnId,
        receipt.expectedThreadId,
        receipt.expectedRevision,
        JSON.stringify(receipt.payload),
        now,
        now,
      );
    database
      .prepare(
        "DELETE FROM command_receipts WHERE status != 'pending' AND updated_at < ? AND command_id NOT IN (SELECT command_id FROM command_receipts ORDER BY updated_at DESC LIMIT ?)",
      )
      .run(now - RECEIPT_RETENTION_MS, RECEIPT_RETENTION_COUNT);
    return {
      accepted: true,
      receipt: { ...receipt, status: "pending", result: null, createdAt: now, updatedAt: now },
    };
  }

  commandReceipt<T = unknown>(commandId: string): CommandReceipt<T> | null {
    const row = this.requireDatabase()
      .prepare(
        "SELECT command_id AS commandId, kind, status, thread_id AS threadId, turn_id AS turnId, expected_thread_id AS expectedThreadId, expected_revision AS expectedRevision, payload, result, created_at AS createdAt, updated_at AS updatedAt FROM command_receipts WHERE command_id = ?",
      )
      .get(commandId) as
      | (Omit<CommandReceipt<T>, "payload" | "result"> & {
          payload: string;
          result: string | null;
        })
      | undefined;
    return row
      ? {
          ...row,
          payload: JSON.parse(row.payload) as T,
          result: row.result === null ? null : (JSON.parse(row.result) as unknown),
        }
      : null;
  }

  finishCommand(
    commandId: string,
    status: Exclude<CommandReceiptStatus, "pending">,
    result: unknown,
  ): void {
    const changed = this.requireDatabase()
      .prepare(
        "UPDATE command_receipts SET status = ?, result = ?, updated_at = ? WHERE command_id = ?",
      )
      .run(status, JSON.stringify(result ?? null), Date.now(), commandId);
    if (changed.changes !== 1) throw new Error(`Unknown command receipt: ${commandId}`);
  }

  pendingCommands<T = unknown>(): CommandReceipt<T>[] {
    const ids = this.requireDatabase()
      .prepare(
        "SELECT command_id AS commandId FROM command_receipts WHERE status = 'pending' ORDER BY created_at ASC",
      )
      .all() as Array<{ commandId: string }>;
    return ids.map(({ commandId }) => this.commandReceipt<T>(commandId)!);
  }

  setProjectionQueueDepth(depth: number): void {
    this.requireDatabase()
      .prepare("UPDATE projection_meta SET projection_queue_depth = ? WHERE id = 1")
      .run(Math.max(0, depth));
  }

  markReconciled(at = Date.now()): void {
    this.requireDatabase()
      .prepare("UPDATE projection_meta SET last_reconciled_at = ? WHERE id = 1")
      .run(at);
  }

  markProjectionSent(committedAt: number, sentAt = Date.now()): void {
    this.requireDatabase()
      .prepare("UPDATE projection_meta SET last_commit_to_send_ms = ? WHERE id = 1")
      .run(Math.max(0, sentAt - committedAt));
  }

  diagnostics(now = Date.now()): ProjectionDiagnostics {
    const row = this.requireDatabase()
      .prepare(
        "SELECT epoch, revision, last_event_at AS lastEventAt, last_reconciled_at AS lastReconciledAt, projection_queue_depth AS projectionQueueDepth, last_receive_to_commit_ms AS lastReceiveToCommitMs, last_commit_to_send_ms AS lastCommitToSendMs FROM projection_meta WHERE id = 1",
      )
      .get() as Omit<ProjectionDiagnostics, "oldestPendingCommandAgeMs">;
    const oldest = this.requireDatabase()
      .prepare("SELECT MIN(created_at) AS createdAt FROM command_receipts WHERE status = 'pending'")
      .get() as { createdAt: number | null };
    return {
      ...row,
      oldestPendingCommandAgeMs:
        oldest.createdAt === null ? null : Math.max(0, now - oldest.createdAt),
    };
  }

  close(): void {
    this.database?.close();
    this.database = null;
    this.loaded = false;
  }

  private async persist(next: CodexNestState): Promise<void> {
    this.requireDatabase()
      .prepare("UPDATE app_state SET json = ?, updated_at = ? WHERE id = 1")
      .run(JSON.stringify(next), Date.now());
  }

  private requireDatabase(): DatabaseSync {
    if (!this.database) throw new Error("StateStore.load() must be called first");
    return this.database;
  }

  private transaction<T>(callback: () => T): T {
    const database = this.requireDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  private createSchema(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS app_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS projection_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        epoch TEXT NOT NULL,
        revision INTEGER NOT NULL,
        last_event_at INTEGER,
        last_reconciled_at INTEGER,
        projection_queue_depth INTEGER NOT NULL DEFAULT 0,
        last_receive_to_commit_ms INTEGER,
        last_commit_to_send_ms INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS projection_snapshot (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        snapshot TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS thread_projections (
        thread_id TEXT PRIMARY KEY,
        detail TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS projection_events (
        epoch TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        patch TEXT NOT NULL,
        PRIMARY KEY (epoch, revision)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS projection_events_created_at
        ON projection_events(created_at);
      CREATE TABLE IF NOT EXISTS command_receipts (
        command_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'noop', 'conflict', 'failed')),
        thread_id TEXT,
        turn_id TEXT,
        expected_thread_id TEXT,
        expected_revision INTEGER,
        payload TEXT NOT NULL,
        result TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS command_receipts_status_created
        ON command_receipts(status, created_at);
    `);
    const receiptColumns = database.prepare("PRAGMA table_info(command_receipts)").all() as Array<{
      name: string;
    }>;
    if (!receiptColumns.some((column) => column.name === "expected_thread_id")) {
      database.exec("ALTER TABLE command_receipts ADD COLUMN expected_thread_id TEXT");
    }
    database
      .prepare(
        "INSERT OR IGNORE INTO projection_meta (id, epoch, revision, projection_queue_depth) VALUES (1, ?, 0, 0)",
      )
      .run(randomUUID());
  }

  private configureDatabase(database: DatabaseSync): void {
    database.exec("PRAGMA busy_timeout = 5000");
    const journal = database.prepare("PRAGMA journal_mode = WAL").get() as
      { journal_mode: string } | undefined;
    if (journal?.journal_mode.toLowerCase() !== "wal") {
      throw new Error("CodexNest SQLite state requires WAL journal mode");
    }
    database.exec("PRAGMA synchronous = FULL");
    database.exec("PRAGMA foreign_keys = ON");
  }

  private async migrateLegacyState(legacy: {
    source: string;
    state: CodexNestState;
  }): Promise<void> {
    const parent = dirname(this.path);
    const backup = await durableLegacyBackup(legacy.source);
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.migration.sqlite`;
    let database: DatabaseSync | null = null;
    try {
      database = new DatabaseSync(temporary);
      this.configureDatabase(database);
      this.createSchema(database);
      transactionOn(database, () => {
        database!
          .prepare("INSERT INTO app_state (id, json, updated_at) VALUES (1, ?, ?)")
          .run(JSON.stringify(legacy.state), Date.now());
        database!
          .prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('legacy_import', ?)")
          .run(backup);
      });
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      database.close();
      database = null;
      await chmod(temporary, 0o600);
      await syncFile(temporary);
      await rename(temporary, this.path);
      await syncDirectory(parent);
    } catch (error) {
      database?.close();
      await removeMigrationFiles(temporary);
      throw error;
    }
  }

  private async readLegacyState(): Promise<{ source: string; state: CodexNestState } | null> {
    const candidates = [this.path];
    if (extname(this.path) === ".sqlite") {
      candidates.push(join(dirname(this.path), `${basename(this.path, ".sqlite")}.json`));
    }
    for (const candidate of candidates) {
      let contents: Buffer;
      try {
        contents = await readFile(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (contents.subarray(0, SQLITE_HEADER.length).toString("binary") === SQLITE_HEADER) {
        if (candidate === this.path) return null;
        throw new Error(`Refusing to ignore sibling SQLite state: ${candidate}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(contents.toString("utf8"));
      } catch {
        throw new Error(`Invalid legacy CodexNest JSON state: ${candidate}`);
      }
      return { source: candidate, state: validateState(parsed) };
    }
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function sqliteTableExists(database: DatabaseSync, table: string): boolean {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

function transactionOn<T>(database: DatabaseSync, callback: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

async function durableLegacyBackup(source: string): Promise<string> {
  const backup = await availableLegacyBackupPath(source);
  try {
    await copyFile(source, backup, constants.COPYFILE_EXCL);
    await chmod(backup, 0o600);
    await syncFile(backup);
    await syncDirectory(dirname(source));
    return backup;
  } catch (error) {
    await unlink(backup).catch(() => undefined);
    throw error;
  }
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeMigrationFiles(path: string): Promise<void> {
  await Promise.all(
    [path, `${path}-wal`, `${path}-shm`].map((candidate) =>
      unlink(candidate).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }),
    ),
  );
}

async function availableLegacyBackupPath(path: string): Promise<string> {
  const base = `${path}.pre-sqlite.json`;
  for (let suffix = 0; ; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}.${suffix}`;
    try {
      await readFile(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidate;
      throw error;
    }
  }
}

function withProjectionCursor<T>(snapshot: T, epoch: string, revision: number): T {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return snapshot;
  return { ...snapshot, epoch, revision };
}

function pruneStateReceipts(state: CodexNestState, now: number): void {
  pruneReceiptMap(state.messageReceipts, now);
  pruneReceiptMap(state.voiceReceipts, now);
}

function pruneReceiptMap<T extends { createdAt: number }>(
  receipts: Record<string, T> | undefined,
  now: number,
): void {
  if (!receipts || Object.keys(receipts).length <= RECEIPT_RETENTION_COUNT) return;
  const retained = new Set(
    Object.entries(receipts)
      .sort(([, left], [, right]) => right.createdAt - left.createdAt)
      .slice(0, RECEIPT_RETENTION_COUNT)
      .map(([id]) => id),
  );
  const cutoff = now - RECEIPT_RETENTION_MS;
  for (const [id, receipt] of Object.entries(receipts)) {
    if (!retained.has(id) && receipt.createdAt < cutoff) delete receipts[id];
  }
}

function reduceThreadProjection(database: DatabaseSync, value: unknown): void {
  if (!isRecord(value) || typeof value.type !== "string") return;
  const event = value as ServerEvent;
  if (event.type === "projection.replaced") {
    const summaries = new Map(event.snapshot.threads.map((thread) => [thread.id, thread]));
    const rows = database
      .prepare("SELECT thread_id AS threadId, detail FROM thread_projections")
      .all() as Array<{ threadId: string; detail: string }>;
    for (const row of rows) {
      const summary = summaries.get(row.threadId);
      if (!summary) {
        database.prepare("DELETE FROM thread_projections WHERE thread_id = ?").run(row.threadId);
        database
          .prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)")
          .run(threadTombstoneKey(row.threadId), String(Date.now()));
        continue;
      }
      const detail = JSON.parse(row.detail) as ThreadDetail;
      detail.summary = summary;
      detail.turns = detail.turns.slice(-20);
      writeThreadProjection(database, row.threadId, detail);
    }
    for (const threadId of summaries.keys()) {
      database.prepare("DELETE FROM metadata WHERE key = ?").run(threadTombstoneKey(threadId));
    }
    return;
  }
  if (event.type === "thread.removed") {
    database.prepare("DELETE FROM thread_projections WHERE thread_id = ?").run(event.threadId);
    database
      .prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)")
      .run(threadTombstoneKey(event.threadId), String(Date.now()));
    return;
  }
  const threadId = projectionEventThreadId(event);
  if (!threadId) return;
  const row = database
    .prepare("SELECT detail FROM thread_projections WHERE thread_id = ?")
    .get(threadId) as { detail: string } | undefined;
  let detail = row ? (JSON.parse(row.detail) as ThreadDetail) : null;
  if (!detail && event.type === "thread.upserted") {
    const tombstone = database
      .prepare("SELECT 1 FROM metadata WHERE key = ?")
      .get(threadTombstoneKey(event.thread.id));
    if (tombstone) return;
    detail = {
      summary: event.thread,
      turns: [],
      queuedMessages: [],
      olderTurnsCursor: null,
      draft: null,
    };
  }
  if (!detail) return;
  switch (event.type) {
    case "thread.upserted":
      detail.summary = event.thread;
      if (!event.thread.currentTurnId) {
        const active = detail.turns.find((turn) => turn.status === "inProgress");
        if (active) {
          active.status =
            event.thread.state === "failed"
              ? "failed"
              : event.thread.state === "interrupted"
                ? "interrupted"
                : "completed";
          active.completedAt ??= event.thread.updatedAt;
        }
      }
      break;
    case "activity.upserted": {
      const turn = materializedTurn(detail, event.turnId);
      if (!turn) return;
      const index = turn.items.findIndex((item) => item.id === event.item.id);
      if (index < 0) turn.items.push(event.item);
      else turn.items[index] = event.item;
      break;
    }
    case "turn.progressed": {
      const turn = materializedTurn(detail, event.turnId);
      if (!turn) return;
      turn.progress = event.progress;
      break;
    }
    case "queue.changed":
      detail.queuedMessages = event.messages;
      break;
    case "draft.changed":
      detail.draft = event.draft;
      break;
    default:
      return;
  }
  detail.turns = detail.turns.slice(-20);
  writeThreadProjection(database, threadId, detail);
}

function projectionEventThreadId(event: ServerEvent): string | null {
  if (event.type === "thread.upserted") return event.thread.id;
  if ("threadId" in event && typeof event.threadId === "string") return event.threadId;
  return null;
}

function materializedTurn(
  detail: ThreadDetail,
  turnId: string,
): ThreadDetail["turns"][number] | null {
  const existing = detail.turns.find((candidate) => candidate.id === turnId);
  if (existing) return existing;
  if (detail.summary.currentTurnId !== turnId) return null;
  const turn: ThreadDetail["turns"][number] = {
    id: turnId,
    status: "inProgress",
    startedAt: null,
    completedAt: null,
    durationMs: null,
    progress: {
      startedAt: null,
      explanation: null,
      steps: [],
      filesChanged: 0,
      additions: 0,
      deletions: 0,
    },
    items: [],
    itemsLoaded: false,
  };
  detail.turns.push(turn);
  return turn;
}

function mergeThreadProjection(
  previous: ThreadDetail | null,
  incoming: ThreadDetail,
): ThreadDetail {
  const previousTurns = new Map(previous?.turns.map((turn) => [turn.id, turn]) ?? []);
  const turns = incoming.turns.slice(-20).map((turn) => {
    const persisted = previousTurns.get(turn.id);
    if (turn.itemsLoaded !== false || !persisted || persisted.itemsLoaded === false) {
      return structuredClone(turn);
    }
    const items = structuredClone(persisted.items);
    for (const item of turn.items) {
      const index = items.findIndex((candidate) => candidate.id === item.id);
      if (index < 0) items.push(structuredClone(item));
      else items[index] = structuredClone(item);
    }
    return { ...structuredClone(turn), items, itemsLoaded: true };
  });
  return { ...structuredClone(incoming), turns };
}

function writeThreadProjection(
  database: DatabaseSync,
  threadId: string,
  detail: ThreadDetail,
): void {
  const trimmed = { ...detail, turns: detail.turns.slice(-20) };
  database
    .prepare(
      "INSERT INTO thread_projections (thread_id, detail, updated_at) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET detail = excluded.detail, updated_at = excluded.updated_at",
    )
    .run(threadId, JSON.stringify(trimmed), Date.now());
}

function threadTombstoneKey(threadId: string): string {
  return `thread_tombstone:${threadId}`;
}

function validateState(value: unknown): CodexNestState {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Unsupported or corrupt CodexNest state schema");
  }
  if (!isRecord(value.auth) || !Array.isArray(value.projects)) {
    throw new Error("Corrupt CodexNest state");
  }
  if (
    value.dismissedProjectPaths !== undefined &&
    (!Array.isArray(value.dismissedProjectPaths) ||
      value.dismissedProjectPaths.some(
        (path) => typeof path !== "string" || !path.trim() || !isAbsolute(path),
      ))
  ) {
    throw new Error("Corrupt dismissed project paths in CodexNest state");
  }
  if (!isRecord(value.threadMeta) || !isRecord(value.devices)) {
    throw new Error("Corrupt CodexNest state");
  }
  const transcriptionTimings = normalizeTranscriptionTimings(value.transcriptionTimings);
  if (value.messageQueues !== undefined && !isRecord(value.messageQueues)) {
    throw new Error("Corrupt message queues in CodexNest state");
  }
  if (value.messageReceipts !== undefined && !isRecord(value.messageReceipts)) {
    throw new Error("Corrupt message receipts in CodexNest state");
  }
  if (value.teamToolOperations !== undefined && !isRecord(value.teamToolOperations)) {
    throw new Error("Corrupt Team tool operations in CodexNest state");
  }
  if (value.voiceTranscriptions !== undefined && !isRecord(value.voiceTranscriptions)) {
    throw new Error("Corrupt voice transcriptions in CodexNest state");
  }
  if (value.voiceReceipts !== undefined && !isRecord(value.voiceReceipts)) {
    throw new Error("Corrupt voice receipts in CodexNest state");
  }
  if (
    value.defaultReasoningEffort !== undefined &&
    (typeof value.defaultReasoningEffort !== "string" || !value.defaultReasoningEffort.trim())
  ) {
    throw new Error("Corrupt default reasoning effort in CodexNest state");
  }
  if (value.taskDefaults !== undefined && !isTaskDefaults(value.taskDefaults)) {
    throw new Error("Corrupt task defaults in CodexNest state");
  }
  if (
    value.uiLanguage !== undefined &&
    (typeof value.uiLanguage !== "string" || !["en", "ru"].includes(value.uiLanguage))
  ) {
    throw new Error("Corrupt UI language in CodexNest state");
  }
  for (const project of value.projects) {
    if (!isProject(project)) throw new Error("Corrupt project in CodexNest state");
  }
  for (const meta of Object.values(value.threadMeta)) {
    if (isRecord(meta) && isLegacyTeamOrchestrationState(meta.teamOrchestration)) {
      delete meta.teamOrchestration;
    }
    if (
      !isRecord(meta) ||
      typeof meta.pinned !== "boolean" ||
      typeof meta.lastReadUpdatedAt !== "number" ||
      (meta.lastViewedUpdatedAt !== undefined && typeof meta.lastViewedUpdatedAt !== "number") ||
      (meta.lastOutcome !== undefined &&
        !["completed", "failed", "interrupted"].includes(String(meta.lastOutcome))) ||
      (meta.outcomeUpdatedAt !== undefined && typeof meta.outcomeUpdatedAt !== "number") ||
      (meta.settings !== undefined && !isSessionSettings(meta.settings)) ||
      (meta.inheritCodexSettings !== undefined && typeof meta.inheritCodexSettings !== "boolean") ||
      (meta.awaitingPlanResponse !== undefined && typeof meta.awaitingPlanResponse !== "boolean") ||
      (meta.timelineArtifacts !== undefined && !isTimelineArtifacts(meta.timelineArtifacts)) ||
      (meta.teamOrchestration !== undefined && !isTeamOrchestrationState(meta.teamOrchestration)) ||
      (meta.teamToolsVersion !== undefined &&
        meta.teamToolsVersion !== 1 &&
        meta.teamToolsVersion !== 2) ||
      (meta.managedParent !== undefined && !isManagedParent(meta.managedParent)) ||
      (meta.unmaterialized !== undefined && typeof meta.unmaterialized !== "boolean") ||
      (meta.draft !== undefined && !isThreadDraft(meta.draft))
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
  for (const receipt of Object.values(value.messageReceipts ?? {})) {
    if (
      !isRecord(receipt) ||
      typeof receipt.threadId !== "string" ||
      (receipt.turnId !== null && typeof receipt.turnId !== "string") ||
      typeof receipt.contentHash !== "string" ||
      !/^[a-f\d]{64}$/iu.test(receipt.contentHash) ||
      typeof receipt.createdAt !== "number"
    ) {
      throw new Error("Corrupt message receipt");
    }
  }
  for (const operation of Object.values(value.teamToolOperations ?? {})) {
    if (!isTeamToolOperation(operation)) {
      throw new Error("Corrupt Team tool operation");
    }
  }
  for (const [threadId, job] of Object.entries(value.voiceTranscriptions ?? {})) {
    if (!isVoiceTranscription(job, threadId)) {
      throw new Error("Corrupt voice transcription in CodexNest state");
    }
  }
  for (const receipt of Object.values(value.voiceReceipts ?? {})) {
    if (
      !isRecord(receipt) ||
      typeof receipt.threadId !== "string" ||
      typeof receipt.createdAt !== "number"
    ) {
      throw new Error("Corrupt voice receipt");
    }
  }
  const verifier = value.auth.tokenSha256;
  if (
    verifier !== undefined &&
    (typeof verifier !== "string" || !/^[a-f\d]{64}$/i.test(verifier))
  ) {
    throw new Error("Corrupt token verifier in CodexNest state");
  }
  const state = value as unknown as CodexNestState;
  return {
    ...state,
    ...(transcriptionTimings === undefined ? {} : { transcriptionTimings }),
    ...(value.uiLanguage === undefined ? { uiLanguage: "ru" as const } : {}),
  };
}

function normalizeTranscriptionTimings(
  value: unknown,
): Record<string, TranscriptionTimingSampleState[]> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Corrupt transcription timings in CodexNest state");

  const normalized: Record<string, TranscriptionTimingSampleState[]> = {};
  for (const [profile, samples] of Object.entries(value)) {
    if (!Array.isArray(samples) || samples.length > 20) {
      throw new Error("Corrupt transcription timings in CodexNest state");
    }
    normalized[profile] = samples.flatMap((sample) => {
      if (typeof sample === "number" && Number.isFinite(sample) && sample > 0) return [];
      if (
        !isRecord(sample) ||
        typeof sample.audioDurationMs !== "number" ||
        !Number.isFinite(sample.audioDurationMs) ||
        sample.audioDurationMs <= 0 ||
        typeof sample.processingMs !== "number" ||
        !Number.isFinite(sample.processingMs) ||
        sample.processingMs <= 0
      ) {
        throw new Error("Corrupt transcription timings in CodexNest state");
      }
      return [
        {
          audioDurationMs: sample.audioDurationMs,
          processingMs: sample.processingMs,
        },
      ];
    });
  }
  return normalized;
}

function isTimelineArtifacts(value: unknown): value is Record<string, TimelineArtifact[]> {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (items) => Array.isArray(items) && items.every(isTimelineArtifact),
  );
}

function isTimelineArtifact(value: unknown): value is TimelineArtifact {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.timestamp !== "number" ||
    (value.afterItemId !== null && typeof value.afterItemId !== "string")
  ) {
    return false;
  }
  if (value.type === "userInputResponse") {
    return (
      value.status === "completed" &&
      Array.isArray(value.entries) &&
      value.entries.every(
        (entry) =>
          isRecord(entry) &&
          typeof entry.header === "string" &&
          typeof entry.question === "string" &&
          Array.isArray(entry.answers) &&
          entry.answers.every((answer) => typeof answer === "string"),
      )
    );
  }
  if (value.type === "planChecklist") {
    return (
      ["inProgress", "completed", "failed"].includes(String(value.status)) &&
      (value.explanation === null || typeof value.explanation === "string") &&
      Array.isArray(value.steps) &&
      value.steps.every(
        (step) =>
          isRecord(step) &&
          typeof step.step === "string" &&
          ["pending", "inProgress", "completed"].includes(String(step.status)),
      )
    );
  }
  if (value.type === "orchestrationNotice") {
    return (
      value.status === "completed" &&
      Array.isArray(value.agents) &&
      value.agents.length > 0 &&
      value.agents.every(
        (agent) =>
          isRecord(agent) &&
          typeof agent.threadId === "string" &&
          typeof agent.title === "string" &&
          (agent.nickname === null || typeof agent.nickname === "string") &&
          ["completed", "failed", "interrupted"].includes(String(agent.outcome)),
      )
    );
  }
  return false;
}

function isTeamOrchestrationState(value: unknown): value is TeamOrchestrationState {
  if (!isRecord(value) || !isRecord(value.tasks)) return false;
  if (
    !Object.entries(value.tasks).every(
      ([taskId, task]) => isManagedTeamTaskState(task) && task.id === taskId,
    )
  ) {
    return false;
  }

  const tasks = value.tasks as Record<string, ManagedTeamTaskState>;
  for (const task of Object.values(tasks)) {
    const references = [
      ...(task.dependsOn ?? []),
      ...(task.predecessorTaskId ? [task.predecessorTaskId] : []),
    ];
    if (references.some((taskId) => taskId === task.id || tasks[taskId] === undefined))
      return false;
    if (task.predecessorTaskId && tasks[task.predecessorTaskId]!.createdAt > task.createdAt) {
      return false;
    }
  }
  return !hasManagedTaskReferenceCycle(tasks);
}

function isManagedTeamTaskState(value: unknown): value is ManagedTeamTaskState {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.childThreadId !== "string" ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    typeof value.prompt !== "string" ||
    !value.prompt.trim() ||
    !["queued", "starting", "running", "completed", "failed", "interrupted"].includes(
      String(value.status),
    ) ||
    typeof value.createdAt !== "number" ||
    typeof value.lastActivityAt !== "number" ||
    (value.startedAt !== undefined && typeof value.startedAt !== "number") ||
    (value.expectedWakeAt !== undefined &&
      (typeof value.expectedWakeAt !== "number" || !Number.isFinite(value.expectedWakeAt))) ||
    (value.recoveryMisses !== undefined &&
      (typeof value.recoveryMisses !== "number" ||
        !Number.isInteger(value.recoveryMisses) ||
        value.recoveryMisses < 0)) ||
    (value.lastWatchdogAt !== undefined && typeof value.lastWatchdogAt !== "number") ||
    (value.watchdog !== undefined && !isManagedWatchdog(value.watchdog)) ||
    (value.childThreadSource !== undefined && typeof value.childThreadSource !== "string") ||
    (value.childTurnId !== undefined && typeof value.childTurnId !== "string") ||
    (value.startMessageId !== undefined && typeof value.startMessageId !== "string") ||
    (value.terminalTurnId !== undefined && typeof value.terminalTurnId !== "string") ||
    (value.dependsOn !== undefined && !isManagedTaskReferences(value.dependsOn)) ||
    (value.predecessorTaskId !== undefined && !isBoundedString(value.predecessorTaskId, 200)) ||
    (value.access !== undefined && !isManagedTaskAccess(value.access)) ||
    (value.resolvedModel !== undefined && !isBoundedString(value.resolvedModel, 200)) ||
    (value.resolvedReasoningEffort !== undefined &&
      value.resolvedReasoningEffort !== null &&
      !isBoundedString(value.resolvedReasoningEffort, 200)) ||
    (value.resolvedServiceTier !== undefined &&
      value.resolvedServiceTier !== null &&
      !isBoundedString(value.resolvedServiceTier, 200)) ||
    (value.timeoutMinutes !== undefined &&
      (typeof value.timeoutMinutes !== "number" ||
        !Number.isSafeInteger(value.timeoutMinutes) ||
        value.timeoutMinutes < 1 ||
        value.timeoutMinutes > 1_440)) ||
    (value.tokenBudget !== undefined &&
      (typeof value.tokenBudget !== "number" ||
        !Number.isSafeInteger(value.tokenBudget) ||
        value.tokenBudget < 1 ||
        value.tokenBudget > 10_000_000)) ||
    (value.tokensUsed !== undefined &&
      (typeof value.tokensUsed !== "number" ||
        !Number.isSafeInteger(value.tokensUsed) ||
        value.tokensUsed < 0)) ||
    (value.timeUsedSeconds !== undefined && !isNonNegativeFiniteNumber(value.timeUsedSeconds)) ||
    (value.failureReason !== undefined && !isBoundedString(value.failureReason, 2_000)) ||
    (value.budgetReason !== undefined &&
      !["timeout", "tokenBudget"].includes(String(value.budgetReason))) ||
    (value.workspace !== undefined && !isManagedTaskWorkspace(value.workspace)) ||
    (value.resultCandidate !== undefined && !isManagedResultCandidate(value.resultCandidate)) ||
    (value.result !== undefined && !isManagedResult(value.result))
  ) {
    return false;
  }
  return value.delivery === undefined || isManagedDelivery(value.delivery);
}

function isManagedDelivery(value: unknown): boolean {
  return (
    isRecord(value) &&
    ["claimed", "delivered"].includes(String(value.status)) &&
    typeof value.claimId === "string" &&
    (value.parentTurnId === undefined || typeof value.parentTurnId === "string") &&
    (value.markerId === undefined || typeof value.markerId === "string") &&
    (value.dispatchStartedAt === undefined || typeof value.dispatchStartedAt === "number") &&
    (value.contextHash === undefined ||
      (typeof value.contextHash === "string" && /^[a-f\d]{64}$/iu.test(value.contextHash)))
  );
}

function isManagedTaskReferences(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 50 &&
    value.every((taskId) => isBoundedString(taskId, 200)) &&
    new Set(value).size === value.length
  );
}

function hasManagedTaskReferenceCycle(tasks: Record<string, ManagedTeamTaskState>): boolean {
  const states = new Map<string, "visiting" | "visited">();
  for (const taskId of Object.keys(tasks)) {
    if (states.has(taskId)) continue;
    const stack: Array<{ taskId: string; references: string[]; index: number }> = [
      { taskId, references: managedTaskReferences(tasks[taskId]!), index: 0 },
    ];
    states.set(taskId, "visiting");
    while (stack.length) {
      const current = stack.at(-1)!;
      const reference = current.references[current.index++];
      if (reference === undefined) {
        states.set(current.taskId, "visited");
        stack.pop();
        continue;
      }
      if (states.get(reference) === "visiting") return true;
      if (states.get(reference) === "visited") continue;
      states.set(reference, "visiting");
      stack.push({
        taskId: reference,
        references: managedTaskReferences(tasks[reference]!),
        index: 0,
      });
    }
  }
  return false;
}

function managedTaskReferences(task: ManagedTeamTaskState): string[] {
  return [...(task.dependsOn ?? []), ...(task.predecessorTaskId ? [task.predecessorTaskId] : [])];
}

function isManagedTaskAccess(value: unknown): value is ManagedTeamTaskAccessState {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["mode", "writePaths", "network"]) ||
    !["readOnly", "isolatedWrite", "sharedWrite"].includes(String(value.mode)) ||
    (value.network !== undefined && typeof value.network !== "boolean")
  ) {
    return false;
  }
  const writePaths = value.writePaths;
  if (
    writePaths !== undefined &&
    (!isSafeRelativePathList(writePaths, 100) || !writePaths.every(isSafeManagedWritePath))
  )
    return false;
  if (value.mode === "readOnly") return writePaths === undefined || writePaths.length === 0;
  return Array.isArray(writePaths) && writePaths.length > 0;
}

function isManagedTaskWorkspace(value: unknown): value is ManagedTeamTaskWorkspaceState {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "lifecycle",
      "repositoryRoot",
      "gitCommonDir",
      "worktreePath",
      "head",
      "baseline",
      "createdAt",
      "updatedAt",
      "changedPaths",
      "conflictPaths",
      "error",
    ]) ||
    ![
      "creating",
      "ready",
      "integrating",
      "integrated",
      "discarding",
      "discarded",
      "conflicted",
      "recoveryRequired",
    ].includes(String(value.lifecycle)) ||
    !isSafeAbsolutePath(value.repositoryRoot) ||
    !isSafeAbsolutePath(value.gitCommonDir) ||
    !isSafeAbsolutePath(value.worktreePath) ||
    !isPathInside(value.gitCommonDir, value.worktreePath) ||
    typeof value.head !== "string" ||
    !/^[a-f\d]{40}(?:[a-f\d]{24})?$/iu.test(value.head) ||
    !isWorkspaceBaseline(value.baseline) ||
    !isNonNegativeFiniteNumber(value.createdAt) ||
    !isNonNegativeFiniteNumber(value.updatedAt) ||
    value.updatedAt < value.createdAt ||
    (value.changedPaths !== undefined && !isSafeRelativePathList(value.changedPaths, 10_000)) ||
    (value.conflictPaths !== undefined && !isSafeRelativePathList(value.conflictPaths, 10_000)) ||
    (value.error !== undefined && !isBoundedString(value.error, 4_000))
  ) {
    return false;
  }
  return true;
}

function isWorkspaceBaseline(
  value: unknown,
): value is Record<string, ManagedTeamTaskWorkspaceFileState> {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 50_000 &&
    entries.reduce((length, [path]) => length + path.length, 0) <= 5_000_000 &&
    entries.every(([path, entry]) => isSafeRelativePath(path) && isWorkspaceFileState(entry))
  );
}

function isWorkspaceFileState(value: unknown): value is ManagedTeamTaskWorkspaceFileState {
  if (!isRecord(value)) return false;
  if (value.type === "file") {
    return (
      hasOnlyKeys(value, ["type", "mode", "digest"]) &&
      Number.isInteger(value.mode) &&
      Number(value.mode) >= 0 &&
      Number(value.mode) <= 0o777 &&
      typeof value.digest === "string" &&
      /^[a-f\d]{64}$/iu.test(value.digest)
    );
  }
  return (
    value.type === "symlink" &&
    hasOnlyKeys(value, ["type", "target"]) &&
    isBoundedString(value.target, 4_096) &&
    !value.target.includes("\0")
  );
}

function isSafeRelativePathList(value: unknown, maximum: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every(isSafeRelativePath) &&
    new Set(value).size === value.length
  );
}

function isSafeRelativePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 4_096 ||
    value.includes("\0") ||
    value.includes("\\") ||
    isAbsolute(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) => Boolean(segment) && segment !== "." && segment !== "..");
}

function isSafeManagedWritePath(value: string): boolean {
  return value.split("/").every((segment) => segment.toLowerCase() !== ".git");
}

function isSafeAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 1 &&
    value.length <= 4_096 &&
    !value.includes("\0") &&
    isAbsolute(value) &&
    normalize(value) === value &&
    dirname(value) !== value
  );
}

function isPathInside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return isSafeRelativePath(child);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= maximum;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isTeamToolOperation(value: unknown): value is TeamToolOperationState {
  if (
    !isRecord(value) ||
    typeof value.threadId !== "string" ||
    typeof value.turnId !== "string" ||
    typeof value.callId !== "string" ||
    ![
      "spawn_task",
      "followup_task",
      "steer_task",
      "cancel_task",
      "submit_result",
      "integrate_task",
      "discard_task_changes",
    ].includes(String(value.tool)) ||
    typeof value.argumentsHash !== "string" ||
    !/^[a-f\d]{64}$/iu.test(value.argumentsHash) ||
    !["prepared", "applied"].includes(String(value.status)) ||
    typeof value.createdAt !== "number" ||
    typeof value.updatedAt !== "number" ||
    (value.taskId !== undefined && typeof value.taskId !== "string") ||
    (value.childThreadSource !== undefined && typeof value.childThreadSource !== "string")
  ) {
    return false;
  }
  if (value.response === undefined) return value.status === "prepared";
  return (
    value.status === "applied" &&
    isRecord(value.response) &&
    typeof value.response.success === "boolean" &&
    Array.isArray(value.response.contentItems) &&
    value.response.contentItems.every(
      (item) =>
        isRecord(item) &&
        ((item.type === "inputText" && typeof item.text === "string") ||
          (item.type === "inputImage" && typeof item.imageUrl === "string")),
    )
  );
}

function isLegacyTeamOrchestrationState(value: unknown): boolean {
  return isRecord(value) && isRecord(value.children) && value.tasks === undefined;
}

function isManagedParent(value: unknown): boolean {
  return (
    isRecord(value) && typeof value.parentThreadId === "string" && typeof value.taskId === "string"
  );
}

function isManagedResultCandidate(value: unknown): value is ManagedTeamTaskResultCandidate {
  return (
    isRecord(value) &&
    typeof value.summary === "string" &&
    Boolean(value.summary.trim()) &&
    (value.details === undefined || typeof value.details === "string") &&
    typeof value.submittedAt === "number" &&
    typeof value.callId === "string" &&
    isManagedResultFields(value)
  );
}

function isManagedWatchdog(value: unknown): boolean {
  return (
    isRecord(value) &&
    ["pending", "claimed"].includes(String(value.status)) &&
    typeof value.triggeredAt === "number" &&
    (value.claimId === undefined || typeof value.claimId === "string") &&
    (value.status !== "claimed" || typeof value.claimId === "string") &&
    (value.markerId === undefined || typeof value.markerId === "string") &&
    (value.dispatchStartedAt === undefined || typeof value.dispatchStartedAt === "number") &&
    (value.contextHash === undefined ||
      (typeof value.contextHash === "string" && /^[a-f\d]{64}$/iu.test(value.contextHash)))
  );
}

function isManagedResult(value: unknown): value is ManagedTeamTaskResult {
  return (
    isRecord(value) &&
    typeof value.summary === "string" &&
    Boolean(value.summary.trim()) &&
    (value.details === undefined || typeof value.details === "string") &&
    ["submitted", "final_answer", "agent_message", "status"].includes(String(value.source)) &&
    isManagedResultFields(value)
  );
}

function isManagedResultFields(value: Record<string, unknown>): boolean {
  const outcome = value.outcome;
  if (
    outcome !== undefined &&
    !["success", "partial", "blocked", "failed"].includes(String(outcome))
  ) {
    return false;
  }
  if (
    value.checks !== undefined &&
    (!Array.isArray(value.checks) ||
      value.checks.length > 100 ||
      !value.checks.every(isManagedResultCheck))
  ) {
    return false;
  }
  if (
    value.risks !== undefined &&
    (!Array.isArray(value.risks) ||
      value.risks.length > 100 ||
      !value.risks.every((risk) => isBoundedString(risk, 4_000)))
  ) {
    return false;
  }
  if (
    value.artifacts !== undefined &&
    (!Array.isArray(value.artifacts) ||
      value.artifacts.length > 100 ||
      !value.artifacts.every(isManagedResultArtifact))
  ) {
    return false;
  }
  return (
    outcome !== undefined ||
    (value.checks === undefined && value.risks === undefined && value.artifacts === undefined)
  );
}

function isManagedResultCheck(value: unknown): value is ManagedTeamTaskResultCheck {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["name", "outcome", "details"]) &&
    isBoundedString(value.name, 500) &&
    ["passed", "failed", "notRun"].includes(String(value.outcome)) &&
    (value.details === undefined ||
      (typeof value.details === "string" && value.details.length <= 10_000))
  );
}

function isManagedResultArtifact(value: unknown): value is ManagedTeamTaskResultArtifact {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["label", "path", "url"]) &&
    isBoundedString(value.label, 500) &&
    (value.path === undefined || isSafeRelativePath(value.path)) &&
    (value.url === undefined || isSafeArtifactUrl(value.url)) &&
    (value.path !== undefined || value.url !== undefined)
  );
}

function isSafeArtifactUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isQueuedMessage(value: unknown, threadId: string): value is QueuedMessage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.threadId === threadId &&
    typeof value.text === "string" &&
    (value.images === undefined ||
      (Array.isArray(value.images) && value.images.every(isInlineImage))) &&
    (value.goal === undefined || typeof value.goal === "boolean") &&
    (Boolean(value.text.trim()) || (Array.isArray(value.images) && value.images.length > 0)) &&
    typeof value.createdAt === "number" &&
    ["queued", "dispatching"].includes(String(value.status))
  );
}

function isVoiceTranscription(value: unknown, threadId: string): value is VoiceTranscriptionState {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    value.threadId !== threadId ||
    !["draft", "send", "queue", "steer"].includes(String(value.mode)) ||
    !["queued", "transcribing", "applying", "failed"].includes(String(value.status)) ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    (value.startedAt !== null &&
      (typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt))) ||
    typeof value.audioDurationMs !== "number" ||
    !Number.isFinite(value.audioDurationMs) ||
    value.audioDurationMs <= 0 ||
    (value.estimatedTotalSeconds !== null &&
      (typeof value.estimatedTotalSeconds !== "number" ||
        !Number.isFinite(value.estimatedTotalSeconds) ||
        value.estimatedTotalSeconds <= 0)) ||
    (value.error !== null && typeof value.error !== "string") ||
    !["audio/webm", "audio/mp4"].includes(String(value.contentType)) ||
    typeof value.audioBytes !== "number" ||
    !Number.isSafeInteger(value.audioBytes) ||
    value.audioBytes <= 0 ||
    typeof value.selectionStart !== "number" ||
    !Number.isSafeInteger(value.selectionStart) ||
    value.selectionStart < 0 ||
    typeof value.selectionEnd !== "number" ||
    !Number.isSafeInteger(value.selectionEnd) ||
    value.selectionEnd < value.selectionStart ||
    (value.timingProfile !== undefined &&
      (typeof value.timingProfile !== "string" || !value.timingProfile.trim())) ||
    (value.transcript !== undefined &&
      (typeof value.transcript !== "string" || !value.transcript.trim())) ||
    (value.attempts !== undefined &&
      (typeof value.attempts !== "number" ||
        !Number.isSafeInteger(value.attempts) ||
        value.attempts < 0)) ||
    (value.nextAttemptAt !== undefined &&
      (typeof value.nextAttemptAt !== "number" || !Number.isFinite(value.nextAttemptAt)))
  ) {
    return false;
  }
  if (
    value.audioFile !== undefined &&
    (typeof value.audioFile !== "string" ||
      !/^[a-zA-Z0-9._-]+$/.test(value.audioFile) ||
      value.audioFile.includes(".."))
  ) {
    return false;
  }
  return value.status === "failed" || Boolean(value.audioFile) || Boolean(value.transcript);
}

function isTaskDefaults(value: unknown): value is TaskDefaults {
  if (!isRecord(value)) return false;
  return ["serviceTier", "personality"].every(
    (key) => value[key] === undefined || (typeof value[key] === "string" && value[key].trim()),
  );
}

function isInlineImage(value: unknown): value is string {
  return typeof value === "string" && /^data:image\/[a-z0-9.+-]+;base64,/i.test(value);
}

function isThreadDraft(value: unknown): value is ThreadDraft {
  if (
    !isRecord(value) ||
    typeof value.input !== "string" ||
    typeof value.goalMode !== "boolean" ||
    typeof value.updatedAt !== "number" ||
    !Number.isFinite(value.updatedAt) ||
    !Array.isArray(value.images) ||
    !Array.isArray(value.annotations)
  ) {
    return false;
  }
  return (
    value.images.every(
      (image) =>
        isRecord(image) &&
        typeof image.id === "string" &&
        Boolean(image.id) &&
        typeof image.name === "string" &&
        Boolean(image.name) &&
        isInlineImage(image.url),
    ) && value.annotations.every(isThreadDraftAnnotation)
  );
}

function isThreadDraftAnnotation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    Boolean(value.id) &&
    typeof value.messageId === "string" &&
    Boolean(value.messageId) &&
    ["agentMessage", "plan"].includes(String(value.source)) &&
    typeof value.quote === "string" &&
    Boolean(value.quote.trim()) &&
    typeof value.startOffset === "number" &&
    Number.isInteger(value.startOffset) &&
    value.startOffset >= 0 &&
    typeof value.endOffset === "number" &&
    Number.isInteger(value.endOffset) &&
    value.endOffset > value.startOffset &&
    typeof value.comment === "string" &&
    Boolean(value.comment.trim()) &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt)
  );
}

function isSessionSettings(value: unknown): value is SessionSettings {
  if (!isRecord(value) || !["default", "plan", "team"].includes(String(value.collaborationMode))) {
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
