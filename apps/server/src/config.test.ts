import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "./config";

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
});
