import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { CodexBridge } from "./bridge";
import type { JsonlProcess } from "./transport";

class HandshakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly frames: Array<Record<string, unknown>> = [];
  constructor() {
    super();
    this.stdin.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n")) {
        const frame = JSON.parse(line) as Record<string, unknown>;
        this.frames.push(frame);
        if (frame.method === "initialize")
          this.stdout.write(`${JSON.stringify({ id: frame.id, result: { userAgent: "fake" } })}\n`);
      }
    });
  }
  kill(): boolean {
    queueMicrotask(() => this.emit("exit", 0, null));
    return true;
  }
}

describe("CodexBridge", () => {
  it("initializes before sending initialized", async () => {
    const child = new HandshakeChild();
    const bridge = new CodexBridge({
      codexBin: "codex",
      checkVersion: async () => "0.144.6",
      spawnProcess: () => child as unknown as JsonlProcess,
    });
    await bridge.start();
    expect(bridge.state).toBe("ready");
    expect(child.frames.map((frame) => frame.method)).toEqual(["initialize", "initialized"]);
    const initialize = child.frames[0]?.params as { capabilities: Record<string, boolean> };
    expect(initialize.capabilities).toMatchObject({
      experimentalApi: true,
      requestAttestation: false,
    });
    bridge.stop();
  });

  it("does not launch turns with an incompatible CLI", async () => {
    const spawnProcess = vi.fn();
    const bridge = new CodexBridge({
      codexBin: "codex",
      checkVersion: async () => "0.145.0",
      spawnProcess,
    });
    await bridge.start();
    expect(bridge.state).toBe("incompatible");
    expect(spawnProcess).not.toHaveBeenCalled();
    await expect(bridge.request("thread/list", {})).rejects.toMatchObject({
      bridgeState: "incompatible",
    });
  });
});
