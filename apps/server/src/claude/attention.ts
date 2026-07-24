import { randomUUID } from "node:crypto";

import type { AttentionRequest, AttentionResponse, UserInputQuestion } from "@codexnest/protocol";

import type { AttentionManager } from "../attention";

/** Local mirror of the SDK's PermissionResult (SDK imports stay confined to sdk.ts). */
export type ClaudePermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string; interrupt?: boolean };

const DENY_DECLINED = "Пользователь отклонил действие";
const DENY_EXPIRED = "Запрос действия отменён";
const PLAN_QUESTION = "Принять план и продолжить?";
const PLAN_ACCEPT = "Да";
const PLAN_QUESTION_ID = "exit-plan";
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export interface ClaudeAttentionCallbacks {
  /** Record + emit a userInputResponse artifact after an AskUserQuestion answer. */
  onUserInputResponse(
    turnId: string,
    itemId: string,
    questions: UserInputQuestion[],
    answers: Record<string, string[]>,
  ): void;
  /** A plan was accepted: flip collaborationMode → default and publish the change. */
  onPlanAccepted(turnId: string): void;
  /** A pending request was cancelled: interrupt the running turn. */
  onCancel(turnId: string): void;
}

interface Pending {
  attentionId: string;
  toolUseId: string;
  resolvers: Array<(result: ClaudePermissionResult) => void>;
  settled: boolean;
}

/**
 * Bridges the SDK `canUseTool` callback to CodexNest AttentionRequests for one live
 * session. Each request registers a callback-settled entry with the shared
 * AttentionManager; the returned promise resolves to the SDK PermissionResult when the
 * user responds — or is deny-settled if the manager expires the entry (interrupt,
 * turn-end, backend teardown) so the SDK turn never hangs.
 */
export class ClaudeAttention {
  private readonly pending = new Map<string, Pending>(); // attentionId → pending
  private readonly byToolUse = new Map<string, string>(); // toolUseId → attentionId
  private readonly decisions = new Map<string, ClaudePermissionResult>(); // toolUseId → replay
  private readonly allowlist = new Set<string>(); // acceptForSession keys
  private readonly onRemoved = (attentionId: string): void => this.handleRemoved(attentionId);

  constructor(
    private readonly threadId: string,
    private readonly cwd: string,
    private readonly attention: AttentionManager,
    private readonly callbacks: ClaudeAttentionCallbacks,
  ) {
    this.attention.on("removed", this.onRemoved);
  }

  dispose(): void {
    // Expire our entries out of the shared manager first (while the listener is still
    // attached, so handleRemoved deny-settles each pending promise), then detach.
    this.attention.expireByThread(this.threadId);
    this.attention.off("removed", this.onRemoved);
    for (const entry of [...this.pending.values()]) this.denySettle(entry);
    this.pending.clear();
    this.byToolUse.clear();
  }

  /** Deny-settles this thread's pending requests (interrupt / turn-end). */
  expire(): void {
    this.attention.expireByThread(this.threadId);
  }

  async request(
    turnId: string,
    toolName: string,
    input: Record<string, unknown>,
    toolUseId: string,
  ): Promise<ClaudePermissionResult> {
    const replay = this.decisions.get(toolUseId);
    if (replay) return replay;

    const existingId = this.byToolUse.get(toolUseId);
    const existing = existingId ? this.pending.get(existingId) : undefined;
    if (existing) return new Promise((resolve) => existing.resolvers.push(resolve));

    if (this.isAllowed(toolName, input)) return { behavior: "allow", updatedInput: input };

    const attentionId = `claude-attention-${randomUUID()}`;
    const request = this.buildRequest(attentionId, turnId, toolName, input, toolUseId);
    return new Promise<ClaudePermissionResult>((resolve) => {
      const entry: Pending = { attentionId, toolUseId, resolvers: [resolve], settled: false };
      this.pending.set(attentionId, entry);
      this.byToolUse.set(toolUseId, attentionId);
      this.attention.add(
        request,
        (response) => this.settle(entry, turnId, toolName, input, request, response),
        "claude",
      );
    });
  }

  private settle(
    entry: Pending,
    turnId: string,
    toolName: string,
    input: Record<string, unknown>,
    request: AttentionRequest,
    response: AttentionResponse,
  ): void {
    if (entry.settled) return;
    entry.settled = true;
    const result = this.mapResponse(turnId, toolName, input, request, response);
    this.decisions.set(entry.toolUseId, result);
    for (const resolve of entry.resolvers) resolve(result);
  }

  private handleRemoved(attentionId: string): void {
    const entry = this.pending.get(attentionId);
    if (!entry) return;
    this.pending.delete(attentionId);
    this.byToolUse.delete(entry.toolUseId);
    this.denySettle(entry);
  }

