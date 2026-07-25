import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type {
  ThreadDraft,
  UiLanguage,
  VoiceInputMode,
  VoiceTranscriptionJob,
} from "@codexnest/protocol";

import type { MessageQueue } from "./message-queue";
import type { AppProjection } from "./projection";
import type { StateStore, VoiceTranscriptionState } from "./state/store";
import { appendTranscriptionTimingSample, type TranscriptionService } from "./transcription";

export const MAX_VOICE_QUEUE_BYTES = 240 * 1024 * 1024;

type VoiceTranscriptionManagerOptions = {
  store: StateStore;
  projection: Pick<AppProjection, "publishVoiceTranscription" | "removeVoiceTranscription">;
  transcription: Pick<TranscriptionService, "transcribe">;
  queue: Pick<MessageQueue, "enqueue">;
  onWarning?(error: unknown, message: string): void;
};

type AcceptVoiceTranscription = {
  threadId: string;
  mode: VoiceInputMode;
  audio: Buffer;
  contentType: "audio/webm" | "audio/mp4";
  audioDurationMs: number;
  estimatedTotalSeconds: number | null;
  selectionStart: number;
  selectionEnd: number;
  expectedDraftUpdatedAt: number | null;
  timingProfile: string | null;
};

export class VoiceTranscriptionConflictError extends Error {}
export class VoiceTranscriptionQueueFullError extends Error {}

