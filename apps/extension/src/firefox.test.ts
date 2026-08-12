import { describe, expect, it } from "vitest";

import { FirefoxController } from "./firefox";

describe("Firefox automation adapter", () => {
  it("uses the agreed request/result/chunk frames with thread-scoped operations", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const controller = new FirefoxController(
      (frame) => sent.push(frame),
      async () => undefined,
    );
    controller.setConnected();

    const attaching = controller.ensureAttached(3, "thread-1");
    await Promise.resolve();
    expect(sent[0]).toMatchObject({
      type: "automation.request",
      threadId: "thread-1",
      tabId: 3,
      operation: "attach",
      arguments: { marker: expect.any(String) },
    });
    controller.acceptFrame({
      type: "automation.result",
      requestId: sent[0]!.requestId,
      result: { attached: true },
    });
    await attaching;

    const evaluation = controller.command(3, "Runtime.evaluate", { expression: "6 * 7" });
    await Promise.resolve();
    expect(sent[1]).toMatchObject({
      type: "automation.request",
      threadId: "thread-1",
      tabId: 3,
      operation: "evaluate",
      arguments: { method: "Runtime.evaluate", parameters: { expression: "6 * 7" } },
    });
    const requestId = String(sent[1]!.requestId);
    controller.acceptFrame({
      type: "automation.result.chunk",
      requestId,
      chunkIndex: 1,
      chunkCount: 2,
      data: "42}",
    });
    controller.acceptFrame({
      type: "automation.result.chunk",
      requestId,
      chunkIndex: 0,
      chunkCount: 2,
      data: '{"value":',
    });
    await expect(evaluation).resolves.toEqual({ value: 42 });
  });

  it("rejects automation errors without leaking a pending request", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const controller = new FirefoxController(
      (frame) => sent.push(frame),
      async () => undefined,
    );
    controller.setConnected();
    const attaching = controller.ensureAttached(4, "thread-2");
    await Promise.resolve();
    controller.acceptFrame({
      type: "automation.error",
      requestId: sent[0]!.requestId,
      error: { code: "unavailable", message: "BiDi is unavailable" },
    });
    await expect(attaching).rejects.toThrow("BiDi is unavailable");
  });
});
