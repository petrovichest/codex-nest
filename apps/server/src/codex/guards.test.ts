import { describe, expect, it } from "vitest";

import {
  parseAccountRateLimits,
  parseThreadList,
  parseThreadRead,
  parseThreadResume,
  ProtocolShapeError,
} from "./guards";

const thread = {
  id: "thread-1",
  preview: "Hello",
  cwd: "/srv/project",
  createdAt: 1,
  updatedAt: 2,
  name: null,
  status: { type: "idle" },
  turns: [],
};

describe("app-server response guards", () => {
  it("accepts the fields CodexNest uses and ignores additive protocol fields", () => {
    const response = {
      data: [{ ...thread, futureThreadField: { enabled: true } }],
      nextCursor: null,
      futurePageField: "ignored",
    };

    expect(parseThreadList(response).data[0]?.id).toBe("thread-1");
  });

  it("rejects a response that omits a field used by the projection", () => {
    expect(() =>
      parseThreadRead({
        thread: {
          ...thread,
          cwd: undefined,
        },
      }),
    ).toThrow(ProtocolShapeError);
  });

  it("accepts a resumed thread without depending on unrelated response fields", () => {
    expect(parseThreadResume({ thread, futureResumeField: true }).thread.id).toBe("thread-1");
  });

  it("rejects malformed pagination envelopes", () => {
    expect(() => parseThreadList({ data: [thread], nextCursor: 42 })).toThrow(
      "Invalid app-server response shape for thread/list",
    );
  });

  it("selects the Codex rate-limit bucket and falls back to the compatible bucket", () => {
    const window = { usedPercent: 20, windowDurationMins: 300, resetsAt: null };
    const fallback = {
      limitId: null,
      limitName: null,
      primary: window,
      secondary: null,
      credits: null,
      individualLimit: null,
      planType: null,
      rateLimitReachedType: null,
    };
    const codex = {
      ...fallback,
      limitId: "codex",
      primary: { ...window, usedPercent: 35 },
      secondary: { ...window, usedPercent: 45, windowDurationMins: 10_080 },
    };

    expect(
      parseAccountRateLimits({
        rateLimits: fallback,
        rateLimitsByLimitId: { codex },
        rateLimitResetCredits: null,
      }),
    ).toEqual({
      primary: { usedPercent: 35, windowDurationMins: 300 },
      secondary: { usedPercent: 45, windowDurationMins: 10_080 },
    });
    expect(
      parseAccountRateLimits({
        rateLimits: fallback,
        rateLimitsByLimitId: null,
        rateLimitResetCredits: null,
      }).primary,
    ).toEqual({ usedPercent: 20, windowDurationMins: 300 });
  });

  it("rejects malformed rate-limit windows", () => {
    expect(() =>
      parseAccountRateLimits({
        rateLimits: { primary: { usedPercent: "20", windowDurationMins: 300 }, secondary: null },
      }),
    ).toThrow("Invalid app-server response shape for account/rateLimits/read");
  });
});
