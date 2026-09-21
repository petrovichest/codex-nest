import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AppServerState, ServerFrame } from "@codexnest/protocol";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app";
import { AttentionManager } from "./attention";
import { hashToken } from "./auth";
import type { CodexBridge } from "./codex/bridge";
import { loadConfig } from "./config";
import { AppProjection } from "./projection";
import { StateStore } from "./state/store";

const response = (usedPercent = 25) => ({
  rateLimits: {
    primary: { usedPercent, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    secondary: null,
  },
});

class LimitsBridge extends EventEmitter {
  state: AppServerState = "ready";
  request = vi.fn<(method: string, params: unknown) => Promise<unknown>>(async () => response());
  changeState(state: AppServerState) {
    this.state = state;
    this.emit("state", state);
  }
}

const apps: FastifyInstance[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-rate-limits-"));
  directories.push(directory);
  const store = new StateStore(join(directory, "state.json"));
  await store.load();
  await store.update((state) => {
    state.auth.tokenSha256 = hashToken("correct");
  });
  const bridge = new LimitsBridge();
  const attention = new AttentionManager();
  const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
  const app = await buildApp(
    loadConfig({
      statePath: store.path,
      clientDist: join(directory, "missing"),
      allowedOrigins: new Set(["http://localhost"]),
    }),
    { bridge: bridge as unknown as CodexBridge, store, projection, attention },
  );
  apps.push(app);
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  const read = () =>
    app.inject({ url: "/api/v1/codex/rate-limits", headers: { authorization: "Bearer correct" } });
  return { app, bridge, projection, read };
}

async function connect(app: FastifyInstance) {
  const socket = await app.injectWS("/api/v1/events", {
    headers: { origin: "http://localhost" },
  });
  const frames: ServerFrame[] = [];
  socket.on("message", (data) => frames.push(JSON.parse(data.toString()) as ServerFrame));
  const snapshot = new Promise<ServerFrame>((resolve) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString()) as ServerFrame));
  });
  socket.send(JSON.stringify({ type: "authenticate", token: "correct" }));
  await snapshot;
  return { socket, frames };
}

