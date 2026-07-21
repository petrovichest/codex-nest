import { describe, expect, it } from "vitest";

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
  });

  it("formats bearer credentials without putting them in a URL", () => {
    expect(bearerHeader("abc")).toBe("Bearer abc");
  });
});
