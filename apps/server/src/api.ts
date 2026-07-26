import { randomBytes } from "node:crypto";
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
  SessionSettings,
  StartTurnRequest,
  SteerTurnRequest,
  TaskDefaults,
  ThreadGoal,
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
import type { ThreadResumeResponse } from "./codex/generated/v2/index";
import {
  parseAccountRateLimits,
  parseThreadRead,
  parseThreadStart,
  parseTurnStart,
  parseTurnSteer,
} from "./codex/guards";
import { RpcError } from "./codex/transport";
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
  MessageQueue,
  MessageQueueConflictError,
  MessageQueueNotFoundError,
  MessageQueuePausedError,
  MessageQueueValidationError,
} from "./message-queue";
import type { CodexNestState, StateStore } from "./state/store";
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
const TEAM_MODE_CONTEXT = [
  "This session is in CodexNest Team mode. Act only as the root coordinator.",
  "Once a plan exists, the parent session may only schedule its executable steps, wait, and report results.",
  "For every executable plan step, create a fresh native subagent session and send exactly one self-contained task prompt.",
  'Always spawn it with fork_turns="none" so the child receives no parent conversation history.',
  "Start the prompt with one line in the exact form `Task: <concise task-specific title>`; put the execution details after it.",
  "Include only the minimum context needed to complete that step: its objective, relevant constraints, affected scope, and expected result.",
  "Never copy or summarize the conversation, the full plan, unrelated plan steps, or prior agent messages in a subagent prompt.",
  "Do not execute any plan step in the parent session.",
  "After spawning a subagent, do not steer it, send follow-up input, or resume or reuse that session for another step; only wait for its result.",
  "Choose sequential or parallel delegation based on dependencies and workspace overlap.",
  "Never run parallel subagents that may write to overlapping files.",
  "When the required results are ready, return one consolidated result to the user.",
  "The user should not need to coordinate subagents directly.",
].join(" ");

interface DownloadTicket {
  root: string;
  path: string;
  fileName: string;
  expiresAt: number;
}

export interface ApiServices {
  bridge: CodexBridge;
  store: StateStore;
  projection: AppProjection;
  attention: AttentionManager;
  push: PushNotifier;
  codexManager?: CodexManager;
  appManager?: AppManager;
  threadTitles?: Pick<ThreadTitleGenerator, "generate">;
  transcription?: Pick<
    TranscriptionService,
    "configuration" | "updateConfiguration" | "transcribe"
  >;
  projectRoot?: string;
}

