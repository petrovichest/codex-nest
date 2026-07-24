import { describe, expect, it, vi } from "vitest";

import { ClaudeManager } from "./manager";
import type { ClaudeProbeResult } from "./backend";

describe("ClaudeManager", () => {
  it("reads the backend's current probe outcome without re-probing", () => {
    let current: ClaudeProbeResult = { version: "2.1.218", unavailableReason: null };
    const probe = vi.fn(async () => current);
    const manager = new ClaudeManager({
      path: "/usr/bin/claude",
      currentStatus: () => current,
      probe,
    });
    expect(manager.status()).toEqual({
      supported: true,
      unavailableReason: null,
      cliVersion: "2.1.218",
      path: "/usr/bin/claude",
    });
    expect(probe).not.toHaveBeenCalled();

    current = { version: null, unavailableReason: "gone" };
    expect(manager.status()).toMatchObject({ cliVersion: null, unavailableReason: "gone" });
  });

  it("re-probes on check and returns the refreshed status", async () => {
    const probe = vi.fn(async () => ({ version: "9.9.9", unavailableReason: null }));
    const manager = new ClaudeManager({
      path: "claude",
      currentStatus: () => ({ version: null, unavailableReason: "stale" }),
      probe,
    });
    await expect(manager.check()).resolves.toMatchObject({ cliVersion: "9.9.9", supported: true });
    expect(probe).toHaveBeenCalledOnce();
  });
});
