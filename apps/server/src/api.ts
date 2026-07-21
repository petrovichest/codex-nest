import type { FastifyInstance, FastifyReply } from "fastify";

import { DEFAULT_SESSION_SETTINGS } from "@codexnest/protocol";
import type {
  ApiErrorCode,
  AttentionResponse,
  CreateDirectoryRequest,
  CreateProjectRequest,
  CreateThreadRequest,
  DeviceRegistrationRequest,
  InterruptTurnRequest,
  MarkReadRequest,
  ModelOption,
  SessionSettings,
  StartTurnRequest,
  SteerTurnRequest,
  UpdateProjectRequest,
  UpdateThreadSettingsRequest,
  UpdateThreadRequest,
} from "@codexnest/protocol";

import { AttentionValidationError, type AttentionManager } from "./attention";
import { bearerToken, verifyToken } from "./auth";
import { BridgeUnavailableError, type CodexBridge } from "./codex/bridge";
import type { ThreadResumeResponse } from "./codex/generated/v2/index";
import { parseThreadStart, parseTurnStart, parseTurnSteer } from "./codex/guards";
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
      DEFAULT_SESSION_SETTINGS,
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
      const patch = validateSettingsPatch(request.body);
      if (Object.keys(patch).length === 0) {
        return apiError(reply, 400, "validation_failed", "At least one setting is required");
      }
      const settings = mergeSettings(summary.settings, patch, projection.availableModels);
      return projection.setSettings(request.params.id, settings);
    },
  );

  app.post<{ Params: { id: string }; Body: StartTurnRequest }>(
    "/api/v1/threads/:id/turns",
    async (request, reply) => {
      const body = validateStartTurnBody(request.body, reply);
      if (!body) return;
      const summary = projection.summary(request.params.id);
      if (!summary) return apiError(reply, 404, "not_found", "Thread not found");
      await bridge.request<ThreadResumeResponse>(
        "thread/resume",
        {
          threadId: request.params.id,
          cwd: summary.cwd,
          excludeTurns: true,
          ...threadSettings(summary.settings),
        },
        30_000,
      );
      const turn = parseTurnStart(
        await bridge.request<unknown>("turn/start", {
          threadId: request.params.id,
          clientUserMessageId: body.clientMessageId ?? null,
          input: textInput(body.input),
          ...turnSettings(summary.settings, projection.availableModels),
        }),
      );
      return reply.code(201).send({ turnId: turn.turn.id });
    },
  );

  app.post<{ Params: { id: string }; Body: SteerTurnRequest }>(
    "/api/v1/threads/:id/steer",
    async (request, reply) => {
      const body = requireRecord<SteerTurnRequest>(request.body);
      if (typeof body.turnId !== "string" || typeof body.input !== "string" || !body.input.trim()) {
        return apiError(reply, 400, "validation_failed", "turnId and input are required");
      }
      const result = parseTurnSteer(
        await bridge.request<unknown>("turn/steer", {
          threadId: request.params.id,
          expectedTurnId: body.turnId,
          input: textInput(body.input),
        }),
      );
      return result;
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
    sandbox: settings.sandboxMode,
    approvalPolicy: approvalPolicy(settings.approvalPolicy),
    approvalsReviewer: settings.approvalsReviewer,
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
    approvalPolicy: approvalPolicy(settings.approvalPolicy),
    approvalsReviewer: settings.approvalsReviewer,
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

function validateSettings(value: unknown): SessionSettings | undefined {
  if (value === undefined) return undefined;
  const patch = validateSettingsPatch(value);
  return applySettingsPatch(DEFAULT_SESSION_SETTINGS, patch);
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
    "sandboxMode",
    "approvalPolicy",
    "approvalsReviewer",
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
  if (
    settings.sandboxMode !== undefined &&
    settings.sandboxMode !== null &&
    !["read-only", "workspace-write", "danger-full-access"].includes(String(settings.sandboxMode))
  ) {
    throw new ProjectValidationError("Invalid sandboxMode");
  }
  if (
    settings.approvalPolicy !== undefined &&
    settings.approvalPolicy !== null &&
    !["untrusted", "on-request", "granular", "never"].includes(String(settings.approvalPolicy))
  ) {
    throw new ProjectValidationError("Invalid approvalPolicy");
  }
  if (
    settings.approvalsReviewer !== undefined &&
    settings.approvalsReviewer !== null &&
    !["user", "auto_review"].includes(String(settings.approvalsReviewer))
  ) {
    throw new ProjectValidationError("Invalid approvalsReviewer");
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

function approvalPolicy(value: SessionSettings["approvalPolicy"]): unknown {
  if (value !== "granular") return value;
  return {
    granular: {
      sandbox_approval: true,
      rules: true,
      skill_approval: true,
      request_permissions: true,
      mcp_elicitations: true,
    },
  };
}

function requireRecord<T>(value: unknown): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectValidationError("JSON object expected");
  }
  return value as T;
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
