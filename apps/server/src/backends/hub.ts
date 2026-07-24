import { EventEmitter } from "node:events";

import type {
  AgentId,
  AppSnapshot,
  AttentionRequest,
  BackendStatus,
  ConnectionView,
  Project,
  QueuedMessage,
  ServerEvent,
  ThreadSummary,
} from "@codexnest/protocol";

import type { AttentionManager } from "../attention";
import type { StateStore } from "../state/store";
import type { AgentBackend } from "./backend";
import { ThreadNotFoundError } from "./backend";

const OFFLINE_CONNECTION: ConnectionView = { state: "unavailable", message: null, syncedAt: null };

/**
 * SessionHub multiplexes one or more agent backends behind a single event stream and
 * snapshot. It owns the global sequence counter that clients observe; each backend emits
 * unsequenced events which the hub re-emits with a monotonically increasing sequence.
 */
export class SessionHub extends EventEmitter {
  private sequence = 0;

  constructor(
    private readonly backends: AgentBackend[],
    private readonly store: StateStore,
    private readonly attention: AttentionManager,
    private readonly pushConfigured: boolean,
  ) {
    super();
    for (const backend of backends) {
      backend.on("event", (event: ServerEvent) => this.handleBackendEvent(backend, event));
    }
    // Listener order is load-bearing for the public event stream: AppProjection
    // subscribes to AttentionManager in its own constructor (before this hub is
    // built), so on an attention upsert the projection's publishThread side effect
    // fires first — thread.upserted precedes attention.upserted on the wire. The
    // client reducer is order-independent here, but reordering these subscriptions
    // (e.g. constructing the hub before the projection) would change the observable
    // ordering, so keep the projection-before-hub construction order.
    this.attention.on("upserted", (request: AttentionRequest) =>
      this.publish({ type: "attention.upserted", attention: request }),
    );
    this.attention.on("removed", (attentionId: string) =>
      this.publish({ type: "attention.removed", attentionId }),
    );
  }

  snapshot(): AppSnapshot {
    const state = this.store.snapshot();
    const codex = this.backend("codex");
    const threads = this.backends.flatMap((backend) => backend.threads()).sort(compareThreads);
    return {
      sequence: this.sequence,
      connection: codex?.connection ?? OFFLINE_CONNECTION,
      projects: state.projects,
      threads,
      attention: this.attention.list(),
      models: codex?.models ?? [],
      defaultReasoningEffort: state.defaultReasoningEffort,
      taskDefaults: state.taskDefaults ?? {},
      pushConfigured: this.pushConfigured,
      uiLanguage: state.uiLanguage,
      backends: this.backends.map((backend) => this.backendStatus(backend)),
    };
  }

  publish(event: ServerEvent): void {
    this.sequence += 1;
    this.emit("event", this.sequence, event);
  }

  backendFor(threadId: string): AgentBackend | undefined {
    return this.backends.find((backend) => backend.owns(threadId));
  }

  backend(agent: AgentId): AgentBackend | undefined {
    return this.backends.find((backend) => backend.agent === agent);
  }

  requireBackend(threadId: string): AgentBackend {
    const backend = this.backendFor(threadId);
    if (!backend) throw new ThreadNotFoundError();
    return backend;
  }

  summary(threadId: string): ThreadSummary | undefined {
    return this.backendFor(threadId)?.summary(threadId);
  }

  get threadCount(): number {
    return this.backends.reduce((total, backend) => total + backend.threads().length, 0);
  }

  get lastSyncedAt(): string | null {
    return this.backend("codex")?.connection.syncedAt ?? null;
  }

  publishProject(projectId: string): void {
    const project = this.store.snapshot().projects.find((candidate) => candidate.id === projectId);
    if (project) this.publish({ type: "project.upserted", project });
    this.republishThreads();
  }

  publishProjectsReordered(projects: Project[]): void {
    this.publish({ type: "projects.reordered", projects });
  }

  removeProject(projectId: string): void {
    this.publish({ type: "project.removed", projectId });
    this.republishThreads();
  }

  publishQueue(threadId: string, messages: QueuedMessage[]): void {
    this.publish({ type: "queue.changed", threadId, messages });
    const summary = this.summary(threadId);
    if (summary) this.publish({ type: "thread.upserted", thread: summary });
  }

  async sync(): Promise<void> {
    // allSettled: one backend's sync failure must not fail POST /sync — its failure
    // surfaces through its own connection state instead.
    await Promise.allSettled(this.backends.map((backend) => backend.sync()));
  }

  private handleBackendEvent(backend: AgentBackend, event: ServerEvent): void {
    const isConnectionOrModels =
      event.type === "connection.changed" || event.type === "models.changed";
    if (backend.agent === "codex") {
      this.publish(event);
      if (isConnectionOrModels) {
        this.publish({ type: "backend.changed", backend: this.backendStatus(backend) });
      }
      return;
    }
    if (isConnectionOrModels) {
      this.publish({ type: "backend.changed", backend: this.backendStatus(backend) });
      return;
    }
    this.publish(event);
  }

  private backendStatus(backend: AgentBackend): BackendStatus {
    return { agent: backend.agent, connection: backend.connection, models: backend.models };
  }

  private republishThreads(): void {
    for (const backend of this.backends) {
      for (const summary of backend.threads()) {
        this.publish({ type: "thread.upserted", thread: summary });
      }
    }
  }
}

function compareThreads(a: ThreadSummary, b: ThreadSummary): number {
  return b.updatedAt - a.updatedAt;
}
