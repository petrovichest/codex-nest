import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  FormData,
  ProxyAgent,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
} from "undici";

import type {
  TranscriptionConfigResponse,
  TranscriptionProvider,
  UpdateTranscriptionSettingsRequest,
} from "@codexnest/protocol";

import { readProxyUrl } from "./codex-management";
import type { TranscriptRefiner } from "./transcript-refiner";

export const MAX_TRANSCRIPTION_BYTES = 24 * 1024 * 1024;
export const MAX_RECORDING_SECONDS = 5 * 60;

const OPENAI_TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_MODELS = new Set(["gpt-4o-transcribe", "gpt-4o-mini-transcribe"]);
const MANAGED_ENVIRONMENT_VARIABLES = new Set([
  "CODEXNEST_STT_PROVIDER",
  "CODEXNEST_STT_LOCAL_URL",
  "CODEXNEST_STT_OPENAI_API_KEY",
  "CODEXNEST_STT_OPENAI_MODEL",
  "CODEXNEST_STT_LANGUAGE",
  "CODEXNEST_STT_REFINE_LOCAL",
  "CODEXNEST_STT_REFINEMENT_MODEL",
]);
const OPENAI_TRANSCRIPTION_PROMPT =
  "Техническая диктовка на русском языке с англоязычными терминами. Используй естественную пунктуацию и регистр. Корректно пиши Codex, Docker, Git, GitHub, GitLab, git push, git pull, SSH, API, TypeScript, JavaScript, Python, npm, pnpm, PM2 и systemd.";
const AUDIO_TYPES = new Map([
  ["audio/webm", "webm"],
  ["audio/mp4", "mp4"],
]);

type FetchOptions = UndiciRequestInit;
type FetchLike = (input: string | URL, init?: FetchOptions) => Promise<Response>;

interface TranscriptionSettings {
  provider?: TranscriptionProvider;
  localUrl?: string;
  openAiApiKey?: string;
  openAiModel: string;
  language?: string;
  refineLocal: boolean;
  refinementModel: string;
}

export interface TranscriptionServiceOptions extends TranscriptionSettings {
  timeoutMs: number;
  proxyEnvFile: string;
  settingsEnvFile: string;
  cwd: string;
  refiner?: Pick<TranscriptRefiner, "refine">;
  fetch?: FetchLike;
  readProxy?: (path: string) => Promise<string | null>;
  onRefinementError?: (error: unknown) => void;
}

export class TranscriptionError extends Error {
  constructor(
    public readonly kind: "unavailable" | "failed" | "validation",
    message: string,
  ) {
    super(message);
    this.name = "TranscriptionError";
  }
}

export class TranscriptionService {
  private readonly request: FetchLike;
  private readonly loadProxy: (path: string) => Promise<string | null>;
  private settings: TranscriptionSettings;

  constructor(private readonly options: TranscriptionServiceOptions) {
    this.request = options.fetch ?? defaultFetch;
    this.loadProxy = options.readProxy ?? readProxyUrl;
    this.settings = settingsFromOptions(options);
  }

  configuration(): TranscriptionConfigResponse {
    const providers: TranscriptionProvider[] = [];
    if (this.settings.localUrl) providers.push("local");
    if (this.settings.openAiApiKey) providers.push("openai");
    return {
      providers,
      provider: this.settings.provider ?? null,
      localUrl: this.settings.localUrl ?? null,
      openAiApiKeyConfigured: Boolean(this.settings.openAiApiKey),
      openAiModel: this.settings.openAiModel,
      language: this.settings.language ?? null,
      refineLocal: this.settings.refineLocal,
      refinementModel: this.settings.refinementModel,
      maxRecordingSeconds: MAX_RECORDING_SECONDS,
      maxUploadBytes: MAX_TRANSCRIPTION_BYTES,
    };
  }

  async updateConfiguration(
    input: UpdateTranscriptionSettingsRequest,
  ): Promise<TranscriptionConfigResponse> {
    const next = validateSettingsUpdate(input, this.settings);
    await persistSettingsEnvironment(this.options.settingsEnvFile, next);
    this.settings = next;
    return this.configuration();
  }

  async transcribe(audio: Buffer, contentType: string): Promise<string> {
    const mediaType = normalizeAudioType(contentType);
    const extension = AUDIO_TYPES.get(mediaType);
    if (!extension) throw new TranscriptionError("failed", "Unsupported audio format");

    const provider = this.settings.provider;
    if (!provider) {
      throw new TranscriptionError("unavailable", "Transcription provider is not selected");
    }
    if (provider === "local" && !this.settings.localUrl) {
      throw new TranscriptionError("unavailable", "Local transcription is not configured");
    }
    if (provider === "openai" && !this.settings.openAiApiKey) {
      throw new TranscriptionError("unavailable", "OpenAI transcription is not configured");
    }

    const text = await this.requestTranscription(provider, audio, mediaType, extension);
    if (provider !== "local" || !this.settings.refineLocal || !this.options.refiner) return text;

    try {
      return await this.options.refiner.refine(text, {
        cwd: this.options.cwd,
        model: this.settings.refinementModel,
      });
    } catch (error) {
      (this.options.onRefinementError ?? defaultRefinementError)(error);
      return text;
    }
  }

