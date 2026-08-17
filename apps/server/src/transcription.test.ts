import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { FormData as UndiciFormData, Request as UndiciRequest } from "undici";

import {
  appendTranscriptionTimingSample,
  transcriptionTimingEstimate,
  TranscriptionService,
  type TranscriptionError,
} from "./transcription";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("TranscriptionService", () => {
  it("reports global settings without exposing credentials", () => {
    const service = createService({
      provider: "local",
      localUrl: "http://127.0.0.1:8178/inference",
      openAiApiKey: "secret",
    });

    expect(service.configuration()).toEqual({
      providers: ["local", "openai"],
      provider: "local",
      localUrl: "http://127.0.0.1:8178/inference",
      openAiApiKeyConfigured: true,
      openAiModel: "gpt-4o-transcribe",
      language: null,
      refineLocal: true,
      refinementModel: "gpt-5.6-luna",
      maxRecordingSeconds: 300,
      maxUploadBytes: 24 * 1024 * 1024,
      timingEstimate: {
        sampleCount: 0,
        estimatedFixedProcessingMs: null,
        estimatedProcessingMsPerAudioSecond: null,
      },
    });
    expect(JSON.stringify(service.configuration())).not.toContain("secret");
  });

  it("learns fixed and duration-based processing time from recent samples", () => {
    expect(transcriptionTimingEstimate(undefined)).toEqual({
      sampleCount: 0,
      estimatedFixedProcessingMs: null,
      estimatedProcessingMsPerAudioSecond: null,
    });
    expect(
      transcriptionTimingEstimate([
        { audioDurationMs: 1_000, processingMs: 5_000 },
        { audioDurationMs: 5_000, processingMs: 9_000 },
        { audioDurationMs: 10_000, processingMs: 14_000 },
        { audioDurationMs: 15_000, processingMs: 19_000 },
        { audioDurationMs: 20_000, processingMs: 24_000 },
        { audioDurationMs: 30_000, processingMs: 150_000 },
      ]),
    ).toEqual({
      sampleCount: 6,
      estimatedFixedProcessingMs: 4_000,
      estimatedProcessingMsPerAudioSecond: 1_000,
    });
  });

  it("waits for enough varied timing samples before estimating", () => {
    const tooFew = [
      { audioDurationMs: 1_000, processingMs: 5_000 },
      { audioDurationMs: 5_000, processingMs: 9_000 },
      { audioDurationMs: 10_000, processingMs: 14_000 },
      { audioDurationMs: 15_000, processingMs: 19_000 },
    ];
    expect(transcriptionTimingEstimate(tooFew)).toEqual({
      sampleCount: 4,
      estimatedFixedProcessingMs: null,
      estimatedProcessingMsPerAudioSecond: null,
    });
    expect(
      transcriptionTimingEstimate([...tooFew, { audioDurationMs: 5_500, processingMs: 9_500 }]),
    ).toEqual({
      sampleCount: 5,
      estimatedFixedProcessingMs: 4_000,
      estimatedProcessingMsPerAudioSecond: 1_000,
    });
    expect(
      transcriptionTimingEstimate([
        { audioDurationMs: 1_000, processingMs: 5_000 },
        { audioDurationMs: 2_000, processingMs: 6_000 },
        { audioDurationMs: 3_000, processingMs: 7_000 },
        { audioDurationMs: 4_000, processingMs: 8_000 },
        { audioDurationMs: 5_000, processingMs: 9_000 },
      ]),
    ).toEqual({
      sampleCount: 5,
      estimatedFixedProcessingMs: null,
      estimatedProcessingMsPerAudioSecond: null,
    });
  });

  it("keeps only the latest timing samples", () => {
    expect(
      appendTranscriptionTimingSample(
        Array.from({ length: 20 }, (_, index) => ({
          audioDurationMs: index + 1,
          processingMs: index + 101,
        })),
        { audioDurationMs: 21, processingMs: 121 },
      ),
    ).toEqual(
      Array.from({ length: 20 }, (_, index) => ({
        audioDurationMs: index + 2,
        processingMs: index + 102,
      })),
    );
  });

  it("sends OpenAI multipart requests through the configured Codex proxy", async () => {
    const requests: Array<{
      input: string;
      init: { body?: unknown; dispatcher?: unknown; headers?: unknown };
    }> = [];
    const readProxy = vi.fn(async () => "http://user:password@proxy.example:8080");
    const refiner = { refine: vi.fn(async () => "must not run") };
    const service = createService({
      provider: "openai",
      openAiApiKey: "secret",
      language: "ru",
      readProxy,
      refiner,
      fetch: vi.fn(async (input, init) => {
        requests.push({ input: String(input), init: init ?? {} });
        return jsonResponse({ text: "  распознанный текст  " });
      }),
    });

    await expect(service.transcribe(Buffer.from("audio"), "audio/webm")).resolves.toBe(
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
    expect(form.get("prompt")).toContain("Docker");
    expect(form.get("file")).toBeInstanceOf(Blob);
    expect(refiner.refine).not.toHaveBeenCalled();
  });

  it("refines local transcripts and falls back to raw text when refinement fails", async () => {
    const readProxy = vi.fn(async () => "http://proxy.example:8080");
    const refiner = { refine: vi.fn(async () => "Local text.") };
    const fetch = vi.fn(async (_input, init) => {
      const form = init?.body as UndiciFormData;
      expect(form.get("language")).toBe("auto");
      expect(init?.dispatcher).toBeUndefined();
      return jsonResponse({ text: "local text" });
    });
    const onRefinementError = vi.fn();
    const service = createService({
      provider: "local",
      localUrl: "http://127.0.0.1:8178/inference",
      readProxy,
      refiner,
      fetch,
      onRefinementError,
    });

    await expect(service.transcribe(Buffer.from("audio"), "audio/mp4")).resolves.toBe(
      "Local text.",
    );
    expect(fetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8178/inference");
    expect(readProxy).not.toHaveBeenCalled();
    expect(refiner.refine).toHaveBeenCalledWith("local text", {
      cwd: "/work",
      model: "gpt-5.6-luna",
    });

    refiner.refine.mockRejectedValueOnce(new Error("timeout"));
    await expect(service.transcribe(Buffer.from("audio"), "audio/mp4")).resolves.toBe("local text");
    expect(onRefinementError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("atomically persists server-wide settings while preserving unrelated environment entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-stt-settings-test-"));
    directories.push(directory);
    const settingsEnvFile = join(directory, "server.env");
    await writeFile(
      settingsEnvFile,
      "OTHER_SETTING='keep me'\nCODEXNEST_STT_LOCAL_URL='http://old'\nCODEXNEST_STT_TIMEOUT_MS='1234'\n",
      { mode: 0o644 },
    );
    const service = createService({
      provider: "local",
      localUrl: "http://127.0.0.1:8178/inference",
      settingsEnvFile,
    });

    const updated = await service.updateConfiguration({
      provider: "openai",
      localUrl: null,
      openAiApiKey: "new-secret",
      openAiModel: "gpt-4o-mini-transcribe",
      language: "ru",
      refineLocal: false,
      refinementModel: "gpt-5.6-terra",
    });

    expect(updated).toMatchObject({
      providers: ["openai"],
      provider: "openai",
      localUrl: null,
      openAiApiKeyConfigured: true,
      openAiModel: "gpt-4o-mini-transcribe",
      refineLocal: false,
      refinementModel: "gpt-5.6-terra",
    });
    expect(JSON.stringify(updated)).not.toContain("new-secret");
    const persisted = await readFile(settingsEnvFile, "utf8");
    expect(persisted).toContain("OTHER_SETTING='keep me'");
    expect(persisted).toContain("CODEXNEST_STT_TIMEOUT_MS='1234'");
    expect(persisted).not.toContain("http://old");
    expect(persisted).toContain("CODEXNEST_STT_OPENAI_API_KEY='new-secret'");
    expect((await stat(settingsEnvFile)).mode & 0o777).toBe(0o600);

    await service.updateConfiguration({
      provider: "openai",
      localUrl: "http://127.0.0.1:8178/inference",
      openAiModel: "gpt-4o-transcribe",
      language: "ru",
      refineLocal: true,
      refinementModel: "gpt-5.6-luna",
    });
    expect(await readFile(settingsEnvFile, "utf8")).toContain(
      "CODEXNEST_STT_OPENAI_API_KEY='new-secret'",
    );

    await service.updateConfiguration({
      provider: null,
      localUrl: "http://127.0.0.1:8178/inference",
      openAiApiKey: null,
      openAiModel: "gpt-4o-transcribe",
      language: null,
      refineLocal: true,
      refinementModel: "gpt-5.6-luna",
    });
    expect(await readFile(settingsEnvFile, "utf8")).not.toContain("CODEXNEST_STT_OPENAI_API_KEY");
  });

  it("fails closed for missing providers, bad proxy config, invalid settings, and empty responses", async () => {
    const unavailable = createService({ provider: undefined });
    await expect(unavailable.transcribe(Buffer.from("audio"), "audio/webm")).rejects.toMatchObject({
      kind: "unavailable",
    });

    const badProxy = createService({
      provider: "openai",
      openAiApiKey: "secret",
      readProxy: vi.fn(async () => {
        throw new Error("permissions");
      }),
    });
    await expect(badProxy.transcribe(Buffer.from("audio"), "audio/webm")).rejects.toEqual(
      expect.objectContaining<Partial<TranscriptionError>>({ kind: "unavailable" }),
    );

    const empty = createService({
      provider: "local",
      localUrl: "http://127.0.0.1:8178/inference",
      refineLocal: false,
      fetch: vi.fn(async () => jsonResponse({ text: "" })),
    });
    await expect(empty.transcribe(Buffer.from("audio"), "audio/webm")).rejects.toMatchObject({
      kind: "failed",
    });

    await expect(
      empty.updateConfiguration({
        provider: "openai",
        localUrl: null,
        openAiModel: "other-model",
        language: "ru",
        refineLocal: true,
        refinementModel: "gpt-5.6-luna",
      }),
    ).rejects.toMatchObject({ kind: "validation" });
    await expect(
      empty.updateConfiguration({
        provider: "device" as never,
        localUrl: "http://127.0.0.1:8178/inference",
        openAiModel: "gpt-4o-transcribe",
        language: "ru",
        refineLocal: true,
        refinementModel: "gpt-5.6-luna",
      }),
    ).rejects.toMatchObject({ kind: "validation" });
  });

  it("does not retry a local recording when the provider detects no speech", async () => {
    const noSpeech = createService({
      provider: "local",
      localUrl: "http://127.0.0.1:8178/inference",
      refineLocal: false,
      fetch: vi.fn(async () => jsonResponse({ error: "No speech detected" }, 422)),
    });

    await expect(noSpeech.transcribe(Buffer.from("audio"), "audio/webm")).rejects.toMatchObject({
      kind: "validation",
      message: "No speech was detected in the recording",
    });

    const unavailable = createService({
      provider: "local",
      localUrl: "http://127.0.0.1:8178/inference",
      refineLocal: false,
      fetch: vi.fn(async () => jsonResponse({ error: "Unavailable" }, 500)),
    });
    await expect(unavailable.transcribe(Buffer.from("audio"), "audio/webm")).rejects.toMatchObject({
      kind: "failed",
      message: "Local transcription failed (500)",
    });
  });
});

function createService(
  overrides: Partial<ConstructorParameters<typeof TranscriptionService>[0]> = {},
): TranscriptionService {
  return new TranscriptionService({
    provider: "local",
    openAiModel: "gpt-4o-transcribe",
    refineLocal: true,
    refinementModel: "gpt-5.6-luna",
    timeoutMs: 10_000,
    proxyEnvFile: "/tmp/proxy.env",
    settingsEnvFile: "/tmp/server.env",
    cwd: "/work",
    fetch: vi.fn(async () => jsonResponse({ text: "text" })),
    readProxy: vi.fn(async () => null),
    ...overrides,
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
