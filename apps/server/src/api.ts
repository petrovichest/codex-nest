import type { FastifyInstance, FastifyReply } from "fastify";

import type {
  ApiErrorCode,
  AttentionResponse,
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
  PermissionPreset,
  QueueMessageRequest,
  QueuedMessage,
  SessionSettings,
  StartTurnRequest,
  SteerTurnRequest,
  UpdateGlobalPermissionSettingsRequest,
  UpdateProjectRequest,
  UpdateThreadSettingsRequest,
  UpdateThreadRequest,
} from "@codexnest/protocol";

import { AttentionValidationError, type AttentionManager } from "./attention";
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
import { EXPECTED_CODEX_VERSION, SERVER_VERSION } from "./config";
import {
  assertUniqueProjectPath,
  canonicalProjectPath,
  createDirectory,
  createProject,
  listDirectories,
  ProjectConflictError,
  ProjectForbiddenError,
  ProjectNotFoundError,
  ProjectValidationError,
} from "./projects";
import type { AppProjection } from "./projection";
import type { PushNotifier } from "./push";
import { MessageQueue, MessageQueueNotFoundError } from "./message-queue";
import type { StateStore } from "./state/store";

export interface ApiServices {
  bridge: CodexBridge;
  store: StateStore;
  projection: AppProjection;
  attention: AttentionManager;
  push: PushNotifier;
  projectRoot?: string;
}

