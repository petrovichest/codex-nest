import { afterEach, describe, expect, it, vi } from "vitest";

import { childProcessEnvironment, loadConfig } from "./config";

afterEach(() => vi.unstubAllEnvs());

describe("loadConfig", () => {
  it("keeps direct stdio as the default transport", () => {
    vi.stubEnv("CODEXNEST_CODEX_TRANSPORT", "");
    expect(loadConfig().codexTransport).toBe("stdio");
  });

  it("accepts the persistent daemon transport", () => {
    vi.stubEnv("CODEXNEST_CODEX_TRANSPORT", "daemon");
    expect(loadConfig().codexTransport).toBe("daemon");
  });

  it("rejects unknown transports", () => {
    vi.stubEnv("CODEXNEST_CODEX_TRANSPORT", "remote");
    expect(() => loadConfig()).toThrow("CODEXNEST_CODEX_TRANSPORT must be stdio or daemon");
  });

  it("always allows the bundled Android client origin", () => {
    vi.stubEnv("CODEXNEST_ALLOWED_ORIGINS", "https://codex.home.arpa");
    expect(loadConfig().allowedOrigins).toEqual(
      new Set(["http://localhost", "https://codex.home.arpa"]),
    );
  });

  it("keeps app updates opt-in for unmanaged development checkouts", () => {
    vi.stubEnv("CODEXNEST_MANAGED_INSTALL", "");
    expect(loadConfig()).toMatchObject({
      managedInstall: false,
      updateStatusPath: expect.stringContaining("codexnest/update.json"),
      managementCli: expect.stringContaining(".local/bin/codexnest"),
    });
  });

  it("keeps speech-to-text optional and defaults OpenAI to the accurate model", () => {
    vi.stubEnv("CODEXNEST_STT_LOCAL_URL", "");
    vi.stubEnv("CODEXNEST_STT_OPENAI_API_KEY", "");
    vi.stubEnv("CODEXNEST_STT_OPENAI_MODEL", "");
    expect(loadConfig()).toMatchObject({
      sttLocalUrl: undefined,
      sttProvider: undefined,
      sttOpenAiApiKey: undefined,
      sttOpenAiModel: "gpt-4o-transcribe",
      sttLanguage: "ru",
      sttRefineLocal: true,
      sttRefinementModel: "gpt-5.6-luna",
      sttTimeoutMs: 600_000,
    });
  });

  it("loads and validates the global transcription mode", () => {
    vi.stubEnv("CODEXNEST_STT_PROVIDER", "openai");
    vi.stubEnv("CODEXNEST_STT_OPENAI_MODEL", "gpt-4o-mini-transcribe");
    vi.stubEnv("CODEXNEST_STT_LANGUAGE", "en-US");
    vi.stubEnv("CODEXNEST_STT_REFINE_LOCAL", "false");
    vi.stubEnv("CODEXNEST_STT_REFINEMENT_MODEL", "gpt-5.6-terra");
    expect(loadConfig()).toMatchObject({
      sttProvider: "openai",
      sttOpenAiModel: "gpt-4o-mini-transcribe",
      sttLanguage: "en-US",
      sttRefineLocal: false,
      sttRefinementModel: "gpt-5.6-terra",
    });

    vi.stubEnv("CODEXNEST_STT_PROVIDER", "device");
    expect(() => loadConfig()).toThrow("CODEXNEST_STT_PROVIDER");
  });

  it("rejects invalid OpenAI transcription models, languages, and booleans", () => {
    vi.stubEnv("CODEXNEST_STT_OPENAI_MODEL", "gpt-other");
    expect(() => loadConfig()).toThrow("CODEXNEST_STT_OPENAI_MODEL");

    vi.stubEnv("CODEXNEST_STT_OPENAI_MODEL", "gpt-4o-transcribe");
    vi.stubEnv("CODEXNEST_STT_LANGUAGE", "not a language");
    expect(() => loadConfig()).toThrow("CODEXNEST_STT_LANGUAGE");

    vi.stubEnv("CODEXNEST_STT_LANGUAGE", "ru");
    vi.stubEnv("CODEXNEST_STT_REFINE_LOCAL", "sometimes");
    expect(() => loadConfig()).toThrow("CODEXNEST_STT_REFINE_LOCAL");
  });

  it("validates local transcription URLs and timeouts", () => {
    vi.stubEnv("CODEXNEST_STT_LOCAL_URL", "ftp://localhost/model");
    expect(() => loadConfig()).toThrow("CODEXNEST_STT_LOCAL_URL");
    vi.stubEnv("CODEXNEST_STT_LOCAL_URL", "http://127.0.0.1:8178/inference");
    vi.stubEnv("CODEXNEST_STT_TIMEOUT_MS", "999");
    expect(() => loadConfig()).toThrow("CODEXNEST_STT_TIMEOUT_MS");
  });

  it("does not pass the transcription API key to child processes", () => {
    vi.stubEnv("CODEXNEST_STT_OPENAI_API_KEY", "secret");
    expect(childProcessEnvironment({ EXTRA_VALUE: "kept" })).toMatchObject({ EXTRA_VALUE: "kept" });
    expect(childProcessEnvironment()).not.toHaveProperty("CODEXNEST_STT_OPENAI_API_KEY");
  });

  it("defaults the Claude backend to auto with the bundled binary name", () => {
    vi.stubEnv("CODEXNEST_CLAUDE_ENABLED", "");
    vi.stubEnv("CODEXNEST_CLAUDE_BIN", "");
    vi.stubEnv("CODEXNEST_CLAUDE_MODELS", "");
    expect(loadConfig()).toMatchObject({
      claudeBin: "claude",
      claudeEnabled: "auto",
      claudeIdleTimeoutMs: 300_000,
      claudeMaxSessions: 3,
      claudeModels: undefined,
    });
  });

  it("accepts explicit Claude enablement modes and rejects unknown ones", () => {
    vi.stubEnv("CODEXNEST_CLAUDE_ENABLED", "true");
    expect(loadConfig().claudeEnabled).toBe("true");
    vi.stubEnv("CODEXNEST_CLAUDE_ENABLED", "false");
    expect(loadConfig().claudeEnabled).toBe("false");
    vi.stubEnv("CODEXNEST_CLAUDE_ENABLED", "maybe");
    expect(() => loadConfig()).toThrow("CODEXNEST_CLAUDE_ENABLED");
  });

  it("validates the Claude idle timeout and session cap", () => {
    vi.stubEnv("CODEXNEST_CLAUDE_IDLE_TIMEOUT_MS", "500");
    expect(() => loadConfig()).toThrow("CODEXNEST_CLAUDE_IDLE_TIMEOUT_MS");
    vi.stubEnv("CODEXNEST_CLAUDE_IDLE_TIMEOUT_MS", "60000");
    vi.stubEnv("CODEXNEST_CLAUDE_MAX_SESSIONS", "0");
    expect(() => loadConfig()).toThrow("CODEXNEST_CLAUDE_MAX_SESSIONS");
    vi.stubEnv("CODEXNEST_CLAUDE_MAX_SESSIONS", "5");
    expect(loadConfig()).toMatchObject({ claudeIdleTimeoutMs: 60_000, claudeMaxSessions: 5 });
  });

  it("carries the raw Claude models override for downstream validation", () => {
    vi.stubEnv("CODEXNEST_CLAUDE_MODELS", '[{"id":"sonnet"}]');
    expect(loadConfig().claudeModels).toBe('[{"id":"sonnet"}]');
  });
});
