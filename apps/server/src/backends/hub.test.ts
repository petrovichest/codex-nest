import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type {
  AgentId,
  ConnectionView,
  ModelOption,
  ServerEvent,
  ThreadSummary,
} from "@codexnest/protocol";

import { AttentionManager } from "../attention";
import type { ServerRequest } from "../codex/generated/index";
import type { JsonlTransport } from "../codex/transport";
import type { StateStore } from "../state/store";
import type { AgentBackend } from "./backend";
import { ThreadNotFoundError } from "./backend";
import { SessionHub } from "./hub";

class FakeBackend extends EventEmitter {
  connection: ConnectionView = { state: "ready", message: null, syncedAt: null };
  models: ModelOption[] = [];
  newSessionSettings = { collaborationMode: "default" as const };
  owned: ThreadSummary[] = [];
  sync = vi.fn(async () => undefined);

  constructor(readonly agent: AgentId) {
    super();
  }

  owns(threadId: string): boolean {
    return this.owned.some((thread) => thread.id === threadId);
  }

  threads(): ThreadSummary[] {
    return this.owned;
  }

  summary(threadId: string): ThreadSummary | undefined {
    return this.owned.find((thread) => thread.id === threadId);
  }

  emitEvent(event: ServerEvent): void {
    this.emit("event", event);
  }
}

function asBackend(fake: FakeBackend): AgentBackend {
  return fake as unknown as AgentBackend;
}

function fakeStore(overrides: Record<string, unknown> = {}): StateStore {
  return {
    snapshot: () => ({ projects: [], threadMeta: {}, ...overrides }),
  } as unknown as StateStore;
}

function summary(id: string, agent: AgentId, updatedAt: number): ThreadSummary {
  return {
    id,
    agent,
    projectId: null,
    title: id,
    preview: "",
    cwd: "/work",
    state: "idle",
    unread: false,
    unseen: false,
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt,
    currentTurnId: null,
    queuedMessageCount: 0,
    settings: { collaborationMode: "default" },
  };
}

function model(id: string): ModelOption {
  return {
    id,
    displayName: id,
    description: "",
    isDefault: true,
    reasoningEfforts: [],
    serviceTiers: [],
    supportsPersonality: false,
  };
}

