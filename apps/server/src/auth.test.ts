import { describe, expect, it } from "vitest";

import { generateToken, hashToken, verifyToken } from "./auth";

describe("token authentication", () => {
  it("generates 32 random bytes and stores only a SHA-256 verifier", () => {
    const token = generateToken();
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    const verifier = hashToken(token);
    expect(verifier).toMatch(/^[a-f\d]{64}$/);
    expect(verifier).not.toContain(token);
    expect(verifyToken(token, verifier)).toBe(true);
    expect(verifyToken(`${token}x`, verifier)).toBe(false);
  });
});
