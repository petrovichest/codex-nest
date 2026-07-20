import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app";
import { AttentionManager } from "./attention";
import { hashToken } from "./auth";
import { CodexBridge } from "./codex/bridge";
import { loadConfig } from "./config";
import { AppProjection } from "./projection";
import { PushNotifier } from "./push";
import { StateStore } from "./state/store";

const directories: string[] = [];
afterEach(async () =>
  Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  ),
);

describe("HTTP authentication", () => {
  it("keeps health public and rejects missing, query, and bad tokens", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-api-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.auth.tokenSha256 = hashToken("correct");
    });
    const bridge = new CodexBridge({
      codexBin: "codex",
      checkVersion: async () => "0.144.6",
      spawnProcess: () => {
        throw new Error("not started");
      },
    });
    const attention = new AttentionManager();
    const push = new PushNotifier(store);
    const projection = new AppProjection(bridge, store, attention, false);
    const config = loadConfig({
      statePath: store.path,
      clientDist: join(directory, "missing"),
      allowedOrigins: new Set(["http://localhost"]),
      websocketAuthTimeoutMs: 25,
    });
    const app = await buildApp(config, { bridge, store, projection, attention, push });

    expect((await app.inject({ url: "/api/v1/health" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/v1/summary" })).json()).toMatchObject({
      error: { code: "unauthorized" },
    });
    expect((await app.inject({ url: "/api/v1/summary?token=correct" })).json()).toMatchObject({
      error: { code: "validation_failed" },
    });
    expect(
      (await app.inject({ url: "/api/v1/summary", headers: { authorization: "Bearer wrong" } }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({ url: "/api/v1/summary", headers: { authorization: "Bearer correct" } })
      ).json(),
    ).toMatchObject({ threadCount: 0 });
    expect(
      (
        await app.inject({
          url: "/api/v1/summary",
          headers: { origin: "https://evil.example", authorization: "Bearer correct" },
        })
      ).statusCode,
    ).toBe(403);

    await app.ready();
    const authorized = await app.injectWS("/api/v1/events", {
      headers: { origin: "http://localhost" },
    });
    const snapshot = new Promise<Record<string, unknown>>((resolve) => {
      authorized.once("message", (data) =>
        resolve(JSON.parse(data.toString()) as Record<string, unknown>),
      );
    });
    authorized.send(JSON.stringify({ type: "authenticate", token: "correct" }));
    await expect(snapshot).resolves.toMatchObject({ type: "snapshot" });
    authorized.terminate();

    const unauthorized = await app.injectWS("/api/v1/events", {
      headers: { origin: "http://localhost" },
    });
    let unauthorizedMessages = 0;
    unauthorized.on("message", () => {
      unauthorizedMessages += 1;
    });
    const closed = new Promise<number>((resolve) => unauthorized.once("close", resolve));
    unauthorized.send(JSON.stringify({ type: "authenticate", token: "wrong" }));
    await expect(closed).resolves.toBe(1008);
    expect(unauthorizedMessages).toBe(0);

    await expect(
      app.injectWS("/api/v1/events?token=correct", { headers: { origin: "http://localhost" } }),
    ).rejects.toThrow("400");

    const idle = await app.injectWS("/api/v1/events", { headers: { origin: "http://localhost" } });
    const idleClosed = new Promise<number>((resolve) => idle.once("close", resolve));
    await expect(idleClosed).resolves.toBe(1008);

    await expect(
      app.injectWS("/api/v1/events", { headers: { origin: "https://evil.example" } }),
    ).rejects.toThrow();

    const revocable = await app.injectWS("/api/v1/events", {
      headers: { origin: "http://localhost" },
    });
    const revocableSnapshot = new Promise<void>((resolve) =>
      revocable.once("message", () => resolve()),
    );
    revocable.send(JSON.stringify({ type: "authenticate", token: "correct" }));
    await revocableSnapshot;
    const revoked = new Promise<number>((resolve) => revocable.once("close", resolve));
    await store.update((state) => {
      state.auth.tokenSha256 = hashToken("rotated");
    });
    await expect(revoked).resolves.toBe(1008);
    await app.close();
  });
});
