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

  it("keeps speech-to-text optional and defaults OpenAI to the accurate model", () => {
    vi.stubEnv("CODEXNEST_STT_LOCAL_URL", "");
    vi.stubEnv("CODEXNEST_STT_OPENAI_API_KEY", "");
    vi.stubEnv("CODEXNEST_STT_OPENAI_MODEL", "");
    expect(loadConfig()).toMatchObject({
      sttLocalUrl: undefined,
      sttOpenAiApiKey: undefined,
      sttOpenAiModel: "gpt-4o-transcribe",
      sttTimeoutMs: 600_000,
    });
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
