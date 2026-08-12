import { describe, expect, it } from "vitest";

import type { ActivityItem, ThreadArtifactsResponse } from "./index.js";
import {
  BROWSER_EXTENSION_PROTOCOL,
  BROWSER_EXTENSION_PROTOCOL_VERSION,
  BROWSER_TOOL_RESULT_CHUNK_BYTES,
  BROWSER_TOOL_NAMES,
  bearerHeader,
  isBrowserExtensionClientFrame,
  isBrowserExtensionServerFrame,
  isClientFrame,
  isServerFrame,
} from "./index.js";

describe("protocol guards", () => {
  it("accepts authentication and ping client frames", () => {
    expect(isClientFrame({ type: "authenticate", token: "secret" })).toBe(true);
    expect(isClientFrame({ type: "ping" })).toBe(true);
  });

  it("rejects malformed client frames", () => {
    expect(isClientFrame({ type: "authenticate", token: "" })).toBe(false);
    expect(isClientFrame({ type: "other" })).toBe(false);
  });

  it("recognizes server frames", () => {
    expect(isServerFrame({ type: "pong" })).toBe(true);
    expect(isServerFrame({ type: "event", sequence: 1, event: { type: "resync.required" } })).toBe(
      true,
    );
    expect(
      isServerFrame({
        type: "event",
        sequence: 2,
        event: { type: "projects.reordered", projects: [] },
      }),
    ).toBe(true);
    expect(isServerFrame({ type: "event", sequence: 3, event: { type: "skills.changed" } })).toBe(
      true,
    );
  });

  it("formats bearer credentials without putting them in a URL", () => {
    expect(bearerHeader("abc")).toBe("Bearer abc");
  });

  it("guards the versioned browser-extension handshake and lifecycle requests", () => {
    expect(
      isBrowserExtensionClientFrame({
        type: "client.hello",
        protocol: BROWSER_EXTENSION_PROTOCOL,
        version: BROWSER_EXTENSION_PROTOCOL_VERSION,
        token: "owner-token",
        instanceId: "extension-instance-1",
        extensionVersion: "0.1.6",
        browser: { name: "chrome", version: "128" },
        capabilities: {
          tools: BROWSER_TOOL_NAMES,
          maxProjectFileBytes: 100,
          screenshots: ["image/jpeg"],
        },
        bindings: [],
      }),
    ).toBe(true);
    expect(
      isBrowserExtensionClientFrame({
        type: "session.request",
        requestId: "request-1",
        target: { kind: "new", projectId: "project-1" },
        tab: { id: 1, windowId: 1, groupId: -1, active: true, title: "Tab", url: "https://x" },
      }),
    ).toBe(true);
    expect(
      isBrowserExtensionClientFrame({
        type: "session.request",
        requestId: "request-2",
        target: { kind: "existing", threadId: "thread-1" },
        tab: { id: 1, windowId: 1, groupId: -1, active: true, title: "Tab", url: "https://x" },
      }),
    ).toBe(true);
    expect(
      isBrowserExtensionClientFrame({
        type: "client.hello",
        protocol: BROWSER_EXTENSION_PROTOCOL,
        version: 1,
        token: "owner-token",
        instanceId: "spaces are rejected",
        extensionVersion: "0.1.6",
        browser: { name: "chrome", version: "128" },
        capabilities: { tools: [], maxProjectFileBytes: 100, screenshots: [] },
        bindings: [],
      }),
    ).toBe(false);
  });

  it("guards browser binding updates and tool calls", () => {
    expect(BROWSER_TOOL_NAMES).toContain("tabs_context");
    expect(BROWSER_TOOL_NAMES).toContain("upload_file");
    expect(
      isBrowserExtensionServerFrame({
        type: "server.hello",
        protocol: BROWSER_EXTENSION_PROTOCOL,
        version: BROWSER_EXTENSION_PROTOCOL_VERSION,
        locale: "en",
        projects: [],
        threads: [],
      }),
    ).toBe(true);
    expect(
      isBrowserExtensionServerFrame({
        type: "tool.call",
        requestId: "call-1",
        threadId: "thread-1",
        tool: "navigate",
        arguments: { url: "https://example.com" },
      }),
    ).toBe(true);
    expect(
      isBrowserExtensionServerFrame({
        type: "tool.call",
        requestId: "call-1",
        threadId: "thread-1",
        tool: "steal_credentials",
        arguments: {},
      }),
    ).toBe(false);
    expect(
      isBrowserExtensionClientFrame({
        type: "tool.result.chunk",
        requestId: "call-1",
        chunkIndex: 0,
        chunkCount: 2,
        data: "partial",
      }),
    ).toBe(true);
    expect(
      isBrowserExtensionClientFrame({
        type: "tool.result.chunk",
        requestId: "call-1",
        chunkIndex: 0,
        chunkCount: 2,
        data: "x".repeat(BROWSER_TOOL_RESULT_CHUNK_BYTES + 1),
      }),
    ).toBe(false);
  });

  it("keeps v1 orchestration notices valid while carrying optional v2 results", () => {
    const v1 = {
      type: "orchestrationNotice",
      id: "v1",
      status: "completed",
      agents: [
        {
          threadId: "child-v1",
          title: "Legacy child",
          nickname: null,
          outcome: "completed",
        },
      ],
      timestamp: 1,
      afterItemId: null,
    } satisfies ActivityItem;
    const v2 = {
      type: "orchestrationNotice",
      id: "v2",
      status: "completed",
      agents: [
        {
          threadId: "child-v2",
          taskId: "task-v2",
          title: "Rich child",
          nickname: "reviewer",
          outcome: "completed",
          result: {
            outcome: "partial",
            summary: "Implemented the focused change.",
            checks: [{ name: "client tests", outcome: "passed", details: "12 passed" }],
          },
          budgetReason: "tokenBudget",
          changedPaths: ["apps/client/src/components/ThreadPage.tsx"],
          changedPathCount: 24,
          workspaceIntegrationStatus: "integrated",
        },
      ],
      timestamp: 2,
      afterItemId: "continuation",
    } satisfies ActivityItem;

    expect(v1.agents[0]).not.toHaveProperty("result");
    expect(v2.agents[0]!.result).toMatchObject({ outcome: "partial" });
  });

  it("exposes explicit and unavailable artifact capability responses", () => {
    const explicit = {
      capability: "explicit",
      artifacts: [
        {
          id: "artifact-id",
          label: "Final report",
          path: "/work/deliverables/report.txt",
          relativePath: "deliverables/report.txt",
          fileName: "report.txt",
          turnId: "turn-1",
          createdAt: 1,
        },
      ],
    } satisfies ThreadArtifactsResponse;
    const unavailable = {
      capability: "unavailable",
      artifacts: [],
    } satisfies ThreadArtifactsResponse;
    expect(explicit.artifacts[0]?.label).toBe("Final report");
    expect(unavailable.artifacts).toEqual([]);
  });
});
