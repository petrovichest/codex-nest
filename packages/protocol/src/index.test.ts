import { describe, expect, it } from "vitest";

import type { ActivityItem, ThreadArtifactsResponse } from "./index.js";
import { bearerHeader, isClientFrame, isServerFrame } from "./index.js";

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
