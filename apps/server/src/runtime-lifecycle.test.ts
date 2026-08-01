import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RESTART_RECOVERY_PROTOCOL_VERSION,
  RestartTokenError,
  RuntimeLifecycle,
} from "./runtime-lifecycle";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("RuntimeLifecycle", () => {
  it("keeps the built release marker aligned with the server protocol", async () => {
    const marker = JSON.parse(
      await readFile(resolve(process.cwd(), "../../deploy/restart-protocol.json"), "utf8"),
    ) as { recoveryProtocolVersion: number; supportedTeamToolsVersions: number[] };
    expect(marker.recoveryProtocolVersion).toBe(RESTART_RECOVERY_PROTOCOL_VERSION);
    expect(marker.supportedTeamToolsVersions).toContain(1);
  });

  it("drains tracked work, checkpoints, and resumes with a protected token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-lifecycle-"));
    directories.push(directory);
    const tokenPath = join(directory, "restart-token");
    let bridgeReady = true;
    let releaseWork!: () => void;
    const work = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    const checkpoint = vi.fn(async () => undefined);
    const pause = vi.fn(async () => undefined);
    const resume = vi.fn(async () => undefined);
    const lifecycle = new RuntimeLifecycle({
      transport: "daemon",
      tokenPath,
      bridgeReady: () => bridgeReady,
      checkpoint,
      drainLeaseMs: 1_000,
    });
    lifecycle.register({ pause, resume });
    await lifecycle.initialize();
    lifecycle.syncing();
    lifecycle.ready();
    lifecycle.track(work);

    const token = (await readFile(tokenPath, "utf8")).trim();
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
    const preparing = lifecycle.prepare(token);
    await vi.waitFor(() => expect(pause).toHaveBeenCalledOnce());
    expect(lifecycle.state).toBe("draining");
    expect(checkpoint).not.toHaveBeenCalled();
    releaseWork();
    await preparing;
    expect(checkpoint).toHaveBeenCalledOnce();

    await expect(lifecycle.resume("invalid")).rejects.toBeInstanceOf(RestartTokenError);
    await lifecycle.resume(token);
    expect(resume).toHaveBeenCalledOnce();
    expect(lifecycle.state).toBe("ready");

    bridgeReady = false;
    lifecycle.unavailable();
    expect(lifecycle.acceptsMutations).toBe(false);
    await lifecycle.close();
  });

  it("automatically releases an abandoned drain lease", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-lifecycle-lease-"));
    directories.push(directory);
    const tokenPath = join(directory, "restart-token");
    const resume = vi.fn(async () => undefined);
    const lifecycle = new RuntimeLifecycle({
      transport: "daemon",
      tokenPath,
      bridgeReady: () => true,
      checkpoint: async () => undefined,
      drainLeaseMs: 20,
    });
    lifecycle.register({ pause: async () => undefined, resume });
    await lifecycle.initialize();
    lifecycle.ready();
    const token = (await readFile(tokenPath, "utf8")).trim();
    await lifecycle.prepare(token);
    await vi.waitFor(() => expect(lifecycle.state).toBe("ready"), { timeout: 500 });
    expect(resume).toHaveBeenCalledOnce();
    await lifecycle.close();
  });

  it("times out an abandoned drain and allows a clean retry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-lifecycle-timeout-"));
    directories.push(directory);
    const tokenPath = join(directory, "restart-token");
    let releasePause!: () => void;
    const pauseGate = new Promise<void>((resolve) => {
      releasePause = resolve;
    });
    const checkpoint = vi.fn(async () => undefined);
    const pause = vi.fn(async () => pauseGate);
    const resume = vi.fn(async () => undefined);
    const lifecycle = new RuntimeLifecycle({
      transport: "daemon",
      tokenPath,
      bridgeReady: () => true,
      checkpoint,
      drainTimeoutMs: 20,
    });
    lifecycle.register({ pause, resume });
    await lifecycle.initialize();
    lifecycle.ready();
    const token = (await readFile(tokenPath, "utf8")).trim();

    await expect(lifecycle.prepare(token)).rejects.toThrow(
      "CodexNest restart preparation timed out",
    );
    expect(resume).toHaveBeenCalledOnce();
    expect(lifecycle.state).toBe("ready");

    releasePause();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(checkpoint).not.toHaveBeenCalled();
    await lifecycle.prepare(token);
    expect(pause).toHaveBeenCalledTimes(2);
    expect(checkpoint).toHaveBeenCalledOnce();
    await lifecycle.resume(token);
    await lifecycle.close();
  });

  it("serializes concurrent prepare, resume, and duplicate prepare calls", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-lifecycle-race-"));
    directories.push(directory);
    const tokenPath = join(directory, "restart-token");
    let releasePause!: () => void;
    const pauseGate = new Promise<void>((resolve) => {
      releasePause = resolve;
    });
    const pause = vi.fn(async () => pauseGate);
    const resume = vi.fn(async () => undefined);
    const checkpoint = vi.fn(async () => undefined);
    const lifecycle = new RuntimeLifecycle({
      transport: "daemon",
      tokenPath,
      bridgeReady: () => true,
      checkpoint,
    });
    lifecycle.register({ pause, resume });
    await lifecycle.initialize();
    lifecycle.ready();
    const token = (await readFile(tokenPath, "utf8")).trim();

    const firstPrepare = lifecycle.prepare(token);
    const duplicatePrepare = lifecycle.prepare(token);
    await vi.waitFor(() => expect(pause).toHaveBeenCalledOnce());
    const concurrentResume = lifecycle.resume(token);
    releasePause();
    await Promise.all([firstPrepare, duplicatePrepare, concurrentResume]);

    expect(pause).toHaveBeenCalledOnce();
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
    expect(lifecycle.state).toBe("ready");
    await lifecycle.close();
  });

  it("leaves drain mode when the durable checkpoint fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-lifecycle-failure-"));
    directories.push(directory);
    const tokenPath = join(directory, "restart-token");
    const resume = vi.fn(async () => undefined);
    const lifecycle = new RuntimeLifecycle({
      transport: "daemon",
      tokenPath,
      bridgeReady: () => true,
      checkpoint: async () => {
        throw new Error("disk full");
      },
    });
    lifecycle.register({ pause: async () => undefined, resume });
    await lifecycle.initialize();
    lifecycle.ready();
    const token = (await readFile(tokenPath, "utf8")).trim();
    await expect(lifecycle.prepare(token)).rejects.toThrow("disk full");
    expect(resume).toHaveBeenCalledOnce();
    expect(lifecycle.state).toBe("ready");
    await lifecycle.close();
  });
});