export function registerApi(app: FastifyInstance, services: ApiServices): void {
  const { bridge, store, projection, attention, codexManager, appManager, threadTitles } = services;
  const downloadTickets = new Map<string, DownloadTicket>();
  const projectThreadCreations = new Map<string, Promise<ThreadSummary>>();
  app.addContentTypeParser(/^audio\//i, { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });
  const scheduleThreadTitle = (threadId: string, input: string, summary: ThreadSummary): void => {
    if (!threadTitles || !input.trim() || projection.hasExplicitName(threadId)) return;
    const model = effectiveModel(summary.settings, projection.availableModels);
    void threadTitles
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
  };
  const startTurnUnlocked = async (
    threadId: string,
    input: string,
    images: string[],
    clientMessageId: string | null,
    goal = false,
  ): Promise<TurnStartResult> => {
    let summary = projection.summary(threadId);
    if (!summary) throw new MessageQueueNotFoundError("Thread not found");
    assertWritableThread(summary);
    const shouldGenerateTitle =
      projection.isUnmaterialized(threadId) && !projection.hasExplicitName(threadId);
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
    let turn;
    try {
      if (!projection.isUnmaterialized(threadId)) {
        await bridge.request<ThreadResumeResponse>(
          "thread/resume",
          {
            threadId,
            cwd: summary.cwd,
            excludeTurns: true,
            ...threadSettings(summary.settings),
          },
          30_000,
        );
      }
      turn = parseTurnStart(
        await bridge.request<unknown>("turn/start", {
          threadId,
          clientUserMessageId: clientMessageId,
          input: messageInput(input, images),
          ...turnSettings(summary.settings, projection.availableModels),
        }),
      );
    } catch (error) {
      if (goal) await clearThreadGoal(bridge, threadId).catch(() => undefined);
      throw error;
    }
    await projection.markMaterialized(threadId);
    await projection.setCurrentTurn(threadId, turn.turn.id);
    if (clientMessageId) {
      projection.recordUserMessage(threadId, turn.turn.id, clientMessageId, input, images);
    }
    if (shouldGenerateTitle) scheduleThreadTitle(threadId, input, summary);
    if (!goal) return { turnId: turn.turn.id };
    try {
      await setThreadGoal(bridge, threadId, { status: "active" });
      return { turnId: turn.turn.id };
    } catch {
      return {
        turnId: turn.turn.id,
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
    const release = codexManager?.beginTurn();
    return startTurnUnlocked(threadId, input, images, clientMessageId, goal).finally(() =>
      release?.(),
    );
  };

  async function findReusableProjectThread(projectId: string): Promise<ThreadSummary | null> {
    for (const candidate of projection.emptyThreadCandidates(projectId)) {
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
        }),
      );
      projection.upsertThread(started.thread);
      await projection.markUnmaterialized(started.thread.id);
      return projection.setSettings(started.thread.id, settings);
    })().finally(() => {
      if (projectThreadCreations.get(projectId) === request) {
        projectThreadCreations.delete(projectId);
      }
    });
    projectThreadCreations.set(projectId, request);
    return request;
  }

  const steerTurn = async (
    threadId: string,
    turnId: string,
    input: string,
    images: string[],
    clientMessageId: string | null,
  ): Promise<string> => {
    codexManager?.assertTurnsAllowed();
    const result = parseTurnSteer(
      await bridge.request<unknown>("turn/steer", {
        threadId,
        expectedTurnId: turnId,
        clientUserMessageId: clientMessageId,
        input: messageInput(input, images),
      }),
    );
    if (projection.summary(threadId)) await projection.setCurrentTurn(threadId, result.turnId);
    if (clientMessageId) {
      projection.recordUserMessage(threadId, result.turnId, clientMessageId, input, images);
    }
    return result.turnId;
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
    wasDelivered: async (threadId, messageId) => {
      const result = parseThreadRead(
        await bridge.request<unknown>("thread/read", { threadId, includeTurns: true }, 30_000),
      );
      return result.thread.turns.some((turn) =>
        turn.items.some((item) => item.type === "userMessage" && item.clientId === messageId),
      );
    },
    publish: (threadId, messages) => projection.publishQueue(threadId, messages),
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

  projection.on("event", (_sequence, event) => {
    if (event.type === "resync.required") {
      void queue.recover().catch(() => undefined);
    } else if (event.type === "thread.upserted" && !event.thread.currentTurnId) {
      void queue.drain(event.thread.id).catch(() => undefined);
    } else if (event.type === "thread.removed") {
      void queue.removeThread(event.threadId).catch(() => undefined);
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
      parsed.pathname === "/api/v1/events"
    )
      return;
    const token = bearerToken(request);
    if (!token || !verifyToken(token, store.snapshot().auth.tokenSha256)) {
      return apiError(reply, 401, "unauthorized", "Invalid or missing bearer token");
    }
  });

  app.get("/api/v1/health", async () => ({
    status: bridge.state === "ready" ? "ok" : "degraded",
    serverVersion: SERVER_VERSION,
    appServer: {
      state: bridge.state,
      installedVersion: bridge.actualVersion ?? null,
      message: bridge.state === "ready" ? null : "Codex app-server is unavailable",
    },
  }));

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
    };
    Body: Buffer;
  }>(
    "/api/v1/threads/:id/voice-transcriptions",
    { bodyLimit: MAX_TRANSCRIPTION_BYTES },
    async (request, reply): Promise<VoiceTranscriptionJob | undefined> => {
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
      return reply.code(202).send(
        await voiceTranscriptions.accept({
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
        }),
      );
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
      }
    },
  );

  app.post("/api/v1/settings/codex/update", async (): Promise<CodexManagementStatus> => {
    try {
      return await requireCodexManager(codexManager).update();
    } finally {
      await queue.resume();
    }
  });

  app.post("/api/v1/settings/codex/restart", async (): Promise<CodexManagementStatus> => {
    try {
      return await requireCodexManager(codexManager).restart();
    } finally {
      await queue.resume();
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
      const observed = projection.summary(request.params.id);
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
        }),
      );
      projection.upsertThread(started.thread);
      await projection.markUnmaterialized(started.thread.id);
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
    await bridge.request("thread/delete", { threadId: request.params.id });
    await voiceTranscriptions?.cancelThread(request.params.id);
    await queue.removeThread(request.params.id);
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
        summary.settings.collaborationMode !== "team" &&
        (await readThreadGoal(bridge, request.params.id))
      ) {
        throw new ProjectConflictError("Team mode cannot be combined with a goal");
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

function turnSettings(settings: SessionSettings, models: ModelOption[]): Record<string, unknown> {
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
      settings.collaborationMode === "team"
        ? {
            "codexnest.team": {
              kind: "application",
              value: TEAM_MODE_CONTEXT,
            },
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
