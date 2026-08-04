import type {
  ApiError,
  AppUpdateStatus,
  AppSnapshot,
  AttentionResponse,
  CodexRateLimitsResponse,
  CodexManagementStatus,
  CreateDirectoryRequest,
  CreateProjectRequest,
  CreateProjectThreadResponse,
  CreateThreadRequest,
  DeviceRegistrationRequest,
  DirectoryListing,
  ForceRestartAccepted,
  ForkThreadRequest,
  ForkThreadResponse,
  GitChangesSummary,
  GlobalPermissionSettings,
  HealthResponse,
  MarkReadRequest,
  MoveProjectRequest,
  Project,
  QueuedMessage,
  QueueMessageRequest,
  RefreshThreadResponse,
  StartTurnRequest,
  SteerTurnRequest,
  SummaryResponse,
  ThreadDetail,
  ThreadChanges,
  ThreadDraft,
  ThreadGoal,
  ThreadSummary,
  ThreadSyncPoint,
  TurnItemsResponse,
  TranscriptionConfigResponse,
  TranscriptionResponse,
  UpdateTranscriptionSettingsRequest,
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
  UpdateUiLanguageRequest,
  TaskDefaults,
  VoiceTranscriptionJob,
  VoiceTranscriptionMode,
} from "@codexnest/protocol";

import type { ConnectionSettings } from "./storage";
import { readInitialLanguage, translate } from "./i18n";

export class ApiClient {
  constructor(public readonly settings: ConnectionSettings) {}

  health(): Promise<HealthResponse> {
    return this.request("/api/v1/health", { authenticated: false });
  }

  summary(): Promise<SummaryResponse> {
    return this.request("/api/v1/summary");
  }

  readAppSettings(): Promise<AppUpdateStatus> {
    return this.request("/api/v1/settings/app");
  }

  checkAppUpdate(): Promise<AppUpdateStatus> {
    return this.request("/api/v1/settings/app/check", { method: "POST", timeoutMs: null });
  }

  updateApp(): Promise<AppUpdateStatus> {
    return this.request("/api/v1/settings/app/update", { method: "POST", timeoutMs: null });
  }

  forceRestartApp(): Promise<ForceRestartAccepted> {
    return this.request("/api/v1/settings/app/force-restart", {
      method: "POST",
      timeoutMs: 10_000,
    });
  }

  readTranscriptionConfig(): Promise<TranscriptionConfigResponse> {
    return this.request("/api/v1/transcriptions/config");
  }

  updateTranscriptionSettings(
    body: UpdateTranscriptionSettingsRequest,
  ): Promise<TranscriptionConfigResponse> {
    return this.request("/api/v1/settings/transcription", { method: "PUT", body });
  }

  transcribe(audio: Blob, recordingDurationMs?: number): Promise<TranscriptionResponse> {
    return this.request("/api/v1/transcriptions", {
      method: "POST",
      rawBody: audio,
      contentType: audio.type,
      headers:
        recordingDurationMs === undefined
          ? undefined
          : {
              "X-CodexNest-Audio-Duration-Ms": String(Math.max(1, Math.round(recordingDurationMs))),
            },
      timeoutMs: null,
    });
  }

  createVoiceTranscription(
    threadId: string,
    audio: Blob,
    options: {
      recordingDurationMs: number;
      mode: VoiceTranscriptionMode;
      selectionStart: number;
      selectionEnd: number;
      draftUpdatedAt: number | null;
      clientUploadId: string;
    },
  ): Promise<VoiceTranscriptionJob | null> {
    const query = new URLSearchParams({
      mode: options.mode,
      selectionStart: String(options.selectionStart),
      selectionEnd: String(options.selectionEnd),
      draftUpdatedAt: options.draftUpdatedAt === null ? "none" : String(options.draftUpdatedAt),
      clientUploadId: options.clientUploadId,
    });
    return this.request(
      `/api/v1/threads/${encodeURIComponent(threadId)}/voice-transcriptions?${query}`,
      {
        method: "POST",
        rawBody: audio,
        contentType: audio.type,
        headers: {
          "X-CodexNest-Audio-Duration-Ms": String(
            Math.max(1, Math.round(options.recordingDurationMs)),
          ),
        },
        timeoutMs: 60_000,
      },
    );
  }

