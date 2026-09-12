import { describe, expect, it } from "vitest";

import {
  parseAccountRateLimits,
  parseSkillsConfigWrite,
  parseSkillsList,
  parseThreadList,
  parseThreadLoadedList,
  parseThreadRead,
  parseThreadResume,
  parseThreadSearch,
  parseThreadOccurrences,
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
    expect(() => parseThreadRead({ thread: { ...thread, canAcceptDirectInput: "false" } })).toThrow(
      ProtocolShapeError,
    );
    expect(
      parseThreadRead({
        thread: { ...thread, canAcceptDirectInput: null, model: "model", reasoningEffort: null },
      }).thread.model,
    ).toBe("model");
  });

  it("rejects malformed pagination envelopes", () => {
    expect(() => parseThreadList({ data: [thread], nextCursor: 42 })).toThrow(
      "Invalid app-server response shape for thread/list",
    );
  });

  it("accepts only thread ids from the loaded-thread listing", () => {
    expect(parseThreadLoadedList({ data: ["parent", "child"], nextCursor: null }).data).toEqual([
      "parent",
      "child",
    ]);
    expect(() => parseThreadLoadedList({ data: [thread], nextCursor: null })).toThrow(
      "Invalid app-server response shape for thread/loaded/list data",
    );
  });

  it("validates skill discovery and config responses", () => {
    const response = {
      data: [
        {
          cwd: "/work",
          skills: [
            {
              name: "review",
              description: "Review changes",
              path: "/skills/review/SKILL.md",
              scope: "repo",
              enabled: true,
              futureField: true,
            },
          ],
          errors: [],
        },
      ],
    };

    expect(parseSkillsList(response).data[0]?.skills[0]?.name).toBe("review");
    expect(parseSkillsConfigWrite({ effectiveEnabled: false })).toEqual({
      effectiveEnabled: false,
    });
    expect(() =>
      parseSkillsList({
        data: [
          {
            cwd: "/work",
            skills: [{ ...response.data[0]!.skills[0], scope: "future" }],
            errors: [],
          },
        ],
      }),
    ).toThrow("Invalid app-server response shape for skills/list");
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
      primary: { ...window, usedPercent: 35, resetsAt: 1_785_258_183 },
      secondary: {
        ...window,
        usedPercent: 45,
        windowDurationMins: 10_080,
        resetsAt: 1_785_344_583,
      },
    };

    expect(
      parseAccountRateLimits({
        rateLimits: fallback,
        rateLimitsByLimitId: { codex },
        rateLimitResetCredits: null,
      }),
    ).toEqual({
      ordinaryUsageAllowed: null,
      spendControlReached: null,
      rateLimitReachedType: null,
      primary: { usedPercent: 35, windowDurationMins: 300, resetsAt: 1_785_258_183_000 },
      secondary: {
        usedPercent: 45,
        windowDurationMins: 10_080,
        resetsAt: 1_785_344_583_000,
      },
    });
    expect(
      parseAccountRateLimits({
        rateLimits: fallback,
        rateLimitsByLimitId: null,
        rateLimitResetCredits: null,
      }).primary,
    ).toEqual({ usedPercent: 20, windowDurationMins: 300, resetsAt: null });
  });

  it("rejects malformed rate-limit windows", () => {
    expect(() =>
      parseAccountRateLimits({
        rateLimits: { primary: { usedPercent: "20", windowDurationMins: 300 }, secondary: null },
      }),
    ).toThrow("Invalid app-server response shape for account/rateLimits/read");
    expect(() =>
      parseAccountRateLimits({
        rateLimits: {
          primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: "tomorrow" },
          secondary: null,
        },
      }),
    ).toThrow("Invalid app-server response shape for account/rateLimits/read");
  });

  it("keeps explicit usage restrictions separate from a reset quota window", () => {
    expect(
      parseAccountRateLimits({
        ordinaryUsageAllowed: false,
        rateLimits: { primary: null, secondary: null, spendControlReached: false },
        rateLimitsByLimitId: {
          codex: {
            primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1 },
            secondary: null,
            spendControlReached: true,
            rateLimitReachedType: "future_reason",
          },
        },
      }),
    ).toMatchObject({
      ordinaryUsageAllowed: false,
      spendControlReached: true,
      rateLimitReachedType: "future_reason",
    });
    expect(
      parseAccountRateLimits({ rateLimits: { primary: null, secondary: null } }),
    ).toMatchObject({
      ordinaryUsageAllowed: null,
      spendControlReached: null,
      rateLimitReachedType: null,
    });
  });

  it("validates native search pages and UTF-16 occurrence offsets", () => {
    expect(
      parseThreadSearch({ data: [{ thread, snippet: "match" }], nextCursor: "next" }).data[0]
        ?.thread.id,
    ).toBe(thread.id);
    const occurrence = {
      turnId: "turn",
      itemId: "item",
      snippet: "😀привет",
      snippetMatchRange: { start: 2, end: 8 },
      turnCursor: "cursor",
    };
    expect(parseThreadOccurrences({ data: [occurrence], nextCursor: null }).data).toEqual([
      occurrence,
    ]);
    expect(() => parseThreadSearch({ data: [thread], nextCursor: null })).toThrow(
      ProtocolShapeError,
    );
    for (const range of [
      { start: -1, end: 3 },
      { start: 3, end: 2 },
      { start: 0, end: 99 },
    ]) {
      expect(() =>
        parseThreadOccurrences({
          data: [{ ...occurrence, snippetMatchRange: range }],
          nextCursor: null,
        }),
      ).toThrow(ProtocolShapeError);
    }
  });
});
