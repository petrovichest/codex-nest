import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, createReadStream, type Stats } from "node:fs";
import { access, lstat, mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { FastifyInstance, FastifyReply } from "fastify";

import type {
  ApiErrorCode,
  AppUpdateStatus,
  ForceRestartAccepted,
  ForkThreadRequest,
  ForkThreadResponse,
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
  Project,
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
  TurnItemsResponse,
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
  RestartPreparationTimeoutError,
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
  CodexNestStateView,
  DeepReadonly,
  ManagedTeamTaskAccessState,
  ManagedTeamTaskResultArtifact,
  ManagedTeamTaskResultCheck,
  ManagedTeamTaskResult,
  ManagedTeamTaskState,
  StateStore,
  TeamToolOperationState,
} from "./state/store";
import type { ThreadTitleGenerator } from "./thread-title";
import {
  computeTeamWorkspaceDelta,
  createTeamWorkspace,
  discardTeamWorkspace,
  integrateTeamWorkspace,
  TeamWorkspaceConflictError,
  TeamWorkspaceError,
  TeamWorkspacePathError,
} from "./team-workspace";
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
const TEAM_MAX_ACTIVE_TASKS = 10;
const TEAM_TASK_HISTORY_LIMIT = 50;
const TEAM_NOTICE_CHANGED_PATH_LIMIT = 20;
const TEAM_WATCHDOG_MS = 10 * 60_000;
const TEAM_ACTIVITY_PERSIST_MS = 1_000;
const TEAM_CHILD_MODEL_ID = "gpt-5.6-sol";
const TEAM_SANDBOX_MOUNTPOINTS = [".agents", ".codex"] as const;

type ManagedTeamTaskView = DeepReadonly<ManagedTeamTaskState>;
type ManagedTeamTaskMapView = DeepReadonly<Record<string, ManagedTeamTaskState>>;
type TeamToolOperationView = DeepReadonly<TeamToolOperationState>;
const TEAM_CONTINUATION_MARKER_TEXT =
  "Continue CodexNest Team orchestration using the attached managed-task results.";
const TEAM_SESSION_UPGRADE_MESSAGE =
  "Эта сессия создана до появления managed Team tools. Создайте новую Team-сессию.";
const TEAM_MODE_CONTEXT = [
  "This session is in CodexNest Team mode. You are the root agent and may perform any part of the user's task directly, including inspecting, analyzing, editing, and testing code.",
  "Delegate only when you judge that a managed child is materially useful. Use only the codexnest managed-task tools for delegation and never use native subagent tools.",
  "Use the smallest sufficient solution that resolves the user's main problem. Add complexity only to address a concrete, confirmed risk.",
  "Before calling codexnest.spawn_task, confirm that the task is necessary to achieve the user's original goal.",
  "Honor an explicit user request to work in the main session unless delegation is necessary to achieve the request.",
  "Do not create managed tasks for optional improvements, speculative risks, extra completeness, or checks without a concrete target.",
  "When the user asks to stop or cancel subagents, use codexnest.list_tasks when needed and codexnest.cancel_task for every queued, starting, or running managed task. Do not create replacement tasks unless the user asks for them.",
  "After every meaningful stage, pause and reassess the remaining plan against the user's original goal. Continue without asking the user only with steps that are still necessary; never proceed merely because a step was previously planned.",
  "Every test, command run, and checklist item must target a specific product risk or an observed defect. Omit it otherwise.",
  "Keep the full conversation and complete plan only in the root coordinator's context.",
  "In each managed child prompt, include only the single assigned plan step and the minimum task-specific context needed to complete it: its objective, relevant constraints, affected scope, and expected result.",
  "Never copy or summarize the conversation, the full plan, unrelated plan steps, or prior agent messages in a subagent prompt.",
  "Once work is delegated, do not duplicate the same scope in the parent session unless integration or repair requires it.",
  "CodexNest may end the current parent turn and automatically start a continuation turn when a child result arrives.",
  "Never call sleep, run shell sleep commands, repeatedly call list_tasks or inspect_task, or otherwise poll to wait for managed tasks.",
  "When a task explicitly requires checking results after a fixed delay or deadline, delegate the complete start, initial health check, sleep, and final inspection cycle to one managed child; never wait in the parent.",
  "After scheduling all tasks that are ready now, finish the turn instead of waiting; child completion automatically notifies and resumes this parent session.",
  "On a CodexNest orchestration continuation, process the named child results and continue reasoning about the original task before deciding the next action.",
  "If an explicit user message is present, answer it first without forgetting any active or newly completed subagents.",
  "Grant network access only when a managed task requires external access such as documentation, package downloads, remote APIs, or health checks; set access.network to true in that case and leave it false for local-only work.",
  "Choose sequential or parallel delegation based on dependencies and workspace overlap.",
  "Do not run multiple repository-wide builds, full test suites, or similarly resource-heavy commands in parallel; schedule those tasks sequentially.",
  "Never run parallel sharedWrite tasks whose write paths overlap.",
  "Parallel isolatedWrite tasks may edit overlapping files when comparing alternatives or when their results will be synthesized; their worktrees remain separate.",
  "Integrate isolated results sequentially. If an isolated result conflicts after another result changed the parent, call codexnest.inspect_task to obtain workspacePath, compare that workspace with the parent, manually merge the required changes in the parent, and then call codexnest.discard_task_changes for that workspace.",
  "Use codexnest.inspect_task, codexnest.steer_task, or codexnest.cancel_task when a watchdog reports that a task is silent.",
  "You may write managed-task prompts and steering messages in English whenever you judge that it improves efficiency or precision, regardless of the user's language.",
  "Keep concise task titles and the consolidated user-facing response in the user's language.",
  "When the required results are ready, return one consolidated result to the user.",
  "The user should not need to coordinate subagents directly.",
].join(" ");
const TEAM_CHILD_INSTRUCTIONS = [
  "You are a CodexNest managed child agent. Complete exactly the assigned task in this thread.",
  "Do not create or delegate to subagents.",
  "Honor the enforced workspace, writable-path, and network limits. Never attempt to escape them or request broader approval.",
  "Do not commit, push, deploy, or change Git refs; the root agent alone integrates and publishes changes.",
  "When the task explicitly requires checking results after a fixed delay or deadline, start the workload asynchronously, perform one brief startup check, and use the built-in sleep tool once for only the remaining time.",
  "Before finishing, call codexnest.submit_result with outcome, a concise summary, optional details, checks, risks, and artifacts.",
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

interface ManagedTaskOptions {
  dependsOn: string[];
  access: ManagedTeamTaskAccessState;
  model: string;
  reasoningEffort: string | null;
  serviceTier: string | null;
}

interface ManagedChildRuntime {
  cwd: string;
  runtimeWorkspaceRoots?: string[];
  sandboxPolicy?:
    | { type: "readOnly"; networkAccess: boolean }
    | {
        type: "workspaceWrite";
        writableRoots: string[];
        networkAccess: boolean;
        excludeTmpdirEnvVar: boolean;
        excludeSlashTmp: boolean;
      };
}

const TEAM_ACCESS_SCHEMA = {
  type: "object",
  properties: {
    mode: {
      type: "string",
      enum: ["readOnly", "isolatedWrite", "sharedWrite"],
      description: "Workspace access mode. Defaults to readOnly.",
    },
    writePaths: {
      type: "array",
      items: { type: "string" },
      description: "Repository-relative writable paths. Required for write modes.",
    },
    network: {
      type: "boolean",
      description:
        "Allow network access when the task requires documentation, downloads, remote APIs, or health checks. Defaults to false.",
    },
  },
  additionalProperties: false,
} as const;

const TEAM_TASK_OPTIONS_SCHEMA = {
  dependsOn: { type: "array", items: { type: "string" }, maxItems: 50 },
  access: TEAM_ACCESS_SCHEMA,
  reasoningEffort: { type: "string" },
  serviceTier: { type: "string" },
} as const;

const TEAM_ROOT_DYNAMIC_TOOLS = [
  {
    type: "namespace",
    name: "codexnest",
    description: "Create and manage isolated CodexNest child tasks for Team mode.",
    tools: [
      dynamicTool("spawn_task", "Create one managed child task.", {
        type: "object",
        properties: {
          title: { type: "string", description: "Concise task-specific title." },
          prompt: { type: "string", description: "Self-contained task instructions." },
          ...TEAM_TASK_OPTIONS_SCHEMA,
        },
        required: ["title", "prompt"],
        additionalProperties: false,
      }),
      dynamicTool("followup_task", "Continue a delivered managed task in the same child thread.", {
        type: "object",
        properties: {
          taskId: { type: "string" },
          title: { type: "string" },
          prompt: { type: "string", description: "Self-contained follow-up instructions." },
          access: TEAM_ACCESS_SCHEMA,
          reasoningEffort: { type: "string" },
          serviceTier: { type: "string" },
        },
        required: ["taskId", "prompt"],
        additionalProperties: false,
      }),
      dynamicTool("list_tasks", "List this parent's managed tasks.", {
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      dynamicTool(
        "inspect_task",
        "Inspect one managed task and obtain its isolated workspace path for review or synthesis.",
        {
          type: "object",
          properties: { taskId: { type: "string" } },
          required: ["taskId"],
          additionalProperties: false,
        },
      ),
      dynamicTool("steer_task", "Send corrective guidance to a running managed task.", {
        type: "object",
        properties: { taskId: { type: "string" }, message: { type: "string" } },
        required: ["taskId", "message"],
        additionalProperties: false,
      }),
      dynamicTool("cancel_task", "Cancel a queued or running managed task.", {
        type: "object",
        properties: { taskId: { type: "string" }, reason: { type: "string" } },
        required: ["taskId"],
        additionalProperties: false,
      }),
      dynamicTool("integrate_task", "Apply an isolated task's verified changes to the parent.", {
        type: "object",
        properties: { taskId: { type: "string" } },
        required: ["taskId"],
        additionalProperties: false,
      }),
      dynamicTool("discard_task_changes", "Discard an isolated task's unapplied changes.", {
        type: "object",
        properties: { taskId: { type: "string" } },
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
    description: "Return the structured result of the current CodexNest managed task.",
    tools: [
      dynamicTool("submit_result", "Submit the result candidate for this managed task.", {
        type: "object",
        properties: {
          outcome: { type: "string", enum: ["success", "partial", "blocked", "failed"] },
          summary: { type: "string", description: "Concise non-empty result summary." },
          details: { type: "string", description: "Optional Markdown details." },
          checks: {
            type: "array",
            maxItems: 100,
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                outcome: { type: "string", enum: ["passed", "failed", "notRun"] },
                details: { type: "string" },
              },
              required: ["name", "outcome"],
              additionalProperties: false,
            },
          },
          risks: { type: "array", maxItems: 100, items: { type: "string" } },
          artifacts: {
            type: "array",
            maxItems: 100,
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                path: { type: "string" },
                url: { type: "string" },
              },
              required: ["label"],
              additionalProperties: false,
            },
          },
        },
        required: ["outcome", "summary"],
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
  const stoppedTeamParents = new Set<string>();
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
    void (lifecycle?.track(pending, "thread title generation") ?? pending);
  };
  const startTurnUnlocked = async (
    threadId: string,
    input: string,
    images: string[],
    clientMessageId: string | null,
    goal = false,
  ): Promise<TurnStartResult> => {
    if (clientMessageId) {
      const receipt = store.view().messageReceipts?.[clientMessageId];
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
    if (summary.settings.collaborationMode === "team") {
      const automaticContinuation = !clientMessageId && !input.trim() && !images.length;
      if (automaticContinuation && stoppedTeamParents.has(threadId)) {
        throw new TeamContinuationStoppedError();
      }
      if (!automaticContinuation) stoppedTeamParents.delete(threadId);
    }
    const shouldGenerateTitle =
      projection.isUnmaterialized(threadId) && !projection.hasExplicitName(threadId);
    if (
      summary.settings.collaborationMode === "team" &&
      store.view().threadMeta[threadId]?.managedTeamToolsAvailable !== true
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
    const automaticTeamContinuation = Boolean(teamClaim && !input.trim() && !images.length);
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
      const startParams = {
        threadId,
        clientUserMessageId: teamMarkerId ?? clientMessageId,
        input: messageInput(input, images),
        ...turnSettings(
          summary.settings,
          projection.availableModels,
          teamClaim ? teamContinuationContext(store, threadId, teamClaim) : undefined,
        ),
      };
      let started: unknown;
      try {
        started = await bridge.request<unknown>("turn/start", startParams);
      } catch (error) {
        if (!(automaticTeamContinuation && error instanceof RpcError && error.code === -32_602)) {
          throw error;
        }
        started = await bridge.request<unknown>("turn/start", {
          ...startParams,
          input: messageInput(TEAM_CONTINUATION_MARKER_TEXT, []),
        });
      }
      const turn = parseTurnStart(started);
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
      await recordTeamNotice(
        store,
        projection,
        threadId,
        turnId,
        teamClaim.results,
        clientMessageId,
      );
      projection.publishThreadState(threadId);
      scheduleTeamTasks(threadId);
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
      if (store.view().threadMeta[candidate.thread.id]?.managedTeamToolsAvailable !== true) {
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
      if (existing) return projection.setSettings(existing.id, projection.newSessionSettings);
      codexManager?.assertTurnsAllowed();
      const project = store.view().projects.find((candidate) => candidate.id === projectId);
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

  const pendingUserInput = (threadId: string, turnId: string) => {
    for (const request of attention.list()) {
      if (
        request.kind === "userInput" &&
        request.threadId === threadId &&
        request.turnId === turnId
      ) {
        return request;
      }
    }
    return undefined;
  };

  const steerTurnUnlocked = async (
    threadId: string,
    turnId: string,
    input: string,
    images: string[],
    clientMessageId: string | null,
  ): Promise<string> => {
    codexManager?.assertTurnsAllowed();
    const userInput = pendingUserInput(threadId, turnId);
    if (userInput) {
      const firstQuestion = userInput.questions[0];
      const response: AttentionResponse = {
        kind: "userInput",
        answers:
          firstQuestion && input.trim() && images.length === 0
            ? { [firstQuestion.id]: [input.trim()] }
            : {},
      };
      const resolved = attention.resolve(userInput.id, response);
      if (resolved) {
        await projection.recordAttentionResponse(resolved, response);
        if (images.length === 0) return turnId;
      }
    }
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
        store,
        projection,
        threadId,
        resultTurnId,
        teamClaim.results,
        clientMessageId,
      );
      projection.publishThreadState(threadId);
      scheduleTeamTasks(threadId);
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
    shouldSteerQueuedMessage: (threadId, turnId) => Boolean(pendingUserInput(threadId, turnId)),
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
  const managedTokenUsage = new Map<string, { tokens: number; persistedAt: number }>();
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
    return lifecycle?.track(promise, "Team background run") ?? promise;
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
            if (stoppedTeamParents.has(threadId)) {
              const tasks = Object.values(
                store.view().threadMeta[threadId]?.teamOrchestration?.tasks ?? {},
              );
              const hasPendingWorkspace = tasks.some(managedTaskHasPendingWorkspace);
              if (tasks.length && tasks.every(isTerminalTask) && !hasPendingWorkspace) {
                await store.update((state) => {
                  const meta = state.threadMeta[threadId];
                  if (meta) delete meta.teamOrchestration;
                });
                projection.publishThreadState(threadId);
              }
              return;
            }
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
            if (!(error instanceof TeamContinuationStoppedError)) {
              app.log.warn(
                { err: safeError(error), threadId },
                "Failed to continue Team orchestration",
              );
            }
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
      Object.values(store.view().teamToolOperations ?? {}).some(
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
      ? managedTaskForNotification(store.view(), notification)
      : undefined;
    if (childThreadId && managed) {
      managedActivity.set(childThreadId, Date.now());
    }
    if (!isManagedTeamNotification(notification, store)) return;
    teamNotificationQueue = teamNotificationQueue
      .catch(() => undefined)
      .then(async () => {
        const run = () =>
          handleManagedTeamNotification(
            notification,
            bridge,
            store,
            projection,
            managedActivity,
            managedTokenUsage,
          );
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
          : managedTaskForChild(store.view(), caller)?.parentThreadId;
      const operation = () => handleManagedTeamToolCall(request, bridge, store, projection);
      const pending = withKeyLock(teamToolOperationLocks, operationKey, () =>
        parent ? withKeyLock(teamParentLocks, parent, operation) : operation(),
      );
      void (lifecycle?.track(pending, "Team tool operation") ?? pending)
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
        const now = Date.now();
        const affected = await triggerTeamWatchdogs(store, managedActivity, now);
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
    managedTokenUsage.clear();
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
        const threadIds = new Set<string>();
        const parentThreadIds = Object.entries(store.view().threadMeta)
          .filter(([, meta]) => Boolean(meta.teamOrchestration))
          .map(([threadId]) => threadId);
        for (const parentThreadId of parentThreadIds) {
          const reconciled = await withKeyLock(teamParentLocks, parentThreadId, () =>
            reconcileTeamOrchestration(bridge, store, projection, parentThreadId),
          );
          for (const threadId of reconciled) threadIds.add(threadId);
        }
        if (
          Object.values(store.view().threadMeta).some((meta) =>
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
    recoveryPromise = lifecycle?.track(pending, "durable runtime recovery") ?? pending;
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

  if (lifecycle) {
    app.addHook("onRoute", (routeOptions) => {
      const methods = Array.isArray(routeOptions.method)
        ? routeOptions.method
        : [routeOptions.method];
      if (
        !routeOptions.url.startsWith("/api/v1/") ||
        !methods.some((method) => isTrackedMutation(method, routeOptions.url))
      ) {
        return;
      }
      const handler = routeOptions.handler;
      routeOptions.handler = function trackedMutationHandler(request, reply) {
        if (!isTrackedMutation(request.method, routeOptions.url)) {
          return handler.call(this, request, reply);
        }
        const pending = (async () => handler.call(this, request, reply))();
        return lifecycle.track(pending, `HTTP ${request.method} ${routeOptions.url}`);
      };
    });
  }
  app.addHook("onRequest", async (request, reply) => {
    if (!lifecycle || !request.url.startsWith("/api/v1/")) return;
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (!isTrackedMutation(request.method, pathname)) return;
    if (!lifecycle.acceptsMutations) {
      reply.header("Retry-After", "2");
      return apiError(
        reply,
        503,
        "app_server_unavailable",
        `CodexNest is ${lifecycle.state}; retry after recovery`,
      );
    }
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
    if (!token || !verifyToken(token, store.view().auth.tokenSha256)) {
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
      if (error instanceof RestartPreparationTimeoutError) {
        return apiError(reply, 503, "app_server_unavailable", error.message);
      }
      throw error;
    }
    const snapshot = store.view();
    const activeTurnCount = projection
      .snapshot()
      .threads.filter((thread) => thread.currentTurnId !== null).length;
    const hasManagedWork = Object.values(snapshot.threadMeta).some((meta) =>
      Object.values(meta.teamOrchestration?.tasks ?? {}).some(managedTeamTaskHasWork),
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
    projectCount: store.view().projects.length,
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
      const inputLength = store.view().threadMeta[request.params.id]?.draft?.input.length ?? 0;
      if (selectionStart > inputLength || selectionEnd > inputLength) {
        return apiError(reply, 400, "validation_failed", "Voice selection is outside the draft");
      }
      const expectedDraftUpdatedAt =
        request.query.draftUpdatedAt === "none"
          ? null
          : parseNonNegativeInteger(request.query.draftUpdatedAt);
      const currentDraftUpdatedAt =
        store.view().threadMeta[request.params.id]?.draft?.updatedAt ?? null;
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
    return store.view().taskDefaults ?? {};
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

  app.post("/api/v1/settings/codex/force-restart", async (): Promise<CodexManagementStatus> => {
    const manager = requireCodexManager(codexManager);
    try {
      return await manager.forceRestart();
    } finally {
      if (!manager.maintenanceActive) {
        await queue.resume();
        resumeTeamContinuations();
      }
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

  app.post(
    "/api/v1/settings/app/force-restart",
    async (request, reply): Promise<ForceRestartAccepted> => {
      const result = await requireAppManager(appManager).forceRestart();
      return reply.code(202).send(result);
    },
  );

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
    const existing = store.view().projects;
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
      const state = store.view();
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
      const currentProjects = store.view().projects;
      const index = currentProjects.findIndex((project) => project.id === request.params.id);
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
      if (hasTargetIndex && targetIndex >= currentProjects.length) {
        return apiError(reply, 400, "validation_failed", "targetIndex is outside the project list");
      }
      if (targetIndex < 0 || targetIndex >= currentProjects.length) {
        return cloneView<Project[]>(currentProjects);
      }
      if (targetIndex === index) return cloneView<Project[]>(currentProjects);

      const updated = await store.update((state) => {
        const currentIndex = state.projects.findIndex(
          (project) => project.id === request.params.id,
        );
        if (currentIndex < 0) throw new ProjectNotFoundError("Project not found");
        const [project] = state.projects.splice(currentIndex, 1);
        state.projects.splice(targetIndex, 0, project!);
      });
      const projects = cloneView<Project[]>(updated.projects);
      projection.publishProjectsReordered(projects);
      return projects;
    },
  );

  app.delete<{ Params: { id: string } }>("/api/v1/projects/:id", async (request, reply) => {
    const project = store.view().projects.find((candidate) => candidate.id === request.params.id);
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
    if (!store.view().projects.some((project) => project.id === request.params.id)) {
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
        observed = await projection.refreshThread(request.params.id);
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
    const observed = await projection.refreshThread(request.params.id);
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

  app.get<{ Params: { id: string; turnId: string } }>(
    "/api/v1/threads/:id/turns/:turnId/items",
    async (request, reply): Promise<TurnItemsResponse | undefined> => {
      let observed = projection.summary(request.params.id);
      if (!observed) observed = await projection.refreshThread(request.params.id);
      if (!observed) return apiError(reply, 404, "not_found", "Thread not found");
      return projection.readTurnItems(request.params.id, request.params.turnId);
    },
  );

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
      observed = await projection.refreshThread(request.params.id);
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
        const receipt = store.view().messageReceipts?.[body.clientMessageId];
        if (receipt) {
          if (
            receipt.contentHash !==
            messageContentHash(body.input, body.images ?? [], body.goal ?? false)
          ) {
            throw new MessageQueueConflictError("Message id has already been used");
          }
          let existing = projection.summary(receipt.threadId);
          if (!existing) {
            existing = await projection.refreshThread(receipt.threadId);
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
      const project = store.view().projects.find((candidate) => candidate.id === body.projectId);
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

  app.post<{ Params: { id: string }; Body: ForkThreadRequest }>(
    "/api/v1/threads/:id/forks",
    async (request, reply) => {
      codexManager?.assertTurnsAllowed();
      const body = validateForkThreadBody(request.body);
      let source = projection.summary(request.params.id);
      if (!source) source = await projection.refreshThread(request.params.id);
      if (!source) return apiError(reply, 404, "not_found", "Thread not found");
      assertWritableThread(source);

      const turn = await readForkTurn(bridge, source.id, body.lastTurnId);
      if (!turn) {
        return apiError(reply, 400, "validation_failed", "Fork turn was not found");
      }
      if (turn.status !== "completed") {
        return apiError(reply, 409, "conflict", "Only completed turns can be forked");
      }
      const forkResponse = [...turn.items]
        .reverse()
        .find(
          (item): item is Extract<ThreadItem, { type: "agentMessage" | "plan" }> =>
            (item.type === "agentMessage" || item.type === "plan") && Boolean(item.text.trim()),
        );
      if (!forkResponse || forkResponse.id !== body.agentMessageId) {
        return apiError(
          reply,
          400,
          "validation_failed",
          "agentMessageId must select the last non-empty agent message or plan of the turn",
        );
      }
      if (!threadTitles) throw new Error("Thread title generation is unavailable");
      const model = effectiveModel(source.settings, projection.availableModels);
      const title = await threadTitles.generate(forkResponse.text, {
        cwd: source.cwd,
        model: model?.id,
        effort: model?.reasoningEfforts[0]?.value,
      });
      const forked = parseThreadStart(
        await bridge.request<unknown>("thread/fork", {
          threadId: source.id,
          lastTurnId: turn.id,
          excludeTurns: true,
        }),
      ).thread;
      await bridge.request("thread/goal/clear", { threadId: forked.id });
      await bridge.request("thread/name/set", { threadId: forked.id, name: title });

      const sourceMeta = store.view().threadMeta[source.id];
      await store.update((state) => {
        state.threadMeta[forked.id] = {
          pinned: false,
          lastReadUpdatedAt: 0,
          lastOutcome: "completed",
          outcomeUpdatedAt: forked.updatedAt * 1_000,
          settings: structuredClone(source.settings),
          ...(sourceMeta?.managedTeamToolsAvailable === true
            ? { managedTeamToolsAvailable: true as const }
            : {}),
        };
        if (state.messageQueues) delete state.messageQueues[forked.id];
      });
      projection.upsertThread({ ...forked, name: title });
      return reply.code(201).send({
        thread: projection.summary(forked.id)!,
      } satisfies ForkThreadResponse);
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
      if (
        patch.collaborationMode !== undefined &&
        patch.collaborationMode !== "team" &&
        summary.settings.collaborationMode === "team" &&
        teamOrchestrationHasWork(store, request.params.id)
      ) {
        throw new ProjectConflictError(
          "Нельзя выключить Team, пока субагенты работают или их результаты ещё не обработаны. Попросите главного агента завершить или отменить их.",
        );
      }
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
        summary.settings.collaborationMode !== "team" &&
        store.view().threadMeta[request.params.id]?.managedTeamToolsAvailable !== true
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
      if (body.turnId !== undefined && typeof body.turnId !== "string") {
        return apiError(reply, 400, "validation_failed", "turnId must be a string");
      }
      const requestedTurnId = summary.currentTurnId ?? body.turnId;
      const orchestration = store.view().threadMeta[request.params.id]?.teamOrchestration;
      if (!requestedTurnId && !orchestration) {
        return apiError(reply, 400, "validation_failed", "There is no running task to stop");
      }
      if (orchestration) {
        stoppedTeamParents.add(request.params.id);
        const immediate = teamContinuationImmediates.get(request.params.id);
        if (immediate) clearImmediate(immediate);
        teamContinuationImmediates.delete(request.params.id);
        scheduledTeamContinuations.delete(request.params.id);
      }
      const interruptedTurnIds: string[] = [];
      await withKeyLock(teamParentLocks, request.params.id, async () => {
        if (requestedTurnId) {
          const interrupted = await interruptTurnIfRunning(
            bridge,
            request.params.id,
            requestedTurnId,
          );
          interruptedTurnIds.push(requestedTurnId);
          if (interrupted && interrupted !== requestedTurnId) interruptedTurnIds.push(interrupted);
        }
        const tasks = Object.values(
          store.view().threadMeta[request.params.id]?.teamOrchestration?.tasks ?? {},
        );
        const hasPendingWorkspace = tasks.some(managedTaskHasPendingWorkspace);
        if (tasks.length && tasks.every(isTerminalTask) && !hasPendingWorkspace) {
          await store.update((state) => {
            const meta = state.threadMeta[request.params.id];
            if (meta) delete meta.teamOrchestration;
          });
        }
      });
      await projection.markInterrupted(request.params.id, interruptedTurnIds);
      projection.publishThreadState(request.params.id);
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
    request.log.error(
      {
        err: safeError(error),
        rpcCode: error instanceof RpcError ? error.code : undefined,
        method: request.method,
        route: request.routeOptions.url,
      },
      "request failed",
    );
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
    const managed = managedTaskForChild(store.view(), threadId);
    if (!managed) return finish(dynamicToolError("This thread is not a managed Team task"));
    const summary = requiredToolString(args, "summary");
    const details = optionalToolString(args, "details");
    const fields = managedResultFields(args);
    await validateManagedResultArtifacts(
      fields.artifacts,
      managed.task.workspace?.worktreePath ?? projection.summary(managed.parentThreadId)?.cwd,
    );
    if (!fields.outcome) {
      throw new ProjectValidationError("outcome is required for managed Team results");
    }
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
        ...fields,
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
    const options = managedTaskOptions(args, parent.settings, projection.availableModels);
    const tasks = store.view().threadMeta[threadId]?.teamOrchestration?.tasks ?? {};
    const missing = options.dependsOn.filter((dependency) => !tasks[dependency]);
    if (missing.length) {
      return finish(dynamicToolError(`Managed task dependencies not found: ${missing.join(", ")}`));
    }
    const operation = prepared!.operation;
    const taskId = operation.taskId!;
    const childThreadSource = operation.childThreadSource!;
    let task = store.view().threadMeta[threadId]?.teamOrchestration?.tasks[taskId];
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
          options,
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
          options,
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
    const taskMap = store.view().threadMeta[threadId]?.teamOrchestration?.tasks ?? {};
    const tasks = Object.values(taskMap)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((task) => publicManagedTask(task, taskMap));
    return dynamicToolSuccess({ tasks });
  }

  const taskId = requiredToolString(args, "taskId");
  const task = store.view().threadMeta[threadId]?.teamOrchestration?.tasks[taskId];
  if (!task) return finish(dynamicToolError("Managed task not found"));

  if (tool === "followup_task") {
    if (!isTerminalTask(task) || task.delivery?.status !== "delivered") {
      return finish(dynamicToolError("Only a delivered terminal task can be continued"));
    }
    const tasks = store.view().threadMeta[threadId]?.teamOrchestration?.tasks ?? {};
    const existingFollowup = tasks[prepared!.operation.taskId!];
    if (existingFollowup) {
      return finish(
        dynamicToolSuccess({
          taskId: existingFollowup.id,
          threadId: existingFollowup.childThreadId,
          status: existingFollowup.status,
        }),
      );
    }
    if (Object.values(tasks).some((candidate) => candidate.predecessorTaskId === task.id)) {
      return finish(dynamicToolError("This managed task already has a follow-up"));
    }
    const prompt = requiredToolString(args, "prompt");
    const title = optionalToolString(args, "title") ?? task.title;
    const options = managedTaskOptions(args, parent.settings, projection.availableModels, task);
    const reusesWorkspace = Boolean(
      task.workspace && !["integrated", "discarded"].includes(task.workspace.lifecycle),
    );
    if (
      reusesWorkspace &&
      (options.access.mode !== "isolatedWrite" ||
        canonicalJson(options.access.writePaths ?? []) !==
          canonicalJson(task.access?.writePaths ?? []))
    ) {
      return finish(
        dynamicToolError(
          "A follow-up with pending isolated changes must keep the same workspace write paths",
        ),
      );
    }
    const nextTaskId = prepared!.operation.taskId!;
    const now = Date.now();
    const next: ManagedTeamTaskState = {
      id: nextTaskId,
      childThreadId: task.childThreadId,
      childThreadSource: task.childThreadSource,
      startMessageId: teamTaskStartMarkerId(nextTaskId),
      title,
      prompt,
      status: "queued",
      predecessorTaskId: task.id,
      access: options.access,
      resolvedModel: options.model,
      resolvedReasoningEffort: options.reasoningEffort,
      resolvedServiceTier: options.serviceTier,
      ...(reusesWorkspace && task.workspace
        ? { workspace: cloneView<NonNullable<ManagedTeamTaskState["workspace"]>>(task.workspace) }
        : {}),
      createdAt: now,
      lastActivityAt: now,
    };
    await store.update((state) => {
      const orchestration = state.threadMeta[threadId]?.teamOrchestration;
      if (!orchestration || orchestration.tasks[nextTaskId]) return;
      orchestration.tasks[nextTaskId] = next;
      const childMeta = state.threadMeta[next.childThreadId] ?? {
        pinned: false,
        lastReadUpdatedAt: 0,
      };
      childMeta.managedParent = { parentThreadId: threadId, taskId: nextTaskId };
      state.threadMeta[next.childThreadId] = childMeta;
    });
    await bridge
      .request("thread/name/set", { threadId: next.childThreadId, name: title })
      .catch(() => undefined);
    projection.publishThreadState(next.childThreadId);
    return finish(
      dynamicToolSuccess({ taskId: next.id, threadId: next.childThreadId, status: next.status }),
    );
  }

  if (tool === "integrate_task") {
    if (!isTerminalTask(task)) {
      return finish(dynamicToolError("Only a terminal managed task can be integrated"));
    }
    if (!task.workspace) {
      return finish(dynamicToolError("This managed task has no isolated workspace"));
    }
    if (task.workspace.lifecycle === "integrated") {
      return finish(
        dynamicToolSuccess({
          integrated: true,
          changedPaths: task.workspace.changedPaths ?? [],
          alreadyIntegrated: true,
        }),
      );
    }
    if (task.workspace.lifecycle === "discarded") {
      return finish(dynamicToolError("This managed task's changes were discarded"));
    }
    if (
      Object.values(store.view().threadMeta[threadId]?.teamOrchestration?.tasks ?? {}).some(
        (candidate) => candidate.predecessorTaskId === task.id,
      )
    ) {
      return finish(dynamicToolError("Integrate the latest follow-up task instead"));
    }
    const activeSharedWriter = activeSharedWriteTask(store, threadId, task.id);
    if (activeSharedWriter) {
      return finish(
        dynamicToolError(
          `Wait for shared-write task ${activeSharedWriter.title} [${activeSharedWriter.id}] before integrating isolated changes`,
        ),
      );
    }
    try {
      await store.update((state) => {
        const current = state.threadMeta[threadId]?.teamOrchestration?.tasks[taskId];
        if (current?.workspace) {
          current.workspace.lifecycle = "integrating";
          current.workspace.updatedAt = Date.now();
        }
      });
      const integration = await integrateTeamWorkspace(
        task.workspace,
        task.access?.writePaths ?? [],
      );
      const integratedAt = Date.now();
      await store.update((state) => {
        const orchestration = state.threadMeta[threadId]?.teamOrchestration;
        const current = orchestration?.tasks[taskId];
        if (!current?.workspace) return;
        for (const candidate of Object.values(orchestration?.tasks ?? {})) {
          if (candidate.workspace?.worktreePath !== current.workspace.worktreePath) continue;
          candidate.workspace = {
            ...candidate.workspace,
            lifecycle: "integrated",
            changedPaths: integration.changedPaths,
            conflictPaths: undefined,
            error: undefined,
            updatedAt: integratedAt,
          };
        }
      });
      let cleanupError: string | undefined;
      try {
        await discardTeamWorkspace(task.workspace);
      } catch (error) {
        cleanupError = safeError(error).message;
        await store.update((state) => {
          const current = state.threadMeta[threadId]?.teamOrchestration?.tasks[taskId];
          if (current?.workspace?.lifecycle === "integrated") {
            current.workspace.error = cleanupError;
            current.workspace.updatedAt = Date.now();
          }
        });
      }
      return finish(dynamicToolSuccess({ integrated: true, ...integration, cleanupError }));
    } catch (error) {
      if (error instanceof TeamWorkspaceConflictError || error instanceof TeamWorkspacePathError) {
        const conflictPaths =
          error instanceof TeamWorkspaceConflictError
            ? error.conflicts.map((conflict) => conflict.path)
            : error.paths;
        await store.update((state) => {
          const current = state.threadMeta[threadId]?.teamOrchestration?.tasks[taskId];
          if (!current?.workspace) return;
          current.workspace.lifecycle = "conflicted";
          current.workspace.conflictPaths = conflictPaths;
          current.workspace.error = error.message;
          current.workspace.updatedAt = Date.now();
        });
        return finish(dynamicToolError(`${error.message}: ${conflictPaths.join(", ")}`));
      }
      if (error instanceof TeamWorkspaceError) {
        await store.update((state) => {
          const current = state.threadMeta[threadId]?.teamOrchestration?.tasks[taskId];
          if (current?.workspace) {
            current.workspace.lifecycle = "recoveryRequired";
            current.workspace.error = error.message;
            current.workspace.updatedAt = Date.now();
          }
        });
      }
      throw error;
    }
  }

  if (tool === "discard_task_changes") {
    if (!isTerminalTask(task)) {
      return finish(dynamicToolError("Only a terminal managed task can be discarded"));
    }
    if (!task.workspace) {
      return finish(dynamicToolError("This managed task has no isolated workspace"));
    }
    if (task.workspace.lifecycle === "discarded") {
      return finish(dynamicToolSuccess({ discarded: true, alreadyDiscarded: true }));
    }
    if (task.workspace.lifecycle === "integrated") {
      return finish(dynamicToolError("This managed task was already integrated"));
    }
    if (
      Object.values(store.view().threadMeta[threadId]?.teamOrchestration?.tasks ?? {}).some(
        (candidate) => candidate.predecessorTaskId === task.id,
      )
    ) {
      return finish(dynamicToolError("Discard the latest follow-up task instead"));
    }
    await store.update((state) => {
      const current = state.threadMeta[threadId]?.teamOrchestration?.tasks[taskId];
      if (current?.workspace) {
        current.workspace.lifecycle = "discarding";
        current.workspace.updatedAt = Date.now();
      }
    });
    try {
      await discardTeamWorkspace(task.workspace);
      await store.update((state) => {
        const orchestration = state.threadMeta[threadId]?.teamOrchestration;
        const current = orchestration?.tasks[taskId];
        if (current?.workspace) {
          for (const candidate of Object.values(orchestration?.tasks ?? {})) {
            if (candidate.workspace?.worktreePath !== current.workspace.worktreePath) continue;
            candidate.workspace.lifecycle = "discarded";
            candidate.workspace.updatedAt = Date.now();
            delete candidate.workspace.error;
          }
        }
      });
      return finish(dynamicToolSuccess({ discarded: true }));
    } catch (error) {
      await store.update((state) => {
        const current = state.threadMeta[threadId]?.teamOrchestration?.tasks[taskId];
        if (current?.workspace) {
          current.workspace.lifecycle = "recoveryRequired";
          current.workspace.error = safeError(error).message;
          current.workspace.updatedAt = Date.now();
        }
      });
      throw error;
    }
  }

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
    return dynamicToolSuccess({
      ...publicManagedTask(task, store.view().threadMeta[threadId]?.teamOrchestration?.tasks),
      workspacePath:
        task.workspace && !["integrated", "discarded"].includes(task.workspace.lifecycle)
          ? task.workspace.worktreePath
          : null,
      recentMessages,
    });
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
    await finalizeManagedTask(
      store,
      task.childThreadId,
      `cancelled:${Date.now()}`,
      "interrupted",
      {
        summary: reason ? `Task cancelled: ${reason}` : "Task cancelled by the parent agent.",
        source: "status",
      },
      task.id,
    );
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
  options: ManagedTaskOptions,
): Promise<ManagedTeamTaskState> {
  if (store.view().threadMeta[parent.id]?.managedTeamToolsAvailable !== true) {
    throw new ProjectConflictError("This Team session does not have managed tools");
  }
  const started = recoveredThread
    ? { thread: recoveredThread }
    : parseThreadStart(
        await bridge.request<unknown>("thread/start", {
          cwd: parent.cwd,
          model: options.model,
          ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
          ...(parent.settings.personality ? { personality: parent.settings.personality } : {}),
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
    ...(options?.dependsOn.length ? { dependsOn: options.dependsOn } : {}),
    access: options.access,
    resolvedModel: options.model,
    resolvedReasoningEffort: options.reasoningEffort,
    resolvedServiceTier: options.serviceTier,
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

function managedTaskDependencyFailure(
  task: ManagedTeamTaskView,
  tasks: ManagedTeamTaskMapView,
): string | null {
  for (const dependencyId of task.dependsOn ?? []) {
    const dependency = tasks[dependencyId];
    if (!dependency) return `Dependency ${dependencyId} is unavailable.`;
    if (!isTerminalTask(dependency)) continue;
    if (
      dependency.status !== "completed" ||
      (dependency.result?.outcome !== undefined && dependency.result.outcome !== "success") ||
      (dependency.workspace?.lifecycle === "discarded" &&
        Boolean(dependency.workspace.changedPaths?.length))
    ) {
      return `Dependency ${dependency.title} [${dependency.id}] did not complete successfully.`;
    }
  }
  return null;
}

function managedTaskDependenciesReady(
  task: ManagedTeamTaskView,
  tasks: ManagedTeamTaskMapView,
): boolean {
  return (task.dependsOn ?? []).every((dependencyId) => {
    const dependency = tasks[dependencyId];
    if (!dependency || !isTerminalTask(dependency) || dependency.delivery?.status !== "delivered") {
      return false;
    }
    if (dependency.status !== "completed") return false;
    if (dependency.result?.outcome !== undefined && dependency.result.outcome !== "success") {
      return false;
    }
    return (
      !dependency.workspace ||
      dependency.workspace.lifecycle === "integrated" ||
      (dependency.workspace.lifecycle === "discarded" && !dependency.workspace.changedPaths?.length)
    );
  });
}

async function prepareManagedTaskWorkspace(
  store: StateStore,
  parentThreadId: string,
  task: ManagedTeamTaskView,
  parentCwd: string,
): Promise<ManagedTeamTaskState["workspace"] | null> {
  if (task.access?.mode !== "isolatedWrite") return null;
  if (task.workspace) {
    const reused = {
      ...cloneView<NonNullable<ManagedTeamTaskState["workspace"]>>(task.workspace),
      lifecycle: "ready" as const,
      updatedAt: Date.now(),
    };
    await ensureManagedTaskSandboxMountpoints(reused.worktreePath);
    await store.update((state) => {
      const current = state.threadMeta[parentThreadId]?.teamOrchestration?.tasks[task.id];
      if (current?.status === "starting") current.workspace = reused;
    });
    return reused;
  }
  const metadata = await createTeamWorkspace(parentCwd, task.id);
  const now = Date.now();
  const workspace: NonNullable<ManagedTeamTaskState["workspace"]> = {
    lifecycle: "ready",
    ...metadata,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await ensureManagedTaskSandboxMountpoints(workspace.worktreePath);
    await store.update((state) => {
      const current = state.threadMeta[parentThreadId]?.teamOrchestration?.tasks[task.id];
      if (!current || current.status !== "starting") {
        throw new ProjectConflictError("Managed task is no longer starting");
      }
      current.workspace = workspace;
    });
  } catch (error) {
    await discardTeamWorkspace(metadata).catch(() => undefined);
    throw error;
  }
  return workspace;
}

async function ensureManagedTaskSandboxMountpoints(worktreePath: string): Promise<void> {
  for (const name of TEAM_SANDBOX_MOUNTPOINTS) {
    const mountpoint = join(worktreePath, name);
    try {
      await mkdir(mountpoint);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!(await lstat(mountpoint)).isDirectory()) {
      throw new ProjectConflictError(`Team sandbox mountpoint is not a directory: ${name}`);
    }
  }
}

async function managedChildRuntime(
  task: ManagedTeamTaskView,
  parentCwd: string,
  workspace: ManagedTeamTaskState["workspace"] | null,
): Promise<ManagedChildRuntime> {
  if (!task.access) return { cwd: parentCwd };
  const networkAccess = task.access.network ?? false;
  if (task.access.mode === "readOnly") {
    return {
      cwd: parentCwd,
      runtimeWorkspaceRoots: [parentCwd],
      sandboxPolicy: { type: "readOnly", networkAccess },
    };
  }
  const root = task.access.mode === "isolatedWrite" ? workspace?.worktreePath : parentCwd;
  if (!root) throw new ProjectConflictError("The isolated Team workspace is unavailable");
  const cwd =
    workspace && task.access.mode === "isolatedWrite"
      ? isolatedTaskCwd(parentCwd, workspace)
      : parentCwd;
  const writableRoots = await Promise.all(
    (task.access.writePaths ?? []).map((path) => safeManagedWritableRoot(root, path)),
  );
  return {
    cwd,
    runtimeWorkspaceRoots:
      workspace && task.access.mode === "isolatedWrite"
        ? [workspace.worktreePath, workspace.repositoryRoot]
        : [parentCwd],
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots,
      networkAccess,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
  };
}

async function safeManagedWritableRoot(root: string, path: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const candidate = resolve(canonicalRoot, path);
  let existing = candidate;
  while (true) {
    try {
      const canonicalExisting = await realpath(existing);
      if (!pathContains(canonicalRoot, canonicalExisting)) {
        throw new ProjectValidationError(`Writable path escapes the managed workspace: ${path}`);
      }
      return candidate;
    } catch (error) {
      if (error instanceof ProjectValidationError) throw error;
      const parent = dirname(existing);
      if (parent === existing) {
        throw new ProjectValidationError(`Writable path is unavailable: ${path}`);
      }
      existing = parent;
    }
  }
}

function isolatedTaskCwd(
  parentCwd: string,
  workspace: NonNullable<ManagedTeamTaskState["workspace"]>,
): string {
  const child = relative(workspace.repositoryRoot, resolve(parentCwd));
  if (!child) return workspace.worktreePath;
  if (child === ".." || child.startsWith("../") || isAbsolute(child)) {
    return workspace.worktreePath;
  }
  return resolve(workspace.worktreePath, child);
}

async function startQueuedTeamTasks(
  bridge: CodexBridge,
  store: StateStore,
  projection: AppProjection,
  parentThreadId: string,
): Promise<void> {
  while (true) {
    const orchestration = store.view().threadMeta[parentThreadId]?.teamOrchestration;
    if (!orchestration) return;
    const active = Object.values(orchestration.tasks).filter(
      (task) => task.status === "starting" || task.status === "running",
    ).length;
    if (active >= TEAM_MAX_ACTIVE_TASKS) return;
    const queuedTasks = Object.values(orchestration.tasks)
      .filter((task) => task.status === "queued")
      .sort((left, right) => left.createdAt - right.createdAt);
    const dependencyFailure = queuedTasks
      .map((task) => ({ task, reason: managedTaskDependencyFailure(task, orchestration.tasks) }))
      .find((candidate) => candidate.reason);
    if (dependencyFailure) {
      await finalizeManagedTask(
        store,
        dependencyFailure.task.childThreadId,
        `dependency-failed:${Date.now()}`,
        "failed",
        {
          outcome: "failed",
          summary: dependencyFailure.reason!,
          source: "status",
        },
        dependencyFailure.task.id,
      );
      continue;
    }
    const queued = queuedTasks.find((task) =>
      managedTaskDependenciesReady(task, orchestration.tasks),
    );
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
      const model = managedChildModel(projection.availableModels);
      const launchTask: ManagedTeamTaskState = {
        ...cloneView<ManagedTeamTaskState>(queued),
        resolvedModel: model.id,
        resolvedReasoningEffort: compatibleManagedChildEffort(model, [
          queued.resolvedReasoningEffort,
          parent.settings.reasoningEffort,
        ]),
        resolvedServiceTier: compatibleManagedChildTier(model, [
          queued.resolvedServiceTier,
          parent.settings.serviceTier,
        ]),
      };
      await store.update((state) => {
        const task = state.threadMeta[parentThreadId]?.teamOrchestration?.tasks[queued.id];
        if (!task || task.status !== "starting") return;
        task.resolvedModel = launchTask.resolvedModel;
        task.resolvedReasoningEffort = launchTask.resolvedReasoningEffort;
        task.resolvedServiceTier = launchTask.resolvedServiceTier;
      });
      const workspace = await prepareManagedTaskWorkspace(
        store,
        parentThreadId,
        launchTask,
        parent.cwd,
      );
      const runtime = await managedChildRuntime(launchTask, parent.cwd, workspace);
      await bridge.request<ThreadResumeResponse>(
        "thread/resume",
        {
          threadId: launchTask.childThreadId,
          cwd: runtime.cwd,
          ...(runtime.runtimeWorkspaceRoots
            ? { runtimeWorkspaceRoots: runtime.runtimeWorkspaceRoots }
            : {}),
          approvalPolicy: "never" as const,
          excludeTurns: true,
          ...managedChildResumeSettings(parent.settings, projection.availableModels, launchTask),
          config: teamRuntimeConfig(),
          developerInstructions: TEAM_CHILD_INSTRUCTIONS,
        },
        30_000,
      );
      const turn = parseTurnStart(
        await bridge.request<unknown>("turn/start", {
          threadId: launchTask.childThreadId,
          clientUserMessageId: launchTask.startMessageId ?? teamTaskStartMarkerId(launchTask.id),
          input: messageInput(launchTask.prompt, []),
          ...managedChildTurnSettings(
            parent.settings,
            projection.availableModels,
            launchTask,
            runtime,
          ),
        }),
      );
      await projection.markMaterialized(launchTask.childThreadId);
      await projection.setCurrentTurn(launchTask.childThreadId, turn.turn.id);
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
          queued.id,
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
  tokenUsage: Map<string, { tokens: number; persistedAt: number }>,
): Promise<Set<string>> {
  const affected = new Set<string>();
  const childThreadId = notificationThreadId(notification);
  if (!childThreadId) return affected;
  const managed = managedTaskForNotification(store.view(), notification);
  if (!managed || isTerminalTask(managed.task)) return affected;
  const now = activity.get(childThreadId) ?? Date.now();
  const expectedWakeAt = managedSleepExpectedWakeAt(notification);
  const sleepCompleted =
    notification.method === "item/completed" && notification.params.item.type === "sleep";
  if (notification.method === "thread/tokenUsage/updated") {
    const tokensUsed = Math.max(0, Math.floor(notification.params.tokenUsage.last.totalTokens));
    const previousUsage = tokenUsage.get(childThreadId);
    const shouldPersist =
      !previousUsage || now - previousUsage.persistedAt >= TEAM_ACTIVITY_PERSIST_MS;
    tokenUsage.set(childThreadId, {
      tokens: tokensUsed,
      persistedAt: shouldPersist ? now : previousUsage.persistedAt,
    });
    if (shouldPersist) {
      await store.updateDeferred((state) => {
        const task =
          state.threadMeta[managed.parentThreadId]?.teamOrchestration?.tasks[managed.task.id];
        if (!task || isTerminalTask(task)) return;
        task.tokensUsed = tokensUsed;
        task.lastActivityAt = now;
      });
    }
  }
  if (expectedWakeAt !== null || sleepCompleted) {
    await store.update((state) => {
      const task =
        state.threadMeta[managed.parentThreadId]?.teamOrchestration?.tasks[managed.task.id];
      if (!task || isTerminalTask(task)) return;
      task.lastActivityAt = now;
      delete task.watchdog;
      if (expectedWakeAt !== null) {
        task.expectedWakeAt = expectedWakeAt;
      } else if (sleepCompleted) {
        delete task.expectedWakeAt;
      }
    });
  } else if (now - managed.task.lastActivityAt >= TEAM_ACTIVITY_PERSIST_MS) {
    await store.updateDeferred((state) => {
      const task =
        state.threadMeta[managed.parentThreadId]?.teamOrchestration?.tasks[managed.task.id];
      if (!task || isTerminalTask(task)) return;
      task.lastActivityAt = now;
      delete task.watchdog;
    });
  }

  if (notification.method === "turn/completed") {
    const finalUsage = tokenUsage.get(childThreadId);
    if (finalUsage) {
      await store.update((state) => {
        const task =
          state.threadMeta[managed.parentThreadId]?.teamOrchestration?.tasks[managed.task.id];
        if (task && !isTerminalTask(task)) task.tokensUsed = finalUsage.tokens;
      });
      tokenUsage.delete(childThreadId);
    }
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
    if (
      await finalizeManagedTask(
        store,
        childThreadId,
        turn.id,
        turnOutcome(turn),
        result,
        managed.task.id,
      )
    ) {
      affected.add(managed.parentThreadId);
    }
    return affected;
  }

  if (
    notification.method === "thread/status/changed" &&
    notification.params.status.type === "systemError"
  ) {
    if (
      await finalizeManagedTask(
        store,
        childThreadId,
        `system-error:${Date.now()}`,
        "failed",
        {
          summary: "Managed task stopped because the Codex thread entered a system error state.",
          source: "status",
        },
        managed.task.id,
      )
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
        managed.task.id,
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
  expectedTaskId?: string,
): Promise<boolean> {
  const managed = managedTaskForChild(store.view(), childThreadId, expectedTaskId);
  if (!managed || isTerminalTask(managed.task)) return false;
  let workspaceUpdate: ManagedTeamTaskState["workspace"] | undefined;
  let changedPathCount = managed.task.workspace?.changedPaths?.length ?? 0;
  if (
    managed.task.workspace &&
    !["integrated", "discarded"].includes(managed.task.workspace.lifecycle)
  ) {
    try {
      const delta = await computeTeamWorkspaceDelta(managed.task.workspace);
      changedPathCount = delta.changedPaths.length;
      if (!delta.changedPaths.length) {
        await discardTeamWorkspace(managed.task.workspace);
        workspaceUpdate = {
          ...cloneView<NonNullable<ManagedTeamTaskState["workspace"]>>(managed.task.workspace),
          lifecycle: "discarded",
          changedPaths: [],
          updatedAt: Date.now(),
        };
      } else {
        workspaceUpdate = {
          ...cloneView<NonNullable<ManagedTeamTaskState["workspace"]>>(managed.task.workspace),
          lifecycle: "ready",
          changedPaths: delta.changedPaths,
          conflictPaths: undefined,
          error: undefined,
          updatedAt: Date.now(),
        };
      }
    } catch (error) {
      workspaceUpdate = {
        ...cloneView<NonNullable<ManagedTeamTaskState["workspace"]>>(managed.task.workspace),
        lifecycle: "recoveryRequired",
        error: safeError(error).message,
        updatedAt: Date.now(),
      };
    }
  }
  let recorded = false;
  await store.update((state) => {
    const task =
      state.threadMeta[managed.parentThreadId]?.teamOrchestration?.tasks[managed.task.id];
    if (!task || isTerminalTask(task)) return;
    task.status = outcome;
    task.terminalTurnId = terminalTurnId;
    if (workspaceUpdate) task.workspace = workspaceUpdate;
    const normalizedResult = !result.outcome
      ? {
          ...result,
          outcome: outcome === "completed" ? ("success" as const) : ("failed" as const),
        }
      : result;
    task.result = task.budgetReason
      ? {
          ...normalizedResult,
          outcome: changedPathCount > 0 ? "partial" : "failed",
        }
      : normalizedResult;
    if (task.startedAt) task.timeUsedSeconds = Math.max(0, (Date.now() - task.startedAt) / 1_000);
    task.lastActivityAt = Date.now();
    delete task.watchdog;
    delete task.delivery;
    delete task.recoveryMisses;
    delete task.expectedWakeAt;
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
          result: JSON.parse(JSON.stringify(task.result)) as ManagedTeamTaskResult,
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
  const orchestration = state.threadMeta[parentThreadId]?.teamOrchestration;
  if (!orchestration) return;
  const terminal = Object.values(orchestration.tasks)
    .filter(
      (task) => isTerminalTask(task) && task.delivery?.status === "delivered" && !task.watchdog,
    )
    .sort((left, right) => right.createdAt - left.createdAt);
  const retained = new Set(terminal.slice(0, TEAM_TASK_HISTORY_LIMIT).map((task) => task.id));
  for (const task of terminal.slice(TEAM_TASK_HISTORY_LIMIT).reverse()) {
    const requiredByActiveTask = Object.values(orchestration.tasks).some(
      (candidate) =>
        !isTerminalTask(candidate) &&
        (candidate.predecessorTaskId === task.id || candidate.dependsOn?.includes(task.id)),
    );
    if (requiredByActiveTask) continue;
    const successor = Object.values(orchestration.tasks).find(
      (candidate) => candidate.predecessorTaskId === task.id,
    );
    const workspaceResolved =
      !task.workspace ||
      !managedTaskHasPendingWorkspace(task) ||
      Boolean(successor?.workspace?.worktreePath === task.workspace.worktreePath);
    if (!workspaceResolved || retained.has(task.id)) continue;
    for (const candidate of Object.values(orchestration.tasks)) {
      if (candidate.predecessorTaskId === task.id) delete candidate.predecessorTaskId;
      if (candidate.dependsOn?.includes(task.id)) {
        candidate.dependsOn = candidate.dependsOn.filter((dependency) => dependency !== task.id);
        if (!candidate.dependsOn.length) delete candidate.dependsOn;
      }
    }
    delete orchestration.tasks[task.id];
  }
}

function hasPendingTeamContinuation(store: StateStore, parentThreadId: string): boolean {
  const orchestration = store.view().threadMeta[parentThreadId]?.teamOrchestration;
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
  const orchestration = store.view().threadMeta[parentThreadId]?.teamOrchestration;
  return Boolean(
    orchestration &&
    Object.values(orchestration.tasks).some(
      (task) => task.delivery?.status === "claimed" || task.watchdog?.status === "claimed",
    ),
  );
}

function pendingTeamParents(store: StateStore): string[] {
  const state = store.view();
  return Object.entries(state.threadMeta)
    .filter(([, meta]) => Boolean(meta.teamOrchestration))
    .map(([threadId]) => threadId);
}

function teamContinuationContext(
  store: StateStore,
  parentThreadId: string,
  claim: TeamResultClaim,
): string {
  const state = store.view();
  const active = Object.values(state.threadMeta[parentThreadId]?.teamOrchestration?.tasks ?? {})
    .filter((task) => task.status === "starting" || task.status === "running")
    .map((task) => `${task.title} [${task.id}]`);
  const queued = Object.values(state.threadMeta[parentThreadId]?.teamOrchestration?.tasks ?? {})
    .filter((task) => task.status === "queued")
    .map((task) => `${task.title} [${task.id}]`);
  const resultSections = claim.results.map((item) => {
    const task = state.threadMeta[parentThreadId]?.teamOrchestration?.tasks[item.taskId];
    return [
      `Task: ${item.title} [${item.taskId}]`,
      `Outcome: ${item.outcome}`,
      `Source: ${item.result.source}`,
      ...(item.result.outcome ? [`Result outcome: ${item.result.outcome}`] : []),
      `Summary: ${item.result.summary}`,
      ...(item.result.details ? [`Details:\n${item.result.details}`] : []),
      ...(item.result.checks?.length
        ? [
            `Checks:\n${item.result.checks
              .map(
                (check) =>
                  `- ${check.name}: ${check.outcome}${check.details ? ` — ${check.details}` : ""}`,
              )
              .join("\n")}`,
          ]
        : []),
      ...(item.result.risks?.length ? [`Risks:\n- ${item.result.risks.join("\n- ")}`] : []),
      ...(item.result.artifacts?.length
        ? [
            `Artifacts:\n${item.result.artifacts
              .map((artifact) => `- ${artifact.label}: ${artifact.path ?? artifact.url}`)
              .join("\n")}`,
          ]
        : []),
      ...(task?.budgetReason ? [`Budget limit: ${task.budgetReason}`] : []),
      ...(task?.workspace
        ? [
            `Workspace: ${task.workspace.lifecycle}${task.workspace.changedPaths?.length ? `; changed paths: ${task.workspace.changedPaths.join(", ")}` : ""}`,
          ]
        : []),
    ].join("\n");
  });
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

async function reconcileManagedTaskWorkspace(
  store: StateStore,
  parentThreadId: string,
  task: ManagedTeamTaskView,
): Promise<void> {
  const workspace = task.workspace;
  if (!workspace) return;
  try {
    if (workspace.lifecycle === "discarding") {
      await discardTeamWorkspace(workspace);
      await updateManagedWorkspaceFamily(store, parentThreadId, workspace.worktreePath, {
        lifecycle: "discarded",
        error: undefined,
      });
      return;
    }
    if (workspace.lifecycle === "integrating") {
      const activeSharedWriter = activeSharedWriteTask(store, parentThreadId, task.id);
      if (activeSharedWriter) {
        await updateManagedWorkspaceFamily(store, parentThreadId, workspace.worktreePath, {
          lifecycle: "recoveryRequired",
          error: `Wait for shared-write task ${activeSharedWriter.title} [${activeSharedWriter.id}] before recovering integration`,
        });
        return;
      }
      const integration = await integrateTeamWorkspace(workspace, task.access?.writePaths ?? []);
      await updateManagedWorkspaceFamily(store, parentThreadId, workspace.worktreePath, {
        lifecycle: "integrated",
        changedPaths: integration.changedPaths,
        conflictPaths: undefined,
        error: undefined,
      });
      try {
        await discardTeamWorkspace(workspace);
      } catch (error) {
        await updateManagedWorkspaceFamily(store, parentThreadId, workspace.worktreePath, {
          lifecycle: "integrated",
          error: safeError(error).message,
        });
      }
      return;
    }
    if (workspace.lifecycle === "integrated") {
      if (workspace.error) {
        try {
          await discardTeamWorkspace(workspace);
          await updateManagedWorkspaceFamily(store, parentThreadId, workspace.worktreePath, {
            lifecycle: "integrated",
            error: undefined,
          });
        } catch (error) {
          await updateManagedWorkspaceFamily(store, parentThreadId, workspace.worktreePath, {
            lifecycle: "integrated",
            error: safeError(error).message,
          });
        }
      }
      return;
    }
    if (workspace.lifecycle === "discarded") return;
    const delta = await computeTeamWorkspaceDelta(workspace);
    if (!delta.changedPaths.length && isTerminalTask(task)) {
      await discardTeamWorkspace(workspace);
      await updateManagedWorkspaceFamily(store, parentThreadId, workspace.worktreePath, {
        lifecycle: "discarded",
        changedPaths: [],
        conflictPaths: undefined,
        error: undefined,
      });
      return;
    }
    await updateManagedWorkspaceFamily(store, parentThreadId, workspace.worktreePath, {
      lifecycle: workspace.lifecycle === "conflicted" ? "conflicted" : "ready",
      changedPaths: delta.changedPaths,
      error: workspace.lifecycle === "conflicted" ? workspace.error : undefined,
    });
  } catch (error) {
    if (error instanceof TeamWorkspaceConflictError) {
      await updateManagedWorkspaceFamily(store, parentThreadId, workspace.worktreePath, {
        lifecycle: "conflicted",
        conflictPaths: error.conflicts.map((conflict) => conflict.path),
        error: error.message,
      });
      return;
    }
    await updateManagedWorkspaceFamily(store, parentThreadId, workspace.worktreePath, {
      lifecycle: "recoveryRequired",
      error: safeError(error).message,
    });
  }
}

function activeSharedWriteTask(
  store: StateStore,
  parentThreadId: string,
  excludedTaskId: string,
): ManagedTeamTaskView | undefined {
  return Object.values(
    store.view().threadMeta[parentThreadId]?.teamOrchestration?.tasks ?? {},
  ).find(
    (candidate) =>
      candidate.id !== excludedTaskId &&
      (candidate.status === "starting" || candidate.status === "running") &&
      candidate.access?.mode === "sharedWrite",
  );
}

async function updateManagedWorkspaceFamily(
  store: StateStore,
  parentThreadId: string,
  worktreePath: string,
  patch: Partial<NonNullable<ManagedTeamTaskState["workspace"]>>,
): Promise<void> {
  await store.update((state) => {
    const tasks = state.threadMeta[parentThreadId]?.teamOrchestration?.tasks ?? {};
    for (const candidate of Object.values(tasks)) {
      if (candidate.workspace?.worktreePath !== worktreePath) continue;
      candidate.workspace = {
        ...candidate.workspace,
        ...patch,
        updatedAt: Date.now(),
      };
    }
  });
}

async function reconcileTeamOrchestration(
  bridge: CodexBridge,
  store: StateStore,
  projection: AppProjection,
  onlyParentThreadId?: string,
): Promise<Set<string>> {
  const affected = new Set<string>();
  const state = store.view();
  for (const [parentThreadId, meta] of Object.entries(state.threadMeta)) {
    if (onlyParentThreadId && parentThreadId !== onlyParentThreadId) continue;
    const orchestration = meta.teamOrchestration;
    if (!orchestration) continue;
    const parent = projection.summary(parentThreadId);
    const claimedById = new Map<
      string,
      { results: TeamResultClaim["results"]; markerId: string | null }
    >();
    for (const task of Object.values(orchestration.tasks)) {
      if (task.workspace) {
        await reconcileManagedTaskWorkspace(store, parentThreadId, task).catch((error) => {
          projection.emit(
            "projectionError",
            error instanceof Error ? error : new Error(String(error)),
          );
        });
      }
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
            result: cloneView<ManagedTeamTaskResult>(task.result),
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
      let expectedTurnId = task.childTurnId;
      if (task.status === "starting" && !expectedTurnId) {
        try {
          expectedTurnId =
            (await deliveredClientMessageTurnId(
              bridge,
              task.childThreadId,
              task.startMessageId ?? teamTaskStartMarkerId(task.id),
            )) ?? undefined;
        } catch (error) {
          projection.emit(
            "projectionError",
            error instanceof Error ? error : new Error(String(error)),
          );
          continue;
        }
        if (!expectedTurnId) {
          await store.update((draft) => {
            const current = draft.threadMeta[parentThreadId]?.teamOrchestration?.tasks[task.id];
            if (current?.status === "starting" && !current.childTurnId) {
              current.status = "queued";
            }
          });
          continue;
        }
      }
      const summary = projection.summary(task.childThreadId);
      if (summary?.currentTurnId && (!expectedTurnId || summary.currentTurnId === expectedTurnId)) {
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
              limit: expectedTurnId ? TEAM_TASK_HISTORY_LIMIT : 1,
              sortDirection: "desc",
              itemsView: "full",
            },
            30_000,
          ),
        );
        const recoveredTurn = expectedTurnId
          ? page.data.find((turn) => turn.id === expectedTurnId)
          : page.data[0];
        if (recoveredTurn && recoveredTurn.status !== "inProgress") {
          const result = task.resultCandidate
            ? submittedManagedResult(task)
            : managedResultFromTurn(recoveredTurn, turnOutcome(recoveredTurn));
          if (
            await finalizeManagedTask(
              store,
              task.childThreadId,
              recoveredTurn.id,
              turnOutcome(recoveredTurn),
              result,
              task.id,
            )
          ) {
            affected.add(parentThreadId);
          }
        } else if (recoveredTurn?.status === "inProgress") {
          await projection.setCurrentTurn(task.childThreadId, recoveredTurn.id);
          await store.update((draft) => {
            const current = draft.threadMeta[parentThreadId]?.teamOrchestration?.tasks[task.id];
            if (!current || isTerminalTask(current)) return;
            current.status = "running";
            current.childTurnId = recoveredTurn.id;
            current.startedAt ??= Date.now();
            current.lastActivityAt = Date.now();
            delete current.recoveryMisses;
          });
        } else if (!recoveredTurn && task.status === "starting") {
          await store.update((draft) => {
            const current = draft.threadMeta[parentThreadId]?.teamOrchestration?.tasks[task.id];
            if (current?.status === "starting") current.status = "queued";
          });
        } else if (!recoveredTurn && task.status === "running") {
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
                task.id,
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
            task.id,
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
            store,
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
  store: StateStore,
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
      const task = store.view().threadMeta[parentThreadId]?.teamOrchestration?.tasks[result.taskId];
      return {
        threadId: result.childThreadId,
        title: result.title,
        nickname: child?.relation.kind === "subagent" ? child.relation.nickname : null,
        outcome: result.outcome,
        taskId: result.taskId,
        ...(result.result.outcome
          ? {
              result: {
                outcome: result.result.outcome,
                summary: result.result.summary,
                ...(result.result.checks ? { checks: result.result.checks } : {}),
              },
            }
          : {}),
        ...(task?.budgetReason ? { budgetReason: task.budgetReason } : {}),
        ...(task?.failureReason ? { failureReason: task.failureReason } : {}),
        ...(task?.workspace?.changedPaths?.length
          ? {
              changedPaths: task.workspace.changedPaths.slice(0, TEAM_NOTICE_CHANGED_PATH_LIMIT),
              changedPathCount: task.workspace.changedPaths.length,
            }
          : {}),
        ...(task?.workspace ? { workspaceIntegrationStatus: task.workspace.lifecycle } : {}),
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
  return Boolean(managedTaskForNotification(store.view(), notification));
}

export async function triggerTeamWatchdogs(
  store: StateStore,
  activity: Map<string, number>,
  now: number,
): Promise<Set<string>> {
  const affected = new Set<string>();
  const state = store.view();
  const due: Array<{ parentThreadId: string; taskId: string; lastActivityAt: number }> = [];
  for (const [parentThreadId, meta] of Object.entries(state.threadMeta)) {
    for (const task of Object.values(meta.teamOrchestration?.tasks ?? {})) {
      if (task.status !== "running" || task.watchdog) continue;
      if (teamWatchdogIsPaused(task, now)) continue;
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
      if (teamWatchdogIsPaused(task, now)) continue;
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

function managedSleepExpectedWakeAt(notification: ServerNotification): number | null {
  if (notification.method !== "item/started" || notification.params.item.type !== "sleep") {
    return null;
  }
  const durationMs = notification.params.item.durationMs;
  if (!Number.isFinite(durationMs) || durationMs < 0) return null;
  return notification.params.startedAtMs + durationMs;
}

function teamWatchdogIsPaused(task: ManagedTeamTaskView, now: number): boolean {
  return task.expectedWakeAt !== undefined && now - task.expectedWakeAt < TEAM_WATCHDOG_MS;
}

function managedTaskForChild(
  state: CodexNestStateView,
  childThreadId: string,
  expectedTaskId?: string,
): { parentThreadId: string; task: ManagedTeamTaskView } | null {
  if (expectedTaskId) {
    for (const [parentThreadId, meta] of Object.entries(state.threadMeta)) {
      const task = meta.teamOrchestration?.tasks[expectedTaskId];
      if (task?.childThreadId === childThreadId) return { parentThreadId, task };
    }
    return null;
  }
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

function managedTaskForNotification(
  state: CodexNestStateView,
  notification: ServerNotification,
): { parentThreadId: string; task: ManagedTeamTaskView } | null {
  const childThreadId = notificationThreadId(notification);
  if (!childThreadId) return null;
  const turnId = notificationTurnId(notification);
  if (!turnId) return managedTaskForChild(state, childThreadId);
  for (const [parentThreadId, meta] of Object.entries(state.threadMeta)) {
    const task = Object.values(meta.teamOrchestration?.tasks ?? {}).find(
      (candidate) => candidate.childThreadId === childThreadId && candidate.childTurnId === turnId,
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

function notificationTurnId(notification: ServerNotification): string | null {
  if (notification.method === "turn/completed" || notification.method === "turn/started") {
    return notification.params.turn.id;
  }
  const params = notification.params as unknown;
  if (!isObjectRecord(params)) return null;
  return typeof params.turnId === "string" ? params.turnId : null;
}

function submittedManagedResult(task: ManagedTeamTaskView): ManagedTeamTaskResult {
  const candidate = task.resultCandidate;
  if (!candidate) {
    return {
      outcome: task.status === "completed" ? "success" : "failed",
      summary: "Managed task completed without a submitted result.",
      source: "status",
    };
  }
  return {
    summary: candidate.summary,
    ...(candidate.details ? { details: candidate.details } : {}),
    ...(candidate.outcome ? { outcome: candidate.outcome } : {}),
    ...(candidate.checks
      ? { checks: cloneView<ManagedTeamTaskResultCheck[]>(candidate.checks) }
      : {}),
    ...(candidate.risks ? { risks: [...candidate.risks] } : {}),
    ...(candidate.artifacts
      ? { artifacts: cloneView<ManagedTeamTaskResultArtifact[]>(candidate.artifacts) }
      : {}),
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
      outcome: outcome === "completed" ? "success" : "failed",
      summary,
      ...(text !== summary ? { details: text } : {}),
      source: final ? "final_answer" : "agent_message",
    };
  }
  return {
    outcome: outcome === "completed" ? "success" : "failed",
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

function isTerminalTask<Task extends { readonly status: ManagedTeamTaskState["status"] }>(
  task: Task,
): task is Task & { readonly status: ThreadOutcome } {
  return task.status === "completed" || task.status === "failed" || task.status === "interrupted";
}

function publicManagedTask(
  task: ManagedTeamTaskView,
  tasks?: ManagedTeamTaskMapView,
): Record<string, unknown> {
  const dependencies = (task.dependsOn ?? []).map((dependency) => tasks?.[dependency]);
  const queueReason =
    task.status !== "queued" || !dependencies.length
      ? null
      : dependencies.some(
            (dependency) =>
              !dependency ||
              !isTerminalTask(dependency) ||
              dependency.delivery?.status !== "delivered",
          )
        ? "waitingForDependencies"
        : dependencies.some(
              (dependency) =>
                dependency?.workspace &&
                dependency.workspace.lifecycle !== "integrated" &&
                !(
                  dependency.workspace.lifecycle === "discarded" &&
                  !dependency.workspace.changedPaths?.length
                ),
            )
          ? "waitingForIntegration"
          : null;
  return {
    taskId: task.id,
    threadId: task.childThreadId,
    title: task.title,
    status: task.status,
    queueReason,
    createdAt: task.createdAt,
    startedAt: task.startedAt ?? null,
    lastActivityAt: task.lastActivityAt,
    dependsOn: task.dependsOn ?? [],
    predecessorTaskId: task.predecessorTaskId ?? null,
    access: task.access ?? null,
    model: task.resolvedModel ?? null,
    reasoningEffort: task.resolvedReasoningEffort ?? null,
    serviceTier: task.resolvedServiceTier ?? null,
    tokensUsed: task.tokensUsed ?? 0,
    timeUsedSeconds:
      task.status === "running" && task.startedAt
        ? Math.max(task.timeUsedSeconds ?? 0, (Date.now() - task.startedAt) / 1_000)
        : (task.timeUsedSeconds ?? 0),
    failureReason: task.failureReason ?? null,
    workspace: task.workspace
      ? {
          lifecycle: task.workspace.lifecycle,
          changedPaths: task.workspace.changedPaths ?? [],
          conflictPaths: task.workspace.conflictPaths ?? [],
          error: task.workspace.error ?? null,
        }
      : null,
    result: task.result ?? null,
  };
}

function dynamicToolArguments(value: unknown): Record<string, unknown> {
  if (!isObjectRecord(value)) throw new ProjectValidationError("Tool arguments must be an object");
  return value;
}

type MutatingTeamTool = TeamToolOperationState["tool"];

function isMutatingTeamTool(value: string): value is MutatingTeamTool {
  return [
    "spawn_task",
    "followup_task",
    "steer_task",
    "cancel_task",
    "submit_result",
    "integrate_task",
    "discard_task_changes",
  ].includes(value);
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
      operation = JSON.parse(JSON.stringify(existing)) as TeamToolOperationState;
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
      ...(request.params.tool === "spawn_task" || request.params.tool === "followup_task"
        ? {
            taskId: randomUUID(),
            ...(request.params.tool === "spawn_task"
              ? { childThreadSource: `codexnest-managed:${key.slice(0, 32)}` }
              : {}),
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
  const grouped = new Map<string, TeamToolOperationView[]>();
  for (const operation of Object.values(store.view().teamToolOperations ?? {})) {
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
  return (
    value.startsWith("codexnest-team-claim:") || value.startsWith("codexnest-team-continuation:")
  );
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

function optionalToolStringArray(
  args: Record<string, unknown>,
  key: string,
  maximum = 100,
): string[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maximum) {
    throw new ProjectValidationError(`${key} must be an array with at most ${maximum} items`);
  }
  const result = value.map((item) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new ProjectValidationError(`${key} must contain non-empty strings`);
    }
    return item.trim();
  });
  if (new Set(result).size !== result.length) {
    throw new ProjectValidationError(`${key} must not contain duplicates`);
  }
  return result;
}

function managedTaskAccess(
  args: Record<string, unknown>,
  inherited?: DeepReadonly<ManagedTeamTaskAccessState>,
): ManagedTeamTaskAccessState {
  const raw = args.access;
  if (raw === undefined) {
    return cloneView<ManagedTeamTaskAccessState>(inherited ?? { mode: "readOnly", network: false });
  }
  if (!isObjectRecord(raw)) throw new ProjectValidationError("access must be an object");
  const mode = raw.mode === undefined ? "readOnly" : raw.mode;
  if (!(["readOnly", "isolatedWrite", "sharedWrite"] as const).includes(mode as never)) {
    throw new ProjectValidationError("access.mode is invalid");
  }
  const writePaths = optionalToolStringArray(raw, "writePaths") ?? [];
  for (const path of writePaths) {
    if (!isManagedRelativePath(path)) {
      throw new ProjectValidationError(`Unsafe repository-relative write path: ${path}`);
    }
  }
  if (mode === "readOnly" && writePaths.length) {
    throw new ProjectValidationError("readOnly tasks cannot declare writePaths");
  }
  if (mode !== "readOnly" && !writePaths.length) {
    throw new ProjectValidationError("Write modes require at least one writePaths entry");
  }
  if (raw.network !== undefined && typeof raw.network !== "boolean") {
    throw new ProjectValidationError("access.network must be a boolean");
  }
  return {
    mode: mode as ManagedTeamTaskAccessState["mode"],
    ...(writePaths.length ? { writePaths } : {}),
    network: raw.network ?? false,
  };
}

function managedTaskOptions(
  args: Record<string, unknown>,
  settings: SessionSettings,
  models: ModelOption[],
  inherited?: ManagedTeamTaskView,
): ManagedTaskOptions {
  const model = managedChildModel(models);
  const requestedEffort = optionalToolString(args, "reasoningEffort");
  if (
    requestedEffort &&
    !model.reasoningEfforts.some((option) => option.value === requestedEffort)
  ) {
    throw new ProjectValidationError("The requested reasoning effort is unavailable");
  }
  const reasoningEffort =
    requestedEffort ??
    compatibleManagedChildEffort(model, [
      inherited?.resolvedReasoningEffort,
      settings.reasoningEffort,
    ]);
  const requestedTier = optionalToolString(args, "serviceTier");
  if (requestedTier && !model.serviceTiers.some((tier) => tier.id === requestedTier)) {
    throw new ProjectValidationError("The requested service tier is unavailable");
  }
  const serviceTier =
    requestedTier ??
    compatibleManagedChildTier(model, [inherited?.resolvedServiceTier, settings.serviceTier]);
  return {
    dependsOn: optionalToolStringArray(args, "dependsOn", 50) ?? [],
    access: managedTaskAccess(args, inherited?.access),
    model: model.id,
    reasoningEffort,
    serviceTier,
  };
}

function managedChildModel(models: ModelOption[]): ModelOption {
  const model = models.find((candidate) => candidate.id === TEAM_CHILD_MODEL_ID);
  if (!model) {
    throw new ProjectValidationError(
      `The required managed-task model ${TEAM_CHILD_MODEL_ID} is unavailable`,
    );
  }
  return model;
}

function compatibleManagedChildEffort(
  model: ModelOption,
  candidates: Array<string | null | undefined>,
): string | null {
  return (
    candidates.find(
      (candidate): candidate is string =>
        Boolean(candidate) && model.reasoningEfforts.some((option) => option.value === candidate),
    ) ??
    model.reasoningEfforts.find((option) => option.isDefault)?.value ??
    null
  );
}

function compatibleManagedChildTier(
  model: ModelOption,
  candidates: Array<string | null | undefined>,
): string | null {
  return (
    candidates.find(
      (candidate): candidate is string =>
        Boolean(candidate) && model.serviceTiers.some((tier) => tier.id === candidate),
    ) ?? null
  );
}

function isManagedRelativePath(value: string): boolean {
  return (
    value.length <= 4_096 &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !isAbsolute(value) &&
    value
      .split("/")
      .every(
        (segment) =>
          Boolean(segment) &&
          segment !== "." &&
          segment !== ".." &&
          segment.toLowerCase() !== ".git",
      )
  );
}

function managedResultFields(args: Record<string, unknown>): {
  outcome?: "success" | "partial" | "blocked" | "failed";
  checks?: ManagedTeamTaskResultCheck[];
  risks?: string[];
  artifacts?: ManagedTeamTaskResultArtifact[];
} {
  const outcomeValue = args.outcome;
  let outcome: "success" | "partial" | "blocked" | "failed" | undefined;
  if (outcomeValue !== undefined) {
    if (!(["success", "partial", "blocked", "failed"] as const).includes(outcomeValue as never)) {
      throw new ProjectValidationError("outcome is invalid");
    }
    outcome = outcomeValue as typeof outcome;
  }
  const risks = optionalToolStringArray(args, "risks");
  const checksValue = args.checks;
  const checks =
    checksValue === undefined
      ? undefined
      : parseManagedResultObjects<ManagedTeamTaskResultCheck>(checksValue, "checks", (entry) => {
          const name = requiredToolString(entry, "name");
          const checkOutcome = entry.outcome;
          if (!(["passed", "failed", "notRun"] as const).includes(checkOutcome as never)) {
            throw new ProjectValidationError("checks[].outcome is invalid");
          }
          return {
            name,
            outcome: checkOutcome as ManagedTeamTaskResultCheck["outcome"],
            ...(optionalToolString(entry, "details")
              ? { details: optionalToolString(entry, "details") }
              : {}),
          };
        });
  const artifactsValue = args.artifacts;
  const artifacts =
    artifactsValue === undefined
      ? undefined
      : parseManagedResultObjects<ManagedTeamTaskResultArtifact>(
          artifactsValue,
          "artifacts",
          (entry) => {
            const label = requiredToolString(entry, "label");
            const path = optionalToolString(entry, "path");
            const url = optionalToolString(entry, "url");
            if (path && !isManagedRelativePath(path)) {
              throw new ProjectValidationError("artifacts[].path must be repository-relative");
            }
            if (!path && !url) {
              throw new ProjectValidationError("Each artifact requires path or url");
            }
            if (url) {
              let parsed: URL;
              try {
                parsed = new URL(url);
              } catch {
                throw new ProjectValidationError("artifacts[].url is invalid");
              }
              if (
                !["http:", "https:"].includes(parsed.protocol) ||
                parsed.username ||
                parsed.password
              ) {
                throw new ProjectValidationError(
                  "artifacts[].url must be an HTTP(S) URL without credentials",
                );
              }
            }
            return { label, ...(path ? { path } : {}), ...(url ? { url } : {}) };
          },
        );
  return {
    ...(outcome ? { outcome } : {}),
    ...(checks ? { checks } : {}),
    ...(risks ? { risks } : {}),
    ...(artifacts ? { artifacts } : {}),
  };
}

function parseManagedResultObjects<T>(
  value: unknown,
  key: string,
  parse: (entry: Record<string, unknown>) => T,
): T[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new ProjectValidationError(`${key} must be an array with at most 100 items`);
  }
  return value.map((entry) => {
    if (!isObjectRecord(entry)) throw new ProjectValidationError(`${key} entries must be objects`);
    return parse(entry);
  });
}

async function validateManagedResultArtifacts(
  artifacts: ManagedTeamTaskResultArtifact[] | undefined,
  root: string | undefined,
): Promise<void> {
  const paths = artifacts?.flatMap((artifact) => (artifact.path ? [artifact.path] : [])) ?? [];
  if (!paths.length) return;
  if (!root) throw new ProjectValidationError("The managed task workspace is unavailable");
  const canonicalRoot = await realpath(root);
  for (const path of paths) {
    let canonicalArtifact: string;
    try {
      canonicalArtifact = await realpath(resolve(canonicalRoot, path));
    } catch {
      throw new ProjectValidationError(`Managed task artifact does not exist: ${path}`);
    }
    if (!pathContains(canonicalRoot, canonicalArtifact)) {
      throw new ProjectValidationError(`Managed task artifact escapes its workspace: ${path}`);
    }
  }
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
  task?: ManagedTeamTaskView,
  runtime?: ManagedChildRuntime,
): Record<string, unknown> {
  const model = managedChildModel(models);
  const effort = compatibleManagedChildEffort(model, [
    task?.resolvedReasoningEffort,
    settings.reasoningEffort,
  ]);
  const serviceTier = compatibleManagedChildTier(model, [
    task?.resolvedServiceTier,
    settings.serviceTier,
  ]);
  return compact({
    model: model.id,
    serviceTier,
    effort,
    personality: settings.personality,
    ...(task && runtime
      ? {
          cwd: runtime.cwd,
          runtimeWorkspaceRoots: runtime.runtimeWorkspaceRoots,
          approvalPolicy: "never",
          sandboxPolicy: runtime.sandboxPolicy,
        }
      : {}),
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

function managedChildResumeSettings(
  settings: SessionSettings,
  models: ModelOption[],
  task: ManagedTeamTaskView,
): Record<string, unknown> {
  const model = managedChildModel(models);
  return compact({
    model: model.id,
    serviceTier: compatibleManagedChildTier(model, [
      task.resolvedServiceTier,
      settings.serviceTier,
    ]),
    personality: settings.personality,
  });
}

async function markTeamToolsAvailable(store: StateStore, threadId: string): Promise<void> {
  await store.update((state) => {
    const meta = state.threadMeta[threadId] ?? { pinned: false, lastReadUpdatedAt: 0 };
    meta.managedTeamToolsAvailable = true;
    state.threadMeta[threadId] = meta;
  });
}

function teamOrchestrationHasWork(store: StateStore, parentThreadId: string): boolean {
  const orchestration = store.view().threadMeta[parentThreadId]?.teamOrchestration;
  return Boolean(orchestration && Object.values(orchestration.tasks).some(managedTeamTaskHasWork));
}

function managedTeamTaskHasWork(task: ManagedTeamTaskView): boolean {
  return Boolean(
    !isTerminalTask(task) ||
    task.delivery?.status !== "delivered" ||
    task.watchdog ||
    managedTaskHasPendingWorkspace(task),
  );
}

function managedTaskHasPendingWorkspace(task: ManagedTeamTaskView): boolean {
  const workspace = task.workspace;
  return Boolean(
    workspace &&
    (!["integrated", "discarded"].includes(workspace.lifecycle) ||
      (workspace.lifecycle === "integrated" && workspace.error)),
  );
}

async function interruptTurnIfRunning(
  bridge: CodexBridge,
  threadId: string,
  turnId: string,
): Promise<string | null> {
  try {
    await bridge.request("turn/interrupt", { threadId, turnId });
    return turnId;
  } catch (error) {
    if (!(error instanceof RpcError)) throw error;
    let latest: Turn | undefined;
    try {
      latest = parseTurnsList(
        await bridge.request<unknown>(
          "thread/turns/list",
          {
            threadId,
            limit: 1,
            sortDirection: "desc",
            itemsView: "summary",
          },
          30_000,
        ),
      ).data[0];
    } catch (readError) {
      if (isMissingRolloutError(readError)) return null;
      throw error;
    }
    if (!latest || latest.status !== "inProgress") return null;
    if (latest.id === turnId) throw error;
    await bridge.request("turn/interrupt", { threadId, turnId: latest.id });
    return latest.id;
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class TeamContinuationStoppedError extends Error {
  constructor() {
    super("Team orchestration was stopped");
    this.name = "TeamContinuationStoppedError";
  }
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
      profile ? store.view().transcriptionTimings?.[profile] : undefined,
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

function cloneView<T>(value: DeepReadonly<T>): T {
  return structuredClone(value) as T;
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

function validateForkThreadBody(value: unknown): ForkThreadRequest {
  const body = requireRecord<ForkThreadRequest>(value);
  if (Object.keys(body).some((key) => !["lastTurnId", "agentMessageId"].includes(key))) {
    throw new ProjectValidationError("Unknown fork field");
  }
  if (
    typeof body.lastTurnId !== "string" ||
    !body.lastTurnId ||
    body.lastTurnId.trim() !== body.lastTurnId ||
    typeof body.agentMessageId !== "string" ||
    !body.agentMessageId ||
    body.agentMessageId.trim() !== body.agentMessageId
  ) {
    throw new ProjectValidationError("lastTurnId and agentMessageId are required");
  }
  return body;
}

async function readForkTurn(
  bridge: CodexBridge,
  threadId: string,
  turnId: string,
): Promise<Turn | undefined> {
  let cursor: string | null = null;
  do {
    const page = parseTurnsList(
      await bridge.request<unknown>(
        "thread/turns/list",
        {
          threadId,
          cursor,
          limit: 100,
          sortDirection: "desc",
          itemsView: "full",
        },
        30_000,
      ),
    );
    const turn = page.data.find((candidate) => candidate.id === turnId);
    if (turn) return turn;
    cursor = page.nextCursor;
  } while (cursor);
  return undefined;
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

function isTrackedMutation(method: string, pathname: string): boolean {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase())) return false;
  if (pathname.startsWith("/api/v1/internal/restart/")) return false;
  return (
    pathname !== "/api/v1/settings/app/force-restart" &&
    pathname !== "/api/v1/settings/codex/force-restart"
  );
}

function apiError(
  reply: FastifyReply,
  status: number,
  code: ApiErrorCode,
  message: string,
): FastifyReply {
  return reply.code(status).send({ error: { code, message } });
}
