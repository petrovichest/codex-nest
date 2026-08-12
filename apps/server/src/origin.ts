import type { FastifyRequest } from "fastify";

export function isAllowedRequestOrigin(
  request: FastifyRequest,
  allowedOrigins: Set<string>,
): boolean {
  const origin = request.headers.origin;
  if (!origin || allowedOrigins.has(origin)) return true;
  const host = request.headers.host?.trim().toLowerCase();
  if (!host) return false;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password &&
      parsed.host.toLowerCase() === host
    );
  } catch {
    return false;
  }
}

export function isFirefoxExtensionOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === "moz-extension:" &&
      !parsed.username &&
      !parsed.password &&
      /^[a-z\d-]{8,200}$/iu.test(parsed.hostname) &&
      parsed.port === "" &&
      (parsed.pathname === "" || parsed.pathname === "/") &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}