  cancelVoiceTranscription(threadId: string): Promise<void> {
    return this.request(`/api/v1/threads/${encodeURIComponent(threadId)}/voice-transcriptions`, {
      method: "DELETE",
    });
  }

  readCodexRateLimits(): Promise<CodexRateLimitsResponse> {
    return this.request("/api/v1/codex/rate-limits");
  }

  readCodexSettings(): Promise<CodexManagementStatus> {
    return this.request("/api/v1/settings/codex");
  }

  checkCodex(): Promise<CodexManagementStatus> {
    return this.request("/api/v1/settings/codex/check", { method: "POST", timeoutMs: null });
  }

  updateCodexProxy(body: UpdateCodexProxyRequest): Promise<CodexManagementStatus> {
    return this.request("/api/v1/settings/codex/proxy", {
      method: "PUT",
      body,
      timeoutMs: null,
    });
  }

  updateCodex(): Promise<CodexManagementStatus> {
    return this.request("/api/v1/settings/codex/update", { method: "POST", timeoutMs: null });
  }

  restartCodex(): Promise<CodexManagementStatus> {
    return this.request("/api/v1/settings/codex/restart", { method: "POST", timeoutMs: null });
  }

  forceRestartCodex(): Promise<CodexManagementStatus> {
    return this.request("/api/v1/settings/codex/force-restart", {
      method: "POST",
      timeoutMs: null,
    });
  }

  readPermissionSettings(): Promise<GlobalPermissionSettings> {
    return this.request("/api/v1/settings/permissions");
  }

  updatePermissionSettings(
    body: UpdateGlobalPermissionSettingsRequest,
  ): Promise<GlobalPermissionSettings> {
    return this.request("/api/v1/settings/permissions", { method: "PUT", body });
  }

  readTaskDefaults(): Promise<TaskDefaults> {
    return this.request("/api/v1/settings/task-defaults");
  }

  updateTaskDefaults(body: UpdateTaskDefaultsRequest): Promise<TaskDefaults> {
    return this.request("/api/v1/settings/task-defaults", { method: "PUT", body });
  }

  updateUiLanguage(body: UpdateUiLanguageRequest): Promise<UiLanguageSettings> {
    return this.request("/api/v1/settings/ui-language", { method: "PUT", body });
  }

  listDirectories(path?: string): Promise<DirectoryListing> {
    const query = path === undefined ? "" : `?${new URLSearchParams({ path })}`;
    return this.request(`/api/v1/directories${query}`);
  }

  createDirectory(body: CreateDirectoryRequest): Promise<DirectoryListing> {
    return this.request("/api/v1/directories", { method: "POST", body });
  }

  createProject(body: CreateProjectRequest): Promise<Project> {
    return this.request("/api/v1/projects", { method: "POST", body });
  }

  updateProject(id: string, body: UpdateProjectRequest): Promise<Project> {
    return this.request(`/api/v1/projects/${encodeURIComponent(id)}`, { method: "PATCH", body });
  }

  moveProject(id: string, body: MoveProjectRequest): Promise<Project[]> {
    return this.request(`/api/v1/projects/${encodeURIComponent(id)}/move`, {
      method: "POST",
      body,
    });
  }

  deleteProject(id: string): Promise<void> {
    return this.request(`/api/v1/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  createProjectThread(projectId: string): Promise<CreateProjectThreadResponse> {
    return this.request(`/api/v1/projects/${encodeURIComponent(projectId)}/threads`, {
      method: "POST",
      retry: true,
    });
  }

  readThread(id: string, cursor?: string, options?: { fresh?: boolean }): Promise<ThreadDetail> {
    const query = cursor ? `?${new URLSearchParams({ cursor })}` : "";
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}${query}`, {
      cache: options?.fresh ? "no-store" : undefined,
      retry: true,
    });
  }