  private denySettle(entry: Pending): void {
    if (entry.settled) return;
    entry.settled = true;
    for (const resolve of entry.resolvers) resolve({ behavior: "deny", message: DENY_EXPIRED });
  }

  private mapResponse(
    turnId: string,
    toolName: string,
    input: Record<string, unknown>,
    request: AttentionRequest,
    response: AttentionResponse,
  ): ClaudePermissionResult {
    if (response.kind === "approval") {
      switch (response.decision) {
        case "accept":
          return { behavior: "allow", updatedInput: input };
        case "acceptForSession":
          this.allowlist.add(this.allowKey(toolName, input));
          return { behavior: "allow", updatedInput: input };
        case "cancel":
          this.callbacks.onCancel(turnId);
          return { behavior: "deny", message: DENY_DECLINED, interrupt: true };
        case "decline":
        default:
          return { behavior: "deny", message: DENY_DECLINED };
      }
    }
    if (response.kind === "userInput") {
      if (toolName === "ExitPlanMode") {
        const accepted = (response.answers[PLAN_QUESTION_ID] ?? []).includes(PLAN_ACCEPT);
        if (!accepted) return { behavior: "deny", message: DENY_DECLINED };
        this.callbacks.onPlanAccepted(turnId);
        return { behavior: "allow", updatedInput: input };
      }
      const questions = request.kind === "userInput" ? request.questions : [];
      this.callbacks.onUserInputResponse(turnId, request.itemId ?? "", questions, response.answers);
      return { behavior: "allow", updatedInput: answeredQuestions(input, response.answers) };
    }
    // Any other response kind cannot satisfy this request — deny rather than hang.
    return { behavior: "deny", message: DENY_DECLINED };
  }

  private buildRequest(
    attentionId: string,
    turnId: string,
    toolName: string,
    input: Record<string, unknown>,
    toolUseId: string,
  ): AttentionRequest {
    const base = {
      id: attentionId,
      threadId: this.threadId,
      turnId,
      itemId: toolUseId,
      createdAt: Date.now(),
    };
    if (toolName === "Bash") {
      return {
        ...base,
        kind: "commandApproval",
        command: stringField(input.command),
        cwd: this.cwd,
        reason: null,
        networkHost: null,
        canAcceptForSession: true,
        proposedPolicyChanges: [],
      };
    }
    if (FILE_TOOLS.has(toolName)) {
      return {
        ...base,
        kind: "fileChangeApproval",
        reason: null,
        grantRoot: this.cwd,
        canAcceptForSession: true,
      };
    }
    if (toolName === "AskUserQuestion") {
      return {
        ...base,
        kind: "userInput",
        questions: mapQuestions(input.questions),
        autoResolutionMs: null,
      };
    }
    if (toolName === "ExitPlanMode") {
      return {
        ...base,
        kind: "userInput",
        autoResolutionMs: null,
        questions: [
          {
            id: PLAN_QUESTION_ID,
            header: "План",
            question: PLAN_QUESTION,
            isOther: false,
            isSecret: false,
            options: [
              { label: PLAN_ACCEPT, description: "" },
              { label: "Нет", description: "" },
            ],
          },
        ],
      };
    }
    return {
      ...base,
      kind: "commandApproval",
      command: `${toolName} ${compactSummary(input)}`.trim(),
      cwd: this.cwd,
      reason: null,
      networkHost: null,
      canAcceptForSession: true,
      proposedPolicyChanges: [],
    };
  }

  private isAllowed(toolName: string, input: Record<string, unknown>): boolean {
    return this.allowlist.has(this.allowKey(toolName, input));
  }

  private allowKey(toolName: string, input: Record<string, unknown>): string {
    if (toolName === "Bash") return `Bash:${firstToken(stringField(input.command))}`;
    return toolName;
  }
}

/** Injects the user's answers into an AskUserQuestion input for the SDK. */
function answeredQuestions(
  input: Record<string, unknown>,
  answers: Record<string, string[]>,
): Record<string, unknown> {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  return {
    ...input,
    questions: questions.map((question, index) =>
      isRecord(question)
        ? { ...question, answers: { answers: answers[String(index)] ?? [] } }
        : question,
    ),
  };
}

function mapQuestions(value: unknown): UserInputQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((question, index) => ({
    id: String(index),
    header: stringField(question.header),
    question: stringField(question.question),
    isOther: false,
    isSecret: false,
    options: Array.isArray(question.options)
      ? question.options.filter(isRecord).map((option) => ({
          label: stringField(option.label),
          description: stringField(option.description),
        }))
      : null,
  }));
}

/** A compact one-line summary of an unknown tool's input for the approval prompt. */
function compactSummary(input: Record<string, unknown>): string {
  const summary = JSON.stringify(input);
  if (summary === undefined || summary === "{}") return "";
  return summary.length > 200 ? `${summary.slice(0, 197)}…` : summary;
}

function firstToken(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "";
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
