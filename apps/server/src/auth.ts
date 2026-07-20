import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { FastifyRequest } from "fastify";

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function verifyToken(token: string, expectedSha256?: string): boolean {
  if (!expectedSha256 || !/^[a-f\d]{64}$/i.test(expectedSha256)) return false;
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedSha256, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+([^\s]+)$/i.exec(header);
  return match?.[1];
}
