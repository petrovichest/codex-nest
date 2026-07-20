import { describe, expect, it, vi } from "vitest";

import type { ServerRequest } from "./codex/generated/index";
import type { JsonlTransport } from "./codex/transport";
import { AttentionManager, AttentionValidationError } from "./attention";

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
    expect(manager.resolve(request.id, { kind: "approval", decision: "accept" })).toBe(true);
    expect(transport.respond).toHaveBeenCalledWith(42, { decision: "accept" });
    expect(manager.resolve(request.id, { kind: "approval", decision: "decline" })).toBe(false);
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
});
