import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { QueuedMessage } from "@codexnest/protocol";

import { StateStore } from "./state/store";
import { insertTranscript, VoiceTranscriptionManager } from "./voice-transcriptions";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("VoiceTranscriptionManager", () => {
  it("acknowledges durable audio before transcription and inserts the result into the draft", async () => {
    const { store, directory } = await createStore("Начало конец");
    let resolveTranscript: ((value: string) => void) | undefined;
    const transcribe = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveTranscript = resolve;
        }),
    );
    const projection = projectionMock();
    const manager = new VoiceTranscriptionManager({
      store,
      projection,
      transcription: { transcribe },
      queue: queueMock(store),
    });
    await manager.start();

    const job = await manager.accept({
      threadId: "thread",
      mode: "draft",
      audio: Buffer.from("audio"),
      contentType: "audio/webm",
      audioDurationMs: 2_000,
      estimatedTotalSeconds: 5,
      selectionStart: 7,
      selectionEnd: 7,
      expectedDraftUpdatedAt: store.snapshot().threadMeta.thread!.draft!.updatedAt,
      timingProfile: "local:test",
    });

    expect(job.status).toBe("queued");
    const stored = store.snapshot().voiceTranscriptions?.thread;
    expect(stored?.audioFile).toBe(`${job.id}.webm`);
    await expect(
      readFile(join(directory, "state.json.voice-transcriptions", `${job.id}.webm`), "utf8"),
    ).resolves.toBe("audio");
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
    expect(store.snapshot().voiceTranscriptions?.thread?.status).toBe("transcribing");

    resolveTranscript?.("голос");
    await vi.waitFor(() => {
      expect(store.snapshot().voiceTranscriptions?.thread).toBeUndefined();
    });
    expect(store.snapshot().threadMeta.thread?.draft?.input).toBe("Начало голос конец");
    expect(store.snapshot().transcriptionTimings?.["local:test"]).toHaveLength(1);
    await expect(
      stat(join(directory, "state.json.voice-transcriptions", `${job.id}.webm`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(projection.removeVoiceTranscription).toHaveBeenCalledWith("thread", job.id, "draft");
  });

  it("recovers an interrupted transcription from disk after restart", async () => {
    const { store } = await createStore("");
    const never = new Promise<string>(() => undefined);
    const first = new VoiceTranscriptionManager({
      store,
      projection: projectionMock(),
      transcription: { transcribe: vi.fn(() => never) },
      queue: queueMock(store),
    });
    await first.start();
    await first.accept({
      threadId: "thread",
      mode: "draft",
      audio: Buffer.from("audio"),
      contentType: "audio/webm",
      audioDurationMs: 1_000,
      estimatedTotalSeconds: null,
      selectionStart: 0,
      selectionEnd: 0,
      expectedDraftUpdatedAt: null,
      timingProfile: null,
    });
    await vi.waitFor(() => {
      expect(store.snapshot().voiceTranscriptions?.thread?.status).toBe("transcribing");
    });
    first.stop();

    const recoveredTranscribe = vi.fn(async () => "после рестарта");
    const second = new VoiceTranscriptionManager({
      store,
      projection: projectionMock(),
      transcription: { transcribe: recoveredTranscribe },
      queue: queueMock(store),
    });
    await second.start();

    await vi.waitFor(() => {
      expect(store.snapshot().voiceTranscriptions?.thread).toBeUndefined();
    });
    expect(recoveredTranscribe).toHaveBeenCalledOnce();
    expect(store.snapshot().threadMeta.thread?.draft?.input).toBe("после рестарта");
  });

  it("accepts recordings from other threads while processing them serially", async () => {
    const { store } = await createStore("");
    await store.update((state) => {
      state.threadMeta.other = { pinned: false, lastReadUpdatedAt: 0 };
    });
    const resolvers: Array<(value: string) => void> = [];
    const transcribe = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const manager = new VoiceTranscriptionManager({
      store,
      projection: projectionMock(),
      transcription: { transcribe },
      queue: queueMock(store),
    });
    await manager.start();

    await manager.accept({
      threadId: "thread",
      mode: "draft",
      audio: Buffer.from("first"),
      contentType: "audio/webm",
      audioDurationMs: 1_000,
      estimatedTotalSeconds: null,
      selectionStart: 0,
      selectionEnd: 0,
      expectedDraftUpdatedAt: null,
      timingProfile: null,
    });
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
    await manager.accept({
      threadId: "other",
      mode: "draft",
      audio: Buffer.from("second"),
      contentType: "audio/webm",
      audioDurationMs: 1_000,
      estimatedTotalSeconds: null,
      selectionStart: 0,
      selectionEnd: 0,
      expectedDraftUpdatedAt: null,
      timingProfile: null,
    });

    expect(Object.keys(store.snapshot().voiceTranscriptions ?? {}).sort()).toEqual([
      "other",
      "thread",
    ]);
    expect(transcribe).toHaveBeenCalledOnce();
    resolvers[0]?.("первая");
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(2));
    resolvers[1]?.("вторая");
    await vi.waitFor(() => {
      expect(store.snapshot().voiceTranscriptions).toEqual({});
    });
    expect(store.snapshot().threadMeta.thread?.draft?.input).toBe("первая");
    expect(store.snapshot().threadMeta.other?.draft?.input).toBe("вторая");
  });

  it("queues an automatic result with the complete draft while the agent is running", async () => {
    const { store } = await createStore("Проверь");
    await store.update((state) => {
      state.threadMeta.thread!.draft!.images = [
        { id: "image", name: "shot.png", url: "data:image/png;base64,AA==" },
      ];
      state.threadMeta.thread!.draft!.goalMode = true;
      state.threadMeta.thread!.draft!.annotations = [
        {
          id: "annotation",
          messageId: "agent",
          source: "agentMessage",
          quote: "фрагмент",
          startOffset: 0,
          endOffset: 8,
          comment: "учти это",
          createdAt: 1,
        },
      ];
    });
    const queue = queueMock(store);
    const { enqueue } = queue;
    const manager = new VoiceTranscriptionManager({
      store,
      projection: projectionMock(),
      transcription: { transcribe: vi.fn(async () => "голос") },
      queue,
    });
    await manager.start();
    const updatedAt = store.snapshot().threadMeta.thread!.draft!.updatedAt;

    const job = await manager.accept({
      threadId: "thread",
      mode: "queue",
      audio: Buffer.from("audio"),
      contentType: "audio/webm",
      audioDurationMs: 1_000,
      estimatedTotalSeconds: null,
      selectionStart: 7,
      selectionEnd: 7,
      expectedDraftUpdatedAt: updatedAt,
      timingProfile: null,
    });

    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledOnce());
    expect(enqueue).toHaveBeenCalledWith(
      "thread",
      expect.stringContaining("Проверь голос"),
      ["data:image/png;base64,AA=="],
      job.id,
      { goal: true, completeVoiceTranscriptionId: job.id },
    );
    expect(enqueue.mock.calls[0]?.[1]).toContain("## Annotations");
    expect(queue.sendNow).not.toHaveBeenCalled();
    expect(store.snapshot().voiceTranscriptions?.thread).toBeUndefined();
    expect(store.snapshot().threadMeta.thread?.draft).toBeUndefined();
  });

  it("steers a durable automatic result and leaves failed delivery in the queue", async () => {
    const { store } = await createStore("Проверь");
    const queue = queueMock(store);
    queue.sendNow.mockRejectedValueOnce(new Error("Turn already completed"));
    const projection = projectionMock();
    const onWarning = vi.fn();
    const manager = new VoiceTranscriptionManager({
      store,
      projection,
      transcription: { transcribe: vi.fn(async () => "голос") },
      queue,
      onWarning,
    });
    await manager.start();
    const updatedAt = store.snapshot().threadMeta.thread!.draft!.updatedAt;

    const job = await manager.accept({
      threadId: "thread",
      mode: "steer",
      audio: Buffer.from("audio"),
      contentType: "audio/webm",
      audioDurationMs: 1_000,
      estimatedTotalSeconds: null,
      selectionStart: 7,
      selectionEnd: 7,
      expectedDraftUpdatedAt: updatedAt,
      timingProfile: null,
    });

    await vi.waitFor(() =>
      expect(projection.removeVoiceTranscription).toHaveBeenCalledWith("thread", job.id, "send"),
    );
    expect(queue.sendNow).toHaveBeenCalledWith("thread", job.id);
    expect(store.snapshot().messageQueues?.thread?.[0]?.text).toBe("Проверь голос");
    expect(onWarning).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Turn already completed" }),
      "Voice steering failed; the message remains in the queue",
    );
  });

  it("keeps a failed job visible but unlocks the thread", async () => {
    const { store, directory } = await createStore("");
    const projection = projectionMock();
    const manager = new VoiceTranscriptionManager({
      store,
      projection,
      transcription: { transcribe: vi.fn(async () => Promise.reject(new Error("STT failed"))) },
      queue: queueMock(store),
    });
    await manager.start();
    const job = await manager.accept({
      threadId: "thread",
      mode: "draft",
      audio: Buffer.from("audio"),
      contentType: "audio/webm",
      audioDurationMs: 1_000,
      estimatedTotalSeconds: null,
      selectionStart: 0,
      selectionEnd: 0,
      expectedDraftUpdatedAt: null,
      timingProfile: null,
    });

    await vi.waitFor(() => {
      expect(store.snapshot().voiceTranscriptions?.thread?.status).toBe("failed");
    });
    expect(manager.active("thread")).toBe(false);
    expect(store.snapshot().voiceTranscriptions?.thread?.error).toBe("STT failed");
    await expect(
      stat(join(directory, "state.json.voice-transcriptions", `${job.id}.webm`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("insertTranscript", () => {
  it("preserves spacing and the goal input limit", () => {
    expect(
      insertTranscript(
        { input: "до после", images: [], goalMode: false, annotations: [] },
        3,
        3,
        "текст",
      ).input,
    ).toBe("до текст после");
    expect(
      insertTranscript(
        { input: "x".repeat(3_999), images: [], goalMode: true, annotations: [] },
        3_999,
        3_999,
        "long",
      ).input,
    ).toHaveLength(4_000);
  });
});

async function createStore(input: string) {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-voice-test-"));
  directories.push(directory);
  const store = new StateStore(join(directory, "state.json"));
  await store.load();
  await store.update((state) => {
    state.threadMeta.thread = {
      pinned: false,
      lastReadUpdatedAt: 0,
      ...(input
        ? {
            draft: {
              input,
              images: [],
              goalMode: false,
              annotations: [],
              updatedAt: Date.now(),
            },
          }
        : {}),
    };
  });
  return { store, directory };
}

function projectionMock() {
  return {
    publishVoiceTranscription: vi.fn(),
    removeVoiceTranscription: vi.fn(),
  };
}

function queueMock(store: StateStore) {
  return {
    enqueue: vi.fn(
      async (
        threadId: string,
        text: string,
        images: string[],
        messageId: string,
        options: { goal?: boolean; completeVoiceTranscriptionId?: string },
      ): Promise<QueuedMessage> => {
        const message: QueuedMessage = {
          id: messageId,
          threadId,
          text,
          images,
          ...(options.goal ? { goal: true } : {}),
          createdAt: Date.now(),
          status: "queued",
        };
        await store.update((state) => {
          state.messageQueues ??= {};
          (state.messageQueues[threadId] ??= []).push(message);
          const meta = state.threadMeta[threadId];
          if (meta) delete meta.draft;
          if (
            options.completeVoiceTranscriptionId &&
            state.voiceTranscriptions?.[threadId]?.id === options.completeVoiceTranscriptionId
          ) {
            delete state.voiceTranscriptions[threadId];
          }
        });
        return message;
      },
    ),
    sendNow: vi.fn(async () => "turn"),
  };
}
