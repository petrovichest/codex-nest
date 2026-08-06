import { describe, expect, it } from "vitest";

import type { ThreadSummary } from "@codexnest/protocol";

import { hasAlwaysVisibleThreadStatus, threadStatusClasses } from "./thread-status";

const thread: Pick<ThreadSummary, "state" | "unread" | "unseen" | "queuedMessageCount"> = {
  state: "idle",
  unread: false,
  unseen: false,
  queuedMessageCount: 0,
};

describe("thread status presentation", () => {
  it("keeps unfinished and unacknowledged sessions visible", () => {
    expect(hasAlwaysVisibleThreadStatus({ ...thread, state: "running" })).toBe(true);
    expect(hasAlwaysVisibleThreadStatus({ ...thread, state: "queued" })).toBe(true);
    expect(hasAlwaysVisibleThreadStatus({ ...thread, queuedMessageCount: 1 })).toBe(true);
    expect(hasAlwaysVisibleThreadStatus({ ...thread, state: "needsAttention" })).toBe(true);
    expect(hasAlwaysVisibleThreadStatus({ ...thread, state: "completed", unread: true })).toBe(
      true,
    );
    expect(hasAlwaysVisibleThreadStatus({ ...thread, state: "failed", unread: true })).toBe(true);
    expect(hasAlwaysVisibleThreadStatus({ ...thread, state: "interrupted", unread: true })).toBe(
      true,
    );
  });

  it("hides acknowledged terminal and neutral sessions", () => {
    for (const state of ["idle", "unavailable", "completed", "failed", "interrupted"] as const) {
      expect(hasAlwaysVisibleThreadStatus({ ...thread, state })).toBe(false);
    }
  });

  it("uses blue queue styling for otherwise gray sessions", () => {
    expect(threadStatusClasses({ ...thread, queuedMessageCount: 1 })).toContain("status-queued");
    expect(
      threadStatusClasses({
        ...thread,
        state: "completed",
        queuedMessageCount: 1,
      }),
    ).toContain("status-queued");
  });

  it("dims an acknowledged failure without hiding a new failure", () => {
    expect(threadStatusClasses({ ...thread, state: "failed", unread: true })).toContain(
      "status-failed",
    );
    expect(threadStatusClasses({ ...thread, state: "failed" })).toContain("status-failed-read");
  });

  it("pulses only unseen completions and sessions needing attention", () => {
    expect(
      threadStatusClasses({ ...thread, state: "completed", unread: true, unseen: true }),
    ).toContain("status-pulsing");
    expect(
      threadStatusClasses({ ...thread, state: "completed", unread: true, unseen: false }),
    ).not.toContain("status-pulsing");
    expect(threadStatusClasses({ ...thread, state: "needsAttention" })).toContain("status-pulsing");

    for (const state of ["running", "queued", "failed", "interrupted"] as const) {
      expect(threadStatusClasses({ ...thread, state, unread: true, unseen: true })).not.toContain(
        "status-pulsing",
      );
    }
  });
});
