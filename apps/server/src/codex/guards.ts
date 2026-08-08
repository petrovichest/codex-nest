import type {
  GetAccountRateLimitsResponse,
  Model,
  ModelListResponse,
  SkillsConfigWriteResponse,
  SkillsListResponse,
  Thread,
  ThreadItemsListResponse,
  ThreadListResponse,
  ThreadLoadedListResponse,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadTurnsListResponse,
  Turn,
  TurnStartResponse,
} from "./generated/v2/index";

type RateLimitWindowView = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type AccountRateLimitsView = {
  primary: RateLimitWindowView | null;
  secondary: RateLimitWindowView | null;
};

export class ProtocolShapeError extends Error {
  constructor(context: string) {
    super(`Invalid app-server response shape for ${context}`);
    this.name = "ProtocolShapeError";
  }
}

export function parseThreadList(value: unknown): ThreadListResponse {
  const page = pageShape(value, "thread/list");
  if (!page.data.every(isThread)) throw new ProtocolShapeError("thread/list data");
  return page as unknown as ThreadListResponse;
}

export function parseThreadLoadedList(value: unknown): ThreadLoadedListResponse {
  const page = pageShape(value, "thread/loaded/list");
  if (!page.data.every((threadId) => typeof threadId === "string")) {
    throw new ProtocolShapeError("thread/loaded/list data");
  }
  return page as unknown as ThreadLoadedListResponse;
}

export function parseModelList(value: unknown): ModelListResponse {
  const page = pageShape(value, "model/list");
  if (!page.data.every(isModel)) throw new ProtocolShapeError("model/list data");
  return page as unknown as ModelListResponse;
}

export function parseTurnsList(value: unknown): ThreadTurnsListResponse {
  const page = pageShape(value, "thread/turns/list");
  if (!page.data.every(isTurn)) throw new ProtocolShapeError("thread/turns/list data");
  return page as unknown as ThreadTurnsListResponse;
}

export function parseItemsList(value: unknown): ThreadItemsListResponse {
  const page = pageShape(value, "thread/items/list");
  if (!page.data.every((item) => isRecord(item) && typeof item.type === "string")) {
    throw new ProtocolShapeError("thread/items/list data");
  }
  return page as unknown as ThreadItemsListResponse;
}

export function parseThreadRead(value: unknown): ThreadReadResponse {
  if (!isRecord(value) || !isThread(value.thread)) throw new ProtocolShapeError("thread/read");
  return value as unknown as ThreadReadResponse;
}

export function parseThreadResume(value: unknown): ThreadResumeResponse {
  if (!isRecord(value) || !isThread(value.thread)) throw new ProtocolShapeError("thread/resume");
  return value as unknown as ThreadResumeResponse;
}

export function parseThreadStart(value: unknown): { thread: Thread } {
  if (!isRecord(value) || !isThread(value.thread)) throw new ProtocolShapeError("thread/start");
  return { thread: value.thread };
}

export function parseTurnStart(value: unknown): TurnStartResponse {
  if (!isRecord(value) || !isTurn(value.turn)) throw new ProtocolShapeError("turn/start");
  return value as unknown as TurnStartResponse;
}

export function parseTurnSteer(value: unknown): { turnId: string } {
  if (!isRecord(value) || typeof value.turnId !== "string")
    throw new ProtocolShapeError("turn/steer");
  return { turnId: value.turnId };
}

export function parseSkillsList(value: unknown): SkillsListResponse {
  if (
    !isRecord(value) ||
    !Array.isArray(value.data) ||
    !value.data.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.cwd === "string" &&
        Array.isArray(entry.skills) &&
        entry.skills.every(isSkillMetadata) &&
        Array.isArray(entry.errors) &&
        entry.errors.every(isSkillError),
    )
  ) {
    throw new ProtocolShapeError("skills/list");
  }
  return value as unknown as SkillsListResponse;
}

export function parseSkillsConfigWrite(value: unknown): SkillsConfigWriteResponse {
  if (!isRecord(value) || typeof value.effectiveEnabled !== "boolean") {
    throw new ProtocolShapeError("skills/config/write");
  }
  return value as unknown as SkillsConfigWriteResponse;
}

