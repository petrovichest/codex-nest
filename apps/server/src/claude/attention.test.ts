import { describe, expect, it, vi } from "vitest";

import type { AttentionRequest } from "@codexnest/protocol";

import { AttentionManager } from "../attention";
import { ClaudeAttention, type ClaudeAttentionCallbacks } from "./attention";

function setup(callbacks: Partial<ClaudeAttentionCallbacks> = {}) {
  const manager = new AttentionManager();
  const cb: ClaudeAttentionCallbacks = {
    onUserInputResponse: vi.fn(),
    onPlanAccepted: vi.fn(),
    onCancel: vi.fn(),
    ...callbacks,
  };
  const attention = new ClaudeAttention("thread-1", "/work", manager, cb);
  return { manager, attention, cb };
}

/** Resolves once the manager has an entry (add() is synchronous, so this is immediate). */
function pendingRequest(manager: AttentionManager): AttentionRequest {
  const list = manager.list();
  if (!list.length) throw new Error("no pending attention");
  return list[0]!;
}

describe("ClaudeAttention tool mapping", () => {
  it("maps Bash to a commandApproval and accept → allow", async () => {
    const { manager, attention } = setup();
    const promise = attention.request("turn-1", "Bash", { command: "date" }, "t-1");
    const request = pendingRequest(manager);
    expect(request).toMatchObject({
      kind: "commandApproval",
      threadId: "thread-1",
      turnId: "turn-1",
      command: "date",
      cwd: "/work",
      canAcceptForSession: true,
    });
    manager.resolve(request.id, { kind: "approval", decision: "accept" });
    await expect(promise).resolves.toEqual({
      behavior: "allow",
      updatedInput: { command: "date" },
    });
  });

  it("maps file tools to a fileChangeApproval with the cwd grant root", async () => {
    const { manager, attention } = setup();
    void attention.request("turn-1", "Write", { file_path: "/work/a.txt" }, "t-1");
    expect(pendingRequest(manager)).toMatchObject({
      kind: "fileChangeApproval",
      grantRoot: "/work",
      canAcceptForSession: true,
    });
  });

  it("maps an unknown tool to a commandApproval summarizing its input", async () => {
    const { manager, attention } = setup();
    void attention.request("turn-1", "CustomTool", { foo: "bar" }, "t-1");
    const request = pendingRequest(manager);
    expect(request.kind).toBe("commandApproval");
    expect(request.kind === "commandApproval" && request.command).toContain("CustomTool");
    expect(request.kind === "commandApproval" && request.command).toContain("bar");
  });

  it("maps AskUserQuestion to userInput and injects answers back into updatedInput", async () => {
    const onUserInputResponse = vi.fn();
    const { manager, attention } = setup({ onUserInputResponse });
    const input = {
      questions: [{ header: "Color", question: "Pick", options: [{ label: "Red" }] }],
    };
    const promise = attention.request("turn-1", "AskUserQuestion", input, "t-1");
    const request = pendingRequest(manager);
    expect(request).toMatchObject({ kind: "userInput" });
    expect(request.kind === "userInput" && request.questions[0]).toMatchObject({
      id: "0",
      header: "Color",
    });

    manager.resolve(request.id, { kind: "userInput", answers: { "0": ["Red"] } });
    const result = await promise;
    expect(result).toEqual({
      behavior: "allow",
      updatedInput: {
        questions: [
          {
            header: "Color",
            question: "Pick",
            options: [{ label: "Red" }],
            answers: { answers: ["Red"] },
          },
        ],
      },
    });
    expect(onUserInputResponse).toHaveBeenCalledWith("turn-1", "t-1", expect.any(Array), {
      "0": ["Red"],
    });
  });

  it("maps ExitPlanMode to a Да/Нет userInput; Да allows and flips the plan", async () => {
    const onPlanAccepted = vi.fn();
    const { manager, attention } = setup({ onPlanAccepted });
    const promise = attention.request("turn-1", "ExitPlanMode", { plan: "# Plan" }, "t-1");
    const request = pendingRequest(manager);
    expect(request.kind === "userInput" && request.questions[0]?.question).toBe(
      "Принять план и продолжить?",
    );
    manager.resolve(request.id, { kind: "userInput", answers: { "exit-plan": ["Да"] } });
    await expect(promise).resolves.toMatchObject({ behavior: "allow" });
    expect(onPlanAccepted).toHaveBeenCalledWith("turn-1");
  });

  it("denies when the plan is rejected", async () => {
    const onPlanAccepted = vi.fn();
    const { manager, attention } = setup({ onPlanAccepted });
    const promise = attention.request("turn-1", "ExitPlanMode", { plan: "# Plan" }, "t-1");
    manager.resolve(pendingRequest(manager).id, {
      kind: "userInput",
      answers: { "exit-plan": ["Нет"] },
    });
    await expect(promise).resolves.toMatchObject({ behavior: "deny" });
    expect(onPlanAccepted).not.toHaveBeenCalled();
  });
});

