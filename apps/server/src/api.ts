import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, createReadStream, type Stats } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";

import type { FastifyInstance, FastifyReply } from "fastify";

import type {
  ApiErrorCode,
  AppUpdateStatus,
  AttentionResponse,
  CodexManagementStatus,
  CodexRateLimitsResponse,
  CreateDirectoryRequest,
  CreateProjectRequest,
  CreateProjectThreadResponse,
  CreateThreadRequest,
  DeviceRegistrationRequest,
  GlobalPermissionSettings,
  InterruptTurnRequest,
  MarkReadRequest,
  ModelOption,
  MoveProjectRequest,
  PermissionPreset,
  QueueMessageRequest,
  QueuedMessage,
  RefreshThreadResponse,
  SessionSettings,
  StartTurnRequest,
  SteerTurnRequest,
  TaskDefaults,
  ThreadGoal,
  ThreadChanges,
  ThreadOutcome,
  ThreadSyncPoint,
  ThreadSummary,
  TranscriptionConfigResponse,
  TranscriptionResponse,
  TurnStartResult,
  UiLanguageSettings,
  UpdateGlobalPermissionSettingsRequest,
  UpdateCodexProxyRequest,
  UpdateProjectRequest,
  UpdateQueuedMessageRequest,
  UpdateTaskDefaultsRequest,
  UpdateThreadDraftRequest,
  UpdateThreadGoalRequest,
  UpdateThreadSettingsRequest,
  UpdateThreadRequest,
  UpdateTranscriptionSettingsRequest,
  UpdateUiLanguageRequest,
  VoiceTranscriptionMode,
  VoiceTranscriptionJob,
} from "@codexnest/protocol";

import { AttentionValidationError, type AttentionManager } from "./attention";
import { AppManagementError, type AppManager } from "./app-management";
import { bearerToken, verifyToken } from "./auth";
import { BridgeUnavailableError, type CodexBridge } from "./codex/bridge";
import type { ServerNotification, ServerRequest } from "./codex/generated/index";
import type {
  DynamicToolCallResponse,
  Thread,
  ThreadItem,
  ThreadResumeResponse,
  Turn,
} from "./codex/generated/v2/index";
import {
  parseAccountRateLimits,
  parseThreadList,
  parseThreadRead,
  parseThreadStart,
  parseTurnsList,
  parseTurnStart,
  parseTurnSteer,
} from "./codex/guards";
import { RpcError, type JsonlTransport } from "./codex/transport";
import { CodexManagementError, type CodexManager } from "./codex-management";
import { SERVER_VERSION } from "./config";
import { readGitChanges } from "./git-changes";
import { safeError } from "./logging";
import {
  assertUniqueProjectPath,
  canonicalProjectPath,
  createDirectory,
  createProject,
  listDirectories,
  pathContains,
  ProjectConflictError,
  ProjectForbiddenError,
  ProjectNotFoundError,
  ProjectValidationError,
} from "./projects";
import type { AppProjection } from "./projection";
import type { PushNotifier } from "./push";
import {
  RESTART_RECOVERY_PROTOCOL_VERSION,
  RestartTokenError,
  type RuntimeLifecycle,
} from "./runtime-lifecycle";
import {
  MessageQueue,
  MessageQueueConflictError,
  MessageQueueNotFoundError,
  MessageQueuePausedError,
  MessageQueueValidationError,
  messageContentHash,
} from "./message-queue";
import type {
  CodexNestState,
  ManagedTeamTaskResult,
  ManagedTeamTaskState,
  StateStore,
  TeamToolOperationState,
} from "./state/store";
import type { ThreadTitleGenerator } from "./thread-title";
import {
  appendTranscriptionTimingSample,
  MAX_TRANSCRIPTION_BYTES,
  MAX_RECORDING_SECONDS,
  normalizeAudioType,
  TranscriptionError,
  transcriptionTimingEstimate,
  transcriptionTimingProfile,
  type TranscriptionService,
} from "./transcription";
import {
  VoiceTranscriptionConflictError,
  VoiceTranscriptionManager,
  VoiceTranscriptionQueueFullError,
} from "./voice-transcriptions";

const CHAT_BODY_LIMIT = Number.MAX_SAFE_INTEGER;
const DOWNLOAD_TICKET_TTL_MS = 60_000;
const MAX_DOWNLOAD_TICKETS = 128;
const TEAM_TOOLS_VERSION = 1;
const TEAM_MAX_ACTIVE_TASKS = 4;
const TEAM_WATCHDOG_MS = 10 * 60_000;
const TEAM_ACTIVITY_PERSIST_MS = 60_000;
const TEAM_CONTINUATION_MARKER_TEXT =
  "Continue CodexNest Team orchestration using the attached managed-task results.";
const TEAM_SESSION_UPGRADE_MESSAGE =
  "Эта сессия создана до появления managed Team tools. Создайте новую Team-сессию.";
const TEAM_MODE_CONTEXT = [
  "This session is in CodexNest Team mode. Act only as the root coordinator.",
  "Use only the codexnest managed-task tools for delegation. Never use native subagent tools.",
  "For every independent executable step, call codexnest.spawn_task with a concise title and one self-contained prompt.",
  "Include only the minimum context needed to complete that step: its objective, relevant constraints, affected scope, and expected result.",
  "Never copy or summarize the conversation, the full plan, unrelated plan steps, or prior agent messages in a subagent prompt.",
  "Do not execute a delegated plan step in the parent session.",
  "CodexNest may end the current parent turn and automatically start a continuation turn when a child result arrives.",
  "Never call sleep, run shell sleep commands, repeatedly call list_tasks or inspect_task, or otherwise poll to wait for managed tasks.",
  "After scheduling all tasks that are ready now, finish the turn instead of waiting; child completion automatically notifies and resumes this parent session.",
  "On a CodexNest orchestration continuation, process the named child results and continue reasoning about the original task before deciding the next action.",
  "If an explicit user message is present, answer it first without forgetting any active or newly completed subagents.",
  "Choose sequential or parallel delegation based on dependencies and workspace overlap.",
  "Never run parallel subagents that may write to overlapping files.",
  "Use codexnest.inspect_task, codexnest.steer_task, or codexnest.cancel_task when a watchdog reports that a task is silent.",
  "You may write managed-task prompts and steering messages in English whenever you judge that it improves efficiency or precision, regardless of the user's language.",
  "Keep concise task titles and the consolidated user-facing response in the user's language.",
  "When the required results are ready, return one consolidated result to the user.",
  "The user should not need to coordinate subagents directly.",
].join(" ");
const TEAM_CHILD_INSTRUCTIONS = [
  "You are a CodexNest managed child agent. Complete exactly the assigned task in this thread.",
  "Do not create or delegate to subagents.",
  "Before finishing, call codexnest.submit_result with a concise summary and optional Markdown details.",
  "The submitted value is a result candidate; still provide a normal final answer after the tool call.",
].join(" ");

interface DownloadTicket {
  root: string;
  path: string;
  fileName: string;
  expiresAt: number;
}

interface TeamResultClaim {
  claimId: string;
  results: Array<{
    taskId: string;
    childThreadId: string;
    terminalTurnId: string;
    outcome: ThreadOutcome;
    title: string;
    result: ManagedTeamTaskResult;
  }>;
  watchdogs: Array<{
    taskId: string;
    childThreadId: string;
    title: string;
    status: ManagedTeamTaskState["status"];
    lastActivityAt: number;
  }>;
}

