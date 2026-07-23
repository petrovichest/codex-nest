import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AppManager } from "./app-management";

describe("AppManager", () => {
  it("keeps status local until an explicit update check", async () => {
    const runCommand = vi.fn(async () => ({
      stdout: JSON.stringify({
        supported: true,
        currentVersion: "0.1.4-1111111",
        latestVersion: "0.1.4-2222222",
        updateAvailable: true,
        operation: "idle",
        result: "none",
        message: "Update check completed",
        checkedAt: "2026-07-22T10:00:00Z",
        updatedAt: "2026-07-22T10:00:00Z",
      }),
      stderr: "",
    }));
    const manager = new AppManager({
      currentVersion: "0.1.0",
      managedInstall: true,
      statusPath: "/missing/update.json",
      managementCli: "/home/user/.local/bin/codexnest",
      runCommand,
    });

    await expect(manager.status()).resolves.toMatchObject({
      latestVersion: null,
      updateAvailable: null,
    });
    expect(runCommand).not.toHaveBeenCalled();
    await expect(manager.check()).resolves.toMatchObject({
      latestVersion: "0.1.4-2222222",
      updateAvailable: true,
    });
    expect(runCommand).toHaveBeenCalledWith(
      "/home/user/.local/bin/codexnest",
      ["check-update", "--json"],
      { timeout: 30_000 },
    );
  });

  it("starts the fixed updater unit without waiting for the application restart", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const manager = new AppManager({
      currentVersion: "0.1.0",
      managedInstall: true,
      statusPath: "/missing/update.json",
      managementCli: "/home/user/.local/bin/codexnest",
      runCommand,
    });

    await expect(manager.update()).resolves.toMatchObject({ operation: "preparing" });
    expect(runCommand).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "start", "--no-block", "codexnest-update.service"],
      { timeout: 10_000 },
    );
  });

  it("recovers a stale in-progress status after a reboot", async () => {
    const statusDirectory = await mkdtemp(join(tmpdir(), "codexnest-interrupted-update-"));
    const statusPath = join(statusDirectory, "update.json");
    try {
      await writeFile(
        statusPath,
        JSON.stringify({
          latestVersion: "0.2.0",
          updateAvailable: true,
          operation: "building",
          result: "none",
        }),
      );
      const runCommand = vi.fn(async () => {
        throw new Error("inactive");
      });
      const manager = new AppManager({
        currentVersion: "0.1.0",
        managedInstall: true,
        statusPath,
        managementCli: "codexnest",
        runCommand,
      });

      await expect(manager.status()).resolves.toMatchObject({
        operation: "idle",
        result: "failed",
        message: expect.stringContaining("interrupted"),
      });
      expect(runCommand).toHaveBeenCalledWith(
        "systemctl",
        ["--user", "is-active", "--quiet", "codexnest-update.service"],
        { timeout: 2_000 },
      );
    } finally {
      await rm(statusDirectory, { recursive: true, force: true });
    }
  });

  it("reads a completed rollback and blocks unmanaged installations", async () => {
    const statusDirectory = await mkdtemp(join(tmpdir(), "codexnest-app-manager-"));
    const statusPath = join(statusDirectory, "update.json");
    try {
      await writeFile(
        statusPath,
        JSON.stringify({
          latestVersion: "0.2.0",
          updateAvailable: true,
          operation: "idle",
          result: "rolled_back",
          message: "Rolled back",
        }),
      );
      const managed = new AppManager({
        currentVersion: "0.1.0",
        managedInstall: true,
        statusPath,
        managementCli: "codexnest",
      });
      await expect(managed.status()).resolves.toMatchObject({
        result: "rolled_back",
        message: "Rolled back",
      });

      const unmanaged = new AppManager({
        currentVersion: "0.1.0",
        managedInstall: false,
        statusPath,
        managementCli: "codexnest",
      });
      await expect(unmanaged.update()).rejects.toEqual(
        expect.objectContaining({ kind: "unsupported" }),
      );
    } finally {
      await rm(statusDirectory, { recursive: true, force: true });
    }
  });
});
