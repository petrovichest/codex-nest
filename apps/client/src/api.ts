import type {
  ApiError,
  AppSnapshot,
  AttentionResponse,
  CreateDirectoryRequest,
  CreateProjectRequest,
  CreateProjectThreadResponse,
  CreateThreadRequest,
  DeviceRegistrationRequest,
  DirectoryListing,
  GlobalPermissionSettings,
  HealthResponse,
  MarkReadRequest,
  Project,
  StartTurnRequest,
  SteerTurnRequest,
  SummaryResponse,
  ThreadDetail,
  ThreadSummary,
  UpdateGlobalPermissionSettingsRequest,
  UpdateProjectRequest,
  UpdateThreadSettingsRequest,
  UpdateThreadRequest,
} from "@codexnest/protocol";

import type { ConnectionSettings } from "./storage";

export class ApiClient {
  constructor(public readonly settings: ConnectionSettings) {}

  health(): Promise<HealthResponse> {
    return this.request("/api/v1/health", { authenticated: false });
  }

  summary(): Promise<SummaryResponse> {
    return this.request("/api/v1/summary");
  }

  readPermissionSettings(): Promise<GlobalPermissionSettings> {
    return this.request("/api/v1/settings/permissions");
  }

  updatePermissionSettings(
    body: UpdateGlobalPermissionSettingsRequest,
  ): Promise<GlobalPermissionSettings> {
    return this.request("/api/v1/settings/permissions", { method: "PUT", body });
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

  deleteProject(id: string): Promise<void> {
    return this.request(`/api/v1/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  createProjectThread(projectId: string): Promise<CreateProjectThreadResponse> {
    return this.request(`/api/v1/projects/${encodeURIComponent(projectId)}/threads`, {
      method: "POST",
    });
  }

  readThread(id: string): Promise<ThreadDetail> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}`);
  }

  createThread(body: CreateThreadRequest): Promise<{ thread: ThreadSummary; turnId: string }> {
    return this.request("/api/v1/threads", { method: "POST", body });
  }

  updateThread(id: string, body: UpdateThreadRequest): Promise<ThreadSummary> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}`, { method: "PATCH", body });
  }

  updateThreadSettings(id: string, body: UpdateThreadSettingsRequest): Promise<ThreadSummary> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/settings`, {
      method: "PATCH",
      body,
    });
  }

  startTurn(id: string, body: StartTurnRequest): Promise<{ turnId: string }> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/turns`, {
      method: "POST",
      body,
    });
  }

  steer(id: string, body: SteerTurnRequest): Promise<{ turnId: string }> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/steer`, {
      method: "POST",
      body,
    });
  }

  interrupt(id: string, turnId: string): Promise<void> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/interrupt`, {
      method: "POST",
      body: { turnId },
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
    return this.request("/api/v1/sync", { method: "POST" });
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
      authenticated?: boolean;
    } = {},
  ): Promise<T> {
    const headers = new Headers({ Accept: "application/json" });
    if (options.authenticated !== false)
      headers.set("Authorization", `Bearer ${this.settings.token}`);
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    let response: Response;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    try {
      response = await fetch(new URL(path, `${this.settings.baseUrl}/`), {
        method: options.method ?? "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch {
      throw new ApiClientError("connection_failed", "Не удалось подключиться к Raspberry Pi");
    } finally {
      window.clearTimeout(timeout);
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