  private async requestTranscription(
    provider: TranscriptionProvider,
    audio: Buffer,
    mediaType: string,
    extension: string,
  ): Promise<string> {
    const bytes = new Uint8Array(audio.byteLength);
    bytes.set(audio);
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mediaType }), `recording.${extension}`);
    form.append("response_format", "json");
    if (provider === "openai") {
      form.append("model", this.settings.openAiModel);
      form.append("prompt", OPENAI_TRANSCRIPTION_PROMPT);
      if (this.settings.language) form.append("language", this.settings.language);
    } else {
      form.append("language", this.settings.language ?? "auto");
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
        provider === "openai" ? OPENAI_TRANSCRIPTIONS_URL : this.settings.localUrl!,
        {
          method: "POST",
          headers:
            provider === "openai"
              ? { Authorization: `Bearer ${this.settings.openAiApiKey!}` }
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

function settingsFromOptions(options: TranscriptionServiceOptions): TranscriptionSettings {
  return {
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.localUrl ? { localUrl: options.localUrl } : {}),
    ...(options.openAiApiKey ? { openAiApiKey: options.openAiApiKey } : {}),
    openAiModel: options.openAiModel,
    ...(options.language ? { language: options.language } : {}),
    refineLocal: options.refineLocal,
    refinementModel: options.refinementModel,
  };
}

function validateSettingsUpdate(
  input: UpdateTranscriptionSettingsRequest,
  current: TranscriptionSettings,
): TranscriptionSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TranscriptionError("validation", "Transcription settings must be an object");
  }
  const record = input as unknown as Record<string, unknown>;
  const allowed = new Set([
    "provider",
    "localUrl",
    "openAiApiKey",
    "openAiModel",
    "language",
    "refineLocal",
    "refinementModel",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new TranscriptionError("validation", "Unknown transcription setting");
  }
  if (record.provider !== null && record.provider !== "local" && record.provider !== "openai") {
    throw new TranscriptionError("validation", "provider must be local, openai, or null");
  }
  const localUrl = nullableString(record.localUrl, "localUrl");
  if (localUrl) validateHttpUrl(localUrl, "localUrl");
  const openAiModel = requiredString(record.openAiModel, "openAiModel", 100);
  if (!OPENAI_MODELS.has(openAiModel)) {
    throw new TranscriptionError(
      "validation",
      "openAiModel must be gpt-4o-transcribe or gpt-4o-mini-transcribe",
    );
  }
  const language = nullableString(record.language, "language", 32);
  if (language && !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(language)) {
    throw new TranscriptionError("validation", "language must be an ISO language code");
  }
  if (typeof record.refineLocal !== "boolean") {
    throw new TranscriptionError("validation", "refineLocal must be a boolean");
  }
  const refinementModel = requiredString(record.refinementModel, "refinementModel", 100);
  let openAiApiKey = current.openAiApiKey;
  if (record.openAiApiKey !== undefined) {
    if (record.openAiApiKey === null) openAiApiKey = undefined;
    else openAiApiKey = requiredString(record.openAiApiKey, "openAiApiKey", 500);
  }

  const next: TranscriptionSettings = {
    ...(record.provider ? { provider: record.provider as TranscriptionProvider } : {}),
    ...(localUrl ? { localUrl } : {}),
    ...(openAiApiKey ? { openAiApiKey } : {}),
    openAiModel,
    ...(language ? { language } : {}),
    refineLocal: record.refineLocal,
    refinementModel,
  };
  if (next.provider === "local" && !next.localUrl) {
    throw new TranscriptionError("validation", "Local URL is required for the local provider");
  }
  if (next.provider === "openai" && !next.openAiApiKey) {
    throw new TranscriptionError(
      "validation",
      "OpenAI API key is required for the OpenAI provider",
    );
  }
  return next;
}

function nullableString(value: unknown, name: string, maxLength = 2_000): string | undefined {
  if (value === null) return undefined;
  return requiredString(value, name, maxLength);
}

function requiredString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new TranscriptionError("validation", `${name} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new TranscriptionError("validation", `${name} is invalid`);
  }
  return normalized;
}

function validateHttpUrl(value: string, name: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TranscriptionError("validation", `${name} must be a valid URL`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new TranscriptionError(
      "validation",
      `${name} must be an HTTP(S) URL without credentials`,
    );
  }
}

async function persistSettingsEnvironment(
  path: string,
  settings: TranscriptionSettings,
): Promise<void> {
  const existing = await readOptionalFile(path);
  const retained = existing.split(/\r?\n/).filter((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z\d_]*)=/.exec(line);
    return !match || !MANAGED_ENVIRONMENT_VARIABLES.has(match[1]!);
  });
  while (retained.at(-1) === "") retained.pop();
  const managed = [
    ...(settings.provider ? [["CODEXNEST_STT_PROVIDER", settings.provider]] : []),
    ...(settings.localUrl ? [["CODEXNEST_STT_LOCAL_URL", settings.localUrl]] : []),
    ...(settings.openAiApiKey ? [["CODEXNEST_STT_OPENAI_API_KEY", settings.openAiApiKey]] : []),
    ["CODEXNEST_STT_OPENAI_MODEL", settings.openAiModel],
    ...(settings.language ? [["CODEXNEST_STT_LANGUAGE", settings.language]] : []),
    ["CODEXNEST_STT_REFINE_LOCAL", String(settings.refineLocal)],
    ["CODEXNEST_STT_REFINEMENT_MODEL", settings.refinementModel],
  ].map(([name, value]) => `${name}=${shellQuote(value!)}`);
  const content = `${[...retained, ...(retained.length ? [""] : []), ...managed].join("\n")}\n`;
  await writeAtomicPrivateFile(path, content);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function writeAtomicPrivateFile(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
    const target = await open(path, "r+");
    try {
      await target.chmod(0o600);
      await target.sync();
    } finally {
      await target.close();
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
}

async function readOptionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function defaultRefinementError(error: unknown): void {
  const name = error instanceof Error ? error.name : "UnknownError";
  process.stderr.write(`Transcript refinement failed (${name})\n`);
}

const defaultFetch: FetchLike = (input, init) =>
  undiciFetch(input, init as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