export class VoiceTranscriptionManager {
  private readonly directory: string;
  private acceptChain: Promise<void> = Promise.resolve();
  private worker: Promise<void> | null = null;
  private startup: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly options: VoiceTranscriptionManagerOptions) {
    this.directory = join(
      dirname(options.store.path),
      `${basename(options.store.path)}.voice-transcriptions`,
    );
  }

  start(): Promise<void> {
    this.startup ??= this.initialize();
    return this.startup;
  }

  private async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.options.store.update((state) => {
      for (const job of Object.values(state.voiceTranscriptions ?? {})) {
        if (job.status === "transcribing") {
          job.status = "queued";
          job.startedAt = null;
          job.error = null;
        }
      }
    });
    await this.removeOrphanedAudio();
    this.kick();
  }

  stop(): void {
    this.stopped = true;
  }

  job(threadId: string): VoiceTranscriptionState | null {
    return this.options.store.snapshot().voiceTranscriptions?.[threadId] ?? null;
  }

  active(threadId: string): boolean {
    const status = this.job(threadId)?.status;
    return status === "queued" || status === "transcribing" || status === "applying";
  }

  accept(input: AcceptVoiceTranscription): Promise<VoiceTranscriptionJob> {
    let accepted!: VoiceTranscriptionJob;
    const task = this.acceptChain
      .catch(() => undefined)
      .then(async () => {
        await this.start();
        accepted = await this.acceptUnlocked(input);
      });
    this.acceptChain = task;
    return task.then(() => accepted);
  }

  async clearFailure(threadId: string): Promise<void> {
    const current = this.job(threadId);
    if (current?.status !== "failed") return;
    await this.options.store.update((state) => {
      if (state.voiceTranscriptions?.[threadId]?.id !== current.id) return;
      delete state.voiceTranscriptions[threadId];
    });
    this.options.projection.removeVoiceTranscription(threadId, current.id, "cancelled");
  }

  async cancelThread(threadId: string): Promise<void> {
    const current = this.job(threadId);
    if (!current) return;
    await this.options.store.update((state) => {
      if (state.voiceTranscriptions?.[threadId]?.id === current.id) {
        delete state.voiceTranscriptions[threadId];
      }
    });
    if (current.audioFile) await unlink(this.audioPath(current.audioFile)).catch(() => undefined);
    this.options.projection.removeVoiceTranscription(threadId, current.id, "cancelled");
  }

  private async acceptUnlocked(input: AcceptVoiceTranscription): Promise<VoiceTranscriptionJob> {
    const existing = this.job(input.threadId);
    if (existing && existing.status !== "failed") {
      throw new VoiceTranscriptionConflictError(
        "A voice transcription is already active in this thread",
      );
    }
    const activeBytes = Object.values(
      this.options.store.snapshot().voiceTranscriptions ?? {},
    ).reduce((total, job) => total + (job.status === "failed" ? 0 : job.audioBytes), 0);
    if (activeBytes + input.audio.length > MAX_VOICE_QUEUE_BYTES) {
      throw new VoiceTranscriptionQueueFullError("Voice transcription queue is full");
    }

    const id = randomUUID();
    const extension = input.contentType === "audio/mp4" ? "mp4" : "webm";
    const audioFile = `${id}.${extension}`;
    const temporary = `${audioFile}.${process.pid}.tmp`;
    await this.writeAudio(temporary, audioFile, input.audio);
    const state: VoiceTranscriptionState = {
      id,
      threadId: input.threadId,
      mode: input.mode,
      status: "queued",
      createdAt: Date.now(),
      startedAt: null,
      audioDurationMs: input.audioDurationMs,
      estimatedTotalSeconds: input.estimatedTotalSeconds,
      error: null,
      contentType: input.contentType,
      audioFile,
      audioBytes: input.audio.length,
      selectionStart: input.selectionStart,
      selectionEnd: input.selectionEnd,
      ...(input.timingProfile ? { timingProfile: input.timingProfile } : {}),
    };
    try {
      await this.options.store.update((draft) => {
        draft.voiceTranscriptions ??= {};
        const current = draft.voiceTranscriptions[input.threadId];
        if (current && current.status !== "failed") {
          throw new VoiceTranscriptionConflictError(
            "A voice transcription is already active in this thread",
          );
        }
        const queuedBytes = Object.values(draft.voiceTranscriptions).reduce(
          (total, job) => total + (job.status === "failed" ? 0 : job.audioBytes),
          0,
        );
        if (queuedBytes + input.audio.length > MAX_VOICE_QUEUE_BYTES) {
          throw new VoiceTranscriptionQueueFullError("Voice transcription queue is full");
        }
        const threadDraft = draft.threadMeta[input.threadId]?.draft;
        if ((threadDraft?.updatedAt ?? null) !== input.expectedDraftUpdatedAt) {
          throw new VoiceTranscriptionConflictError(
            "The draft changed before the recording reached the server",
          );
        }
        if (
          input.selectionStart > (threadDraft?.input.length ?? 0) ||
          input.selectionEnd > (threadDraft?.input.length ?? 0)
        ) {
          throw new VoiceTranscriptionConflictError(
            "The draft changed before the recording reached the server",
          );
        }
        draft.voiceTranscriptions[input.threadId] = state;
      });
    } catch (error) {
      await unlink(this.audioPath(audioFile)).catch(() => undefined);
      throw error;
    }
    this.options.projection.publishVoiceTranscription(state);
    setImmediate(() => this.kick());
    return publicJob(state);
  }

  private async writeAudio(temporary: string, target: string, audio: Buffer): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporaryPath = this.audioPath(temporary);
    const targetPath = this.audioPath(target);
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(audio);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporaryPath, targetPath);
      const directory = await open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private kick(): void {
    if (this.stopped || this.worker) return;
    this.worker = this.run()
      .catch((error: unknown) => {
        this.options.onWarning?.(error, "Voice transcription worker failed");
      })
      .finally(() => {
        this.worker = null;
        if (!this.stopped && this.nextJob()) this.kick();
      });
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const job = this.nextJob();
      if (!job) return;
      try {
        if (job.status !== "applying") await this.transcribe(job);
        const current = this.job(job.threadId);
        if (current?.id === job.id && current.status === "applying") {
          await this.apply(current);
        }
      } catch (error) {
        await this.fail(job, error);
      }
    }
  }

  private nextJob(): VoiceTranscriptionState | null {
    return (
      Object.values(this.options.store.snapshot().voiceTranscriptions ?? {})
        .filter((job) => ["queued", "transcribing", "applying"].includes(job.status))
        .sort((left, right) => left.createdAt - right.createdAt)[0] ?? null
    );
  }

  private async transcribe(job: VoiceTranscriptionState): Promise<void> {
    if (!job.audioFile) throw new Error("Saved audio is missing");
    const startedAt = Date.now();
    let active: VoiceTranscriptionState | null = null;
    await this.options.store.update((state) => {
      const current = state.voiceTranscriptions?.[job.threadId];
      if (!current || current.id !== job.id) return;
      current.status = "transcribing";
      current.startedAt = startedAt;
      current.error = null;
      active = structuredClone(current);
    });
    if (!active) return;
    this.options.projection.publishVoiceTranscription(active);

    const audio = await readFile(this.audioPath(job.audioFile));
    const transcript = await this.options.transcription.transcribe(audio, job.contentType);
    const processingMs = Math.max(1, Date.now() - startedAt);
    let applying: VoiceTranscriptionState | null = null;
    await this.options.store.update((state) => {
      const current = state.voiceTranscriptions?.[job.threadId];
      if (!current || current.id !== job.id) return;
      current.status = "applying";
      current.transcript = transcript.trim();
      current.error = null;
      if (current.timingProfile) {
        state.transcriptionTimings ??= {};
        state.transcriptionTimings[current.timingProfile] = appendTranscriptionTimingSample(
          state.transcriptionTimings[current.timingProfile],
          { audioDurationMs: current.audioDurationMs, processingMs },
        );
      }
      applying = structuredClone(current);
    });
    if (applying) this.options.projection.publishVoiceTranscription(applying);
  }

  private async apply(job: VoiceTranscriptionState): Promise<void> {
    const transcript = job.transcript?.trim();
    if (!transcript) throw new Error("Transcription returned no text");
    if (job.mode === "draft") {
      await this.applyToDraft(job, transcript);
    } else {
      await this.applyToQueue(job, transcript);
    }
    if (job.audioFile) await unlink(this.audioPath(job.audioFile)).catch(() => undefined);
  }

  private async applyToDraft(job: VoiceTranscriptionState, transcript: string): Promise<void> {
    await this.options.store.update((state) => {
      const current = state.voiceTranscriptions?.[job.threadId];
      if (!current || current.id !== job.id) return;
      const meta = state.threadMeta[job.threadId] ?? {
        pinned: false,
        lastReadUpdatedAt: 0,
      };
      const draft = meta.draft ?? emptyDraft();
      meta.draft = {
        ...insertTranscript(draft, job.selectionStart, job.selectionEnd, transcript),
        updatedAt: Date.now(),
      };
      state.threadMeta[job.threadId] = meta;
      delete state.voiceTranscriptions![job.threadId];
    });
    this.options.projection.removeVoiceTranscription(job.threadId, job.id, "draft");
  }

  private async applyToQueue(job: VoiceTranscriptionState, transcript: string): Promise<void> {
    const snapshot = this.options.store.snapshot();
    const draft = snapshot.threadMeta[job.threadId]?.draft ?? emptyDraft();
    const inserted = insertTranscript(draft, job.selectionStart, job.selectionEnd, transcript);
    const text = formatDraftMessage(inserted, snapshot.uiLanguage);
    await this.options.queue.enqueue(
      job.threadId,
      text,
      inserted.images.map((image) => image.url),
      job.id,
      {
        goal: inserted.goalMode,
        completeVoiceTranscriptionId: job.id,
      },
    );
    this.options.projection.removeVoiceTranscription(job.threadId, job.id, "send");
  }

  private async fail(job: VoiceTranscriptionState, error: unknown): Promise<void> {
    let failed: VoiceTranscriptionState | null = null;
    let audioFile: string | undefined;
    await this.options.store.update((state) => {
      const current = state.voiceTranscriptions?.[job.threadId];
      if (!current || current.id !== job.id) return;
      audioFile = current.audioFile;
      current.status = "failed";
      current.error = error instanceof Error ? error.message : "Voice transcription failed";
      delete current.audioFile;
      delete current.transcript;
      failed = structuredClone(current);
    });
    if (audioFile) await unlink(this.audioPath(audioFile)).catch(() => undefined);
    if (failed) this.options.projection.publishVoiceTranscription(failed);
  }

  private async removeOrphanedAudio(): Promise<void> {
    const referenced = new Set(
      Object.values(this.options.store.snapshot().voiceTranscriptions ?? {}).flatMap((job) =>
        job.status !== "failed" && job.audioFile ? [job.audioFile] : [],
      ),
    );
    const files = await readdir(this.directory).catch(() => []);
    await Promise.all(
      files
        .filter((file) => !referenced.has(file))
        .map((file) => unlink(this.audioPath(file)).catch(() => undefined)),
    );
  }

  private audioPath(file: string): string {
    return join(this.directory, file);
  }
}

