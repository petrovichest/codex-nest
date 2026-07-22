import { describe, expect, it, vi } from "vitest";
import { FormData as UndiciFormData, Request as UndiciRequest } from "undici";

import { TranscriptionService, type TranscriptionError } from "./transcription";

describe("TranscriptionService", () => {
  it("reports only configured providers without exposing their credentials", () => {
    const service = createService({
      localUrl: "http://127.0.0.1:8178/inference",
      openAiApiKey: "secret",
    });

    expect(service.configuration()).toEqual({
      providers: ["local", "openai"],
      maxRecordingSeconds: 300,
      maxUploadBytes: 24 * 1024 * 1024,
    });
    expect(JSON.stringify(service.configuration())).not.toContain("secret");
  });

  it("sends OpenAI multipart requests through the configured Codex proxy", async () => {
    const requests: Array<{
      input: string;
      init: { body?: unknown; dispatcher?: unknown; headers?: unknown };
    }> = [];
    const readProxy = vi.fn(async () => "http://user:password@proxy.example:8080");
    const service = createService({
      openAiApiKey: "secret",
      language: "ru",
      readProxy,
      fetch: vi.fn(async (input, init) => {
        requests.push({ input: String(input), init: init ?? {} });
        return jsonResponse({ text: "  распознанный текст  " });
      }),
    });

    await expect(service.transcribe("openai", Buffer.from("audio"), "audio/webm")).resolves.toBe(
      "распознанный текст",
    );
    expect(readProxy).toHaveBeenCalledWith("/tmp/proxy.env");
    expect(requests[0]?.input).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(requests[0]?.init.headers).toEqual({ Authorization: "Bearer secret" });
    expect(requests[0]?.init.dispatcher).toBeDefined();
    const form = requests[0]?.init.body as UndiciFormData;
    expect(form).toBeInstanceOf(UndiciFormData);
    expect(
      new UndiciRequest("https://example.test", { method: "POST", body: form }).headers.get(
        "content-type",
      ),
    ).toMatch(/^multipart\/form-data; boundary=/);
    expect(form.get("model")).toBe("gpt-4o-transcribe");
    expect(form.get("response_format")).toBe("json");
    expect(form.get("language")).toBe("ru");
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  it("calls the local server directly and defaults language detection to auto", async () => {
    const readProxy = vi.fn(async () => "http://proxy.example:8080");
    const fetch = vi.fn(async (_input, init) => {
      const form = init?.body as UndiciFormData;
      expect(form.get("language")).toBe("auto");
      expect(init?.dispatcher).toBeUndefined();
      return jsonResponse({ text: "local text" });
    });
    const service = createService({
      localUrl: "http://127.0.0.1:8178/inference",
      readProxy,
      fetch,
    });

    await expect(service.transcribe("local", Buffer.from("audio"), "audio/mp4")).resolves.toBe(
      "local text",
    );
    expect(fetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8178/inference");
    expect(readProxy).not.toHaveBeenCalled();
  });

  it("fails closed for missing providers, bad proxy config, and invalid responses", async () => {
    const unavailable = createService();
    await expect(
      unavailable.transcribe("openai", Buffer.from("audio"), "audio/webm"),
    ).rejects.toMatchObject({ kind: "unavailable" });

    const badProxy = createService({
      openAiApiKey: "secret",
      readProxy: vi.fn(async () => {
        throw new Error("permissions");
      }),
    });
    await expect(badProxy.transcribe("openai", Buffer.from("audio"), "audio/webm")).rejects.toEqual(
      expect.objectContaining<Partial<TranscriptionError>>({ kind: "unavailable" }),
    );

    const empty = createService({
      localUrl: "http://127.0.0.1:8178/inference",
      fetch: vi.fn(async () => jsonResponse({ text: "" })),
    });
    await expect(
      empty.transcribe("local", Buffer.from("audio"), "audio/webm"),
    ).rejects.toMatchObject({ kind: "failed" });
  });
});

function createService(
  overrides: Partial<ConstructorParameters<typeof TranscriptionService>[0]> = {},
): TranscriptionService {
  return new TranscriptionService({
    openAiModel: "gpt-4o-transcribe",
    timeoutMs: 10_000,
    proxyEnvFile: "/tmp/proxy.env",
    fetch: vi.fn(async () => jsonResponse({ text: "text" })),
    readProxy: vi.fn(async () => null),
    ...overrides,
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