export function registerApi(app: FastifyInstance, services: ApiServices): void {
  const { bridge, store, projection, attention } = services;
  const startTurn = async (
    threadId: string,
    input: string,
    clientMessageId: string | null,
  ): Promise<string> => {
    const summary = projection.summary(threadId);
    if (!summary) throw new MessageQueueNotFoundError("Thread not found");
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
    const turn = parseTurnStart(
      await bridge.request<unknown>("turn/start", {
        threadId,
        clientUserMessageId: clientMessageId,
        input: textInput(input),
        ...turnSettings(summary.settings, projection.availableModels),
      }),
    );
    projection.markMaterialized(threadId);
    projection.setCurrentTurn(threadId, turn.turn.id);
    return turn.turn.id;
  };
  const steerTurn = async (
    threadId: string,
    turnId: string,
    input: string,
    clientMessageId: string | null,
  ): Promise<string> => {
    const result = parseTurnSteer(
      await bridge.request<unknown>("turn/steer", {
        threadId,
        expectedTurnId: turnId,
        clientUserMessageId: clientMessageId,
        input: textInput(input),
      }),
    );
    if (projection.summary(threadId)) projection.setCurrentTurn(threadId, result.turnId);
    return result.turnId;
  };
  const queue = new MessageQueue(store, {
    currentTurnId: (threadId) => projection.summary(threadId)?.currentTurnId ?? null,
    start: (threadId, message) => startTurn(threadId, message.text, message.id),
    steer: (threadId, turnId, message) => steerTurn(threadId, turnId, message.text, message.id),
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
      expectedVersion: EXPECTED_CODEX_VERSION,
      installedVersion: bridge.actualVersion ?? null,
      message:
        bridge.state === "incompatible"
          ? `Codex CLI ${EXPECTED_CODEX_VERSION} is required`
          : bridge.state === "ready"
            ? null
            : "Codex app-server is unavailable",
    },
  }));

  app.get("/api/v1/summary", async () => ({
    threadCount: projection.threadCount,
    projectCount: store.snapshot().projects.length,
    pendingAttentionCount: attention.list().length,
    syncedAt: projection.lastSyncedAt,
  }));

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
      });
      projection.publishProject(updated.id);
      return updated;
    },
  );

  app.delete<{ Params: { id: string } }>("/api/v1/projects/:id", async (request, reply) => {
    if (!store.snapshot().projects.some((project) => project.id === request.params.id)) {
      return apiError(reply, 404, "not_found", "Project not found");
    }
    await store.update((state) => {
      state.projects = state.projects.filter((project) => project.id !== request.params.id);
    });
    projection.removeProject(request.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/v1/projects/:id/threads", async (request, reply) => {
    const project = store
      .snapshot()
      .projects.find((candidate) => candidate.id === request.params.id);
    if (!project) return apiError(reply, 404, "not_found", "Project not found");
    const settings = projection.newSessionSettings;
    const started = parseThreadStart(
      await bridge.request<unknown>("thread/start", {
        cwd: project.path,
        ...threadSettings(settings),
      }),
    );
    projection.upsertThread(started.thread);
    projection.markUnmaterialized(started.thread.id);
    const thread = await projection.setSettings(started.thread.id, settings);
    return reply.code(201).send({ thread } satisfies CreateProjectThreadResponse);
  });

  app.get<{ Params: { id: string } }>("/api/v1/threads/:id", async (request, reply) => {
    if (!projection.summary(request.params.id))
      return apiError(reply, 404, "not_found", "Thread not found");
    return projection.readThread(request.params.id);
  });

  app.post<{ Body: CreateThreadRequest }>("/api/v1/threads", async (request, reply) => {
    const body = validateThreadBody(request.body, reply);
    if (!body) return;
    const project = store.snapshot().projects.find((candidate) => candidate.id === body.projectId);
    if (!project) return apiError(reply, 404, "not_found", "Project not found");
    const settings = mergeSettings(
      projection.newSessionSettings,
      body.settings ?? {},
      projection.availableModels,
    );
    const started = parseThreadStart(
      await bridge.request<unknown>("thread/start", {
        cwd: project.path,
        ...threadSettings(settings),
      }),
    );
    projection.upsertThread(started.thread);
    await projection.setSettings(started.thread.id, settings);
    const turn = parseTurnStart(
      await bridge.request<unknown>("turn/start", {
        threadId: started.thread.id,
        clientUserMessageId: body.clientMessageId ?? null,
        input: textInput(body.input),
        ...turnSettings(settings, projection.availableModels),
      }),
    );
    if (body.settings?.reasoningEffort !== undefined) {
      await projection.setDefaultReasoningEffort(settings.reasoningEffort);
    }
    return reply
      .code(201)
      .send({ thread: projection.summary(started.thread.id), turnId: turn.turn.id });
  });

  app.patch<{ Params: { id: string }; Body: UpdateThreadRequest }>(
    "/api/v1/threads/:id",
    async (request, reply) => {
      const body = requireRecord<UpdateThreadRequest>(request.body);
      if (!projection.summary(request.params.id))
        return apiError(reply, 404, "not_found", "Thread not found");
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

  app.patch<{ Params: { id: string }; Body: UpdateThreadSettingsRequest }>(
    "/api/v1/threads/:id/settings",
    async (request, reply) => {
      const patch = validateSettingsPatch(request.body);
      if (Object.keys(patch).length === 0) {
        return apiError(reply, 400, "validation_failed", "At least one setting is required");
      }
      const summary = projection.summary(request.params.id);
      if (!summary) return apiError(reply, 404, "not_found", "Thread not found");
      if (summary.currentTurnId) {
        return apiError(
          reply,
          409,
          "conflict",
          "Settings cannot be changed while a turn is running",
        );
      }
      const settings = mergeSettings(summary.settings, patch, projection.availableModels);
      const thread = await projection.setSettings(request.params.id, settings);
      if (patch.reasoningEffort !== undefined) {
        await projection.setDefaultReasoningEffort(settings.reasoningEffort);
      }
      return thread;
    },
  );

  app.post<{ Params: { id: string }; Body: StartTurnRequest }>(
    "/api/v1/threads/:id/turns",
    async (request, reply) => {
      const body = validateStartTurnBody(request.body, reply);
      if (!body) return;
      const summary = projection.summary(request.params.id);
      if (!summary) return apiError(reply, 404, "not_found", "Thread not found");
      const turnId = await startTurn(request.params.id, body.input, body.clientMessageId ?? null);
      return reply.code(201).send({ turnId });
    },
  );

  app.post<{ Params: { id: string }; Body: QueueMessageRequest }>(
    "/api/v1/threads/:id/queue",
    async (request, reply) => {
      const body = requireRecord<QueueMessageRequest>(request.body);
      if (typeof body.input !== "string" || !body.input.trim()) {
        return apiError(reply, 400, "validation_failed", "input is required");
      }
      if (!projection.summary(request.params.id)) {
        return apiError(reply, 404, "not_found", "Thread not found");
      }
      const message = await queue.enqueue(request.params.id, body.input);
      return reply.code(202).send(message satisfies QueuedMessage);
    },
  );

  app.post<{ Params: { id: string; messageId: string } }>(
    "/api/v1/threads/:id/queue/:messageId/send",
    async (request) => ({
      turnId: await queue.sendNow(request.params.id, request.params.messageId),
    }),
  );

  app.post<{ Params: { id: string }; Body: SteerTurnRequest }>(
    "/api/v1/threads/:id/steer",
    async (request, reply) => {
      const body = requireRecord<SteerTurnRequest>(request.body);
      if (typeof body.turnId !== "string" || typeof body.input !== "string" || !body.input.trim()) {
        return apiError(reply, 400, "validation_failed", "turnId and input are required");
      }
      return {
        turnId: await steerTurn(request.params.id, body.turnId, body.input, null),
      };
    },
  );

  app.post<{ Params: { id: string }; Body: InterruptTurnRequest }>(
    "/api/v1/threads/:id/interrupt",
    async (request, reply) => {
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
      if (!projection.summary(request.params.id))
        return apiError(reply, 404, "not_found", "Thread not found");
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
      if (!attention.resolve(request.params.attentionId, body)) {
        return apiError(
          reply,
          409,
          "conflict",
          "Attention request has already been resolved or expired",
        );
      }
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
      return apiError(
        reply,
        503,
        error.bridgeState === "incompatible" ? "protocol_incompatible" : "app_server_unavailable",
        error.message,
      );
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
    if (error instanceof ProjectConflictError)
      return apiError(reply, 409, "conflict", error.message);
    return apiError(reply, 500, "internal_error", "Internal server error");
  });
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
      mode: settings.collaborationMode,
      settings: {
        model: model.id,
        reasoning_effort: reasoningEffort,
        developer_instructions: null,
      },
    },
  });
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}