export function publicJob(job: VoiceTranscriptionState): VoiceTranscriptionJob {
  return {
    id: job.id,
    threadId: job.threadId,
    mode: job.mode,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    audioDurationMs: job.audioDurationMs,
    estimatedTotalSeconds: job.estimatedTotalSeconds,
    error: job.error,
  };
}

export function insertTranscript(
  draft: Omit<ThreadDraft, "updatedAt">,
  selectionStart: number,
  selectionEnd: number,
  transcript: string,
): Omit<ThreadDraft, "updatedAt"> {
  const clean = transcript.trim();
  if (!clean) throw new Error("Transcription returned no text");
  const start = Math.min(selectionStart, draft.input.length);
  const end = Math.max(start, Math.min(selectionEnd, draft.input.length));
  const before = draft.input.slice(0, start);
  const after = draft.input.slice(end);
  const leading = before && !/\s$/.test(before) ? " " : "";
  const trailing = after && !/^\s/.test(after) ? " " : "";
  const completeInsertion = `${leading}${clean}${trailing}`;
  const inserted = draft.goalMode
    ? completeInsertion.slice(0, Math.max(0, 4_000 - before.length - after.length))
    : completeInsertion;
  return { ...draft, input: `${before}${inserted}${after}` };
}

function emptyDraft(): Omit<ThreadDraft, "updatedAt"> {
  return { input: "", images: [], goalMode: false, annotations: [] };
}

function formatDraftMessage(draft: Omit<ThreadDraft, "updatedAt">, language: UiLanguage): string {
  const sections: string[] = [];
  const message = draft.input.trim();
  if (message) sections.push(message);
  if (draft.annotations.length) {
    const title =
      language === "en"
        ? "## Annotations for the agent's previous response"
        : "## Аннотации к предыдущему ответу агента";
    const annotationLabel = language === "en" ? "Annotation" : "Аннотация";
    const quoteLabel = language === "en" ? "Selected text:" : "Выделенный текст:";
    const commentLabel = language === "en" ? "Comment:" : "Комментарий:";
    sections.push(
      [
        title,
        ...draft.annotations.map((annotation, index) =>
          [
            `### ${annotationLabel} ${index + 1}`,
            quoteLabel,
            annotation.quote
              .split("\n")
              .map((line) => `> ${line}`)
              .join("\n"),
            commentLabel,
            annotation.comment.trim(),
          ].join("\n\n"),
        ),
      ].join("\n\n"),
    );
  }
  return sections.join("\n\n");
}