  refreshThread(id: string): Promise<RefreshThreadResponse> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/refresh`, {
      method: "POST",
      retry: true,
    });
  }

  readTurnItems(threadId: string, turnId: string): Promise<TurnItemsResponse> {
    return this.request(
      `/api/v1/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/items`,
      { retry: true },
    );
  }

  readThreadChanges(
    id: string,
    syncPoint: ThreadSyncPoint,
    continuationCursor?: string,
  ): Promise<ThreadChanges> {
    const query = new URLSearchParams({
      cursor: syncPoint.cursor,
      anchorTurnId: syncPoint.anchorTurnId,
      anchorRevision: syncPoint.anchorRevision,
    });
    if (continuationCursor) query.set("continuationCursor", continuationCursor);
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/changes?${query}`, {
      cache: "no-store",
      retry: true,
    });
  }

  updateThreadDraft(
    id: string,
    body: UpdateThreadDraftRequest,
    options?: { keepalive?: boolean; retry?: boolean },
  ): Promise<ThreadDraft | null> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/draft`, {
      method: "PUT",
      body: {
        input: body.input,
        images: body.images,
        goalMode: body.goalMode,
        annotations: body.annotations,
      },
      keepalive: options?.keepalive,
      timeoutMs: 15_000,
      retry: options?.retry ?? false,
    });
  }

  readGitChanges(id: string): Promise<GitChangesSummary> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/git-changes`);
  }

  createDownload(id: string, path: string): Promise<DownloadTicketResponse> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/downloads`, {
      method: "POST",
      body: { path },
    });
  }

  createThread(body: CreateThreadRequest): Promise<{ thread: ThreadSummary } & TurnStartResult> {
    return this.request("/api/v1/threads", {
      method: "POST",
      body,
      timeoutMs: null,
      retry: Boolean(body.clientMessageId),
    });
  }

  forkThread(id: string, body: ForkThreadRequest): Promise<ForkThreadResponse> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/forks`, {
      method: "POST",
      body,
      timeoutMs: null,
    });
  }

  updateThread(id: string, body: UpdateThreadRequest): Promise<ThreadSummary> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}`, { method: "PATCH", body });
  }

  deleteThread(id: string): Promise<void> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  updateThreadSettings(id: string, body: UpdateThreadSettingsRequest): Promise<ThreadSummary> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/settings`, {
      method: "PATCH",
      body,
    });
  }

  startTurn(id: string, body: StartTurnRequest): Promise<TurnStartResult> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/turns`, {
      method: "POST",
      body,
      timeoutMs: null,
      retry: Boolean(body.clientMessageId),
    });
  }

  enqueue(id: string, body: QueueMessageRequest): Promise<QueuedMessage> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/queue`, {
      method: "POST",
      body,
      timeoutMs: 15_000,
    });
  }

  readGoal(id: string): Promise<ThreadGoal | null> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/goal`);
  }

  updateGoal(id: string, body: UpdateThreadGoalRequest): Promise<ThreadGoal> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/goal`, {
      method: "PATCH",
      body,
    });
  }

  clearGoal(id: string): Promise<void> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/goal`, {
      method: "DELETE",
    });
  }

  sendQueuedNow(id: string, messageId: string): Promise<{ turnId: string }> {
    return this.request(
      `/api/v1/threads/${encodeURIComponent(id)}/queue/${encodeURIComponent(messageId)}/send`,
      { method: "POST" },
    );
  }

  updateQueued(
    id: string,
    messageId: string,
    body: UpdateQueuedMessageRequest,
  ): Promise<QueuedMessage> {
    return this.request(
      `/api/v1/threads/${encodeURIComponent(id)}/queue/${encodeURIComponent(messageId)}`,
      { method: "PATCH", body },
    );
  }

  deleteQueued(id: string, messageId: string): Promise<void> {
    return this.request(
      `/api/v1/threads/${encodeURIComponent(id)}/queue/${encodeURIComponent(messageId)}`,
      { method: "DELETE" },
    );
  }

  steer(id: string, body: SteerTurnRequest): Promise<{ turnId: string }> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/steer`, {
      method: "POST",
      body,
    });
  }

  interrupt(id: string, turnId?: string): Promise<void> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/interrupt`, {
      method: "POST",
      body: turnId ? { turnId } : {},
    });
  }

  archive(id: string, archived: boolean): Promise<void> {
    return this.request(
      `/api/v1/threads/${encodeURIComponent(id)}/${archived ? "archive" : "unarchive"}`,
      { method: "POST" },
    );
  }

  markRead(id: string, body: MarkReadRequest): Promise<void> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/read`, { method: "PUT", body });
  }

  respond(attentionId: string, body: AttentionResponse): Promise<void> {
    return this.request(`/api/v1/attention/${encodeURIComponent(attentionId)}/respond`, {
      method: "POST",
      body,
    });
  }

  registerDevice(installationId: string, body: DeviceRegistrationRequest): Promise<void> {
    return this.request(`/api/v1/devices/${encodeURIComponent(installationId)}`, {
      method: "PUT",
      body,
    });
  }

  sync(): Promise<AppSnapshot> {
    return this.request("/api/v1/sync", { method: "POST", retry: true });
  }

  webSocketUrl(): string {
    const url = new URL("/api/v1/events", `${this.settings.baseUrl}/`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  private async request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      rawBody?: BodyInit;
      contentType?: string;
      authenticated?: boolean;
      timeoutMs?: number | null;
      keepalive?: boolean;
      headers?: Record<string, string>;
      cache?: RequestCache;
      retry?: boolean;
    } = {},
  ): Promise<T> {
    const retryDelays = [1_000, 2_000, 4_000];
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.requestOnce<T>(path, options);
      } catch (error) {
        if (!options.retry || attempt >= retryDelays.length || !isRetryableApiError(error)) {
          throw error;
        }
        await delay(retryDelays[attempt]!);
      }
    }
  }

  private async requestOnce<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      rawBody?: BodyInit;
      contentType?: string;
      authenticated?: boolean;
      timeoutMs?: number | null;
      keepalive?: boolean;
      headers?: Record<string, string>;
      cache?: RequestCache;
    },
  ): Promise<T> {
    const headers = new Headers({ Accept: "application/json" });
    for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
    if (options.authenticated !== false)
      headers.set("Authorization", `Bearer ${this.settings.token}`);
    if (options.rawBody !== undefined) {
      headers.set("Content-Type", options.contentType || "application/octet-stream");
    } else if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    let response: Response;
    const controller = new AbortController();
    const timeout =
      options.timeoutMs === null
        ? null
        : window.setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
    try {
      response = await fetch(new URL(path, `${this.settings.baseUrl}/`), {
        method: options.method ?? "GET",
        headers,
        body:
          options.rawBody ??
          (options.body === undefined ? undefined : JSON.stringify(options.body)),
        signal: controller.signal,
        keepalive: options.keepalive,
        cache: options.cache,
      });
    } catch {
      throw new ApiClientError(
        "connection_failed",
        translate(readInitialLanguage(), "Не удалось подключиться к серверу"),
      );
    } finally {
      if (timeout !== null) window.clearTimeout(timeout);
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as ApiError | null;
      throw new ApiClientError(
        payload?.error.code ?? "http_error",
        payload?.error.message ?? `HTTP ${response.status}`,
        response.status,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

export interface DownloadTicketResponse {
  downloadUrl: string;
  expiresAt: number;
}

export class ApiClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export function isRetryableApiError(error: unknown): boolean {
  if (!(error instanceof ApiClientError)) return false;
  return (
    error.code === "connection_failed" ||
    error.status === 408 ||
    error.status === 425 ||
    error.status === 429 ||
    (typeof error.status === "number" && error.status >= 500)
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
