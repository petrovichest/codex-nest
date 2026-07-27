import { homedir } from "node:os";
import { basename, resolve } from "node:path";

const releaseDirectory = basename(process.cwd());
export const SERVER_VERSION = /^v\d+\.\d+\.\d+$/.test(releaseDirectory)
  ? releaseDirectory.slice(1)
  : process.env.CODEXNEST_VERSION?.trim() || "0.1.0";

export interface AppConfig {
  host: string;
  port: number;
  statePath: string;
  codexBin: string;
  codexManagementBin: string;
  codexProxyEnvFile: string;
  serverEnvFile: string;
  codexTransport: "stdio" | "daemon";
  allowedOrigins: Set<string>;
  clientDist: string;
  websocketAuthTimeoutMs: number;
  sttLocalUrl?: string;
  sttProvider?: "local" | "openai";
  sttOpenAiApiKey?: string;
  sttOpenAiModel: string;
  sttLanguage?: string;
  sttRefineLocal: boolean;
  sttRefinementModel: string;
  sttTimeoutMs: number;
  firebaseCredentialPath?: string;
  firebaseProjectId?: string;
  managedInstall: boolean;
  updateStatusPath: string;
  restartTokenPath: string;
  managementCli: string;
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
  const configuredSttProvider = env("CODEXNEST_STT_PROVIDER");
  if (
    configuredSttProvider !== undefined &&
    configuredSttProvider !== "local" &&
    configuredSttProvider !== "openai"
  ) {
    throw new Error("CODEXNEST_STT_PROVIDER must be local or openai");
  }
  const sttOpenAiApiKey = env("CODEXNEST_STT_OPENAI_API_KEY");
  const sttOpenAiModel = env("CODEXNEST_STT_OPENAI_MODEL") ?? "gpt-4o-transcribe";
  if (sttOpenAiModel !== "gpt-4o-transcribe" && sttOpenAiModel !== "gpt-4o-mini-transcribe") {
    throw new Error(
      "CODEXNEST_STT_OPENAI_MODEL must be gpt-4o-transcribe or gpt-4o-mini-transcribe",
    );
  }
  const sttLanguage = env("CODEXNEST_STT_LANGUAGE") ?? "ru";
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(sttLanguage)) {
    throw new Error("CODEXNEST_STT_LANGUAGE must be an ISO language code");
  }
  const sttProvider =
    configuredSttProvider ?? (sttLocalUrl ? "local" : sttOpenAiApiKey ? "openai" : undefined);

  return {
    host: env("CODEXNEST_HOST") ?? "127.0.0.1",
    port,
    statePath: env("CODEXNEST_STATE_PATH") ?? resolve(stateRoot, "codexnest/state.json"),
    codexBin: env("CODEXNEST_CODEX_BIN") ?? "codex",
    codexManagementBin: env("CODEXNEST_CODEX_MANAGEMENT_BIN") ?? resolve(homedir(), "bin/codex"),
    codexProxyEnvFile:
      env("CODEXNEST_CODEX_PROXY_ENV_FILE") ?? resolve(homedir(), ".config/codex/app-server.env"),
    serverEnvFile:
      env("CODEXNEST_SERVER_ENV_FILE") ?? resolve(homedir(), ".config/codexnest/server.env"),
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
    sttProvider,
    sttOpenAiApiKey,
    sttOpenAiModel,
    sttLanguage,
    sttRefineLocal: envBoolean("CODEXNEST_STT_REFINE_LOCAL", true),
    sttRefinementModel: env("CODEXNEST_STT_REFINEMENT_MODEL") ?? "gpt-5.6-luna",
    sttTimeoutMs,
    firebaseCredentialPath: env("CODEXNEST_FIREBASE_CREDENTIAL_PATH"),
    firebaseProjectId: env("CODEXNEST_FIREBASE_PROJECT_ID"),
    managedInstall: envBoolean("CODEXNEST_MANAGED_INSTALL", false),
    updateStatusPath:
      env("CODEXNEST_UPDATE_STATUS_PATH") ?? resolve(stateRoot, "codexnest/update.json"),
    restartTokenPath:
      env("CODEXNEST_RESTART_TOKEN_PATH") ?? resolve(stateRoot, "codexnest/restart-token"),
    managementCli: env("CODEXNEST_MANAGEMENT_CLI") ?? resolve(homedir(), ".local/bin/codexnest"),
    ...overrides,
  };
}

function envBoolean(name: string, fallback: boolean): boolean {
  const value = env(name);
  if (value === undefined) return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be true or false`);
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
