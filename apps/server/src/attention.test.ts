import { describe, expect, it, vi } from "vitest";

import type { AttentionRequest, AttentionResponse } from "@codexnest/protocol";

import type { ServerRequest } from "./codex/generated/index";
import type { JsonlTransport } from "./codex/transport";
import { AttentionManager, AttentionValidationError } from "./attention";

function userInputRequest(id: string, threadId: string): AttentionRequest {
  return {
    id,
    kind: "userInput",
    threadId,
    turnId: "turn",
    itemId: "item",
    createdAt: 1,
    autoResolutionMs: null,
    questions: [],
  };
}

function codexApproval(manager: AttentionManager, id: number, threadId: string): AttentionRequest {
  return manager.receive(
    {
      method: "item/commandExecution/requestApproval",
      id,
      params: {
        threadId,
        turnId: "turn",
        itemId: "item",
        startedAtMs: 1,
        environmentId: null,
        command: "ls",
        cwd: "/work",
        availableDecisions: ["accept", "decline"],
      },
    } as ServerRequest,
    fakeTransport(),
  );
}

function fakeTransport() {
  return {
    respond: vi.fn(),
    respondError: vi.fn(),
  } as unknown as JsonlTransport;
}

describe("AttentionManager", () => {
  it("maps canonical approval and lets the first client win", () => {
    const manager = new AttentionManager();
    const transport = fakeTransport();
    const request = manager.receive(
      {
        method: "item/commandExecution/requestApproval",
        id: 42,
        params: {
          threadId: "thread",
          turnId: "turn",
          itemId: "item",
          startedAtMs: 1,
          environmentId: null,
          command: "git status",
          cwd: "/work",
          availableDecisions: ["accept", "acceptForSession", "decline"],
        },
      } as ServerRequest,
      transport,
    );
    expect(request).toMatchObject({
      kind: "commandApproval",
      command: "git status",
      canAcceptForSession: true,
    });
    expect(manager.resolve(request.id, { kind: "approval", decision: "accept" })).toMatchObject({
      id: request.id,
    });
    expect(transport.respond).toHaveBeenCalledWith(42, { decision: "accept" });
    expect(manager.resolve(request.id, { kind: "approval", decision: "decline" })).toBeNull();
  });

  it("maps experimental user input without logging secret answers", () => {
    const manager = new AttentionManager();
    const transport = fakeTransport();
    const request = manager.receive(
      {
        method: "item/tool/requestUserInput",
        id: 7,
        params: {
          threadId: "thread",
          turnId: "turn",
          itemId: "item",
          autoResolutionMs: 60_000,
          questions: [
            {
              id: "password",
              header: "Secret",
              question: "Value?",
              isOther: false,
              isSecret: true,
              options: null,
            },
          ],
        },
      } as ServerRequest,
      transport,
    );
    expect(request).toMatchObject({ kind: "userInput", autoResolutionMs: 60_000 });
    manager.resolve(request.id, { kind: "userInput", answers: { password: ["hidden"] } });
    expect(transport.respond).toHaveBeenCalledWith(7, {
      answers: { password: { answers: ["hidden"] } },
    });
  });

  it("applies a proposed network amendment only after its explicit choice", () => {
    const manager = new AttentionManager();
    const transport = fakeTransport();
    const request = manager.receive(
      {
        method: "item/commandExecution/requestApproval",
        id: 43,
        params: {
          threadId: "thread",
          turnId: "turn",
          itemId: "item",
          startedAtMs: 1,
          environmentId: null,
          command: "curl example.com",
          networkApprovalContext: { host: "example.com", protocol: "https" },
          proposedNetworkPolicyAmendments: [{ host: "example.com", action: "allow" }],
        },
      } as ServerRequest,
      transport,
    );
    expect(request).toMatchObject({
      kind: "commandApproval",
      networkHost: "example.com",
      proposedPolicyChanges: [{ id: "network-0", type: "network" }],
    });
    manager.resolve(request.id, { kind: "approvalAmendment", amendmentId: "network-0" });
    expect(transport.respond).toHaveBeenCalledWith(43, {
      decision: {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: { host: "example.com", action: "allow" },
        },
      },
    });
  });

  it("rejects permission escalation beyond the requested paths", () => {
    const manager = new AttentionManager();
    const transport = fakeTransport();
    const request = manager.receive(
      {
        method: "item/permissions/requestApproval",
        id: 9,
        params: {
          threadId: "thread",
          turnId: "turn",
          itemId: "item",
          environmentId: null,
          startedAtMs: 1,
          cwd: "/work",
          reason: null,
          permissions: { network: null, fileSystem: { read: ["/work"], write: null } },
        },
      } as ServerRequest,
      transport,
    );
    expect(() =>
      manager.resolve(request.id, {
        kind: "permission",
        permissions: { fileSystem: { read: ["/etc"] } },
        scope: "turn",
      }),
    ).toThrow(AttentionValidationError);
  });

  it("maps legacy approval decisions without changing policy", () => {
    const manager = new AttentionManager();
    const transport = fakeTransport();
    const request = manager.receive(
      {
        method: "execCommandApproval",
        id: 10,
        params: {
          conversationId: "thread",
          callId: "call",
          approvalId: null,
          command: ["git", "status"],
          cwd: "/work",
          reason: null,
          parsedCmd: [],
        },
      } as ServerRequest,
      transport,
    );
    manager.resolve(request.id, { kind: "approval", decision: "acceptForSession" });
    expect(transport.respond).toHaveBeenCalledWith(10, { decision: "approved_for_session" });
  });

  it("normalizes required MCP form and multi-select fields", () => {
    const manager = new AttentionManager();
    const request = manager.receive(
      {
        method: "mcpServer/elicitation/request",
        id: 11,
        params: {
          threadId: "thread",
          turnId: "turn",
          serverName: "demo",
          mode: "form",
          _meta: null,
          message: "Настройки",
          requestedSchema: {
            type: "object",
            properties: {
              name: { type: "string", minLength: 2 },
              tags: { type: "array", items: { type: "string", enum: ["a", "b"] }, minItems: 1 },
            },
            required: ["name"],
          },
        },
      } as ServerRequest,
      fakeTransport(),
    );
    expect(request).toMatchObject({
      kind: "elicitation",
      schema: {
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 2 },
          tags: { type: "array", items: { enum: ["a", "b"] }, minItems: 1 },
        },
      },
    });
  });

  it("responds method-not-supported and exposes only a safe card", () => {
    const manager = new AttentionManager();
    const transport = fakeTransport();
    const request = manager.receive(
      { method: "item/tool/call", id: 12, params: { threadId: "thread" } } as ServerRequest,
      transport,
    );
    expect(request).toMatchObject({ kind: "unsupported", method: "item/tool/call" });
    expect(transport.respondError).toHaveBeenCalledWith(
      12,
      -32601,
      expect.stringContaining("not supported"),
    );
  });

  it("settles a callback-registered request and validates its response kind", () => {
    const manager = new AttentionManager();
    const request = userInputRequest("cb-1", "thread");
    const upserts: AttentionRequest[] = [];
    const removed: string[] = [];
    manager.on("upserted", (value: AttentionRequest) => upserts.push(value));
    manager.on("removed", (id: string) => removed.push(id));
    const settled: AttentionResponse[] = [];
    manager.add(request, (response) => settled.push(response), "claude");

    expect(upserts).toEqual([request]);
    expect(manager.list()).toEqual([request]);

    // Wrong response kind is rejected before the entry is settled or removed.
    expect(() => manager.resolve("cb-1", { kind: "approval", decision: "accept" })).toThrow(
      AttentionValidationError,
    );
    expect(settled).toEqual([]);
    expect(removed).toEqual([]);
    expect(manager.list()).toEqual([request]);

    const answer: AttentionResponse = { kind: "userInput", answers: { q: ["a"] } };
    expect(manager.resolve("cb-1", answer)).toBe(request);
    expect(settled).toEqual([answer]);
    expect(removed).toEqual(["cb-1"]);
    expect(manager.list()).toEqual([]);
  });

  it("enforces the permission subset rule on a callback-registered request", () => {
    const manager = new AttentionManager();
    let settled = false;
    const request: AttentionRequest = {
      id: "cb-perm",
      kind: "permissionApproval",
      threadId: "thread",
      turnId: "turn",
      itemId: "item",
      createdAt: 1,
      cwd: "/work",
      reason: null,
      permissions: { fileSystem: { read: ["/work"] } },
    };
    manager.add(request, () => (settled = true), "claude");
    expect(() =>
      manager.resolve("cb-perm", {
        kind: "permission",
        permissions: { fileSystem: { read: ["/etc"] } },
        scope: "turn",
      }),
    ).toThrow(AttentionValidationError);
    expect(settled).toBe(false);
    expect(manager.list()).toEqual([request]);
  });

  it("rejects a policy amendment on a callback-registered approval, keeping it resolvable", () => {
    const manager = new AttentionManager();
    let settled = false;
    const request: AttentionRequest = {
      id: "cb-cmd",
      kind: "commandApproval",
      threadId: "thread",
      turnId: "turn",
      itemId: "item",
      createdAt: 1,
      command: "ls",
      cwd: "/work",
      reason: null,
      networkHost: null,
      canAcceptForSession: true,
      proposedPolicyChanges: [],
    };
    manager.add(request, () => (settled = true), "claude");

    // Callback-settled (Claude) approvals have no amendment path — the mapper would map an
    // amendment to a silent deny, so it is rejected and the entry stays resolvable.
    expect(() =>
      manager.resolve("cb-cmd", { kind: "approvalAmendment", amendmentId: "exec" }),
    ).toThrow(AttentionValidationError);
    expect(settled).toBe(false);
    expect(manager.list()).toEqual([request]);

    // A normal decision still settles it.
    expect(manager.resolve("cb-cmd", { kind: "approval", decision: "accept" })).toBe(request);
    expect(settled).toBe(true);
    expect(manager.list()).toEqual([]);
  });

  it("expires only the named agent's entries and leaves callback entries settle-free", () => {
    const manager = new AttentionManager();
    const codex = codexApproval(manager, 1, "thread");
    let claudeSettled = false;
    const claude = userInputRequest("cb", "thread-2");
    manager.add(claude, () => (claudeSettled = true), "claude");
    const removed: string[] = [];
    manager.on("removed", (id: string) => removed.push(id));

    manager.expireAgent("codex");

    // Only the codex entry expires; the callback entry survives and is NOT settled.
    expect(removed).toEqual([codex.id]);
    expect(claudeSettled).toBe(false);
    expect(manager.list()).toEqual([claude]);
  });

  it("expires attention entries by thread across agents", () => {
    const manager = new AttentionManager();
    const codex = codexApproval(manager, 2, "shared");
    manager.add(userInputRequest("cb-shared", "shared"), () => undefined, "claude");
    manager.add(userInputRequest("cb-other", "other"), () => undefined, "claude");
    const removed: string[] = [];
    manager.on("removed", (id: string) => removed.push(id));

    manager.expireByThread("shared");

    expect(removed.sort()).toEqual([codex.id, "cb-shared"].sort());
    expect(manager.list().map((entry) => entry.id)).toEqual(["cb-other"]);
  });
});
