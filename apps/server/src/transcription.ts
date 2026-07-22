import {
  FormData,
  ProxyAgent,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
} from "undici";

import type { TranscriptionConfigResponse, TranscriptionProvider } from "@codexnest/protocol";

import { readProxyUrl } from "./codex-management";

export const MAX_TRANSCRIPTION_BYTES = 24 * 1024 * 1024;
export const MAX_RECORDING_SECONDS = 5 * 60;

const OPENAI_TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";
const AUDIO_TYPES = new Map([
  ["audio/webm", "webm"],
  ["audio/mp4", "mp4"],
]);

type FetchOptions = UndiciRequestInit;
type FetchLike = (input: string | URL, init?: FetchOptions) => Promise<Response>;

export interface TranscriptionServiceOptions {
  localUrl?: string;
  openAiApiKey?: string;
  openAiModel: string;
  language?: string;
  timeoutMs: number;
  proxyEnvFile: string;
  fetch?: FetchLike;
  readProxy?: (path: string) => Promise<string | null>;
}

export class TranscriptionError extends Error {
  constructor(
    public readonly kind: "unavailable" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "TranscriptionError";
  }
}

export class TranscriptionService {
  private readonly request: FetchLike;
  private readonly loadProxy: (path: string) => Promise<string | null>;

  constructor(private readonly options: TranscriptionServiceOptions) {
    this.request = options.fetch ?? defaultFetch;
    this.loadProxy = options.readProxy ?? readProxyUrl;
  }

  configuration(): TranscriptionConfigResponse {
    const providers: TranscriptionProvider[] = [];
    if (this.options.localUrl) providers.push("local");
    if (this.options.openAiApiKey) providers.push("openai");
    return {
      providers,
      maxRecordingSeconds: MAX_RECORDING_SECONDS,
      maxUploadBytes: MAX_TRANSCRIPTION_BYTES,
    };
  }

  async transcribe(
    provider: TranscriptionProvider,
    audio: Buffer,
    contentType: string,
  ): Promise<string> {
    const mediaType = normalizeAudioType(contentType);
    const extension = AUDIO_TYPES.get(mediaType);
    if (!extension) throw new TranscriptionError("failed", "Unsupported audio format");

    if (provider === "local" && !this.options.localUrl) {
      throw new TranscriptionError("unavailable", "Local transcription is not configured");
    }
    if (provider === "openai" && !this.options.openAiApiKey) {
      throw new TranscriptionError("unavailable", "OpenAI transcription is not configured");
    }

    const bytes = new Uint8Array(audio.byteLength);
    bytes.set(audio);
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mediaType }), `recording.${extension}`);
    form.append("response_format", "json");
    if (provider === "openai") {
      form.append("model", this.options.openAiModel);
      if (this.options.language) form.append("language", this.options.language);
    } else {
      form.append("language", this.options.language ?? "auto");
    }

    let dispatcher: ProxyAgent | undefined;
    try {
      if (provider === "openai") {
        const proxyUrl = await this.loadProxy(this.options.proxyEnvFile).catch(() => {
          throw new TranscriptionError("unavailable", "OpenAI proxy configuration is invalid");
        });
        if (proxyUrl) dispatcher = new ProxyAgent(proxyUrl);
      }

      const response = await this.request(
        provider === "openai" ? OPENAI_TRANSCRIPTIONS_URL : this.options.localUrl!,
        {
          method: "POST",
          headers:
            provider === "openai"
              ? { Authorization: `Bearer ${this.options.openAiApiKey!}` }
              : undefined,
          body: form,
          signal: AbortSignal.timeout(this.options.timeoutMs),
          ...(dispatcher ? { dispatcher } : {}),
        },
      );
      if (!response.ok) {
        throw new TranscriptionError(
          "failed",
          `${provider === "openai" ? "OpenAI" : "Local"} transcription failed (${response.status})`,
        );
      }
      const payload = (await response.json().catch(() => null)) as { text?: unknown } | null;
      const text = typeof payload?.text === "string" ? payload.text.trim() : "";
      if (!text) throw new TranscriptionError("failed", "Transcription returned no text");
      return text;
    } catch (error) {
      if (error instanceof TranscriptionError) throw error;
      throw new TranscriptionError("failed", "Transcription request failed");
    } finally {
      await dispatcher?.close().catch(() => undefined);
    }
  }
}

export function normalizeAudioType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

const defaultFetch: FetchLike = (input, init) =>
  undiciFetch(input, init as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