function textInput(text: string): Array<{ type: "text"; text: string; text_elements: [] }> {
  return [{ type: "text", text: text.trim(), text_elements: [] }];
}

function validateThreadBody(body: unknown, reply: FastifyReply): CreateThreadRequest | undefined {
  const value = requireRecord<CreateThreadRequest>(body);
  if (
    typeof value.projectId !== "string" ||
    typeof value.input !== "string" ||
    !value.input.trim()
  ) {
    apiError(reply, 400, "validation_failed", "projectId and input are required");
    return undefined;
  }
  return { ...value, settings: validateSettings(value.settings) };
}

function validateStartTurnBody(body: unknown, reply: FastifyReply): StartTurnRequest | undefined {
  const value = requireRecord<StartTurnRequest>(body);
  if (Object.keys(value).some((key) => !["input", "clientMessageId"].includes(key))) {
    throw new ProjectValidationError("Unknown turn field");
  }
  if (typeof value.input !== "string" || !value.input.trim()) {
    apiError(reply, 400, "validation_failed", "input is required");
    return undefined;
  }
  return value;
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
    !["default", "plan"].includes(String(settings.collaborationMode))
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validInstallationId(value: string): boolean {
  return /^[A-Za-z0-9._-]{8,128}$/.test(value);
}

function apiError(
  reply: FastifyReply,
  status: number,
  code: ApiErrorCode,
  message: string,
): FastifyReply {
  return reply.code(status).send({ error: { code, message } });
}