describe("server-owned Codex rate limits", () => {
  it("loads on readiness and polls every five minutes without any clients", async () => {
    const { app, bridge, projection } = await harness();
    bridge.state = "unavailable";
    await app.ready();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(bridge.request).not.toHaveBeenCalled();

    bridge.changeState("ready");
    await vi.advanceTimersByTimeAsync(0);
    expect(projection.codexRateLimits.limits?.primary?.usedPercent).toBe(25);
    expect(bridge.request).toHaveBeenCalledExactlyOnceWith("account/rateLimits/read", undefined);
    const firstUpdatedAt = projection.codexRateLimits.updatedAt;
    for (let i = 0; i < 5; i++) projection.snapshot();
    await vi.advanceTimersByTimeAsync(299_999);
    expect(bridge.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(bridge.request).toHaveBeenCalledTimes(2);
    expect(projection.codexRateLimits.updatedAt).toBeGreaterThan(firstUpdatedAt!);
    await app.close();
    await vi.advanceTimersByTimeAsync(600_000);
    bridge.changeState("ready");
    expect(bridge.request).toHaveBeenCalledTimes(2);
  });

  it("keeps the last successful values and timestamp after errors and recovers on schedule", async () => {
    const { app, bridge, projection } = await harness();
    await app.ready();
    await vi.waitFor(() => expect(projection.codexRateLimits.updatedAt).not.toBeNull());
    const previous = projection.codexRateLimits;
    bridge.request.mockRejectedValueOnce(new Error("Unavailable"));
    await vi.advanceTimersByTimeAsync(300_000);
    expect(projection.codexRateLimits).toEqual({ ...previous, refreshError: true });
    bridge.request.mockResolvedValueOnce({ rateLimits: { primary: { usedPercent: "bad" } } });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(projection.codexRateLimits).toEqual({ ...previous, refreshError: true });
    bridge.request.mockResolvedValueOnce(response(40));
    await vi.advanceTimersByTimeAsync(300_000);
    expect(projection.codexRateLimits).toMatchObject({
      limits: { primary: { usedPercent: 40 } },
      refreshing: false,
      refreshError: false,
    });
    expect(projection.codexRateLimits.updatedAt).toBeGreaterThan(previous.updatedAt!);
  });

  it("shares an in-flight manual request with other clients and the timer", async () => {
    const { app, bridge, projection, read } = await harness();
    let requests = 0;
    app.addHook("onRequest", async () => {
      requests++;
    });
    await app.ready();
    await vi.waitFor(() => expect(projection.codexRateLimits.updatedAt).not.toBeNull());
    let resolve!: (value: unknown) => void;
    bridge.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const first = read().then((reply) => reply);
    const second = read().then((reply) => reply);
    await vi.waitFor(() => expect(requests).toBe(2));
    await vi.advanceTimersByTimeAsync(300_000);
    expect(bridge.request).toHaveBeenCalledTimes(2);
    expect(projection.codexRateLimits.refreshing).toBe(true);
    expect(projection.codexRateLimits.limits?.primary?.usedPercent).toBe(25);
    resolve(response(45));
    const replies = await Promise.all([first, second]);
    expect(replies.map((reply) => reply.statusCode)).toEqual([200, 200]);
    expect(replies[0]!.json()).toEqual(replies[1]!.json());
    expect(replies[0]!.json()).toEqual(projection.codexRateLimits.limits);
    expect(projection.codexRateLimits.refreshing).toBe(false);
  });

  it("ignores replies from a lost connection and from requests finishing after shutdown", async () => {
    const { app, bridge, projection } = await harness();
    let resolveOld!: (value: unknown) => void;
    bridge.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolveOld = done;
        }),
    );
    await app.ready();
    expect(projection.codexRateLimits.refreshing).toBe(true);
    bridge.changeState("unavailable");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(bridge.request).toHaveBeenCalledTimes(1);
    bridge.changeState("ready");
    await vi.waitFor(() => expect(projection.codexRateLimits.updatedAt).not.toBeNull());
    resolveOld(response(99));
    await vi.advanceTimersByTimeAsync(0);
    expect(projection.codexRateLimits.limits?.primary?.usedPercent).toBe(25);

    bridge.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolveOld = done;
        }),
    );
    await vi.advanceTimersByTimeAsync(300_000);
    await app.close();
    const stopped = projection.codexRateLimits;
    resolveOld(response(80));
    await vi.advanceTimersByTimeAsync(0);
    expect(projection.codexRateLimits).toBe(stopped);
  });

  it("sends snapshots and versioned updates to every client without reads on connect", async () => {
    const { app, bridge, projection, read } = await harness();
    await app.ready();
    await vi.waitFor(() => expect(projection.codexRateLimits.updatedAt).not.toBeNull());
    const first = await connect(app);
    const second = await connect(app);
    for (const client of [first, second]) {
      expect(client.frames[0]).toMatchObject({
        type: "snapshot",
        snapshot: { codexRateLimits: projection.codexRateLimits },
      });
    }
    expect(bridge.request).toHaveBeenCalledTimes(1);
    bridge.request.mockResolvedValueOnce(response(55));
    expect((await read()).statusCode).toBe(200);
    await vi.waitFor(() => {
      for (const client of [first, second]) {
        expect(client.frames.at(-1)).toMatchObject({
          type: "event",
          version: projection.version,
          event: { type: "codexRateLimits.changed", codexRateLimits: projection.codexRateLimits },
        });
      }
    });
    first.socket.close();
    const reconnected = await connect(app);
    expect(reconnected.frames[0]).toMatchObject({
      type: "snapshot",
      snapshot: { codexRateLimits: { limits: { primary: { usedPercent: 55 } } } },
    });
    expect(bridge.request).toHaveBeenCalledTimes(2);
    second.socket.close();
    reconnected.socket.close();
  });

  it("reports initial failures and accepts an authoritative response with no windows", async () => {
    const { app, bridge, projection, read } = await harness();
    bridge.request.mockRejectedValueOnce(new Error("Unavailable"));
    await app.ready();
    await vi.waitFor(() => expect(projection.codexRateLimits.refreshError).toBe(true));
    expect(projection.codexRateLimits.limits).toBeNull();
    bridge.request.mockResolvedValueOnce({ rateLimits: { primary: null, secondary: null } });
    expect((await read()).statusCode).toBe(200);
    expect(projection.codexRateLimits).toMatchObject({
      limits: { primary: null, secondary: null },
      refreshing: false,
      refreshError: false,
    });
  });
});
