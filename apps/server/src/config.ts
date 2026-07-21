import { homedir } from "node:os";
import { resolve } from "node:path";

export const SERVER_VERSION = "0.1.0";

export interface AppConfig {
  host: string;
  port: number;
  statePath: string;
  codexBin: string;
  codexTransport: "stdio" | "daemon";
  allowedOrigins: Set<string>;
  clientDist: string;
  websocketAuthTimeoutMs: number;
  firebaseCredentialPath?: string;
  firebaseProjectId?: string;
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const stateRoot = env("XDG_STATE_HOME") ?? resolve(homedir(), ".local/state");
  const port = Number(env("CODEXNEST_PORT") ?? 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("CODEXNEST_PORT must be an integer from 1 to 65535");
  }
  const codexTransport = env("CODEXNEST_CODEX_TRANSPORT") ?? "stdio";
  if (codexTransport !== "stdio" && codexTransport !== "daemon") {
    throw new Error("CODEXNEST_CODEX_TRANSPORT must be stdio or daemon");
  }

  return {
    host: env("CODEXNEST_HOST") ?? "127.0.0.1",
    port,
    statePath: env("CODEXNEST_STATE_PATH") ?? resolve(stateRoot, "codexnest/state.json"),
    codexBin: env("CODEXNEST_CODEX_BIN") ?? "codex",
    codexTransport,
    allowedOrigins: new Set(
      (
        env("CODEXNEST_ALLOWED_ORIGINS") ??
        "http://127.0.0.1:4310,http://localhost,http://localhost:5173"
      )
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
    clientDist: env("CODEXNEST_CLIENT_DIST") ?? resolve(process.cwd(), "apps/client/dist"),
    websocketAuthTimeoutMs: 5_000,
    firebaseCredentialPath: env("CODEXNEST_FIREBASE_CREDENTIAL_PATH"),
    firebaseProjectId: env("CODEXNEST_FIREBASE_PROJECT_ID"),
    ...overrides,
  };
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
