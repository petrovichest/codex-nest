import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import { CodexBridge } from "./bridge";
import type { JsonlProcess } from "./transport";

const enabled = process.env.RUN_CODEX_INTEGRATION === "1";

describe.skipIf(!enabled)("real Codex CLI smoke", () => {
  it("initializes 0.144.6 and reads one thread/list page without starting a model turn", async () => {
    const bridge = new CodexBridge({
      codexBin: process.env.CODEXNEST_CODEX_BIN ?? "codex",
      spawnProcess: () =>
        spawn(process.env.CODEXNEST_CODEX_BIN ?? "codex", ["app-server", "--listen", "stdio://"], {
          stdio: ["pipe", "pipe", "pipe"],
          env: process.env,
        }) as unknown as JsonlProcess,
    });
    let lastDetail: unknown;
    bridge.on("state", (_state, detail) => {
      lastDetail = detail;
    });
    await bridge.start();
    expect(bridge.state, JSON.stringify(lastDetail)).toBe("ready");
    const page = await bridge.request<{ data: unknown[]; nextCursor: string | null }>(
      "thread/list",
      { limit: 1, sortKey: "updated_at", sortDirection: "desc", archived: false },
      30_000,
    );
    expect(Array.isArray(page.data)).toBe(true);
    bridge.stop();
  }, 45_000);
});
