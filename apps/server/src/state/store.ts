import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import type {
  ActivityItem,
  Project,
  QueuedMessage,
  SessionSettings,
  TaskDefaults,
  ThreadDraft,
  ThreadOutcome,
  UiLanguage,
  VoiceTranscriptionMode,
  VoiceTranscriptionStatus,
} from "@codexnest/protocol";

export type TimelineArtifact = Extract<
  ActivityItem,
  { type: "userInputResponse" | "planChecklist" }
>;

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
  voiceTranscriptions?: Record<string, VoiceTranscriptionState>;
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
    voiceTranscriptions: {},
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
  if (value.voiceTranscriptions !== undefined && !isRecord(value.voiceTranscriptions)) {
    throw new Error("Corrupt voice transcriptions in CodexNest state");
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
  for (const [threadId, job] of Object.entries(value.voiceTranscriptions ?? {})) {
    if (!isVoiceTranscription(job, threadId)) {
      throw new Error("Corrupt voice transcription in CodexNest state");
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
  return false;
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
      (typeof value.transcript !== "string" || !value.transcript.trim()))
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