export function parseAccountRateLimits(value: unknown): AccountRateLimitsView {
  if (!isRecord(value) || !isRateLimitSnapshot(value.rateLimits)) {
    throw new ProtocolShapeError("account/rateLimits/read");
  }
  const typed = value as unknown as GetAccountRateLimitsResponse;
  const codex = typed.rateLimitsByLimitId?.codex;
  const snapshot = codex ?? typed.rateLimits;
  if (!isRateLimitSnapshot(snapshot)) {
    throw new ProtocolShapeError("account/rateLimits/read codex bucket");
  }
  return {
    primary: rateLimitWindow(snapshot.primary),
    secondary: rateLimitWindow(snapshot.secondary),
  };
}

function pageShape(
  value: unknown,
  context: string,
): { data: unknown[]; nextCursor: string | null; backwardsCursor?: string | null } {
  if (
    !isRecord(value) ||
    !Array.isArray(value.data) ||
    !(value.nextCursor === null || typeof value.nextCursor === "string") ||
    !(
      value.backwardsCursor === undefined ||
      value.backwardsCursor === null ||
      typeof value.backwardsCursor === "string"
    )
  ) {
    throw new ProtocolShapeError(context);
  }
  return value as { data: unknown[]; nextCursor: string | null; backwardsCursor?: string | null };
}

function isThread(value: unknown): value is Thread {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.preview === "string" &&
    typeof value.cwd === "string" &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number" &&
    (value.name === null || typeof value.name === "string") &&
    isThreadStatus(value.status) &&
    Array.isArray(value.turns) &&
    value.turns.every(isTurn)
  );
}

function isThreadStatus(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !["notLoaded", "idle", "systemError", "active"].includes(String(value.type))
  )
    return false;
  return value.type !== "active" || Array.isArray(value.activeFlags);
}

function isTurn(value: unknown): value is Turn {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    ["completed", "interrupted", "failed", "inProgress"].includes(String(value.status)) &&
    Array.isArray(value.items) &&
    value.items.every((item) => isRecord(item) && typeof item.type === "string")
  );
}

function isModel(value: unknown): value is Model {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.displayName === "string" &&
    typeof value.description === "string" &&
    typeof value.isDefault === "boolean" &&
    typeof value.supportsPersonality === "boolean" &&
    typeof value.defaultReasoningEffort === "string" &&
    Array.isArray(value.supportedReasoningEfforts) &&
    value.supportedReasoningEfforts.every(
      (option) =>
        isRecord(option) &&
        typeof option.reasoningEffort === "string" &&
        typeof option.description === "string",
    ) &&
    Array.isArray(value.serviceTiers) &&
    value.serviceTiers.every(
      (tier) => isRecord(tier) && typeof tier.id === "string" && typeof tier.name === "string",
    )
  );
}

function isSkillMetadata(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    typeof value.path === "string" &&
    ["user", "repo", "system", "admin"].includes(String(value.scope)) &&
    typeof value.enabled === "boolean"
  );
}

function isSkillError(value: unknown): boolean {
  return isRecord(value) && typeof value.path === "string" && typeof value.message === "string";
}

function isRateLimitSnapshot(value: unknown): value is GetAccountRateLimitsResponse["rateLimits"] {
  return (
    isRecord(value) &&
    isOptionalRateLimitWindow(value.primary) &&
    isOptionalRateLimitWindow(value.secondary)
  );
}

function isOptionalRateLimitWindow(value: unknown): boolean {
  return value === null || isRateLimitWindow(value);
}

function isRateLimitWindow(value: unknown): value is RateLimitWindowView {
  return (
    isRecord(value) &&
    typeof value.usedPercent === "number" &&
    Number.isFinite(value.usedPercent) &&
    (value.windowDurationMins === null || typeof value.windowDurationMins === "number") &&
    (value.resetsAt === undefined ||
      value.resetsAt === null ||
      (typeof value.resetsAt === "number" && Number.isFinite(value.resetsAt)))
  );
}

function rateLimitWindow(value: unknown): RateLimitWindowView | null {
  if (!isRateLimitWindow(value)) return null;
  return {
    usedPercent: value.usedPercent,
    windowDurationMins: value.windowDurationMins,
    resetsAt: typeof value.resetsAt === "number" ? value.resetsAt * 1_000 : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