describe("ClaudeAttention decisions", () => {
  it("declines with a Russian message", async () => {
    const { manager, attention } = setup();
    const promise = attention.request("turn-1", "Bash", { command: "rm -rf /" }, "t-1");
    manager.resolve(pendingRequest(manager).id, { kind: "approval", decision: "decline" });
    await expect(promise).resolves.toEqual({
      behavior: "deny",
      message: "Пользователь отклонил действие",
    });
  });

  it("cancel denies and triggers an interrupt", async () => {
    const onCancel = vi.fn();
    const { manager, attention } = setup({ onCancel });
    const promise = attention.request("turn-1", "Bash", { command: "date" }, "t-1");
    manager.resolve(pendingRequest(manager).id, { kind: "approval", decision: "cancel" });
    await expect(promise).resolves.toMatchObject({ behavior: "deny", interrupt: true });
    expect(onCancel).toHaveBeenCalledWith("turn-1");
  });

  it("acceptForSession auto-allows later matching commands without new attention", async () => {
    const { manager, attention } = setup();
    const first = attention.request("turn-1", "Bash", { command: "mkdir a" }, "t-1");
    manager.resolve(pendingRequest(manager).id, { kind: "approval", decision: "acceptForSession" });
    await first;

    // A later `mkdir` (same command prefix) is auto-allowed silently — no new attention.
    const second = await attention.request("turn-1", "Bash", { command: "mkdir b" }, "t-2");
    expect(second).toEqual({ behavior: "allow", updatedInput: { command: "mkdir b" } });
    expect(manager.list()).toHaveLength(0);

    // A different command prefix still prompts.
    void attention.request("turn-1", "Bash", { command: "rm x" }, "t-3");
    expect(manager.list()).toHaveLength(1);
  });
});

describe("ClaudeAttention dedupe + expiry", () => {
  it("replays a recorded decision for a re-dispatched toolUseId", async () => {
    const { manager, attention } = setup();
    const first = attention.request("turn-1", "Bash", { command: "date" }, "t-1");
    manager.resolve(pendingRequest(manager).id, { kind: "approval", decision: "accept" });
    await first;
    // Re-dispatch of the same toolUseId replays without creating a new attention entry.
    const replay = await attention.request("turn-1", "Bash", { command: "date" }, "t-1");
    expect(replay).toMatchObject({ behavior: "allow" });
    expect(manager.list()).toHaveLength(0);
  });

  it("re-attaches a concurrent re-dispatch to the single pending entry", async () => {
    const { manager, attention } = setup();
    const a = attention.request("turn-1", "Bash", { command: "date" }, "t-1");
    const b = attention.request("turn-1", "Bash", { command: "date" }, "t-1");
    expect(manager.list()).toHaveLength(1); // one entry, both awaiters attached
    manager.resolve(pendingRequest(manager).id, { kind: "approval", decision: "accept" });
    await expect(a).resolves.toMatchObject({ behavior: "allow" });
    await expect(b).resolves.toMatchObject({ behavior: "allow" });
  });

  it("deny-settles a pending request when the manager expires it (no hanging promise)", async () => {
    const { attention } = setup();
    const promise = attention.request("turn-1", "Bash", { command: "sleep 99" }, "t-1");
    // Expiry (interrupt / turn-end) removes the entry WITHOUT settling — we must deny.
    attention.expire();
    const settled = await Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve("HUNG"), 100)),
    ]);
    expect(settled).toMatchObject({ behavior: "deny" });
  });

  it("deny-settles all pending on dispose", async () => {
    const { attention } = setup();
    const promise = attention.request("turn-1", "Bash", { command: "sleep 99" }, "t-1");
    attention.dispose();
    await expect(promise).resolves.toMatchObject({ behavior: "deny" });
  });
});
