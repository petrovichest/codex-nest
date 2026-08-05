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
    vi.stubEnv("CODEXNEST_STT_PROVIDER", "");
    vi.stubEnv("CODEXNEST_STT_LOCAL_URL", "");
    vi.stubEnv("CODEXNEST_STT_OPENAI_API_KEY", "");
    vi.stubEnv("CODEXNEST_STT_OPENAI_MODEL", "");
    vi.stubEnv("CODEXNEST_STT_LANGUAGE", "");
    vi.stubEnv("CODEXNEST_STT_REFINE_LOCAL", "");
    vi.stubEnv("CODEXNEST_STT_REFINEMENT_MODEL", "");
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
});
