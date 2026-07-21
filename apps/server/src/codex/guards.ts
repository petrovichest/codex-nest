import type {
  Model,
  ModelListResponse,
  Thread,
  ThreadListResponse,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadTurnsListResponse,
  Turn,
  TurnStartResponse,
} from "./generated/v2/index";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