const TEAM_ROOT_DYNAMIC_TOOLS = [
  {
    type: "namespace",
    name: "codexnest",
    description: "Create and manage CodexNest child tasks for Team mode.",
    tools: [
      dynamicTool("spawn_task", "Create one managed child task.", {
        type: "object",
        properties: {
          title: { type: "string", description: "Concise task-specific title." },
          prompt: { type: "string", description: "Self-contained task instructions." },
        },
        required: ["title", "prompt"],
        additionalProperties: false,
      }),
      dynamicTool("list_tasks", "List this parent's managed tasks.", {
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      dynamicTool("inspect_task", "Inspect the current progress of one managed task.", {
        type: "object",
        properties: { taskId: { type: "string" } },
        required: ["taskId"],
        additionalProperties: false,
      }),
      dynamicTool("steer_task", "Send corrective guidance to a running managed task.", {
        type: "object",
        properties: {
          taskId: { type: "string" },
          message: { type: "string" },
        },
        required: ["taskId", "message"],
        additionalProperties: false,
      }),
      dynamicTool("cancel_task", "Cancel a queued or running managed task.", {
        type: "object",
        properties: {
          taskId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["taskId"],
        additionalProperties: false,
      }),
    ],
  },
] as const;

const TEAM_CHILD_DYNAMIC_TOOLS = [
  {
    type: "namespace",
    name: "codexnest",
    description: "Return the result of the current CodexNest managed task.",
    tools: [
      dynamicTool("submit_result", "Submit the result candidate for this managed task.", {
        type: "object",
        properties: {
          summary: { type: "string", description: "Concise non-empty result summary." },
          details: { type: "string", description: "Optional Markdown details." },
        },
        required: ["summary"],
        additionalProperties: false,
      }),
    ],
  },
] as const;

export interface ApiServices {
  bridge: CodexBridge;
  store: StateStore;
  projection: AppProjection;
  attention: AttentionManager;
  push: PushNotifier;
  codexManager?: CodexManager;
  appManager?: AppManager;
  lifecycle?: RuntimeLifecycle;
  threadTitles?: Pick<ThreadTitleGenerator, "generate">;
  transcription?: Pick<
    TranscriptionService,
    "configuration" | "updateConfiguration" | "transcribe"
  >;
  projectRoot?: string;
}

export function registerApi(app: FastifyInstance, services: ApiServices): void {
  const {
    bridge,
    store,
    projection,
    attention,
    codexManager,
    appManager,
    lifecycle,
    threadTitles,
  } = services;
  const downloadTickets = new Map<string, DownloadTicket>();
  const projectThreadCreations = new Map<string, Promise<ThreadSummary>>();
  const turnStartLocks = new Map<string, Promise<unknown>>();
  const teamParentLocks = new Map<string, Promise<unknown>>();
  const teamToolOperationLocks = new Map<string, Promise<unknown>>();
  app.addContentTypeParser(/^audio\//i, { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });
  const scheduleThreadTitle = (threadId: string, input: string, summary: ThreadSummary): void => {
    if (!threadTitles || !input.trim() || projection.hasExplicitName(threadId)) return;
    const model = effectiveModel(summary.settings, projection.availableModels);
    const pending = threadTitles
      .generate(input, {
        cwd: summary.cwd,
        model: model?.id,
        effort: model?.reasoningEfforts[0]?.value,
      })
      .then(async (name) => {
        if (projection.hasExplicitName(threadId)) return;
        await bridge.request("thread/name/set", { threadId, name });
      })
      .catch((error: unknown) => {
        app.log.warn({ err: safeError(error), threadId }, "Failed to generate thread title");
      });
    void (lifecycle?.track(pending) ?? pending);
  };
  const startTurnUnlocked = async (
    threadId: string,
    input: string,
    images: string[],
    clientMessageId: string | null,
    goal = false,
  ): Promise<TurnStartResult> => {
    if (clientMessageId) {
      const receipt = store.snapshot().messageReceipts?.[clientMessageId];
      if (receipt) {
        if (
          receipt.threadId !== threadId ||
          receipt.contentHash !== messageContentHash(input, images, goal)
        ) {
          throw new MessageQueueConflictError("Message id has already been used");
        }
        return { turnId: receipt.turnId ?? clientMessageId };
      }
    }
    let summary = projection.summary(threadId);
    if (!summary) throw new MessageQueueNotFoundError("Thread not found");
    assertWritableThread(summary);
    const shouldGenerateTitle =
      projection.isUnmaterialized(threadId) && !projection.hasExplicitName(threadId);
    if (
      summary.settings.collaborationMode === "team" &&
      store.snapshot().threadMeta[threadId]?.teamToolsVersion !== TEAM_TOOLS_VERSION
    ) {
      throw new ProjectConflictError(TEAM_SESSION_UPGRADE_MESSAGE);
    }
    if (goal) {
      if (summary.settings.collaborationMode === "team") {
        throw new ProjectConflictError("Team mode cannot be combined with a goal");
      }
      if (summary.settings.collaborationMode === "plan") {
        summary = await projection.setSettings(threadId, {
          ...summary.settings,
          collaborationMode: "default",
        });
      }
      await setThreadGoal(bridge, threadId, { objective: input.trim(), status: "paused" });
    }
    const teamClaim =
      summary.settings.collaborationMode === "team"
        ? await claimTeamResults(store, threadId)
        : null;
    const teamMarkerId = teamClaim
      ? (clientMessageId ?? teamContinuationMarkerId(teamClaim.claimId))
      : null;
    const effectiveInput =
      teamClaim && !input.trim() && !images.length ? TEAM_CONTINUATION_MARKER_TEXT : input;
    if (teamClaim && teamMarkerId) {
      await markTeamClaimDispatch(
        store,
        threadId,
        teamClaim.claimId,
        teamMarkerId,
        teamContinuationContext(store, threadId, teamClaim),
      );
    }
    let turnId: string;
    try {
      if (!projection.isUnmaterialized(threadId)) {
        await bridge.request<ThreadResumeResponse>(
          "thread/resume",
          {
            threadId,
            cwd: summary.cwd,
            excludeTurns: true,
            ...threadSettings(summary.settings),
            ...(summary.settings.collaborationMode === "team"
              ? { config: teamRuntimeConfig() }
              : {}),
          },
          30_000,
        );
      }
      const turn = parseTurnStart(
        await bridge.request<unknown>("turn/start", {
          threadId,
          clientUserMessageId: teamMarkerId ?? clientMessageId,
          input: messageInput(effectiveInput, images),
          ...turnSettings(
            summary.settings,
            projection.availableModels,
            teamClaim ? teamContinuationContext(store, threadId, teamClaim) : undefined,
          ),
        }),
      );
      turnId = turn.turn.id;
    } catch (error) {
      if (teamClaim && teamMarkerId) {
        let recoveredTurnId: string | null;
        try {
          recoveredTurnId = await deliveredClientMessageTurnId(bridge, threadId, teamMarkerId);
        } catch {
          // Keep the durable claim parked until bridge recovery can reconcile it.
          throw error;
        }
        if (recoveredTurnId) {
          turnId = recoveredTurnId;
        } else {
          await releaseTeamClaim(store, threadId, teamClaim.claimId);
          if (goal) await clearThreadGoal(bridge, threadId).catch(() => undefined);
          throw error;
        }
      } else {
        if (goal) await clearThreadGoal(bridge, threadId).catch(() => undefined);
        throw error;
      }
    }
    await projection.markMaterialized(threadId);
    await projection.setCurrentTurn(threadId, turnId);
    if (clientMessageId) {
      await store.update((state) => {
        state.messageReceipts ??= {};
        state.messageReceipts[clientMessageId] = {
          threadId,
          turnId,
          contentHash: messageContentHash(input, images, goal),
          createdAt: Date.now(),
        };
      });
    }
    if (clientMessageId) {
      projection.recordUserMessage(threadId, turnId, clientMessageId, input, images);
    }
    if (teamClaim) {
      await deliverTeamClaim(store, threadId, teamClaim.claimId, turnId);
      await projection.recordOrchestrationNotice(
        threadId,
        turnId,
        teamClaim.results.map((result) => {
          const child = projection.summary(result.childThreadId);
          return {
            threadId: result.childThreadId,
            title: result.title,
            nickname: child?.relation.kind === "subagent" ? child.relation.nickname : null,
            outcome: result.outcome,
          };
        }),
        clientMessageId,
      );
      projection.publishThreadState(threadId);
    }
    if (shouldGenerateTitle) scheduleThreadTitle(threadId, input, summary);
    if (!goal) return { turnId };
    try {
      await setThreadGoal(bridge, threadId, { status: "active" });
      return { turnId };
    } catch {
      return {
        turnId,
        goalWarning: "Первый ход начат, но цель осталась на паузе. Продолжите её вручную.",
      };
    }
  };
  const startTurn = (
    threadId: string,
    input: string,
    images: string[],
    clientMessageId: string | null,
    goal = false,
  ): Promise<TurnStartResult> => {
    return withKeyLock(turnStartLocks, threadId, async () => {
      const release = codexManager?.beginTurn();
      const run = () => startTurnUnlocked(threadId, input, images, clientMessageId, goal);
      const result =
        projection.summary(threadId)?.settings.collaborationMode === "team"
          ? withKeyLock(teamParentLocks, threadId, run)
          : run();
      return result.finally(() => release?.());
    });
  };

  async function findReusableProjectThread(projectId: string): Promise<ThreadSummary | null> {
    for (const candidate of projection.emptyThreadCandidates(projectId)) {
      if (
        store.snapshot().threadMeta[candidate.thread.id]?.teamToolsVersion !== TEAM_TOOLS_VERSION
      ) {
        continue;
      }
      if (candidate.knownUnmaterialized) return candidate.thread;
      const detail = await projection.readThread(candidate.thread.id);
      if (detail.turns.length === 0 && detail.queuedMessages.length === 0) {
        await projection.markUnmaterialized(candidate.thread.id);
        return projection.summary(candidate.thread.id) ?? candidate.thread;
      }
      await projection.markMaterialized(candidate.thread.id);
    }
    return null;
  }

  function getOrCreateProjectThread(projectId: string): Promise<ThreadSummary> {
    const current = projectThreadCreations.get(projectId);
    if (current) return current;
    const request = (async () => {
      const existing = await findReusableProjectThread(projectId);
      if (existing) return existing;
      codexManager?.assertTurnsAllowed();
      const project = store.snapshot().projects.find((candidate) => candidate.id === projectId);
      if (!project) throw new ProjectNotFoundError("Project not found");
      const settings = projection.newSessionSettings;
      const started = parseThreadStart(
        await bridge.request<unknown>("thread/start", {
          cwd: project.path,
          ...threadSettings(settings),
          dynamicTools: TEAM_ROOT_DYNAMIC_TOOLS,
          ...(settings.collaborationMode === "team" ? { config: teamRuntimeConfig() } : {}),
        }),
      );
      projection.upsertThread(started.thread);
      await projection.markUnmaterialized(started.thread.id);
      await markTeamToolsAvailable(store, started.thread.id);
      return projection.setSettings(started.thread.id, settings);
    })().finally(() => {
      if (projectThreadCreations.get(projectId) === request) {
        projectThreadCreations.delete(projectId);
      }
    });
    projectThreadCreations.set(projectId, request);
    return request;
  }

  const steerTurnUnlocked = async (
    threadId: string,
    turnId: string,
    input: string,
    images: string[],
    clientMessageId: string | null,
  ): Promise<string> => {
    codexManager?.assertTurnsAllowed();
    const teamClaim =
      projection.summary(threadId)?.settings.collaborationMode === "team"
        ? await claimTeamResults(store, threadId)
        : null;
    const teamMarkerId = teamClaim
      ? (clientMessageId ?? teamContinuationMarkerId(teamClaim.claimId))
      : null;
    if (teamClaim && teamMarkerId) {
      await markTeamClaimDispatch(
        store,
        threadId,
        teamClaim.claimId,
        teamMarkerId,
        teamContinuationContext(store, threadId, teamClaim),
      );
    }
    let resultTurnId: string;
    try {
      const result = parseTurnSteer(
        await bridge.request<unknown>("turn/steer", {
          threadId,
          expectedTurnId: turnId,
          clientUserMessageId: teamMarkerId ?? clientMessageId,
          input: messageInput(input, images),
          ...(teamClaim
            ? {
                additionalContext: {
                  "codexnest.team.results": {
                    kind: "application",
                    value: teamContinuationContext(store, threadId, teamClaim),
                  },
                },
              }
            : {}),
        }),
      );
      resultTurnId = result.turnId;
    } catch (error) {
      if (teamClaim && teamMarkerId) {
        let recoveredTurnId: string | null;
        try {
          recoveredTurnId = await deliveredClientMessageTurnId(bridge, threadId, teamMarkerId);
        } catch {
          throw error;
        }
        if (recoveredTurnId) {
          resultTurnId = recoveredTurnId;
        } else {
          await releaseTeamClaim(store, threadId, teamClaim.claimId);
          throw error;
        }
      } else {
        throw error;
      }
    }
    if (projection.summary(threadId)) await projection.setCurrentTurn(threadId, resultTurnId);
    if (clientMessageId) {
      projection.recordUserMessage(threadId, resultTurnId, clientMessageId, input, images);
    }
    if (teamClaim) {
      await deliverTeamClaim(store, threadId, teamClaim.claimId, resultTurnId);
      await recordTeamNotice(
        projection,
        threadId,
        resultTurnId,
        teamClaim.results,
        clientMessageId,
      );
      projection.publishThreadState(threadId);
    }
    return resultTurnId;
  };
  const steerTurn = (
    threadId: string,
    turnId: string,
    input: string,
    images: string[],
    clientMessageId: string | null,
  ): Promise<string> => {
    const run = () => steerTurnUnlocked(threadId, turnId, input, images, clientMessageId);
    return projection.summary(threadId)?.settings.collaborationMode === "team"
      ? withKeyLock(teamParentLocks, threadId, run)
      : run();
  };
  const queue = new MessageQueue(store, {
    paused: () => codexManager?.maintenanceActive ?? false,
    currentTurnId: (threadId) => projection.summary(threadId)?.currentTurnId ?? null,
    start: (threadId, message) =>
      startTurn(
        threadId,
        message.text,
        message.images ?? [],
        message.id,
        message.goal ?? false,
      ).then((result) => result.turnId),
    steer: (threadId, turnId, message) =>
      steerTurn(threadId, turnId, message.text, message.images ?? [], message.id),
    deliveredTurnId: async (threadId, messageId) => {
      const result = parseThreadRead(
        await bridge.request<unknown>("thread/read", { threadId, includeTurns: true }, 30_000),
      );
      return (
        result.thread.turns.find((turn) =>
          turn.items.some((item) => item.type === "userMessage" && item.clientId === messageId),
        )?.id ?? null
      );
    },
    publish: (threadId, messages) => projection.publishQueue(threadId, messages),
  });
  const scheduledTeamContinuations = new Set<string>();
  const scheduledTeamTaskStarts = new Set<string>();
  const teamContinuationImmediates = new Map<string, NodeJS.Immediate>();
  const teamTaskStartImmediates = new Map<string, NodeJS.Immediate>();
  const managedActivity = new Map<string, number>();
  const teamBackgroundRuns = new Set<Promise<unknown>>();
  const deferredServerRequests = new Map<string, [ServerRequest, JsonlTransport]>();
  let teamNotificationQueue = Promise.resolve();
  let recoveryPromise: Promise<void> | undefined;
  let teamContinuationsClosed = false;
  let teamContinuationsPaused = false;
  const trackTeamBackground = <T>(promise: Promise<T>): Promise<T> => {
    teamBackgroundRuns.add(promise);
    const cleanup = () => teamBackgroundRuns.delete(promise);
    void promise.then(cleanup, cleanup);
    return lifecycle?.track(promise) ?? promise;
  };
  const scheduleTeamContinuation = (threadId: string): void => {
    if (
      teamContinuationsClosed ||
      teamContinuationsPaused ||
      scheduledTeamContinuations.has(threadId)
    )
      return;
    scheduledTeamContinuations.add(threadId);
    const immediate = setImmediate(() => {
      teamContinuationImmediates.delete(threadId);
      void trackTeamBackground(
        (async () => {
          try {
            if (teamContinuationsClosed || teamContinuationsPaused) return;
            const summary = projection.summary(threadId);
            if (
              !summary ||
              summary.relation.kind !== "session" ||
              summary.currentTurnId ||
              !hasPendingTeamContinuation(store, threadId)
            ) {
              return;
            }
            if (queue.count(threadId)) {
              await queue.drain(threadId);
              return;
            }
            await startTurn(threadId, "", [], null);
          } catch (error) {
            app.log.warn(
              { err: safeError(error), threadId },
              "Failed to continue Team orchestration",
            );
          } finally {
            scheduledTeamContinuations.delete(threadId);
          }
        })(),
      );
    });
    teamContinuationImmediates.set(threadId, immediate);
  };
  const scheduleTeamTasks = (parentThreadId: string): void => {
    if (
      teamContinuationsClosed ||
      teamContinuationsPaused ||
      scheduledTeamTaskStarts.has(parentThreadId)
    )
      return;
    scheduledTeamTaskStarts.add(parentThreadId);
    const immediate = setImmediate(() => {
      teamTaskStartImmediates.delete(parentThreadId);
      void trackTeamBackground(
        withKeyLock(teamParentLocks, parentThreadId, async () => {
          try {
            if (teamContinuationsPaused) return;
            await startQueuedTeamTasks(bridge, store, projection, parentThreadId);
            projection.publishThreadState(parentThreadId);
            scheduleTeamContinuation(parentThreadId);
          } catch (error) {
            app.log.warn(
              { err: safeError(error), parentThreadId },
              "Failed to start managed Team task",
            );
          } finally {
            scheduledTeamTaskStarts.delete(parentThreadId);
          }
        }),
      );
    });
    teamTaskStartImmediates.set(parentThreadId, immediate);
  };
  const resumeTeamContinuations = (): void => {
    for (const threadId of pendingTeamParents(store)) {
      scheduleTeamTasks(threadId);
      scheduleTeamContinuation(threadId);
    }
  };
  const teamNotificationHandler = (notification: ServerNotification) => {
    if (teamContinuationsPaused) return;
    if (
      notification.method === "turn/completed" &&
      Object.values(store.snapshot().teamToolOperations ?? {}).some(
        (operation) =>
          operation.status === "applied" &&
          operation.threadId === notification.params.threadId &&
          operation.turnId === notification.params.turn.id,
      )
    ) {
      void pruneAppliedTeamToolOperations(
        store,
        notification.params.threadId,
        notification.params.turn.id,
      ).catch(() => undefined);
    }
    const childThreadId = notificationThreadId(notification);
    const managed = childThreadId
      ? managedTaskForChild(store.snapshot(), childThreadId)
      : undefined;
    if (childThreadId && managed) {
      managedActivity.set(childThreadId, Date.now());
    }
    if (!isManagedTeamNotification(notification, store)) return;
    teamNotificationQueue = teamNotificationQueue
      .catch(() => undefined)
      .then(async () => {
        const run = () =>
          handleManagedTeamNotification(notification, bridge, store, projection, managedActivity);
        const affected = managed
          ? await withKeyLock(teamParentLocks, managed.parentThreadId, run)
          : await run();
        for (const threadId of affected) {
          projection.publishThreadState(threadId);
          scheduleTeamTasks(threadId);
          scheduleTeamContinuation(threadId);
        }
      })
      .catch((error: unknown) => {
        app.log.warn({ err: safeError(error) }, "Failed to process Team orchestration event");
      });
  };
  const teamRequestHandler = (request: ServerRequest, transport: JsonlTransport) => {
    if (
      teamContinuationsPaused ||
      (lifecycle && lifecycle.state !== "ready" && lifecycle.state !== "draining")
    ) {
      deferredServerRequests.set(`${request.method}:${String(request.id)}`, [request, transport]);
      return;
    }
    if (request.method === "item/tool/call" && request.params.namespace === "codexnest") {
      const operationKey = teamToolOperationKey(request);
      const caller = request.params.threadId;
      const parent =
        projection.summary(caller)?.relation.kind === "session"
          ? caller
          : managedTaskForChild(store.snapshot(), caller)?.parentThreadId;
      const operation = () => handleManagedTeamToolCall(request, bridge, store, projection);
      const pending = withKeyLock(teamToolOperationLocks, operationKey, () =>
        parent ? withKeyLock(teamParentLocks, parent, operation) : operation(),
      );
      void (lifecycle?.track(pending) ?? pending)
        .then(async (response) => {
          try {
            transport.respond(request.id, response);
          } catch {
            // The durable receipt will answer the replay on the next connection.
            return;
          }
          if (parent) {
            scheduleTeamTasks(parent);
            projection.publishThreadState(parent);
          }
        })
        .catch(async (error: unknown) => {
          const response = dynamicToolError(safeError(error).message);
          if (isMutatingTeamTool(request.params.tool)) {
            await completeTeamToolOperation(store, operationKey, response).catch(() => undefined);
          }
          try {
            transport.respond(request.id, response);
          } catch {
            // A durable response, when persisted, will answer the replay.
          }
        });
      return;
    }
    try {
      attention.receive(request, transport);
    } catch {
      transport.respondError(request.id, -32_602, "Invalid request parameters");
    }
  };
  bridge.on("notification", teamNotificationHandler);
  bridge.on("request", teamRequestHandler);
  const teamWatchdogTimer = setInterval(() => {
    if (teamContinuationsPaused) return;
    teamNotificationQueue = teamNotificationQueue
      .catch(() => undefined)
      .then(async () => {
        const affected = await triggerTeamWatchdogs(store, managedActivity, Date.now());
        for (const parentThreadId of affected) {
          projection.publishThreadState(parentThreadId);
          scheduleTeamContinuation(parentThreadId);
        }
      })
      .catch((error: unknown) => {
        app.log.warn({ err: safeError(error) }, "Failed to run Team watchdog");
      });
  }, 30_000);
  teamWatchdogTimer.unref();
  const bridgeTeamStateHandler = (state: string) => {
    if (state === "ready" || teamContinuationsClosed) return;
    teamContinuationsPaused = true;
    void queue.pause().catch(() => undefined);
  };
  bridge.on("state", bridgeTeamStateHandler);
  app.addHook("onClose", async () => {
    teamContinuationsClosed = true;
    teamContinuationsPaused = true;
    clearInterval(teamWatchdogTimer);
    for (const immediate of teamContinuationImmediates.values()) clearImmediate(immediate);
    for (const immediate of teamTaskStartImmediates.values()) clearImmediate(immediate);
    teamContinuationImmediates.clear();
    teamTaskStartImmediates.clear();
    deferredServerRequests.clear();
    scheduledTeamContinuations.clear();
    scheduledTeamTaskStarts.clear();
    bridge.off("state", bridgeTeamStateHandler);
    bridge.off("notification", teamNotificationHandler);
    bridge.off("request", teamRequestHandler);
    await queue.pause();
    await teamNotificationQueue;
    await recoveryPromise?.catch(() => undefined);
    await Promise.all(
      [
        ...teamBackgroundRuns,
        ...teamParentLocks.values(),
        ...teamToolOperationLocks.values(),
        ...turnStartLocks.values(),
      ].map((pending) => pending.catch(() => undefined)),
    );
  });
  const voiceTranscriptions = services.transcription
    ? new VoiceTranscriptionManager({
        store,
        projection,
        transcription: services.transcription,
        queue,
        onWarning: (error, message) => app.log.warn({ err: safeError(error) }, message),
      })
    : null;
  if (voiceTranscriptions) {
    void voiceTranscriptions.start().catch((error: unknown) => {
      app.log.error({ err: safeError(error) }, "Failed to start voice transcription worker");
    });
    app.addHook("onClose", async () => voiceTranscriptions.stop());
  }

  let recoveryAgain = false;
  const runRecovery = (): Promise<void> => {
    if (recoveryPromise) {
      recoveryAgain = true;
      return recoveryPromise;
    }
    const pending = (async () => {
      do {
        recoveryAgain = false;
        if (lifecycle && lifecycle.state !== "ready" && lifecycle.state !== "draining") {
          lifecycle.recovering();
        }
        await queue.recover();
        await pruneCompletedTeamToolOperations(bridge, store);
        const threadIds = await reconcileTeamOrchestration(bridge, store, projection);
        if (
          Object.values(store.snapshot().threadMeta).some((meta) =>
            Object.values(meta.teamOrchestration?.tasks ?? {}).some(
              (task) => task.recoveryMisses === 1,
            ),
          )
        ) {
          recoveryAgain = true;
        }
        for (const threadId of threadIds) {
          projection.publishThreadState(threadId);
          if (!teamContinuationsPaused) {
            scheduleTeamTasks(threadId);
            scheduleTeamContinuation(threadId);
          }
        }
      } while (recoveryAgain && !teamContinuationsClosed);
      if (bridge.state === "ready" && lifecycle?.state !== "draining" && !teamContinuationsClosed) {
        teamContinuationsPaused = false;
        await queue.resume();
        resumeTeamContinuations();
        lifecycle?.ready();
        const deferred = [...deferredServerRequests.values()];
        deferredServerRequests.clear();
        for (const [request, transport] of deferred) teamRequestHandler(request, transport);
      }
    })()
      .catch((error: unknown) => {
        lifecycle?.failed();
        app.log.warn({ err: safeError(error) }, "Failed to reconcile durable runtime state");
        throw error;
      })
      .finally(() => {
        recoveryPromise = undefined;
      });
    recoveryPromise = lifecycle?.track(pending) ?? pending;
    return recoveryPromise;
  };

  const unregisterLifecycleParticipant = lifecycle?.register({
    pause: async () => {
      teamContinuationsPaused = true;
      await queue.pause();
      await teamNotificationQueue.catch(() => undefined);
      await Promise.all(
        [
          ...teamBackgroundRuns,
          ...teamParentLocks.values(),
          ...teamToolOperationLocks.values(),
          ...turnStartLocks.values(),
        ].map((pending) => pending.catch(() => undefined)),
      );
      await recoveryPromise?.catch(() => undefined);
    },
    resume: async () => {
      if (teamContinuationsClosed) return;
      await runRecovery().catch(() => undefined);
      teamContinuationsPaused = false;
      await queue.resume();
      const deferred = [...deferredServerRequests.values()];
      deferredServerRequests.clear();
      for (const [request, transport] of deferred) teamRequestHandler(request, transport);
      resumeTeamContinuations();
    },
  });

  projection.on("event", (_sequence, event) => {
    if (event.type === "resync.required") {
      void runRecovery().catch(() => undefined);
    } else if (event.type === "thread.upserted" && !event.thread.currentTurnId) {
      void queue.drain(event.thread.id).catch(() => undefined);
      if (event.thread.relation.kind === "session") {
        if (hasClaimedTeamContinuation(store, event.thread.id)) {
          void runRecovery().catch(() => undefined);
        } else {
          scheduleTeamContinuation(event.thread.id);
        }
      }
    } else if (event.type === "thread.removed") {
      void queue.removeThread(event.threadId).catch(() => undefined);
    }
  });

  app.addHook("onClose", async () => {
    unregisterLifecycleParticipant?.();
  });

  const activeMutationRequests = new Map<string, () => void>();
  const finishMutationRequest = (requestId: string): void => {
    activeMutationRequests.get(requestId)?.();
    activeMutationRequests.delete(requestId);
  };
  app.addHook("onRequest", async (request, reply) => {
    if (!lifecycle || !request.url.startsWith("/api/v1/")) return;
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (
      request.method === "OPTIONS" ||
      !["POST", "PUT", "PATCH", "DELETE"].includes(request.method) ||
      pathname.startsWith("/api/v1/internal/restart/")
    ) {
      return;
    }
    if (!lifecycle.acceptsMutations) {
      reply.header("Retry-After", "2");
      return apiError(
        reply,
        503,
        "app_server_unavailable",
        `CodexNest is ${lifecycle.state}; retry after recovery`,
      );
    }
    let resolveRequest!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveRequest = resolve;
    });
    activeMutationRequests.set(request.id, resolveRequest);
    lifecycle.track(pending);
  });
  app.addHook("onResponse", async (request) => {
    finishMutationRequest(request.id);
  });
  app.addHook("onError", async (request) => {
    finishMutationRequest(request.id);
  });
  app.addHook("onRequestAbort", async (request) => {
    finishMutationRequest(request.id);
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/v1/")) return;
    const parsed = new URL(request.url, "http://localhost");
    if (parsed.searchParams.has("token") || parsed.searchParams.has("access_token")) {
      return apiError(reply, 400, "validation_failed", "Token must not be passed in the URL");
    }
    if (
      request.method === "OPTIONS" ||
      parsed.pathname === "/api/v1/health" ||
      parsed.pathname.startsWith("/api/v1/internal/restart/") ||
      parsed.pathname === "/api/v1/events"
    )
      return;
    const token = bearerToken(request);
    if (!token || !verifyToken(token, store.snapshot().auth.tokenSha256)) {
      return apiError(reply, 401, "unauthorized", "Invalid or missing bearer token");
    }
  });

  app.get("/api/v1/health", async () => ({
    status:
      bridge.state === "ready" && (!lifecycle || lifecycle.state === "ready") ? "ok" : "degraded",
    serverVersion: SERVER_VERSION,
    recoveryState:
      lifecycle?.state ??
      (bridge.state === "ready" ? ("ready" as const) : ("unavailable" as const)),
    restartProtocolVersion: RESTART_RECOVERY_PROTOCOL_VERSION,
    transport: lifecycle?.transport ?? ("stdio" as const),
    appServer: {
      state: bridge.state,
      installedVersion: bridge.actualVersion ?? null,
      message: bridge.state === "ready" ? null : "Codex app-server is unavailable",
    },
  }));

  app.post("/api/v1/internal/restart/prepare", async (request, reply) => {
    if (!lifecycle) {
      return apiError(reply, 409, "conflict", "Restart coordination is unavailable");
    }
    if (!isLoopbackAddress(request.ip)) {
      return apiError(reply, 403, "forbidden", "Restart coordination is loopback-only");
    }
    const token = request.headers["x-codexnest-restart-token"];
    if (typeof token !== "string") {
      return apiError(reply, 403, "forbidden", "Restart token is required");
    }
    try {
      await lifecycle.prepare(token);
    } catch (error) {
      if (error instanceof RestartTokenError) {
        return apiError(reply, 403, "forbidden", error.message);
      }
      throw error;
    }
    const snapshot = store.snapshot();
    const activeTurnCount = projection
      .snapshot()
      .threads.filter((thread) => thread.currentTurnId !== null).length;
    const hasManagedWork = Object.values(snapshot.threadMeta).some((meta) =>
      Boolean(meta.teamOrchestration && Object.keys(meta.teamOrchestration.tasks).length),
    );
    const hasDispatchingMessages = Object.values(snapshot.messageQueues ?? {}).some((messages) =>
      messages.some((message) => message.status === "dispatching"),
    );
    const hasQueuedMessages = Object.values(snapshot.messageQueues ?? {}).some(
      (messages) => messages.length > 0,
    );
    const pendingToolOperationCount = Object.values(snapshot.teamToolOperations ?? {}).filter(
      (operation) => operation.status === "prepared",
    ).length;
    const pendingAttentionCount = attention.list().length;
    const hasActiveVoiceTranscriptions = Object.values(snapshot.voiceTranscriptions ?? {}).some(
      (job) => ["queued", "transcribing", "applying"].includes(job.status),
    );
    return {
      restartProtocolVersion: RESTART_RECOVERY_PROTOCOL_VERSION,
      transport: lifecycle.transport,
      appServerReady: bridge.state === "ready",
      recoveryState: lifecycle.state,
      activeTurnCount,
      hasManagedWork,
      pendingToolOperationCount,
      pendingAttentionCount,
      hasDispatchingMessages,
      hasQueuedMessages,
      hasActiveVoiceTranscriptions,
      quiescent:
        activeTurnCount === 0 &&
        !hasManagedWork &&
        pendingToolOperationCount === 0 &&
        pendingAttentionCount === 0 &&
        !hasQueuedMessages &&
        !hasActiveVoiceTranscriptions,
    };
  });

  app.post("/api/v1/internal/restart/resume", async (request, reply) => {
    if (!lifecycle) {
      return apiError(reply, 409, "conflict", "Restart coordination is unavailable");
    }
    if (!isLoopbackAddress(request.ip)) {
      return apiError(reply, 403, "forbidden", "Restart coordination is loopback-only");
    }
    const token = request.headers["x-codexnest-restart-token"];
    if (typeof token !== "string") {
      return apiError(reply, 403, "forbidden", "Restart token is required");
    }
    try {
      await lifecycle.resume(token);
    } catch (error) {
      if (error instanceof RestartTokenError) {
        return apiError(reply, 403, "forbidden", error.message);
      }
      throw error;
    }
    return reply.code(204).send();
  });

  app.get("/api/v1/summary", async () => ({
    threadCount: projection.threadCount,
    projectCount: store.snapshot().projects.length,
    pendingAttentionCount: attention.list().length,
    syncedAt: projection.lastSyncedAt,
  }));

  app.get("/api/v1/transcriptions/config", async (): Promise<TranscriptionConfigResponse> => {
    return withTranscriptionTiming(
      services.transcription?.configuration() ?? {
        providers: [],
        provider: null,
        localUrl: null,
        openAiApiKeyConfigured: false,
        openAiModel: "gpt-4o-transcribe",
        language: "ru",
        refineLocal: true,
        refinementModel: "gpt-5.6-luna",
        maxRecordingSeconds: 300,
        maxUploadBytes: MAX_TRANSCRIPTION_BYTES,
        timingEstimate: {
          sampleCount: 0,
          estimatedFixedProcessingMs: null,
          estimatedProcessingMsPerAudioSecond: null,
        },
      },
      store,
    );
  });

  app.put<{ Body: UpdateTranscriptionSettingsRequest }>(
    "/api/v1/settings/transcription",
    async (request): Promise<TranscriptionConfigResponse> => {
      if (!services.transcription) {
        throw new TranscriptionError("unavailable", "Transcription is not configured");
      }
      if (
        typeof request.body?.openAiApiKey === "string" &&
        request.protocol !== "https" &&
        !isLoopbackAddress(request.ip)
      ) {
        throw new TranscriptionError(
          "validation",
          "OpenAI API key can only be set over HTTPS or a local connection",
        );
      }
      return withTranscriptionTiming(
        await services.transcription.updateConfiguration(request.body),
        store,
      );
    },
  );

  app.post<{
    Body: Buffer;
  }>(
    "/api/v1/transcriptions",
    { bodyLimit: MAX_TRANSCRIPTION_BYTES },
    async (request, reply): Promise<TranscriptionResponse | undefined> => {
      if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
        return apiError(reply, 400, "validation_failed", "Audio body is required");
      }
      const contentType = request.headers["content-type"] ?? "";
      if (
        typeof contentType !== "string" ||
        !["audio/webm", "audio/mp4"].includes(normalizeAudioType(contentType))
      ) {
        return apiError(reply, 400, "validation_failed", "Audio must be WebM or MP4");
      }
      if (!services.transcription) {
        return apiError(reply, 503, "transcription_unavailable", "Transcription is not configured");
      }
      const audioDurationMs = parseAudioDurationHeader(
        request.headers["x-codexnest-audio-duration-ms"],
      );
      const config = withTranscriptionTiming(services.transcription.configuration(), store);
      const timingProfile = transcriptionTimingProfile(config);
      const startedAt = Date.now();
      const text = await services.transcription.transcribe(request.body, contentType);
      let timingEstimate = config.timingEstimate;
      if (audioDurationMs !== null && timingProfile) {
        const processingMs = Math.max(1, Date.now() - startedAt);
        try {
          const nextState = await store.update((state) => {
            state.transcriptionTimings ??= {};
            state.transcriptionTimings[timingProfile] = appendTranscriptionTimingSample(
              state.transcriptionTimings[timingProfile],
              { audioDurationMs, processingMs },
            );
          });
          timingEstimate = transcriptionTimingEstimate(
            nextState.transcriptionTimings?.[timingProfile],
          );
        } catch (error) {
          app.log.warn({ err: safeError(error) }, "Failed to save transcription timing");
        }
      }
      return { text, timingEstimate };
    },
  );

  app.post<{
    Params: { id: string };
    Querystring: {
      mode?: string;
      selectionStart?: string;
      selectionEnd?: string;
      draftUpdatedAt?: string;
      clientUploadId?: string;
    };
    Body: Buffer;
  }>(
    "/api/v1/threads/:id/voice-transcriptions",
    { bodyLimit: MAX_TRANSCRIPTION_BYTES },
    async (request, reply): Promise<VoiceTranscriptionJob | null | undefined> => {
      const summary = projection.summary(request.params.id);
      if (!summary) {
        return apiError(reply, 404, "not_found", "Thread not found");
      }
      assertWritableThread(summary);
      if (!voiceTranscriptions || !services.transcription) {
        return apiError(reply, 503, "transcription_unavailable", "Transcription is not configured");
      }
      if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
        return apiError(reply, 400, "validation_failed", "Audio body is required");
      }
      const normalizedType = normalizeAudioType(request.headers["content-type"] ?? "");
      if (normalizedType !== "audio/webm" && normalizedType !== "audio/mp4") {
        return apiError(reply, 400, "validation_failed", "Audio must be WebM or MP4");
      }
      if (!["draft", "send", "queue", "steer"].includes(request.query.mode ?? "")) {
        return apiError(reply, 400, "validation_failed", "Voice input mode is invalid");
      }
      const clientUploadId =
        request.query.clientUploadId === undefined
          ? undefined
          : optionalVoiceUploadId(request.query.clientUploadId);
      if (request.query.clientUploadId !== undefined && clientUploadId === null) {
        return apiError(reply, 400, "validation_failed", "Voice upload id is invalid");
      }
      const selectionStart = parseNonNegativeInteger(request.query.selectionStart);
      const selectionEnd = parseNonNegativeInteger(request.query.selectionEnd);
      if (selectionStart === null || selectionEnd === null || selectionEnd < selectionStart) {
        return apiError(reply, 400, "validation_failed", "Voice selection is invalid");
      }
      const inputLength = store.snapshot().threadMeta[request.params.id]?.draft?.input.length ?? 0;
      if (selectionStart > inputLength || selectionEnd > inputLength) {
        return apiError(reply, 400, "validation_failed", "Voice selection is outside the draft");
      }
      const expectedDraftUpdatedAt =
        request.query.draftUpdatedAt === "none"
          ? null
          : parseNonNegativeInteger(request.query.draftUpdatedAt);
      const currentDraftUpdatedAt =
        store.snapshot().threadMeta[request.params.id]?.draft?.updatedAt ?? null;
      if (
        expectedDraftUpdatedAt === null
          ? request.query.draftUpdatedAt !== "none" || currentDraftUpdatedAt !== null
          : currentDraftUpdatedAt !== expectedDraftUpdatedAt
      ) {
        return apiError(reply, 409, "conflict", "The draft changed before voice upload");
      }
      const audioDurationMs = parseAudioDurationHeader(
        request.headers["x-codexnest-audio-duration-ms"],
      );
      if (audioDurationMs === null) {
        return apiError(reply, 400, "validation_failed", "Audio duration is required");
      }
      const config = withTranscriptionTiming(services.transcription.configuration(), store);
      if (!config.provider || !config.providers.includes(config.provider)) {
        return apiError(reply, 503, "transcription_unavailable", "Transcription is not configured");
      }
      const accepted = await voiceTranscriptions.accept({
        ...(clientUploadId ? { clientUploadId } : {}),
        threadId: request.params.id,
        mode: request.query.mode as VoiceTranscriptionMode,
        audio: request.body,
        contentType: normalizedType,
        audioDurationMs,
        estimatedTotalSeconds: estimatedTranscriptionSeconds(config, audioDurationMs),
        selectionStart,
        selectionEnd,
        expectedDraftUpdatedAt,
        timingProfile: transcriptionTimingProfile(config),
      });
      return accepted ? reply.code(202).send(accepted) : reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/threads/:id/voice-transcriptions",
    async (request, reply) => {
      const summary = projection.summary(request.params.id);
      if (!summary) {
        return apiError(reply, 404, "not_found", "Thread not found");
      }
      assertWritableThread(summary);
      await voiceTranscriptions?.cancelThread(request.params.id);
      return reply.code(204).send();
    },
  );

  app.get("/api/v1/codex/rate-limits", async (): Promise<CodexRateLimitsResponse> => {
    return parseAccountRateLimits(
      await bridge.request<unknown>("account/rateLimits/read", undefined),
    );
  });

  app.get("/api/v1/settings/permissions", async () => readPermissionSettings(bridge));

  app.put<{ Body: UpdateGlobalPermissionSettingsRequest }>(
    "/api/v1/settings/permissions",
    async (request, reply) => {
      const body = validatePermissionSettings(request.body);
      const values = PERMISSION_PRESETS[body.preset];
      let writeResult: ConfigWriteResult;
      try {
        writeResult = parseConfigWriteResult(
          await bridge.request<unknown>(
            "config/batchWrite",
            compact({
              edits: [
                configEdit("sandbox_mode", values.sandboxMode),
                configEdit("approval_policy", values.approvalPolicy),
                configEdit("approvals_reviewer", values.approvalsReviewer),
              ],
              expectedVersion: body.expectedVersion ?? undefined,
              reloadUserConfig: true,
            }),
          ),
        );
      } catch (error) {
        if (isConfigVersionConflict(error)) {
          return apiError(
            reply,
            409,
            "conflict",
            "Codex configuration changed; reload settings and try again",
          );
        }
        throw error;
      }
      const effective = await readPermissionSettings(bridge);
      if (writeResult.status === "okOverridden") {
        effective.overridden = true;
        effective.message =
          writeResult.message ?? "A managed Codex configuration overrides this setting";
      }
      return effective;
    },
  );

  app.get("/api/v1/settings/task-defaults", async (): Promise<TaskDefaults> => {
    return store.snapshot().taskDefaults ?? {};
  });

  app.put<{ Body: UpdateTaskDefaultsRequest }>(
    "/api/v1/settings/task-defaults",
    async (request) => {
      const patch = validateTaskDefaults(request.body);
      const merged = mergeSettings(
        projection.newSessionSettings,
        patch,
        projection.availableModels,
      );
      const taskDefaults: TaskDefaults = {
        ...(merged.serviceTier ? { serviceTier: merged.serviceTier } : {}),
        ...(merged.personality ? { personality: merged.personality } : {}),
      };
      await projection.setTaskDefaults(taskDefaults);
      return taskDefaults;
    },
  );

  app.put<{ Body: UpdateUiLanguageRequest }>(
    "/api/v1/settings/ui-language",
    async (request): Promise<UiLanguageSettings> => {
      const body = requireRecord<Record<string, unknown>>(request.body);
      if (
        Object.keys(body).some((key) => key !== "language") ||
        !["en", "ru"].includes(String(body.language))
      ) {
        throw new ProjectValidationError("language must be en or ru");
      }
      const language = body.language as UiLanguageSettings["language"];
      await projection.setUiLanguage(language);
      return { language };
    },
  );

  app.get("/api/v1/settings/codex", async (): Promise<CodexManagementStatus> => {
    return requireCodexManager(codexManager).status();
  });

  app.post("/api/v1/settings/codex/check", async (): Promise<CodexManagementStatus> => {
    return requireCodexManager(codexManager).check();
  });

  app.put<{ Body: UpdateCodexProxyRequest }>(
    "/api/v1/settings/codex/proxy",
    async (request): Promise<CodexManagementStatus> => {
      const body = requireRecord<UpdateCodexProxyRequest>(request.body);
      if (Object.keys(body).some((key) => key !== "proxy") || typeof body.proxy !== "string") {
        throw new CodexManagementError("validation", "proxy must be a string");
      }
      try {
        return await requireCodexManager(codexManager).applyProxy(body.proxy);
      } finally {
        await queue.resume();
        resumeTeamContinuations();
      }
    },
  );

  app.post("/api/v1/settings/codex/update", async (): Promise<CodexManagementStatus> => {
    try {
      return await requireCodexManager(codexManager).update();
    } finally {
      await queue.resume();
      resumeTeamContinuations();
    }
  });

  app.post("/api/v1/settings/codex/restart", async (): Promise<CodexManagementStatus> => {
    try {
      return await requireCodexManager(codexManager).restart();
    } finally {
      await queue.resume();
      resumeTeamContinuations();
    }
  });

  app.get("/api/v1/settings/app", async (): Promise<AppUpdateStatus> => {
    return requireAppManager(appManager).status();
  });

  app.post("/api/v1/settings/app/check", async (): Promise<AppUpdateStatus> => {
    return requireAppManager(appManager).check();
  });

  app.post("/api/v1/settings/app/update", async (): Promise<AppUpdateStatus> => {
    return requireAppManager(appManager).update();
  });

  app.get<{ Querystring: { path?: string } }>("/api/v1/directories", async (request) => {
    if (request.query.path !== undefined && typeof request.query.path !== "string") {
      throw new ProjectValidationError("path must be a string");
    }
    return listDirectories(request.query.path, services.projectRoot);
  });

  app.post<{ Body: CreateDirectoryRequest }>("/api/v1/directories", async (request, reply) => {
    const body = requireRecord<CreateDirectoryRequest>(request.body);
    if (typeof body.parentPath !== "string" || typeof body.name !== "string") {
      return apiError(reply, 400, "validation_failed", "parentPath and name are required");
    }
    return reply
      .code(201)
      .send(await createDirectory(body.parentPath, body.name, services.projectRoot));
  });

  app.post<{ Body: CreateProjectRequest }>("/api/v1/projects", async (request, reply) => {
    const body = requireRecord<CreateProjectRequest>(request.body);
    if (typeof body.path !== "string") {
      return apiError(reply, 400, "validation_failed", "path is required");
    }
    const canonical = await canonicalProjectPath(body.path, services.projectRoot);
    const existing = store.snapshot().projects;
    assertUniqueProjectPath(existing, canonical);
    const project = createProject(body.path, canonical);
    await store.update((state) => {
      state.projects.push(project);
      restoreDismissedProjectPath(state, canonical);
    });
    projection.publishProject(project.id);
    return reply.code(201).send(project);
  });

  app.patch<{ Params: { id: string }; Body: UpdateProjectRequest }>(
    "/api/v1/projects/:id",
    async (request, reply) => {
      const body = requireRecord<UpdateProjectRequest>(request.body);
      const state = store.snapshot();
      const current = state.projects.find((project) => project.id === request.params.id);
      if (!current) return apiError(reply, 404, "not_found", "Project not found");
      if (body.path !== undefined && typeof body.path !== "string") {
        return apiError(reply, 400, "validation_failed", "path must be a string");
      }
      if (body.displayName !== undefined && typeof body.displayName !== "string") {
        return apiError(reply, 400, "validation_failed", "displayName must be a string");
      }
      const path =
        body.path === undefined
          ? current.path
          : await canonicalProjectPath(body.path, services.projectRoot);
      assertUniqueProjectPath(state.projects, path, current.id);
      const displayName =
        body.displayName === undefined ? current.displayName : body.displayName.trim();
      if (!displayName) return apiError(reply, 400, "validation_failed", "displayName is required");
      const updated = { ...current, displayName, path, updatedAt: new Date().toISOString() };
      await store.update((draft) => {
        draft.projects = draft.projects.map((project) =>
          project.id === current.id ? updated : project,
        );
        restoreDismissedProjectPath(draft, path);
      });
      projection.publishProject(updated.id);
      return updated;
    },
  );

  app.post<{ Params: { id: string }; Body: MoveProjectRequest }>(
    "/api/v1/projects/:id/move",
    async (request, reply) => {
      const body = requireRecord<MoveProjectRequest>(request.body);
      const hasDirection = body.direction !== undefined;
      const hasTargetIndex = body.targetIndex !== undefined;
      if (hasDirection === hasTargetIndex) {
        return apiError(
          reply,
          400,
          "validation_failed",
          "exactly one of direction or targetIndex is required",
        );
      }
      if (hasDirection && body.direction !== "up" && body.direction !== "down") {
        return apiError(reply, 400, "validation_failed", "direction must be up or down");
      }
      const projects = store.snapshot().projects;
      const index = projects.findIndex((project) => project.id === request.params.id);
      if (index < 0) return apiError(reply, 404, "not_found", "Project not found");
      let targetIndex: number;
      if (hasTargetIndex) {
        if (
          typeof body.targetIndex !== "number" ||
          !Number.isInteger(body.targetIndex) ||
          body.targetIndex < 0
        ) {
          return apiError(
            reply,
            400,
            "validation_failed",
            "targetIndex must be a non-negative integer",
          );
        }
        targetIndex = body.targetIndex;
      } else {
        targetIndex = body.direction === "up" ? index - 1 : index + 1;
      }
      if (hasTargetIndex && targetIndex >= projects.length) {
        return apiError(reply, 400, "validation_failed", "targetIndex is outside the project list");
      }
      if (targetIndex < 0 || targetIndex >= projects.length) return projects;
      if (targetIndex === index) return projects;

      const updated = await store.update((state) => {
        const currentIndex = state.projects.findIndex(
          (project) => project.id === request.params.id,
        );
        if (currentIndex < 0) throw new ProjectNotFoundError("Project not found");
        const [project] = state.projects.splice(currentIndex, 1);
        state.projects.splice(targetIndex, 0, project!);
      });
      projection.publishProjectsReordered(updated.projects);
      return updated.projects;
    },
  );

  app.delete<{ Params: { id: string } }>("/api/v1/projects/:id", async (request, reply) => {
    const project = store
      .snapshot()
      .projects.find((candidate) => candidate.id === request.params.id);
    if (!project) {
      return apiError(reply, 404, "not_found", "Project not found");
    }
    const hasActiveSessions = projection
      .snapshot()
      .threads.some(
        (thread) =>
          thread.projectId === project.id &&
          (thread.state === "running" ||
            thread.state === "needsAttention" ||
            thread.queuedMessageCount > 0),
      );
    if (hasActiveSessions) {
      return apiError(
        reply,
        409,
        "conflict",
        "Нельзя удалить проект, пока его сессии выполняются, ждут решения или содержат сообщения в очереди",
      );
    }
    await store.update((state) => {
      state.projects = state.projects.filter((candidate) => candidate.id !== project.id);
      state.dismissedProjectPaths = [
        ...new Set([...(state.dismissedProjectPaths ?? []), project.path]),
      ];
    });
    projection.removeProject(project.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/v1/projects/:id/threads", async (request, reply) => {
    if (!store.snapshot().projects.some((project) => project.id === request.params.id)) {
      return apiError(reply, 404, "not_found", "Project not found");
    }
    const thread = await getOrCreateProjectThread(request.params.id);
    return reply.code(201).send({ thread } satisfies CreateProjectThreadResponse);
  });

  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>(
    "/api/v1/threads/:id",
    async (request, reply) => {
      let observed = projection.summary(request.params.id);
      if (!observed) {
        await projection.sync();
        observed = projection.summary(request.params.id);
      }
      if (!observed) return apiError(reply, 404, "not_found", "Thread not found");
      const cursor =
        typeof request.query.cursor === "string" && request.query.cursor.length
          ? request.query.cursor
          : null;
      const detail = await projection.readThread(request.params.id, cursor);
      if (cursor === null && observed.unseen) {
        await projection.markViewed(request.params.id, observed.updatedAt);
        return {
          ...detail,
          summary: projection.summary(request.params.id) ?? detail.summary,
        };
      }
      return detail;
    },
  );

  app.post<{ Params: { id: string } }>("/api/v1/threads/:id/refresh", async (request, reply) => {
    await projection.sync();
    const observed = projection.summary(request.params.id);
    if (!observed) return apiError(reply, 404, "not_found", "Thread not found");
    await projection.invalidateHistory(request.params.id);
    const detail = await projection.readThread(request.params.id);
    if (observed.unseen) {
      await projection.markViewed(request.params.id, observed.updatedAt);
    }
    return {
      snapshot: projection.snapshot(),
      detail: {
        ...detail,
        summary: projection.summary(request.params.id) ?? detail.summary,
      },
    } satisfies RefreshThreadResponse;
  });

  app.get<{
    Params: { id: string };
    Querystring: {
      cursor?: string;
      anchorTurnId?: string;
      anchorRevision?: string;
      continuationCursor?: string;
    };
  }>("/api/v1/threads/:id/changes", async (request, reply): Promise<ThreadChanges | undefined> => {
    let observed = projection.summary(request.params.id);
    if (!observed) {
      await projection.sync();
      observed = projection.summary(request.params.id);
    }
    if (!observed) return apiError(reply, 404, "not_found", "Thread not found");
    const { cursor, anchorTurnId, anchorRevision, continuationCursor } = request.query;
    if (
      typeof cursor !== "string" ||
      !cursor ||
      typeof anchorTurnId !== "string" ||
      !anchorTurnId ||
      typeof anchorRevision !== "string" ||
      !anchorRevision ||
      (continuationCursor !== undefined &&
        (typeof continuationCursor !== "string" || !continuationCursor))
    ) {
      return apiError(reply, 400, "validation_failed", "A valid thread sync point is required");
    }
    const syncPoint: ThreadSyncPoint = { cursor, anchorTurnId, anchorRevision };
    const changes = await projection.readThreadChanges(
      request.params.id,
      syncPoint,
      continuationCursor ?? null,
    );
    if (observed.unseen) {
      await projection.markViewed(request.params.id, observed.updatedAt);
      return {
        ...changes,
        summary: projection.summary(request.params.id) ?? changes.summary,
      };
    }
    return changes;
  });

  app.put<{ Params: { id: string }; Body: UpdateThreadDraftRequest }>(
    "/api/v1/threads/:id/draft",
    { bodyLimit: CHAT_BODY_LIMIT },
    async (request, reply) => {
      const summary = projection.summary(request.params.id);
      if (!summary) {
        return apiError(reply, 404, "not_found", "Thread not found");
      }
      assertWritableThread(summary);
      if (voiceTranscriptions?.active(request.params.id)) {
        return apiError(
          reply,
          409,
          "conflict",
          "The composer is locked while voice transcription is active",
        );
      }
      await voiceTranscriptions?.clearFailure(request.params.id);
      return projection.setDraft(request.params.id, validateThreadDraft(request.body));
    },
  );

  app.get<{ Params: { id: string } }>("/api/v1/threads/:id/goal", async (request, reply) => {
    if (!projection.summary(request.params.id)) {
      return apiError(reply, 404, "not_found", "Thread not found");
    }
    return readThreadGoal(bridge, request.params.id);
  });

  app.patch<{ Params: { id: string }; Body: UpdateThreadGoalRequest }>(
    "/api/v1/threads/:id/goal",
    async (request, reply) => {
      const summary = projection.summary(request.params.id);
      if (!summary) {
        return apiError(reply, 404, "not_found", "Thread not found");
      }
      assertWritableThread(summary);
      if (summary.settings.collaborationMode === "team") {
        throw new ProjectConflictError("Team mode cannot be combined with a goal");
      }
      return setThreadGoal(bridge, request.params.id, validateGoalPatch(request.body));
    },
  );

  app.delete<{ Params: { id: string } }>("/api/v1/threads/:id/goal", async (request, reply) => {
    const summary = projection.summary(request.params.id);
    if (!summary) {
      return apiError(reply, 404, "not_found", "Thread not found");
    }
    assertWritableThread(summary);
    await clearThreadGoal(bridge, request.params.id);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>("/api/v1/threads/:id/git-changes", async (request, reply) => {
    const summary = projection.summary(request.params.id);
    if (!summary) return apiError(reply, 404, "not_found", "Thread not found");
    return readGitChanges(summary.cwd);
  });

  app.post<{ Params: { id: string }; Body: { path?: unknown } }>(
    "/api/v1/threads/:id/downloads",
    async (request, reply) => {
      const summary = projection.summary(request.params.id);
      if (!summary) return apiError(reply, 404, "not_found", "Thread not found");
      const body = requireRecord<{ path?: unknown }>(request.body);
      if (Object.keys(body).some((key) => key !== "path") || typeof body.path !== "string") {
        return apiError(reply, 400, "validation_failed", "path is required");
      }
      const file = await resolveDownloadFile(body.path, summary.cwd);
      const now = Date.now();
      removeExpiredDownloadTickets(downloadTickets, now);
      while (downloadTickets.size >= MAX_DOWNLOAD_TICKETS) {
        const oldest = downloadTickets.keys().next().value as string | undefined;
        if (!oldest) break;
        downloadTickets.delete(oldest);
      }
      const ticket = randomBytes(24).toString("base64url");
      const expiresAt = now + DOWNLOAD_TICKET_TTL_MS;
      downloadTickets.set(ticket, { ...file, expiresAt });
      return reply.code(201).send({
        downloadUrl: `/downloads/${ticket}/${encodeURIComponent(file.fileName)}`,
        expiresAt,
      });
    },
  );

  app.get<{ Params: { ticket: string; filename: string } }>(
    "/downloads/:ticket/:filename",
    async (request, reply) => {
      const now = Date.now();
      removeExpiredDownloadTickets(downloadTickets, now);
      const ticket = downloadTickets.get(request.params.ticket);
      if (!ticket) return downloadNotFound(reply);
      downloadTickets.delete(request.params.ticket);
      if (ticket.expiresAt <= now || request.params.filename !== ticket.fileName) {
        return downloadNotFound(reply);
      }
      const currentPath = await realpath(ticket.path).catch(() => null);
      if (!currentPath || currentPath !== ticket.path || !pathContains(ticket.root, currentPath)) {
        return downloadNotFound(reply);
      }
      const info = await Promise.all([stat(currentPath), access(currentPath, constants.R_OK)])
        .then(([value]) => value)
        .catch(() => null);
      if (!info?.isFile()) return downloadNotFound(reply);
      return reply
        .header("Cache-Control", "private, no-store")
        .header("Content-Disposition", attachmentDisposition(ticket.fileName))
        .header("Content-Length", info.size)
        .type("application/octet-stream")
        .send(createReadStream(currentPath));
    },
  );

  app.post<{ Body: CreateThreadRequest }>(
    "/api/v1/threads",
    { bodyLimit: CHAT_BODY_LIMIT },
    async (request, reply) => {
      codexManager?.assertTurnsAllowed();
      const body = validateThreadBody(request.body, reply);
      if (!body) return;
      if (body.clientMessageId) {
        const receipt = store.snapshot().messageReceipts?.[body.clientMessageId];
        if (receipt) {
          if (
            receipt.contentHash !==
            messageContentHash(body.input, body.images ?? [], body.goal ?? false)
          ) {
            throw new MessageQueueConflictError("Message id has already been used");
          }
          let existing = projection.summary(receipt.threadId);
          if (!existing) {
            await projection.sync();
            existing = projection.summary(receipt.threadId);
          }
          if (!existing) {
            throw new MessageQueueConflictError("The original thread is temporarily unavailable");
          }
          return reply.code(200).send({
            thread: existing,
            turnId: receipt.turnId ?? body.clientMessageId,
          });
        }
      }
      const project = store
        .snapshot()
        .projects.find((candidate) => candidate.id === body.projectId);
      if (!project) return apiError(reply, 404, "not_found", "Project not found");
      const settings = mergeSettings(
        projection.newSessionSettings,
        body.settings ?? {},
        projection.availableModels,
      );
      if (body.goal && settings.collaborationMode === "team") {
        throw new ProjectConflictError("Team mode cannot be combined with a goal");
      }
      const started = parseThreadStart(
        await bridge.request<unknown>("thread/start", {
          cwd: project.path,
          ...threadSettings(settings),
          dynamicTools: TEAM_ROOT_DYNAMIC_TOOLS,
          ...(settings.collaborationMode === "team" ? { config: teamRuntimeConfig() } : {}),
        }),
      );
      projection.upsertThread(started.thread);
      await projection.markUnmaterialized(started.thread.id);
      await markTeamToolsAvailable(store, started.thread.id);
      await projection.setSettings(started.thread.id, settings);
      const result = await startTurn(
        started.thread.id,
        body.input,
        body.images ?? [],
        body.clientMessageId ?? null,
        body.goal ?? false,
      );
      if (body.settings?.reasoningEffort !== undefined) {
        await projection.setDefaultReasoningEffort(settings.reasoningEffort);
      }
      return reply.code(201).send({
        thread: projection.summary(started.thread.id),
        ...result,
      });
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateThreadRequest }>(
    "/api/v1/threads/:id",
    async (request, reply) => {
      const body = requireRecord<UpdateThreadRequest>(request.body);
      const summary = projection.summary(request.params.id);
      if (!summary) return apiError(reply, 404, "not_found", "Thread not found");
      assertWritableThread(summary);
      if (body.name !== undefined) {
        if (typeof body.name !== "string" || !body.name.trim())
          return apiError(reply, 400, "validation_failed", "name must not be empty");
        await bridge.request("thread/name/set", {
          threadId: request.params.id,
          name: body.name.trim(),
        });
      }
      if (body.pinned !== undefined) {
        if (typeof body.pinned !== "boolean")
          return apiError(reply, 400, "validation_failed", "pinned must be boolean");
        await projection.setPinned(request.params.id, body.pinned);
      }
      return projection.summary(request.params.id);
    },
  );

  app.delete<{ Params: { id: string } }>("/api/v1/threads/:id", async (request, reply) => {
    const summary = projection.summary(request.params.id);
    if (!summary) {
      return apiError(reply, 404, "not_found", "Thread not found");
    }
    assertWritableThread(summary);
    if (teamOrchestrationHasWork(store, request.params.id)) {
      throw new ProjectConflictError(
        "Managed Team tasks must finish or be cancelled before deleting the parent session",
      );
    }
    await bridge.request("thread/delete", { threadId: request.params.id });
    await voiceTranscriptions?.cancelThread(request.params.id);
    await queue.removeThread(request.params.id);
    await projection.invalidateHistory(request.params.id).catch(() => undefined);
    await store.update((state) => {
      delete state.threadMeta[request.params.id];
    });
    return reply.code(204).send();
  });

  app.patch<{ Params: { id: string }; Body: UpdateThreadSettingsRequest }>(
    "/api/v1/threads/:id/settings",
    async (request, reply) => {
      const patch = validateSettingsPatch(request.body);
      if (Object.keys(patch).length === 0) {
        return apiError(reply, 400, "validation_failed", "At least one setting is required");
      }
      const summary = projection.summary(request.params.id);
      if (!summary) return apiError(reply, 404, "not_found", "Thread not found");
      assertWritableThread(summary);
      if (summary.currentTurnId) {
        return apiError(
          reply,
          409,
          "conflict",
          "Settings cannot be changed while a turn is running",
        );
      }
      const settings = mergeSettings(summary.settings, patch, projection.availableModels);
      if (
        settings.collaborationMode === "team" &&
        store.snapshot().threadMeta[request.params.id]?.teamToolsVersion !== TEAM_TOOLS_VERSION
      ) {
        throw new ProjectConflictError(TEAM_SESSION_UPGRADE_MESSAGE);
      }
      if (
        settings.collaborationMode === "team" &&
        summary.settings.collaborationMode !== "team" &&
        (await readThreadGoal(bridge, request.params.id))
      ) {
        throw new ProjectConflictError("Team mode cannot be combined with a goal");
      }
      if (
        settings.collaborationMode !== "team" &&
        summary.settings.collaborationMode === "team" &&
        teamOrchestrationHasWork(store, request.params.id)
      ) {
        throw new ProjectConflictError(
          "Team mode cannot be disabled while managed tasks are active or undelivered",
        );
      }
      if (settings.collaborationMode === "team" && summary.settings.collaborationMode !== "team") {
        const resumeParams = {
          threadId: request.params.id,
          cwd: summary.cwd,
          excludeTurns: true,
          ...threadSettings(settings),
          config: teamRuntimeConfig(),
        };
        try {
          await bridge.request<ThreadResumeResponse>("thread/resume", resumeParams, 30_000);
        } catch (error) {
          if (!projection.isUnmaterialized(request.params.id) || !isMissingRolloutError(error)) {
            throw error;
          }
          // Codex does not persist an empty thread until its first durable metadata update.
          // Materialize the rollout without starting a model turn or assigning a fake title.
          await bridge.request("thread/metadata/update", {
            threadId: request.params.id,
            gitInfo: { sha: null },
          });
          await bridge.request<ThreadResumeResponse>("thread/resume", resumeParams, 30_000);
        }
      }
      const thread = await projection.setSettings(request.params.id, settings);
      if (patch.reasoningEffort !== undefined) {
        await projection.setDefaultReasoningEffort(settings.reasoningEffort);
      }
      return thread;
    },
  );

  app.post<{ Params: { id: string }; Body: StartTurnRequest }>(
    "/api/v1/threads/:id/turns",
    { bodyLimit: CHAT_BODY_LIMIT },
    async (request, reply) => {
      if (voiceTranscriptions?.active(request.params.id)) {
        return apiError(
          reply,
          409,
          "conflict",
          "The composer is locked while voice transcription is active",
        );
      }
      await voiceTranscriptions?.clearFailure(request.params.id);
      const body = validateStartTurnBody(request.body, reply);
      if (!body) return;
      const summary = projection.summary(request.params.id);
      if (!summary) return apiError(reply, 404, "not_found", "Thread not found");
      assertWritableThread(summary);
      const result = await startTurn(
        request.params.id,
        body.input,
        body.images ?? [],
        body.clientMessageId ?? null,
        body.goal ?? false,
      );
      return reply.code(201).send(result);
    },
  );

  app.post<{ Params: { id: string }; Body: QueueMessageRequest }>(
    "/api/v1/threads/:id/queue",
    { bodyLimit: CHAT_BODY_LIMIT },
    async (request, reply) => {
      if (voiceTranscriptions?.active(request.params.id)) {
        return apiError(
          reply,
          409,
          "conflict",
          "The composer is locked while voice transcription is active",
        );
      }
      await voiceTranscriptions?.clearFailure(request.params.id);
      const body = requireRecord<QueueMessageRequest>(request.body);
      const images = validateImages(body.images);
      const clientMessageId = optionalClientMessageId(body.clientMessageId);
      if (typeof body.input !== "string" || (!body.input.trim() && !images.length)) {
        return apiError(reply, 400, "validation_failed", "input or images are required");
      }
      if (body.goal !== undefined && typeof body.goal !== "boolean") {
        return apiError(reply, 400, "validation_failed", "goal must be boolean");
      }
      if (body.goal && (!body.input.trim() || body.input.trim().length > 4_000)) {
        return apiError(
          reply,
          400,
          "validation_failed",
          "goal objective must be 1-4000 characters",
        );
      }
      if (body.clientMessageId !== undefined && clientMessageId === null) {
        return apiError(reply, 400, "validation_failed", "clientMessageId must not be empty");
      }
      const summary = projection.summary(request.params.id);
      if (!summary) {
        return apiError(reply, 404, "not_found", "Thread not found");
      }
      assertWritableThread(summary);
      const message = await queue.enqueue(
        request.params.id,
        body.input,
        images,
        clientMessageId ?? undefined,
        { goal: body.goal },
      );
      return reply.code(202).send(message satisfies QueuedMessage);
    },
  );

  app.post<{ Params: { id: string; messageId: string } }>(
    "/api/v1/threads/:id/queue/:messageId/send",
    async (request, reply) => {
      const summary = projection.summary(request.params.id);
      if (!summary) return apiError(reply, 404, "not_found", "Thread not found");
      assertWritableThread(summary);
      return { turnId: await queue.sendNow(request.params.id, request.params.messageId) };
    },
  );

  app.patch<{
    Params: { id: string; messageId: string };
    Body: UpdateQueuedMessageRequest;
  }>(
    "/api/v1/threads/:id/queue/:messageId",
    { bodyLimit: CHAT_BODY_LIMIT },
    async (request, reply) => {
      const summary = projection.summary(request.params.id);
      if (!summary) return apiError(reply, 404, "not_found", "Thread not found");
      assertWritableThread(summary);
      const body = requireRecord<UpdateQueuedMessageRequest>(request.body);
      if (typeof body.input !== "string") {
        return apiError(reply, 400, "validation_failed", "input must be a string");
      }
      return queue.update(request.params.id, request.params.messageId, body.input);
    },
  );

  app.delete<{ Params: { id: string; messageId: string } }>(
    "/api/v1/threads/:id/queue/:messageId",
    async (request, reply) => {
      const summary = projection.summary(request.params.id);
      if (!summary) return apiError(reply, 404, "not_found", "Thread not found");
      assertWritableThread(summary);
      await queue.cancel(request.params.id, request.params.messageId);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string }; Body: SteerTurnRequest }>(
    "/api/v1/threads/:id/steer",
    { bodyLimit: CHAT_BODY_LIMIT },
    async (request, reply) => {
      const summary = projection.summary(request.params.id);
      if (!summary) return apiError(reply, 404, "not_found", "Thread not found");
      assertWritableThread(summary);
      if (voiceTranscriptions?.active(request.params.id)) {
        return apiError(
          reply,
          409,
          "conflict",
          "The composer is locked while voice transcription is active",
        );
      }
      await voiceTranscriptions?.clearFailure(request.params.id);
      const body = requireRecord<SteerTurnRequest>(request.body);
      const images = validateImages(body.images);
      if (
        typeof body.turnId !== "string" ||
        typeof body.input !== "string" ||
        (!body.input.trim() && !images.length)
      ) {
        return apiError(reply, 400, "validation_failed", "turnId and input or images are required");
      }
      return {
        turnId: await steerTurn(request.params.id, body.turnId, body.input, images, null),
      };
    },
  );

  app.post<{ Params: { id: string }; Body: InterruptTurnRequest }>(
    "/api/v1/threads/:id/interrupt",
    async (request, reply) => {
      const summary = projection.summary(request.params.id);
      if (!summary) return apiError(reply, 404, "not_found", "Thread not found");
      assertWritableThread(summary);
      const body = requireRecord<InterruptTurnRequest>(request.body);
      if (typeof body.turnId !== "string")
        return apiError(reply, 400, "validation_failed", "turnId is required");
      await bridge.request("turn/interrupt", { threadId: request.params.id, turnId: body.turnId });
      return reply.code(204).send();
    },
  );

  for (const [route, method] of [
    ["archive", "thread/archive"],
    ["unarchive", "thread/unarchive"],
  ] as const) {
    app.post<{ Params: { id: string } }>(`/api/v1/threads/:id/${route}`, async (request, reply) => {
      const summary = projection.summary(request.params.id);
      if (!summary) return apiError(reply, 404, "not_found", "Thread not found");
      assertWritableThread(summary);
      await bridge.request(method, { threadId: request.params.id });
      return reply.code(204).send();
    });
  }

  app.put<{ Params: { id: string }; Body: MarkReadRequest }>(
    "/api/v1/threads/:id/read",
    async (request, reply) => {
      const body = requireRecord<MarkReadRequest>(request.body);
      if (typeof body.observedUpdatedAt !== "number")
        return apiError(reply, 400, "validation_failed", "observedUpdatedAt is required");
      if (!projection.summary(request.params.id))
        return apiError(reply, 404, "not_found", "Thread not found");
      await projection.markRead(request.params.id, body.observedUpdatedAt);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { attentionId: string }; Body: AttentionResponse }>(
    "/api/v1/attention/:attentionId/respond",
    async (request, reply) => {
      const body = requireRecord<AttentionResponse>(request.body);
      const resolved = attention.resolve(request.params.attentionId, body);
      if (!resolved) {
        return apiError(
          reply,
          409,
          "conflict",
          "Attention request has already been resolved or expired",
        );
      }
      await projection.recordAttentionResponse(resolved, body);
      return reply.code(204).send();
    },
  );

  app.put<{ Params: { installationId: string }; Body: DeviceRegistrationRequest }>(
    "/api/v1/devices/:installationId",
    async (request, reply) => {
      const body = requireRecord<DeviceRegistrationRequest>(request.body);
      if (
        !validInstallationId(request.params.installationId) ||
        typeof body.fcmToken !== "string" ||
        !body.fcmToken.trim()
      ) {
        return apiError(reply, 400, "validation_failed", "Invalid installationId or fcmToken");
      }
      await store.update((state) => {
        state.devices[request.params.installationId] = {
          fcmToken: body.fcmToken,
          updatedAt: Date.now(),
        };
      });
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { installationId: string } }>(
    "/api/v1/devices/:installationId",
    async (request, reply) => {
      await store.update((state) => {
        delete state.devices[request.params.installationId];
      });
      return reply.code(204).send();
    },
  );

  app.post("/api/v1/sync", async (_request, reply) => {
    await projection.sync();
    return reply.send(projection.snapshot());
  });

  app.setErrorHandler((error: Error, request, reply) => {
    request.log.error({ errorName: error.name }, "request failed");
    if (error instanceof BridgeUnavailableError) {
      return apiError(reply, 503, "app_server_unavailable", error.message);
    }
    if (error instanceof TranscriptionError) {
      if (error.kind === "validation") {
        return apiError(reply, 400, "validation_failed", error.message);
      }
      return apiError(
        reply,
        error.kind === "unavailable" ? 503 : 502,
        error.kind === "unavailable" ? "transcription_unavailable" : "transcription_failed",
        error.message,
      );
    }
    if ("statusCode" in error && error.statusCode === 413) {
      return apiError(reply, 413, "payload_too_large", "Audio recording is too large");
    }
    if (error instanceof ProjectValidationError || error instanceof AttentionValidationError) {
      return apiError(reply, 400, "validation_failed", error.message);
    }
    if (error instanceof ProjectForbiddenError)
      return apiError(reply, 403, "forbidden", error.message);
    if (error instanceof ProjectNotFoundError)
      return apiError(reply, 404, "not_found", error.message);
    if (error instanceof MessageQueueNotFoundError)
      return apiError(reply, 404, "not_found", error.message);
    if (error instanceof MessageQueueValidationError)
      return apiError(reply, 400, "validation_failed", error.message);
    if (error instanceof MessageQueuePausedError || error instanceof MessageQueueConflictError)
      return apiError(reply, 409, "conflict", error.message);
    if (
      error instanceof VoiceTranscriptionConflictError ||
      error instanceof VoiceTranscriptionQueueFullError
    ) {
      return apiError(reply, 409, "conflict", error.message);
    }
    if (error instanceof CodexManagementError) {
      if (error.kind === "validation")
        return apiError(reply, 400, "validation_failed", error.message);
      if (error.kind === "failed")
        return apiError(reply, 503, "app_server_unavailable", error.message);
      return apiError(reply, 409, "conflict", error.message);
    }
    if (error instanceof AppManagementError) {
      if (error.kind === "failed")
        return apiError(reply, 503, "app_server_unavailable", error.message);
      return apiError(reply, 409, "conflict", error.message);
    }
    if (error instanceof ProjectConflictError)
      return apiError(reply, 409, "conflict", error.message);
    return apiError(reply, 500, "internal_error", "Internal server error");
  });
}

async function handleManagedTeamToolCall(
  request: Extract<ServerRequest, { method: "item/tool/call" }>,
  bridge: CodexBridge,
  store: StateStore,
  projection: AppProjection,
): Promise<DynamicToolCallResponse> {
  const { threadId, callId, tool } = request.params;
  const args = dynamicToolArguments(request.params.arguments);
  const prepared = isMutatingTeamTool(tool)
    ? await prepareTeamToolOperation(store, request, args)
    : null;
  if (prepared?.conflict) {
    return dynamicToolError("This Team tool call id has already been used with other arguments");
  }
  if (prepared?.operation.status === "applied" && prepared.operation.response) {
    return prepared.operation.response;
  }
  const finish = async (response: DynamicToolCallResponse): Promise<DynamicToolCallResponse> => {
    if (prepared) {
      await completeTeamToolOperation(store, prepared.key, response);
    }
    return response;
  };

  if (tool === "submit_result") {
    const managed = managedTaskForChild(store.snapshot(), threadId);
    if (!managed) return finish(dynamicToolError("This thread is not a managed Team task"));
    const summary = requiredToolString(args, "summary");
    const details = optionalToolString(args, "details");
    let accepted = false;
    await store.update((state) => {
      const task =
        state.threadMeta[managed.parentThreadId]?.teamOrchestration?.tasks[managed.task.id];
      if (!task) return;
      if (task.resultCandidate?.callId === callId) {
        accepted = true;
        return;
      }
      if (isTerminalTask(task)) return;
      task.resultCandidate = {
        summary,
        ...(details ? { details } : {}),
        submittedAt: Date.now(),
        callId,
      };
      task.lastActivityAt = Date.now();
      delete task.watchdog;
      accepted = true;
    });
    return finish(
      accepted
        ? dynamicToolSuccess({ accepted: true })
        : dynamicToolError("The managed task is already terminal"),
    );
  }

  const parent = projection.summary(threadId);
  if (
    !parent ||
    parent.relation.kind !== "session" ||
    parent.settings.collaborationMode !== "team"
  ) {
    return finish(
      dynamicToolError("Managed task tools are only available to a Team parent session"),
    );
  }

  if (tool === "spawn_task") {
    const title = requiredToolString(args, "title");
    const prompt = requiredToolString(args, "prompt");
    const operation = prepared!.operation;
    const taskId = operation.taskId!;
    const childThreadSource = operation.childThreadSource!;
    let task = store.snapshot().threadMeta[threadId]?.teamOrchestration?.tasks[taskId];
    if (!task) {
      const recoveredThread = prepared!.created
        ? null
        : await findManagedThreadBySource(bridge, childThreadSource);
      if (!prepared!.created && !recoveredThread) {
        return finish(
          dynamicToolError(
            "The previous child creation is ambiguous; no replacement thread was created",
          ),
        );
      }
      try {
        task = await createManagedTeamTask(
          bridge,
          store,
          projection,
          parent,
          title,
          prompt,
          taskId,
          childThreadSource,
          recoveredThread,
        );
      } catch (error) {
        const recoveredAfterError = await findManagedThreadBySource(bridge, childThreadSource);
        if (!recoveredAfterError) {
          return finish(
            dynamicToolError(`Managed task creation failed: ${safeError(error).message}`),
          );
        }
        task = await createManagedTeamTask(
          bridge,
          store,
          projection,
          parent,
          title,
          prompt,
          taskId,
          childThreadSource,
          recoveredAfterError,
        );
      }
    }
    return finish(
      dynamicToolSuccess({
        taskId: task.id,
        threadId: task.childThreadId,
        status: task.status,
      }),
    );
  }

  if (tool === "list_tasks") {
    const tasks = Object.values(
      store.snapshot().threadMeta[threadId]?.teamOrchestration?.tasks ?? {},
    )
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(publicManagedTask);
    return dynamicToolSuccess({ tasks });
  }

  const taskId = requiredToolString(args, "taskId");
  const task = store.snapshot().threadMeta[threadId]?.teamOrchestration?.tasks[taskId];
  if (!task) return finish(dynamicToolError("Managed task not found"));

  if (tool === "inspect_task") {
    let recentMessages: string[] = [];
    try {
      const page = parseTurnsList(
        await bridge.request<unknown>(
          "thread/turns/list",
          {
            threadId: task.childThreadId,
            limit: 1,
            sortDirection: "desc",
            itemsView: "full",
          },
          30_000,
        ),
      );
      recentMessages = (page.data[0]?.items ?? [])
        .filter(
          (item): item is Extract<ThreadItem, { type: "agentMessage" }> =>
            item.type === "agentMessage",
        )
        .map((item) => item.text.trim())
        .filter(Boolean)
        .slice(-3);
    } catch {
      // The persisted coordinator state is still useful when detailed history is unavailable.
    }
    return dynamicToolSuccess({ ...publicManagedTask(task), recentMessages });
  }

  if (tool === "steer_task") {
    if (task.status !== "running" || !task.childTurnId) {
      return finish(dynamicToolError("Only a running managed task can be steered"));
    }
    const message = requiredToolString(args, "message");
    const markerId = teamToolMarkerId(prepared!.key);
    let resultTurnId: string | null = null;
    if (!prepared!.created) {
      resultTurnId = await deliveredClientMessageTurnId(bridge, task.childThreadId, markerId);
      if (!resultTurnId) {
        return finish(
          dynamicToolError(
            "The previous steer delivery is ambiguous; inspect the task before steering again",
          ),
        );
      }
    } else {
      try {
        resultTurnId = parseTurnSteer(
          await bridge.request<unknown>("turn/steer", {
            threadId: task.childThreadId,
            expectedTurnId: task.childTurnId,
            clientUserMessageId: markerId,
            input: messageInput(message, []),
          }),
        ).turnId;
      } catch (error) {
        let recovered: string | null;
        try {
          recovered = await deliveredClientMessageTurnId(bridge, task.childThreadId, markerId);
        } catch {
          throw error;
        }
        if (!recovered) {
          return finish(
            dynamicToolError(
              "The steer request was not confirmed; inspect the task before retrying",
            ),
          );
        }
        resultTurnId = recovered;
      }
    }
    await store.update((state) => {
      const current = state.threadMeta[threadId]?.teamOrchestration?.tasks[taskId];
      if (!current || isTerminalTask(current)) return;
      current.childTurnId = resultTurnId!;
      current.lastActivityAt = Date.now();
      delete current.watchdog;
    });
    return finish(dynamicToolSuccess({ accepted: true, turnId: resultTurnId }));
  }

  if (tool === "cancel_task") {
    if (isTerminalTask(task)) {
      return finish(dynamicToolSuccess({ accepted: true, status: task.status }));
    }
    if (task.childTurnId) {
      await bridge.request("turn/interrupt", {
        threadId: task.childThreadId,
        turnId: task.childTurnId,
      });
    }
    const reason = optionalToolString(args, "reason");
    await finalizeManagedTask(store, task.childThreadId, `cancelled:${Date.now()}`, "interrupted", {
      summary: reason ? `Task cancelled: ${reason}` : "Task cancelled by the parent agent.",
      source: "status",
    });
    return finish(dynamicToolSuccess({ accepted: true, status: "interrupted" }));
  }

  return finish(dynamicToolError(`Unknown CodexNest tool: ${tool}`));
}

async function createManagedTeamTask(
  bridge: CodexBridge,
  store: StateStore,
  projection: AppProjection,
  parent: ThreadSummary,
  title: string,
  prompt: string,
  taskId: string,
  childThreadSource: string,
  recoveredThread: Thread | null,
): Promise<ManagedTeamTaskState> {
  if (store.snapshot().threadMeta[parent.id]?.teamToolsVersion !== TEAM_TOOLS_VERSION) {
    throw new ProjectConflictError("This Team session does not have managed tools");
  }
  const started = recoveredThread
    ? { thread: recoveredThread }
    : parseThreadStart(
        await bridge.request<unknown>("thread/start", {
          cwd: parent.cwd,
          ...threadSettings(parent.settings),
          config: teamRuntimeConfig(),
          developerInstructions: TEAM_CHILD_INSTRUCTIONS,
          dynamicTools: TEAM_CHILD_DYNAMIC_TOOLS,
          threadSource: childThreadSource,
        }),
      );
  projection.upsertThread(started.thread);
  await projection.markUnmaterialized(started.thread.id);
  await bridge
    .request("thread/name/set", { threadId: started.thread.id, name: title })
    .catch(() => undefined);
  const now = Date.now();
  const task: ManagedTeamTaskState = {
    id: taskId,
    childThreadId: started.thread.id,
    childThreadSource,
    startMessageId: teamTaskStartMarkerId(taskId),
    title,
    prompt,
    status: "queued",
    createdAt: now,
    lastActivityAt: now,
  };
  await store.update((state) => {
    const parentMeta = state.threadMeta[parent.id] ?? {
      pinned: false,
      lastReadUpdatedAt: 0,
    };
    parentMeta.teamOrchestration ??= { tasks: {} };
    parentMeta.teamOrchestration.tasks[task.id] = task;
    state.threadMeta[parent.id] = parentMeta;
    const childMeta = state.threadMeta[task.childThreadId] ?? {
      pinned: false,
      lastReadUpdatedAt: 0,
    };
    childMeta.managedParent = { parentThreadId: parent.id, taskId: task.id };
    state.threadMeta[task.childThreadId] = childMeta;
  });
  projection.publishThreadState(task.childThreadId);
  return task;
}

async function startQueuedTeamTasks(
  bridge: CodexBridge,
  store: StateStore,
  projection: AppProjection,
  parentThreadId: string,
): Promise<void> {
  while (true) {
    const orchestration = store.snapshot().threadMeta[parentThreadId]?.teamOrchestration;
    if (!orchestration) return;
    const active = Object.values(orchestration.tasks).filter(
      (task) => task.status === "starting" || task.status === "running",
    ).length;
    if (active >= TEAM_MAX_ACTIVE_TASKS) return;
    const queued = Object.values(orchestration.tasks)
      .filter((task) => task.status === "queued")
      .sort((left, right) => left.createdAt - right.createdAt)[0];
    if (!queued) return;

    await store.update((state) => {
      const task = state.threadMeta[parentThreadId]?.teamOrchestration?.tasks[queued.id];
      if (task?.status === "queued") {
        task.status = "starting";
        task.lastActivityAt = Date.now();
      }
    });
    projection.publishThreadState(queued.childThreadId);

    try {
      const parent = projection.summary(parentThreadId);
      if (!parent) throw new Error("Managed task parent is unavailable");
      await bridge.request<ThreadResumeResponse>(
        "thread/resume",
        {
          threadId: queued.childThreadId,
          cwd: parent.cwd,
          excludeTurns: true,
          ...threadSettings(parent.settings),
          config: teamRuntimeConfig(),
          developerInstructions: TEAM_CHILD_INSTRUCTIONS,
        },
        30_000,
      );
      const turn = parseTurnStart(
        await bridge.request<unknown>("turn/start", {
          threadId: queued.childThreadId,
          clientUserMessageId: queued.startMessageId ?? teamTaskStartMarkerId(queued.id),
          input: messageInput(queued.prompt, []),
          ...managedChildTurnSettings(parent.settings, projection.availableModels),
        }),
      );
      await projection.markMaterialized(queued.childThreadId);
      await projection.setCurrentTurn(queued.childThreadId, turn.turn.id);
      await store.update((state) => {
        const task = state.threadMeta[parentThreadId]?.teamOrchestration?.tasks[queued.id];
        if (!task || task.status !== "starting") return;
        const now = Date.now();
        task.status = "running";
        task.childTurnId = turn.turn.id;
        task.startedAt = now;
        task.lastActivityAt = now;
        delete task.recoveryMisses;
      });
    } catch (error) {
      let recoveredTurnId: string | null;
      try {
        recoveredTurnId = await deliveredClientMessageTurnId(
          bridge,
          queued.childThreadId,
          queued.startMessageId ?? teamTaskStartMarkerId(queued.id),
        );
      } catch {
        // Keep "starting" durable while the bridge is ambiguous; cold recovery will retry.
        projection.publishThreadState(queued.childThreadId);
        return;
      }
      if (recoveredTurnId) {
        await projection.markMaterialized(queued.childThreadId);
        await projection.setCurrentTurn(queued.childThreadId, recoveredTurnId);
        await store.update((state) => {
          const task = state.threadMeta[parentThreadId]?.teamOrchestration?.tasks[queued.id];
          if (!task || isTerminalTask(task)) return;
          const now = Date.now();
          task.status = "running";
          task.childTurnId = recoveredTurnId!;
          task.startedAt ??= now;
          task.lastActivityAt = now;
        });
      } else {
        await finalizeManagedTask(
          store,
          queued.childThreadId,
          `start-error:${Date.now()}`,
          "failed",
          {
            summary: `Managed task failed to start: ${safeError(error).message}`,
            source: "status",
          },
        );
      }
    }
    projection.publishThreadState(queued.childThreadId);
  }
}

async function handleManagedTeamNotification(
  notification: ServerNotification,
  bridge: CodexBridge,
  store: StateStore,
  projection: AppProjection,
  activity: Map<string, number>,
): Promise<Set<string>> {
  const affected = new Set<string>();
  const childThreadId = notificationThreadId(notification);
  if (!childThreadId) return affected;
  const managed = managedTaskForChild(store.snapshot(), childThreadId);
  if (!managed) return affected;
  const now = activity.get(childThreadId) ?? Date.now();
  if (now - managed.task.lastActivityAt >= TEAM_ACTIVITY_PERSIST_MS) {
    await store.update((state) => {
      const task =
        state.threadMeta[managed.parentThreadId]?.teamOrchestration?.tasks[managed.task.id];
      if (!task || isTerminalTask(task)) return;
      task.lastActivityAt = now;
      delete task.watchdog;
    });
  }

  if (notification.method === "turn/completed") {
    let turn = notification.params.turn;
    if (!managed.task.resultCandidate && turn.itemsView !== "full") {
      const page = parseTurnsList(
        await bridge.request<unknown>(
          "thread/turns/list",
          {
            threadId: childThreadId,
            limit: 1,
            sortDirection: "desc",
            itemsView: "full",
          },
          30_000,
        ),
      );
      turn = page.data[0] ?? turn;
    }
    const result =
      managed.task.resultCandidate !== undefined
        ? submittedManagedResult(managed.task)
        : managedResultFromTurn(turn, turnOutcome(turn));
    if (await finalizeManagedTask(store, childThreadId, turn.id, turnOutcome(turn), result)) {
      affected.add(managed.parentThreadId);
    }
    return affected;
  }

  if (
    notification.method === "thread/status/changed" &&
    notification.params.status.type === "systemError"
  ) {
    if (
      await finalizeManagedTask(store, childThreadId, `system-error:${Date.now()}`, "failed", {
        summary: "Managed task stopped because the Codex thread entered a system error state.",
        source: "status",
      })
    ) {
      affected.add(managed.parentThreadId);
    }
  } else if (notification.method === "thread/closed" || notification.method === "thread/deleted") {
    const outcome = notification.method === "thread/deleted" ? "failed" : "interrupted";
    if (
      await finalizeManagedTask(
        store,
        childThreadId,
        `${notification.method}:${Date.now()}`,
        outcome,
        {
          summary:
            notification.method === "thread/deleted"
              ? "Managed task thread was deleted."
              : "Managed task thread was closed.",
          source: "status",
        },
      )
    ) {
      affected.add(managed.parentThreadId);
    }
  }
  return affected;
}

async function finalizeManagedTask(
  store: StateStore,
  childThreadId: string,
  terminalTurnId: string,
  outcome: ThreadOutcome,
  result: ManagedTeamTaskResult,
): Promise<boolean> {
  const managed = managedTaskForChild(store.snapshot(), childThreadId);
  if (!managed || isTerminalTask(managed.task)) return false;
  let recorded = false;
  await store.update((state) => {
    const task =
      state.threadMeta[managed.parentThreadId]?.teamOrchestration?.tasks[managed.task.id];
    if (!task || isTerminalTask(task)) return;
    task.status = outcome;
    task.terminalTurnId = terminalTurnId;
    task.result = result;
    task.lastActivityAt = Date.now();
    delete task.watchdog;
    delete task.delivery;
    delete task.recoveryMisses;
    const childMeta = state.threadMeta[childThreadId];
    if (childMeta) {
      childMeta.lastOutcome = outcome;
      childMeta.outcomeUpdatedAt = Date.now();
    }
    recorded = true;
  });
  return recorded;
}

async function claimTeamResults(
  store: StateStore,
  parentThreadId: string,
): Promise<TeamResultClaim | null> {
  if (!hasPendingTeamContinuation(store, parentThreadId)) return null;
  const claimId = randomBytes(16).toString("hex");
  const results: TeamResultClaim["results"] = [];
  const watchdogs: TeamResultClaim["watchdogs"] = [];
  await store.update((state) => {
    const orchestration = state.threadMeta[parentThreadId]?.teamOrchestration;
    if (!orchestration) return;
    for (const task of Object.values(orchestration.tasks)) {
      if (isTerminalTask(task) && task.terminalTurnId && task.result && !task.delivery) {
        task.delivery = { status: "claimed", claimId };
        results.push({
          taskId: task.id,
          childThreadId: task.childThreadId,
          terminalTurnId: task.terminalTurnId,
          outcome: task.status,
          title: task.title,
          result: task.result,
        });
      }
      if (task.watchdog?.status === "pending") {
        task.watchdog = { ...task.watchdog, status: "claimed", claimId };
        watchdogs.push({
          taskId: task.id,
          childThreadId: task.childThreadId,
          title: task.title,
          status: task.status,
          lastActivityAt: task.lastActivityAt,
        });
      }
    }
  });
  return results.length || watchdogs.length ? { claimId, results, watchdogs } : null;
}

async function markTeamClaimDispatch(
  store: StateStore,
  parentThreadId: string,
  claimId: string,
  markerId: string,
  context: string,
): Promise<void> {
  await store.update((state) => {
    const orchestration = state.threadMeta[parentThreadId]?.teamOrchestration;
    if (!orchestration) return;
    const dispatchStartedAt = Date.now();
    const contextHash = sha256(context);
    for (const task of Object.values(orchestration.tasks)) {
      if (task.delivery?.status === "claimed" && task.delivery.claimId === claimId) {
        task.delivery = {
          ...task.delivery,
          markerId,
          dispatchStartedAt,
          contextHash,
        };
      }
      if (task.watchdog?.status === "claimed" && task.watchdog.claimId === claimId) {
        task.watchdog = {
          ...task.watchdog,
          markerId,
          dispatchStartedAt,
          contextHash,
        };
      }
    }
  });
}

async function deliverTeamClaim(
  store: StateStore,
  parentThreadId: string,
  claimId: string,
  parentTurnId: string,
): Promise<void> {
  await store.update((state) => {
    const orchestration = state.threadMeta[parentThreadId]?.teamOrchestration;
    if (!orchestration) return;
    for (const task of Object.values(orchestration.tasks)) {
      if (task.delivery?.status === "claimed" && task.delivery.claimId === claimId) {
        task.delivery = { ...task.delivery, status: "delivered", parentTurnId };
      }
      if (task.watchdog?.status === "claimed" && task.watchdog.claimId === claimId) {
        delete task.watchdog;
      }
    }
    cleanupTeamOrchestration(state, parentThreadId);
  });
}

async function releaseTeamClaim(
  store: StateStore,
  parentThreadId: string,
  claimId: string,
): Promise<void> {
  await store.update((state) => {
    const orchestration = state.threadMeta[parentThreadId]?.teamOrchestration;
    if (!orchestration) return;
    for (const task of Object.values(orchestration.tasks)) {
      if (task.delivery?.status === "claimed" && task.delivery.claimId === claimId) {
        delete task.delivery;
      }
      if (task.watchdog?.status === "claimed" && task.watchdog.claimId === claimId) {
        task.watchdog = { status: "pending", triggeredAt: task.watchdog.triggeredAt };
      }
    }
  });
}

function cleanupTeamOrchestration(state: CodexNestState, parentThreadId: string): void {
  const meta = state.threadMeta[parentThreadId];
  const orchestration = meta?.teamOrchestration;
  if (!orchestration) return;
  for (const [taskId, task] of Object.entries(orchestration.tasks)) {
    if (isTerminalTask(task) && task.delivery?.status === "delivered" && !task.watchdog) {
      delete orchestration.tasks[taskId];
    }
  }
  if (!Object.keys(orchestration.tasks).length) delete meta!.teamOrchestration;
}

function hasPendingTeamContinuation(store: StateStore, parentThreadId: string): boolean {
  const orchestration = store.snapshot().threadMeta[parentThreadId]?.teamOrchestration;
  return Boolean(
    orchestration &&
    Object.values(orchestration.tasks).some(
      (task) =>
        (isTerminalTask(task) &&
          Boolean(task.terminalTurnId) &&
          Boolean(task.result) &&
          task.delivery === undefined) ||
        task.watchdog?.status === "pending",
    ),
  );
}

function hasClaimedTeamContinuation(store: StateStore, parentThreadId: string): boolean {
  const orchestration = store.snapshot().threadMeta[parentThreadId]?.teamOrchestration;
  return Boolean(
    orchestration &&
    Object.values(orchestration.tasks).some(
      (task) => task.delivery?.status === "claimed" || task.watchdog?.status === "claimed",
    ),
  );
}

function pendingTeamParents(store: StateStore): string[] {
  const state = store.snapshot();
  return Object.entries(state.threadMeta)
    .filter(([, meta]) => Boolean(meta.teamOrchestration))
    .map(([threadId]) => threadId);
}

function teamContinuationContext(
  store: StateStore,
  parentThreadId: string,
  claim: TeamResultClaim,
): string {
  const state = store.snapshot();
  const active = Object.values(state.threadMeta[parentThreadId]?.teamOrchestration?.tasks ?? {})
    .filter((task) => task.status === "starting" || task.status === "running")
    .map((task) => `${task.title} [${task.id}]`);
  const queued = Object.values(state.threadMeta[parentThreadId]?.teamOrchestration?.tasks ?? {})
    .filter((task) => task.status === "queued")
    .map((task) => `${task.title} [${task.id}]`);
  const resultSections = claim.results.map((item) =>
    [
      `Task: ${item.title} [${item.taskId}]`,
      `Outcome: ${item.outcome}`,
      `Source: ${item.result.source}`,
      `Summary: ${item.result.summary}`,
      ...(item.result.details ? [`Details:\n${item.result.details}`] : []),
    ].join("\n"),
  );
  const watchdogSections = claim.watchdogs.map(
    (item) =>
      `Silent task: ${item.title} [${item.taskId}], status=${item.status}, last activity=${new Date(item.lastActivityAt).toISOString()}. Inspect it, steer it, cancel it, or end the turn and let CodexNest continue automatically after its next event.`,
  );
  return [
    "CodexNest orchestration continuation.",
    ...(resultSections.length ? ["New terminal managed-task results:", ...resultSections] : []),
    ...(watchdogSections.length ? ["Managed-task watchdog:", ...watchdogSections] : []),
    active.length
      ? `Managed tasks still running: ${active.join(", ")}.`
      : "No managed tasks are currently running.",
    ...(queued.length ? [`Managed tasks queued: ${queued.join(", ")}.`] : []),
    "If this turn also contains an explicit user message, answer the user first.",
    "Then incorporate every named result into the original task, decide the next concrete action, and continue working.",
    "Do not merely acknowledge the result or say that you are waiting.",
  ].join(" ");
}

async function reconcileTeamOrchestration(
  bridge: CodexBridge,
  store: StateStore,
  projection: AppProjection,
): Promise<Set<string>> {
  const affected = new Set<string>();
  const state = store.snapshot();
  for (const [parentThreadId, meta] of Object.entries(state.threadMeta)) {
    const orchestration = meta.teamOrchestration;
    if (!orchestration) continue;
    const parent = projection.summary(parentThreadId);
    const claimedById = new Map<
      string,
      { results: TeamResultClaim["results"]; markerId: string | null }
    >();
    for (const task of Object.values(orchestration.tasks)) {
      if (task.delivery?.status === "claimed") {
        const claim = claimedById.get(task.delivery.claimId) ?? {
          results: [],
          markerId: task.delivery.markerId ?? null,
        };
        if (isTerminalTask(task) && task.terminalTurnId && task.result) {
          claim.results.push({
            taskId: task.id,
            childThreadId: task.childThreadId,
            terminalTurnId: task.terminalTurnId,
            outcome: task.status,
            title: task.title,
            result: task.result,
          });
        }
        claim.markerId ??= task.delivery.markerId ?? null;
        claimedById.set(task.delivery.claimId, claim);
      }
      if (task.watchdog?.status === "claimed" && task.watchdog.claimId) {
        const claim = claimedById.get(task.watchdog.claimId) ?? {
          results: [],
          markerId: task.watchdog.markerId ?? null,
        };
        claim.markerId ??= task.watchdog.markerId ?? null;
        claimedById.set(task.watchdog.claimId, claim);
      }
      if (task.status !== "running" && task.status !== "starting") continue;
      const summary = projection.summary(task.childThreadId);
      if (summary?.currentTurnId) {
        await store.update((draft) => {
          const current = draft.threadMeta[parentThreadId]?.teamOrchestration?.tasks[task.id];
          if (!current || isTerminalTask(current)) return;
          current.status = "running";
          current.childTurnId = summary.currentTurnId!;
          current.startedAt ??= Date.now();
          current.lastActivityAt = Date.now();
          delete current.recoveryMisses;
        });
        continue;
      }
      try {
        const page = parseTurnsList(
          await bridge.request<unknown>(
            "thread/turns/list",
            {
              threadId: task.childThreadId,
              limit: 1,
              sortDirection: "desc",
              itemsView: "full",
            },
            30_000,
          ),
        );
        const latest = page.data[0];
        if (latest && latest.status !== "inProgress") {
          const result = task.resultCandidate
            ? submittedManagedResult(task)
            : managedResultFromTurn(latest, turnOutcome(latest));
          if (
            await finalizeManagedTask(
              store,
              task.childThreadId,
              latest.id,
              turnOutcome(latest),
              result,
            )
          ) {
            affected.add(parentThreadId);
          }
        } else if (latest?.status === "inProgress") {
          await projection.setCurrentTurn(task.childThreadId, latest.id);
          await store.update((draft) => {
            const current = draft.threadMeta[parentThreadId]?.teamOrchestration?.tasks[task.id];
            if (!current || isTerminalTask(current)) return;
            current.status = "running";
            current.childTurnId = latest.id;
            current.startedAt ??= Date.now();
            current.lastActivityAt = Date.now();
            delete current.recoveryMisses;
          });
        } else if (!latest && task.status === "starting") {
          await store.update((draft) => {
            const current = draft.threadMeta[parentThreadId]?.teamOrchestration?.tasks[task.id];
            if (current?.status === "starting") current.status = "queued";
          });
        } else if (!latest && task.status === "running") {
          const misses = task.recoveryMisses ?? 0;
          if (misses < 1) {
            await store.update((draft) => {
              const current = draft.threadMeta[parentThreadId]?.teamOrchestration?.tasks[task.id];
              if (current?.status === "running") current.recoveryMisses = misses + 1;
            });
          } else {
            if (
              await finalizeManagedTask(
                store,
                task.childThreadId,
                `reconcile-missing:${Date.now()}`,
                "interrupted",
                {
                  summary: "Managed task had no recoverable turn after CodexNest restarted.",
                  source: "status",
                },
              )
            ) {
              affected.add(parentThreadId);
            }
          }
        }
      } catch (error) {
        if (
          isMissingRolloutError(error) &&
          (await finalizeManagedTask(
            store,
            task.childThreadId,
            `reconcile-deleted:${Date.now()}`,
            "failed",
            {
              summary: "Managed task thread is no longer available in Codex.",
              source: "status",
            },
          ))
        ) {
          affected.add(parentThreadId);
          continue;
        }
        projection.emit(
          "projectionError",
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    for (const [claimId, claim] of claimedById) {
      if (!claim.markerId) {
        await releaseTeamClaim(store, parentThreadId, claimId);
        affected.add(parentThreadId);
        continue;
      }
      try {
        const deliveredTurnId = await deliveredClientMessageTurnId(
          bridge,
          parentThreadId,
          claim.markerId,
        );
        if (deliveredTurnId) {
          await deliverTeamClaim(store, parentThreadId, claimId, deliveredTurnId);
          await recordTeamNotice(
            projection,
            parentThreadId,
            deliveredTurnId,
            claim.results,
            isTeamContinuationMarkerId(claim.markerId) ? null : claim.markerId,
          );
        } else if (!parent?.currentTurnId) {
          await releaseTeamClaim(store, parentThreadId, claimId);
        }
        affected.add(parentThreadId);
      } catch (error) {
        projection.emit(
          "projectionError",
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    affected.add(parentThreadId);
  }
  return affected;
}

async function recordTeamNotice(
  projection: AppProjection,
  parentThreadId: string,
  parentTurnId: string,
  results: TeamResultClaim["results"],
  afterItemId: string | null,
): Promise<void> {
  if (!results.length) return;
  await projection.recordOrchestrationNotice(
    parentThreadId,
    parentTurnId,
    results.map((result) => {
      const child = projection.summary(result.childThreadId);
      return {
        threadId: result.childThreadId,
        title: result.title,
        nickname: child?.relation.kind === "subagent" ? child.relation.nickname : null,
        outcome: result.outcome,
      };
    }),
    afterItemId,
  );
}

function turnOutcome(turn: Turn): ThreadOutcome {
  if (turn.status === "failed") return "failed";
  if (turn.status === "interrupted") return "interrupted";
  return "completed";
}

function isManagedTeamNotification(notification: ServerNotification, store: StateStore): boolean {
  const threadId = notificationThreadId(notification);
  return Boolean(threadId && managedTaskForChild(store.snapshot(), threadId));
}

export async function triggerTeamWatchdogs(
  store: StateStore,
  activity: Map<string, number>,
  now: number,
): Promise<Set<string>> {
  const affected = new Set<string>();
  const state = store.snapshot();
  const due: Array<{ parentThreadId: string; taskId: string; lastActivityAt: number }> = [];
  for (const [parentThreadId, meta] of Object.entries(state.threadMeta)) {
    for (const task of Object.values(meta.teamOrchestration?.tasks ?? {})) {
      if (task.status !== "running" || task.watchdog) continue;
      const lastActivityAt = Math.max(task.lastActivityAt, activity.get(task.childThreadId) ?? 0);
      if (
        now - lastActivityAt >= TEAM_WATCHDOG_MS &&
        now - (task.lastWatchdogAt ?? 0) >= TEAM_WATCHDOG_MS
      ) {
        due.push({ parentThreadId, taskId: task.id, lastActivityAt });
      }
    }
  }
  if (!due.length) return affected;
  await store.update((draft) => {
    for (const item of due) {
      const task = draft.threadMeta[item.parentThreadId]?.teamOrchestration?.tasks[item.taskId];
      if (!task || task.status !== "running" || task.watchdog) continue;
      const lastActivityAt = Math.max(task.lastActivityAt, activity.get(task.childThreadId) ?? 0);
      if (now - lastActivityAt < TEAM_WATCHDOG_MS) continue;
      task.lastActivityAt = lastActivityAt;
      task.lastWatchdogAt = now;
      task.watchdog = { status: "pending", triggeredAt: now };
      affected.add(item.parentThreadId);
    }
  });
  return affected;
}

function managedTaskForChild(
  state: CodexNestState,
  childThreadId: string,
): { parentThreadId: string; task: ManagedTeamTaskState } | null {
  const relation = state.threadMeta[childThreadId]?.managedParent;
  if (relation) {
    const task =
      state.threadMeta[relation.parentThreadId]?.teamOrchestration?.tasks[relation.taskId];
    if (task?.childThreadId === childThreadId) {
      return { parentThreadId: relation.parentThreadId, task };
    }
  }
  for (const [parentThreadId, meta] of Object.entries(state.threadMeta)) {
    const task = Object.values(meta.teamOrchestration?.tasks ?? {}).find(
      (candidate) => candidate.childThreadId === childThreadId,
    );
    if (task) return { parentThreadId, task };
  }
  return null;
}

function notificationThreadId(notification: ServerNotification): string | null {
  if (notification.method === "thread/started") return notification.params.thread.id;
  const params = notification.params as unknown;
  if (!isObjectRecord(params)) return null;
  return typeof params.threadId === "string" ? params.threadId : null;
}

function submittedManagedResult(task: ManagedTeamTaskState): ManagedTeamTaskResult {
  const candidate = task.resultCandidate;
  if (!candidate) {
    return { summary: "Managed task completed without a submitted result.", source: "status" };
  }
  return {
    summary: candidate.summary,
    ...(candidate.details ? { details: candidate.details } : {}),
    source: "submitted",
  };
}

function managedResultFromTurn(turn: Turn, outcome: ThreadOutcome): ManagedTeamTaskResult {
  const messages = turn.items.filter(
    (item): item is Extract<ThreadItem, { type: "agentMessage" }> =>
      item.type === "agentMessage" && Boolean(item.text.trim()),
  );
  const final = [...messages].reverse().find((item) => item.phase === "final_answer");
  const selected = final ?? messages.at(-1);
  if (selected) {
    const text = selected.text.trim();
    const summary = firstResultParagraph(text);
    return {
      summary,
      ...(text !== summary ? { details: text } : {}),
      source: final ? "final_answer" : "agent_message",
    };
  }
  return {
    summary:
      outcome === "completed"
        ? "Managed task completed without an agent message."
        : outcome === "failed"
          ? "Managed task failed without an agent message."
          : "Managed task was interrupted without an agent message.",
    source: "status",
  };
}

function firstResultParagraph(text: string): string {
  const paragraph =
    text
      .split(/\n\s*\n/u)
      .find((part) => part.trim())
      ?.trim() ?? text.trim();
  return paragraph.length <= 500 ? paragraph : `${paragraph.slice(0, 499).trimEnd()}…`;
}

function isTerminalTask(
  task: ManagedTeamTaskState,
): task is ManagedTeamTaskState & { status: ThreadOutcome } {
  return task.status === "completed" || task.status === "failed" || task.status === "interrupted";
}

function publicManagedTask(task: ManagedTeamTaskState): Record<string, unknown> {
  return {
    taskId: task.id,
    threadId: task.childThreadId,
    title: task.title,
    status: task.status,
    createdAt: task.createdAt,
    startedAt: task.startedAt ?? null,
    lastActivityAt: task.lastActivityAt,
    result: task.result ?? null,
  };
}

function dynamicToolArguments(value: unknown): Record<string, unknown> {
  if (!isObjectRecord(value)) throw new ProjectValidationError("Tool arguments must be an object");
  return value;
}

type MutatingTeamTool = TeamToolOperationState["tool"];

function isMutatingTeamTool(value: string): value is MutatingTeamTool {
  return ["spawn_task", "steer_task", "cancel_task", "submit_result"].includes(value);
}

function teamToolOperationKey(
  request: Extract<ServerRequest, { method: "item/tool/call" }>,
): string {
  const { threadId, turnId, callId, tool } = request.params;
  return sha256(`${threadId}\0${turnId}\0${callId}\0${tool}`);
}

async function prepareTeamToolOperation(
  store: StateStore,
  request: Extract<ServerRequest, { method: "item/tool/call" }>,
  args: Record<string, unknown>,
): Promise<{
  key: string;
  operation: TeamToolOperationState;
  created: boolean;
  conflict: boolean;
}> {
  const key = teamToolOperationKey(request);
  const argumentsHash = sha256(canonicalJson(args));
  let created = false;
  let conflict = false;
  let operation: TeamToolOperationState | undefined;
  await store.update((state) => {
    state.teamToolOperations ??= {};
    const existing = state.teamToolOperations[key];
    if (existing) {
      conflict = existing.argumentsHash !== argumentsHash;
      operation = structuredClone(existing);
      return;
    }
    const now = Date.now();
    const next: TeamToolOperationState = {
      threadId: request.params.threadId,
      turnId: request.params.turnId,
      callId: request.params.callId,
      tool: request.params.tool as MutatingTeamTool,
      argumentsHash,
      status: "prepared",
      createdAt: now,
      updatedAt: now,
      ...(request.params.tool === "spawn_task"
        ? {
            taskId: randomUUID(),
            childThreadSource: `codexnest-managed:${key.slice(0, 32)}`,
          }
        : {}),
    };
    state.teamToolOperations[key] = next;
    operation = structuredClone(next);
    created = true;
  });
  return { key, operation: operation!, created, conflict };
}

async function completeTeamToolOperation(
  store: StateStore,
  key: string,
  response: DynamicToolCallResponse,
): Promise<void> {
  await store.update((state) => {
    const operation = state.teamToolOperations?.[key];
    if (!operation || operation.status === "applied") return;
    operation.status = "applied";
    operation.response = structuredClone(response);
    operation.updatedAt = Date.now();
  });
}

async function pruneAppliedTeamToolOperations(
  store: StateStore,
  threadId: string,
  turnId: string,
): Promise<void> {
  await store.update((state) => {
    for (const [key, operation] of Object.entries(state.teamToolOperations ?? {})) {
      if (
        operation.status === "applied" &&
        operation.threadId === threadId &&
        operation.turnId === turnId
      ) {
        delete state.teamToolOperations![key];
      }
    }
  });
}

async function pruneCompletedTeamToolOperations(
  bridge: CodexBridge,
  store: StateStore,
): Promise<void> {
  const grouped = new Map<string, TeamToolOperationState[]>();
  for (const operation of Object.values(store.snapshot().teamToolOperations ?? {})) {
    if (operation.status !== "applied") continue;
    const operations = grouped.get(operation.threadId) ?? [];
    operations.push(operation);
    grouped.set(operation.threadId, operations);
  }
  const completedKeys = new Set<string>();
  for (const [threadId, operations] of grouped) {
    let turns: Turn[];
    try {
      turns = parseThreadRead(
        await bridge.request<unknown>("thread/read", { threadId, includeTurns: true }, 30_000),
      ).thread.turns;
    } catch {
      continue;
    }
    const terminalTurnIds = new Set(
      turns.filter((turn) => turn.status !== "inProgress").map((turn) => turn.id),
    );
    for (const operation of operations) {
      if (terminalTurnIds.has(operation.turnId)) {
        completedKeys.add(
          sha256(
            `${operation.threadId}\0${operation.turnId}\0${operation.callId}\0${operation.tool}`,
          ),
        );
      }
    }
  }
  if (!completedKeys.size) return;
  await store.update((state) => {
    for (const key of completedKeys) delete state.teamToolOperations?.[key];
  });
}

async function findManagedThreadBySource(
  bridge: CodexBridge,
  source: string,
): Promise<Thread | null> {
  const candidates: Thread[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = parseThreadList(
      await bridge.request<unknown>(
        "thread/list",
        {
          cursor,
          limit: 100,
          sourceKinds: [],
          sortKey: "created_at",
          sortDirection: "asc",
        },
        30_000,
      ),
    );
    candidates.push(...page.data.filter((thread) => thread.threadSource === source));
    cursor = page.nextCursor;
    if (cursor && seenCursors.has(cursor)) break;
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return (
    candidates.sort(
      (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
    )[0] ?? null
  );
}

async function deliveredClientMessageTurnId(
  bridge: CodexBridge,
  threadId: string,
  markerId: string,
): Promise<string | null> {
  const result = parseThreadRead(
    await bridge.request<unknown>("thread/read", { threadId, includeTurns: true }, 30_000),
  );
  return (
    result.thread.turns.find((turn) =>
      turn.items.some((item) => item.type === "userMessage" && item.clientId === markerId),
    )?.id ?? null
  );
}

function teamToolMarkerId(operationKey: string): string {
  return `codexnest-team-tool:${operationKey}`;
}

function teamTaskStartMarkerId(taskId: string): string {
  return `codexnest-team-task:${taskId}`;
}

function teamContinuationMarkerId(claimId: string): string {
  return `codexnest-team-claim:${claimId}`;
}

function isTeamContinuationMarkerId(value: string): boolean {
  return value.startsWith("codexnest-team-claim:");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObjectRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requiredToolString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new ProjectValidationError(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function optionalToolString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ProjectValidationError(`${key} must be a string`);
  return value.trim() || undefined;
}

function dynamicToolSuccess(value: unknown): DynamicToolCallResponse {
  return {
    contentItems: [{ type: "inputText", text: JSON.stringify(value) }],
    success: true,
  };
}

function dynamicToolError(message: string): DynamicToolCallResponse {
  return {
    contentItems: [{ type: "inputText", text: JSON.stringify({ error: message }) }],
    success: false,
  };
}

function dynamicTool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
): {
  type: "function";
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  deferLoading: true;
} {
  return { type: "function", name, description, inputSchema, deferLoading: true };
}

function teamRuntimeConfig(): Record<string, unknown> {
  return { agents: { enabled: false } };
}

function managedChildTurnSettings(
  settings: SessionSettings,
  models: ModelOption[],
): Record<string, unknown> {
  const model = effectiveModel(settings, models);
  if (!model) throw new ProjectValidationError("No model is available for managed task");
  const effort =
    settings.reasoningEffort ??
    model.reasoningEfforts.find((option) => option.isDefault)?.value ??
    null;
  return compact({
    model: model.id,
    serviceTier: settings.serviceTier,
    effort,
    personality: settings.personality,
    collaborationMode: {
      mode: "default",
      settings: {
        model: model.id,
        reasoning_effort: effort,
        developer_instructions: null,
      },
    },
  });
}

async function markTeamToolsAvailable(store: StateStore, threadId: string): Promise<void> {
  await store.update((state) => {
    const meta = state.threadMeta[threadId] ?? { pinned: false, lastReadUpdatedAt: 0 };
    meta.teamToolsVersion = TEAM_TOOLS_VERSION;
    state.threadMeta[threadId] = meta;
  });
}

function teamOrchestrationHasWork(store: StateStore, parentThreadId: string): boolean {
  const orchestration = store.snapshot().threadMeta[parentThreadId]?.teamOrchestration;
  return Boolean(
    orchestration &&
    Object.values(orchestration.tasks).some(
      (task) => !isTerminalTask(task) || task.delivery?.status !== "delivered" || task.watchdog,
    ),
  );
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withKeyLock<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  locks.set(key, next);
  const cleanup = () => {
    if (locks.get(key) === next) locks.delete(key);
  };
  void next.then(cleanup, cleanup);
  return next;
}

function withTranscriptionTiming(
  config: TranscriptionConfigResponse,
  store: StateStore,
): TranscriptionConfigResponse {
  const profile = transcriptionTimingProfile(config);
  return {
    ...config,
    timingEstimate: transcriptionTimingEstimate(
      profile ? store.snapshot().transcriptionTimings?.[profile] : undefined,
    ),
  };
}

function parseAudioDurationHeader(value: string | string[] | undefined): number | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new TranscriptionError("validation", "Audio duration must be an integer");
  }
  const durationMs = Number(value);
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs < 1 ||
    durationMs > MAX_RECORDING_SECONDS * 1_000
  ) {
    throw new TranscriptionError(
      "validation",
      `Audio duration must be between 1 and ${MAX_RECORDING_SECONDS * 1_000} milliseconds`,
    );
  }
  return durationMs;
}

function parseNonNegativeInteger(value: string | undefined): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function estimatedTranscriptionSeconds(
  config: TranscriptionConfigResponse,
  audioDurationMs: number,
): number | null {
  const fixed = config.timingEstimate.estimatedFixedProcessingMs;
  const perSecond = config.timingEstimate.estimatedProcessingMsPerAudioSecond;
  if (fixed === null || perSecond === null) return null;
  return Math.max(1, Math.ceil((fixed + (audioDurationMs / 1_000) * perSecond) / 1_000));
}

function requireCodexManager(manager: CodexManager | undefined): CodexManager {
  if (!manager) {
    throw new CodexManagementError("unsupported", "Codex management is not configured");
  }
  return manager;
}

function requireAppManager(manager: AppManager | undefined): AppManager {
  if (!manager) {
    throw new AppManagementError("unsupported", "CodexNest management is not configured");
  }
  return manager;
}

function threadSettings(settings?: SessionSettings): Record<string, unknown> {
  if (!settings) return {};
  return compact({
    model: settings.model,
    serviceTier: settings.serviceTier,
    personality: settings.personality,
  });
}

function turnSettings(
  settings: SessionSettings,
  models: ModelOption[],
  continuationContext?: string,
): Record<string, unknown> {
  const model = effectiveModel(settings, models);
  if (!model) throw new ProjectValidationError("No model is available for collaboration mode");
  const reasoningEffort =
    settings.reasoningEffort ??
    model.reasoningEfforts.find((option) => option.isDefault)?.value ??
    null;
  return compact({
    model: settings.model,
    serviceTier: settings.serviceTier,
    effort: settings.reasoningEffort,
    personality: settings.personality,
    collaborationMode: {
      mode: settings.collaborationMode === "plan" ? "plan" : "default",
      settings: {
        model: model.id,
        reasoning_effort: reasoningEffort,
        developer_instructions: null,
      },
    },
    additionalContext:
      settings.collaborationMode === "team" || continuationContext
        ? {
            ...(settings.collaborationMode === "team"
              ? {
                  "codexnest.team": {
                    kind: "application",
                    value: TEAM_MODE_CONTEXT,
                  },
                }
              : {}),
            ...(continuationContext
              ? {
                  "codexnest.team.results": {
                    kind: "application",
                    value: continuationContext,
                  },
                }
              : {}),
          }
        : undefined,
  });
}

function assertWritableThread(summary: ThreadSummary): void {
  if (summary.relation.kind === "subagent") {
    throw new ProjectConflictError("Subagent threads are managed by their parent session");
  }
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}

function isLoopbackAddress(value: string): boolean {
  return value === "127.0.0.1" || value === "::1" || value.startsWith("::ffff:127.");
}

function messageInput(
  text: string,
  images: string[],
): Array<{ type: "text"; text: string; text_elements: [] } | { type: "image"; url: string }> {
  const result: Array<
    { type: "text"; text: string; text_elements: [] } | { type: "image"; url: string }
  > = [];
  if (text.trim()) result.push({ type: "text", text: text.trim(), text_elements: [] });
  result.push(...images.map((url) => ({ type: "image" as const, url })));
  return result;
}

function validateThreadBody(body: unknown, reply: FastifyReply): CreateThreadRequest | undefined {
  const value = requireRecord<CreateThreadRequest>(body);
  const images = validateImages(value.images);
  if (typeof value.projectId !== "string" || typeof value.input !== "string") {
    apiError(reply, 400, "validation_failed", "projectId and input are required");
    return undefined;
  }
  if (!value.input.trim() && !images.length) {
    apiError(reply, 400, "validation_failed", "input or images are required");
    return undefined;
  }
  if (value.goal !== undefined && typeof value.goal !== "boolean") {
    apiError(reply, 400, "validation_failed", "goal must be boolean");
    return undefined;
  }
  if (value.goal && (!value.input.trim() || value.input.trim().length > 4_000)) {
    apiError(reply, 400, "validation_failed", "goal objective must be 1-4000 characters");
    return undefined;
  }
  if (
    value.clientMessageId !== undefined &&
    optionalClientMessageId(value.clientMessageId) === null
  ) {
    apiError(reply, 400, "validation_failed", "clientMessageId must not be empty");
    return undefined;
  }
  return { ...value, images, settings: validateSettings(value.settings) };
}

function validateStartTurnBody(body: unknown, reply: FastifyReply): StartTurnRequest | undefined {
  const value = requireRecord<StartTurnRequest>(body);
  if (
    Object.keys(value).some((key) => !["input", "images", "goal", "clientMessageId"].includes(key))
  ) {
    throw new ProjectValidationError("Unknown turn field");
  }
  const images = validateImages(value.images);
  if (typeof value.input !== "string" || (!value.input.trim() && !images.length)) {
    apiError(reply, 400, "validation_failed", "input or images are required");
    return undefined;
  }
  if (value.goal !== undefined && typeof value.goal !== "boolean") {
    apiError(reply, 400, "validation_failed", "goal must be boolean");
    return undefined;
  }
  if (value.goal && (!value.input.trim() || value.input.trim().length > 4_000)) {
    apiError(reply, 400, "validation_failed", "goal objective must be 1-4000 characters");
    return undefined;
  }
  if (
    value.clientMessageId !== undefined &&
    optionalClientMessageId(value.clientMessageId) === null
  ) {
    apiError(reply, 400, "validation_failed", "clientMessageId must not be empty");
    return undefined;
  }
  return { ...value, images };
}

function optionalClientMessageId(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    value.trim() === value
    ? value
    : null;
}

function optionalVoiceUploadId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(value)
    ? value
    : null;
}

function validateImages(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((image) => !isInlineImage(image))) {
    throw new ProjectValidationError("images must contain inline image data URLs");
  }
  return value;
}

function validateThreadDraft(value: unknown): UpdateThreadDraftRequest {
  const body = requireRecord<UpdateThreadDraftRequest>(value);
  if (
    Object.keys(body).some(
      (key) => !["input", "images", "goalMode", "annotations"].includes(key),
    ) ||
    typeof body.input !== "string" ||
    typeof body.goalMode !== "boolean" ||
    !Array.isArray(body.images) ||
    !Array.isArray(body.annotations)
  ) {
    throw new ProjectValidationError("Invalid thread draft");
  }
  const images = body.images.map((image) => {
    if (
      !isRecord(image) ||
      typeof image.id !== "string" ||
      !image.id ||
      typeof image.name !== "string" ||
      !image.name ||
      !isInlineImage(image.url)
    ) {
      throw new ProjectValidationError("Invalid draft image");
    }
    return { id: image.id, name: image.name, url: image.url };
  });
  const annotations = body.annotations.map((annotation) => {
    if (
      !isRecord(annotation) ||
      typeof annotation.id !== "string" ||
      !annotation.id ||
      typeof annotation.messageId !== "string" ||
      !annotation.messageId ||
      !["agentMessage", "plan"].includes(String(annotation.source)) ||
      typeof annotation.quote !== "string" ||
      !annotation.quote.trim() ||
      !Number.isInteger(annotation.startOffset) ||
      annotation.startOffset < 0 ||
      !Number.isInteger(annotation.endOffset) ||
      annotation.endOffset <= annotation.startOffset ||
      typeof annotation.comment !== "string" ||
      !annotation.comment.trim() ||
      typeof annotation.createdAt !== "number" ||
      !Number.isFinite(annotation.createdAt)
    ) {
      throw new ProjectValidationError("Invalid draft annotation");
    }
    return {
      id: annotation.id,
      messageId: annotation.messageId,
      source: annotation.source as "agentMessage" | "plan",
      quote: annotation.quote,
      startOffset: annotation.startOffset,
      endOffset: annotation.endOffset,
      comment: annotation.comment,
      createdAt: annotation.createdAt,
    };
  });
  return { input: body.input, images, goalMode: body.goalMode, annotations };
}

function isInlineImage(value: unknown): value is string {
  return typeof value === "string" && /^data:image\/[a-z0-9.+-]+;base64,/i.test(value);
}

function validateTaskDefaults(value: unknown): UpdateTaskDefaultsRequest {
  const body = requireRecord<UpdateTaskDefaultsRequest>(value);
  if (Object.keys(body).some((key) => !["serviceTier", "personality"].includes(key))) {
    throw new ProjectValidationError("Unknown task default");
  }
  for (const key of ["serviceTier", "personality"] as const) {
    if (
      body[key] !== undefined &&
      body[key] !== null &&
      (typeof body[key] !== "string" || !body[key]?.trim())
    ) {
      throw new ProjectValidationError(`${key} must be a non-empty string or null`);
    }
  }
  return body;
}

function validateGoalPatch(value: unknown): UpdateThreadGoalRequest {
  const body = requireRecord<UpdateThreadGoalRequest>(value);
  if (Object.keys(body).some((key) => !["objective", "status"].includes(key))) {
    throw new ProjectValidationError("Unknown goal field");
  }
  if (
    body.objective !== undefined &&
    (typeof body.objective !== "string" ||
      !body.objective.trim() ||
      body.objective.trim().length > 4_000)
  ) {
    throw new ProjectValidationError("goal objective must be 1-4000 characters");
  }
  if (
    body.status !== undefined &&
    !["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"].includes(
      body.status,
    )
  ) {
    throw new ProjectValidationError("Invalid goal status");
  }
  if (body.objective === undefined && body.status === undefined) {
    throw new ProjectValidationError("At least one goal field is required");
  }
  return {
    ...(body.objective === undefined ? {} : { objective: body.objective.trim() }),
    ...(body.status === undefined ? {} : { status: body.status }),
  };
}

function validateSettings(value: unknown): UpdateThreadSettingsRequest | undefined {
  if (value === undefined) return undefined;
  return validateSettingsPatch(value);
}

function validateSettingsPatch(value: unknown): UpdateThreadSettingsRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectValidationError("settings must be an object");
  }
  const settings = value as Record<string, unknown>;
  const known = new Set([
    "collaborationMode",
    "model",
    "reasoningEffort",
    "serviceTier",
    "personality",
  ]);
  if (Object.keys(settings).some((key) => !known.has(key))) {
    throw new ProjectValidationError("Unknown session setting");
  }
  if (
    settings.collaborationMode !== undefined &&
    !["default", "plan", "team"].includes(String(settings.collaborationMode))
  ) {
    throw new ProjectValidationError("Invalid collaborationMode");
  }
  for (const key of ["model", "reasoningEffort", "serviceTier", "personality"] as const) {
    if (
      settings[key] !== undefined &&
      settings[key] !== null &&
      (typeof settings[key] !== "string" || !settings[key].trim())
    ) {
      throw new ProjectValidationError(`${key} must be a non-empty string or null`);
    }
  }
  return settings as UpdateThreadSettingsRequest;
}

function mergeSettings(
  current: SessionSettings,
  patch: UpdateThreadSettingsRequest,
  models: ModelOption[],
): SessionSettings {
  const next = applySettingsPatch(current, patch);
  const model = effectiveModel(next, models);
  if (!model) throw new ProjectValidationError("Unknown model");

  if (
    next.reasoningEffort &&
    !model.reasoningEfforts.some(({ value }) => value === next.reasoningEffort)
  ) {
    if (patch.reasoningEffort !== undefined) {
      throw new ProjectValidationError("Reasoning effort is not supported by the selected model");
    }
    const fallback = model.reasoningEfforts.find((option) => option.isDefault)?.value;
    if (fallback) next.reasoningEffort = fallback;
    else delete next.reasoningEffort;
  }
  if (next.serviceTier && !model.serviceTiers.some(({ id }) => id === next.serviceTier)) {
    if (patch.serviceTier !== undefined) {
      throw new ProjectValidationError("Service tier is not supported by the selected model");
    }
    delete next.serviceTier;
  }
  if (next.personality && !model.supportsPersonality) {
    if (patch.personality !== undefined) {
      throw new ProjectValidationError("Personality is not supported by the selected model");
    }
    delete next.personality;
  }
  return next;
}

function applySettingsPatch(
  current: SessionSettings,
  patch: UpdateThreadSettingsRequest,
): SessionSettings {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch) as Array<
    [
      keyof UpdateThreadSettingsRequest,
      UpdateThreadSettingsRequest[keyof UpdateThreadSettingsRequest],
    ]
  >) {
    if (value === null) delete next[key as keyof SessionSettings];
    else if (value !== undefined) Object.assign(next, { [key]: value });
  }
  return next;
}

function effectiveModel(settings: SessionSettings, models: ModelOption[]): ModelOption | undefined {
  if (settings.model) return models.find((model) => model.id === settings.model);
  return models.find((model) => model.isDefault) ?? models[0];
}

function requireRecord<T>(value: unknown): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectValidationError("JSON object expected");
  }
  return value as T;
}

async function readThreadGoal(bridge: CodexBridge, threadId: string): Promise<ThreadGoal | null> {
  const response = await bridge.request<unknown>("thread/goal/get", { threadId });
  if (!isRecord(response) || !(response.goal === null || isThreadGoal(response.goal))) {
    throw new ProjectValidationError("Invalid thread goal response");
  }
  return response.goal;
}

async function setThreadGoal(
  bridge: CodexBridge,
  threadId: string,
  patch: UpdateThreadGoalRequest,
): Promise<ThreadGoal> {
  const response = await bridge.request<unknown>("thread/goal/set", {
    threadId,
    ...patch,
  });
  if (!isRecord(response) || !isThreadGoal(response.goal)) {
    throw new ProjectValidationError("Invalid thread goal response");
  }
  return response.goal;
}

async function clearThreadGoal(bridge: CodexBridge, threadId: string): Promise<void> {
  await bridge.request("thread/goal/clear", { threadId });
}

function isThreadGoal(value: unknown): value is ThreadGoal {
  return (
    isRecord(value) &&
    typeof value.threadId === "string" &&
    typeof value.objective === "string" &&
    ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"].includes(
      String(value.status),
    ) &&
    (value.tokenBudget === null || typeof value.tokenBudget === "number") &&
    typeof value.tokensUsed === "number" &&
    typeof value.timeUsedSeconds === "number" &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number"
  );
}

const PERMISSION_PRESETS: Record<
  PermissionPreset,
  { sandboxMode: string; approvalPolicy: string; approvalsReviewer: string }
> = {
  ask: {
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
  },
  auto: {
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
  },
  "full-access": {
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
    approvalsReviewer: "user",
  },
};

type ConfigReadResult = {
  config: Record<string, unknown>;
  origins: Record<string, unknown>;
  layers: unknown[];
};

type ConfigWriteResult = {
  status: "ok" | "okOverridden";
  version: string;
  message: string | null;
};

async function readPermissionSettings(bridge: CodexBridge): Promise<GlobalPermissionSettings> {
  const result = parseConfigReadResult(
    await bridge.request<unknown>("config/read", { includeLayers: true }),
  );
  const preset = permissionPreset(result.config);
  const overridden = ["sandbox_mode", "approval_policy", "approvals_reviewer"].some((key) => {
    const origin = result.origins[key];
    return (
      isRecord(origin) &&
      isRecord(origin.name) &&
      typeof origin.name.type === "string" &&
      origin.name.type !== "user"
    );
  });
  return {
    preset,
    version: userConfigVersion(result.layers),
    overridden,
    message: overridden ? "A managed Codex configuration overrides these permissions" : null,
  };
}

function validatePermissionSettings(value: unknown): UpdateGlobalPermissionSettingsRequest {
  const body = requireRecord<Record<string, unknown>>(value);
  if (Object.keys(body).some((key) => !["preset", "expectedVersion"].includes(key))) {
    throw new ProjectValidationError("Unknown permission setting");
  }
  if (typeof body.preset !== "string" || !Object.hasOwn(PERMISSION_PRESETS, body.preset)) {
    throw new ProjectValidationError("Invalid permission preset");
  }
  if (
    body.expectedVersion !== undefined &&
    body.expectedVersion !== null &&
    (typeof body.expectedVersion !== "string" || !body.expectedVersion)
  ) {
    throw new ProjectValidationError("expectedVersion must be a non-empty string or null");
  }
  return body as UpdateGlobalPermissionSettingsRequest;
}

function configEdit(keyPath: string, value: string) {
  return { keyPath, value, mergeStrategy: "replace" as const };
}

function parseConfigReadResult(value: unknown): ConfigReadResult {
  if (
    !isRecord(value) ||
    !isRecord(value.config) ||
    !isRecord(value.origins) ||
    !Array.isArray(value.layers)
  ) {
    throw new Error("Malformed config/read response");
  }
  return { config: value.config, origins: value.origins, layers: value.layers };
}

function parseConfigWriteResult(value: unknown): ConfigWriteResult {
  if (
    !isRecord(value) ||
    !["ok", "okOverridden"].includes(String(value.status)) ||
    typeof value.version !== "string"
  ) {
    throw new Error("Malformed config/batchWrite response");
  }
  const metadata = value.overriddenMetadata;
  const message =
    isRecord(metadata) && typeof metadata.message === "string" ? metadata.message : null;
  return {
    status: value.status as ConfigWriteResult["status"],
    version: value.version,
    message,
  };
}

function permissionPreset(config: Record<string, unknown>): PermissionPreset | null {
  const sandboxMode = config.sandbox_mode;
  const approvalPolicy = config.approval_policy;
  const reviewer = config.approvals_reviewer;
  if (sandboxMode === "danger-full-access" && approvalPolicy === "never") {
    return "full-access";
  }
  if (sandboxMode !== "workspace-write" || approvalPolicy !== "on-request") return null;
  if (reviewer === "user") return "ask";
  if (reviewer === "auto_review") return "auto";
  return null;
}

function userConfigVersion(layers: unknown[]): string | null {
  const userLayers = layers.filter(
    (layer) => isRecord(layer) && isRecord(layer.name) && layer.name.type === "user",
  );
  const base = userLayers.find(
    (layer) => isRecord(layer) && isRecord(layer.name) && layer.name.profile === null,
  );
  const selected = base ?? userLayers[0];
  return isRecord(selected) && typeof selected.version === "string" ? selected.version : null;
}

function isConfigVersionConflict(error: unknown): boolean {
  return error instanceof RpcError && /version|stale|changed|conflict/i.test(error.message);
}

function isMissingRolloutError(error: unknown): boolean {
  return (
    error instanceof RpcError &&
    error.code === -32_600 &&
    /no rollout found for thread id/i.test(error.message)
  );
}

function restoreDismissedProjectPath(state: CodexNestState, path: string): void {
  const remaining = (state.dismissedProjectPaths ?? []).filter((candidate) => candidate !== path);
  if (remaining.length) state.dismissedProjectPaths = remaining;
  else delete state.dismissedProjectPaths;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validInstallationId(value: string): boolean {
  return /^[A-Za-z0-9._-]{8,128}$/.test(value);
}

async function resolveDownloadFile(
  input: string,
  cwd: string,
): Promise<{ root: string; path: string; fileName: string }> {
  if (!isAbsolute(input) || input.includes("\0")) {
    throw new ProjectValidationError("File path must be absolute");
  }
  let root: string;
  let path: string;
  try {
    [root, path] = await Promise.all([realpath(cwd), realpath(input)]);
  } catch (error) {
    throwDownloadFilesystemError(error);
  }
  if (!pathContains(root, path)) {
    throw new ProjectForbiddenError("File must stay inside the task directory");
  }
  let info: Stats;
  try {
    [info] = await Promise.all([stat(path), access(path, constants.R_OK)]);
  } catch (error) {
    throwDownloadFilesystemError(error);
  }
  if (!info.isFile()) throw new ProjectValidationError("Path must point to a regular file");
  return { root, path, fileName: basename(input) };
}

function throwDownloadFilesystemError(error: unknown): never {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    throw new ProjectNotFoundError("File does not exist");
  }
  if (code === "EACCES" || code === "EPERM") {
    throw new ProjectForbiddenError("File is not accessible");
  }
  if (code === "EINVAL" || code === "ENAMETOOLONG") {
    throw new ProjectValidationError("Invalid file path");
  }
  throw new Error("File could not be opened", { cause: error });
}

function removeExpiredDownloadTickets(tickets: Map<string, DownloadTicket>, now: number): void {
  for (const [ticket, download] of tickets) {
    if (download.expiresAt <= now) tickets.delete(ticket);
  }
}

function attachmentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\\r\n]/g, "_") || "download";
  const encoded = encodeURIComponent(fileName).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function downloadNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: { code: "not_found", message: "Download not found" } });
}

function apiError(
  reply: FastifyReply,
  status: number,
  code: ApiErrorCode,
  message: string,
): FastifyReply {
  return reply.code(status).send({ error: { code, message } });
}