describe("SessionHub", () => {
  it("assigns a global sequence and forwards codex events with a synthesized backend.changed", () => {
    const codex = new FakeBackend("codex");
    const hub = new SessionHub([asBackend(codex)], fakeStore(), new AttentionManager(), false);
    const events: Array<{ sequence: number; event: ServerEvent }> = [];
    hub.on("event", (sequence: number, event: ServerEvent) => events.push({ sequence, event }));

    codex.emitEvent({ type: "thread.removed", threadId: "gone" });
    codex.connection = { state: "unavailable", message: "down", syncedAt: null };
    codex.emitEvent({ type: "connection.changed", connection: codex.connection });

    expect(events).toEqual([
      { sequence: 1, event: { type: "thread.removed", threadId: "gone" } },
      { sequence: 2, event: { type: "connection.changed", connection: codex.connection } },
      {
        sequence: 3,
        event: {
          type: "backend.changed",
          backend: { agent: "codex", connection: codex.connection, models: [] },
        },
      },
    ]);
  });

  it("never surfaces a non-codex backend's connection/models changes as legacy events", () => {
    const codex = new FakeBackend("codex");
    const claude = new FakeBackend("claude");
    const hub = new SessionHub(
      [asBackend(codex), asBackend(claude)],
      fakeStore(),
      new AttentionManager(),
      false,
    );
    const events: ServerEvent[] = [];
    hub.on("event", (_sequence: number, event: ServerEvent) => events.push(event));

    const initialConnection = claude.connection;
    const claudeModels = [model("claude-sonnet")];
    claude.models = claudeModels;
    claude.emitEvent({ type: "models.changed", models: claude.models });
    const updatedConnection: ConnectionView = { state: "ready", message: null, syncedAt: "t" };
    claude.connection = updatedConnection;
    claude.emitEvent({ type: "connection.changed", connection: updatedConnection });
    claude.emitEvent({ type: "thread.removed", threadId: "c1" });

    expect(events.some((event) => event.type === "models.changed")).toBe(false);
    expect(events.some((event) => event.type === "connection.changed")).toBe(false);
    expect(events).toEqual([
      {
        type: "backend.changed",
        backend: { agent: "claude", connection: initialConnection, models: claudeModels },
      },
      {
        type: "backend.changed",
        backend: { agent: "claude", connection: updatedConnection, models: claudeModels },
      },
      { type: "thread.removed", threadId: "c1" },
    ]);
  });

  it("publishes attention lifecycle events from the attention manager", () => {
    const codex = new FakeBackend("codex");
    const attention = new AttentionManager();
    const hub = new SessionHub([asBackend(codex)], fakeStore(), attention, false);
    const events: ServerEvent[] = [];
    hub.on("event", (_sequence: number, event: ServerEvent) => events.push(event));

    const transport = { respond: vi.fn(), respondError: vi.fn() } as unknown as JsonlTransport;
    const request = attention.receive(
      {
        method: "item/commandExecution/requestApproval",
        id: 1,
        params: {
          threadId: "t",
          turnId: "turn",
          itemId: "item",
          startedAtMs: 1,
          environmentId: null,
          command: "ls",
          cwd: "/work",
          availableDecisions: ["accept", "decline"],
        },
      } as ServerRequest,
      transport,
    );
    attention.resolve(request.id, { kind: "approval", decision: "accept" });

    expect(events).toEqual([
      { type: "attention.upserted", attention: request },
      { type: "attention.removed", attentionId: request.id },
    ]);
  });

  it("routes threads to their owning backend and reports unknown threads", () => {
    const codex = new FakeBackend("codex");
    const claude = new FakeBackend("claude");
    codex.owned = [summary("a", "codex", 5)];
    claude.owned = [summary("b", "claude", 9)];
    const hub = new SessionHub(
      [asBackend(codex), asBackend(claude)],
      fakeStore(),
      new AttentionManager(),
      false,
    );

    expect(hub.backendFor("a")).toBe(asBackend(codex));
    expect(hub.backendFor("b")).toBe(asBackend(claude));
    expect(hub.backendFor("missing")).toBeUndefined();
    expect(hub.backend("codex")).toBe(asBackend(codex));
    expect(hub.backend("claude")).toBe(asBackend(claude));
    expect(() => hub.requireBackend("missing")).toThrow(ThreadNotFoundError);
    expect(hub.summary("b")?.id).toBe("b");
    expect(hub.threadCount).toBe(2);
  });

  it("builds a merged snapshot with codex legacy fields and a per-backend status list", () => {
    const codex = new FakeBackend("codex");
    const claude = new FakeBackend("claude");
    codex.owned = [summary("a", "codex", 5)];
    claude.owned = [summary("b", "claude", 9)];
    codex.models = [model("gpt")];
    claude.models = [model("claude")];
    codex.connection = { state: "ready", message: null, syncedAt: "codex-time" };
    const hub = new SessionHub(
      [asBackend(codex), asBackend(claude)],
      fakeStore({ defaultReasoningEffort: "high" }),
      new AttentionManager(),
      true,
    );

    const snapshot = hub.snapshot();
    expect(snapshot.threads.map((thread) => thread.id)).toEqual(["b", "a"]);
    expect(snapshot.connection).toEqual(codex.connection);
    expect(snapshot.models).toEqual(codex.models);
    expect(snapshot.pushConfigured).toBe(true);
    expect(snapshot.defaultReasoningEffort).toBe("high");
    expect(snapshot.backends).toEqual([
      { agent: "codex", connection: codex.connection, models: codex.models },
      { agent: "claude", connection: claude.connection, models: claude.models },
    ]);
    expect(hub.lastSyncedAt).toBe("codex-time");
  });

  it("re-publishes every thread summary when projects change", () => {
    const codex = new FakeBackend("codex");
    codex.owned = [summary("a", "codex", 5), summary("b", "codex", 9)];
    const hub = new SessionHub(
      [asBackend(codex)],
      fakeStore({
        projects: [{ id: "p", displayName: "P", path: "/p", createdAt: "x", updatedAt: "x" }],
      }),
      new AttentionManager(),
      false,
    );
    const events: ServerEvent[] = [];
    hub.on("event", (_sequence: number, event: ServerEvent) => events.push(event));

    hub.publishProject("p");

    expect(events).toEqual([
      {
        type: "project.upserted",
        project: { id: "p", displayName: "P", path: "/p", createdAt: "x", updatedAt: "x" },
      },
      { type: "thread.upserted", thread: codex.owned[0] },
      { type: "thread.upserted", thread: codex.owned[1] },
    ]);
  });
});
