import { homedir } from "node:os";
import { resolve } from "node:path";

export const SERVER_VERSION = "0.1.0";

export interface AppConfig {
  host: string;
  port: number;
  statePath: string;
  codexBin: string;
  codexManagementBin: string;
  codexProxyEnvFile: string;
  codexTransport: "stdio" | "daemon";
  allowedOrigins: Set<string>;
  clientDist: string;
  websocketAuthTimeoutMs: number;
  sttLocalUrl?: string;
  sttOpenAiApiKey?: string;
  sttOpenAiModel: string;
  sttLanguage?: string;
  sttTimeoutMs: number;
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
  const sttTimeoutMs = Number(env("CODEXNEST_STT_TIMEOUT_MS") ?? 600_000);
  if (!Number.isInteger(sttTimeoutMs) || sttTimeoutMs < 1_000) {
    throw new Error("CODEXNEST_STT_TIMEOUT_MS must be an integer of at least 1000");
  }
  const sttLocalUrl = env("CODEXNEST_STT_LOCAL_URL");
  if (sttLocalUrl) validateHttpUrl(sttLocalUrl, "CODEXNEST_STT_LOCAL_URL");

  return {
    host: env("CODEXNEST_HOST") ?? "127.0.0.1",
    port,
    statePath: env("CODEXNEST_STATE_PATH") ?? resolve(stateRoot, "codexnest/state.json"),
    codexBin: env("CODEXNEST_CODEX_BIN") ?? "codex",
    codexManagementBin: env("CODEXNEST_CODEX_MANAGEMENT_BIN") ?? resolve(homedir(), "bin/codex"),
    codexProxyEnvFile:
      env("CODEXNEST_CODEX_PROXY_ENV_FILE") ?? resolve(homedir(), ".config/codex/app-server.env"),
    codexTransport,
    allowedOrigins: new Set([
      "http://localhost",
      ...(env("CODEXNEST_ALLOWED_ORIGINS") ?? "http://127.0.0.1:4310,http://localhost:5173")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ]),
    clientDist: env("CODEXNEST_CLIENT_DIST") ?? resolve(process.cwd(), "apps/client/dist"),
    websocketAuthTimeoutMs: 5_000,
    sttLocalUrl,
    sttOpenAiApiKey: env("CODEXNEST_STT_OPENAI_API_KEY"),
    sttOpenAiModel: env("CODEXNEST_STT_OPENAI_MODEL") ?? "gpt-4o-transcribe",
    sttLanguage: env("CODEXNEST_STT_LANGUAGE"),
    sttTimeoutMs,
    firebaseCredentialPath: env("CODEXNEST_FIREBASE_CREDENTIAL_PATH"),
    firebaseProjectId: env("CODEXNEST_FIREBASE_PROJECT_ID"),
    ...overrides,
  };
}

export function childProcessEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const result = { ...process.env, ...overrides };
  delete result.CODEXNEST_STT_OPENAI_API_KEY;
  return result;
}

function validateHttpUrl(value: string, name: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error(`${name} must be an HTTP(S) URL without credentials`);
  }
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
