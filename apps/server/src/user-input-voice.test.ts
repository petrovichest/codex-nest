import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendUserInputRecordings,
  type AttentionRequest,
  type QueuedMessage,
  type UserInputReply,
} from "@codexnest/protocol";
import { StateStore } from "./state/store";
import { VoiceTranscriptionManager } from "./voice-transcriptions";

const directories: string[] = [];
const managers: VoiceTranscriptionManager[] = [];
const draftKey = "a".repeat(64);
afterEach(async () => {
  managers.splice(0).forEach((manager) => manager.stop());
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(
  transcribe: (audio: Buffer) => Promise<string> = async (audio) => audio.toString(),
  existing?: StateStore,
) {
  let store = existing;
  if (!store) {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-question-voice-"));
    directories.push(directory);
    store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.threadMeta.thread = {
        pinned: false,
        lastReadUpdatedAt: 0,
        draft: {
          input: "Composer draft",
          images: [],
          annotations: [],
          goalMode: false,
          updatedAt: 1,
        },
        userInputDrafts: {
          [draftKey]: {
            turnId: "turn",
            itemId: "questions",
            fingerprint: "b".repeat(64),
            answers: { first: ["Typed"] },
            currentQuestionId: "first",
            revision: 1,
            updatedAt: 1,
          },
        },
      };
    });
  }
  const request: Extract<AttentionRequest, { kind: "userInput" }> = {
    id: "attention",
    kind: "userInput",
    threadId: "thread",
    turnId: "turn",
    itemId: "questions",
    createdAt: 1,
    autoResolutionMs: null,
    questions: ["first", "second"].map((id) => ({
      id,
      header: id,
      question: `${id}?`,
      options: null,
      isOther: true,
      isSecret: false,
    })),
  };
  const queue = {
    enqueue: vi.fn(
      async (
        threadId: string,
        text: string,
        _images: string[],
        id: string,
        options?: { replyToUserInput?: UserInputReply },
      ): Promise<QueuedMessage> => {
        const message: QueuedMessage = {
          id,
          threadId,
          text,
          status: "queued",
          createdAt: Date.now(),
          ...options,
        };
        await store!.update((state) => {
          state.messageQueues ??= {};
          state.messageQueues[threadId] = [message];
        });
        return message;
      },
    ),
    sendNow: vi.fn(),
  };
  const projection = {
    publishVoiceTranscription: vi.fn(),
    removeVoiceTranscription: vi.fn(),
    publishUserInputDraft: vi.fn(),
    userInputVoiceRequest: vi.fn(() => request),
  };
  const manager = new VoiceTranscriptionManager({
    store,
    projection,
    queue,
    transcription: { transcribe },
  });
  managers.push(manager);
  const accept = (id: string, questionId = "first", order = 1) =>
    manager.accept({
      clientUploadId: id,
      threadId: "thread",
      mode: "draft",
      userInput: { draftKey, questionId, order },
      audio: Buffer.from(id),
      contentType: "audio/webm",
      audioDurationMs: 1_000,
      estimatedTotalSeconds: 1,
      selectionStart: 0,
      selectionEnd: 0,
      expectedDraftUpdatedAt: null,
      timingProfile: null,
    });
  return {
    store,
    manager,
    accept,
    queue,
    projection,
    draft: () => store!.view().threadMeta.thread!.userInputDrafts![draftKey]!,
  };
}

describe("question voice processing", () => {
  it("waits for missing predecessors and appends to edited answers, preserving the composer", async () => {
    const calls: string[] = [];
    const f = await fixture(async (audio) => {
      calls.push(audio.toString());
      return audio.toString();
    });
    await f.accept("second-clip", "first", 2);
    await f.accept("other-question", "second", 1);
    await vi.waitFor(() => expect(f.draft().answers.second).toEqual(["other-question"]));
    expect(calls).toEqual(["other-question"]);
    await f.store.update((state) => {
      state.threadMeta.thread!.userInputDrafts![draftKey]!.answers.first = ["Edited"];
    });
    await f.accept("first-clip", "first", 1);
    await vi.waitFor(() =>
      expect(f.draft().answers.first).toEqual(["Edited first-clip second-clip"]),
    );
    expect(calls).toEqual(["other-question", "first-clip", "second-clip"]);
    expect(f.store.view().threadMeta.thread!.draft!.input).toBe("Composer draft");
    expect(f.queue.enqueue).not.toHaveBeenCalled();
    expect(await f.accept("first-clip", "first", 1)).toMatchObject({
      status: "completed",
      transcript: "first-clip",
    });
    expect(f.draft().answers.first).toEqual(["Edited first-clip second-clip"]);
  });

  it("merges late draft saves with completed clips exactly once", async () => {
    const f = await fixture();
    await f.accept("voice");
    await vi.waitFor(() => expect(f.draft().appliedRecordingIds).toEqual(["voice"]));
    const recordings = Object.values(f.store.snapshot().voiceTranscriptions!);
    const merged = appendUserInputRecordings(
      { answers: { first: ["Manual edit"], second: ["Keep"] }, currentQuestionId: "second" },
      recordings,
    );
    expect(merged.answers).toEqual({ first: ["Manual edit voice"], second: ["Keep"] });
    expect(appendUserInputRecordings(merged, recordings)).toEqual(merged);
    const edited = { ...merged, answers: { first: ["Corrected transcript"] } };
    expect(appendUserInputRecordings(edited, recordings).answers.first).toEqual([
      "Corrected transcript",
    ]);
  });

  it("restores pending submission after restart and sends all answers once", async () => {
    const first = await fixture(() => new Promise<string>(() => undefined));
    await first.accept("one");
    await first.accept("two", "second");
    await first.manager.submitUserInput(
      "thread",
      draftKey,
      { answers: { first: ["Final edit"] }, currentQuestionId: "second" },
      ["one", "two"],
    );
    expect(first.queue.enqueue).not.toHaveBeenCalled();
    first.manager.stop();
    const reopened = new StateStore(first.store.path);
    await reopened.load();
    const restored = await fixture(undefined, reopened);
    await restored.manager.start();
    await vi.waitFor(() => expect(restored.queue.enqueue).toHaveBeenCalledOnce());
    expect(restored.queue.enqueue).toHaveBeenCalledWith(
      "thread",
      "first?\nFinal edit one\n\nsecond?\ntwo",
      [],
      expect.stringMatching(/^user-input:/),
      {
        replyToUserInput: {
          turnId: "turn",
          itemId: "questions",
          answers: { first: ["Final edit one"], second: ["two"] },
        },
      },
    );
    await restored.manager.submitUserInput(
      "thread",
      draftKey,
      { answers: {}, currentQuestionId: null },
      ["one", "two"],
    );
    restored.manager.wake();
    await vi.waitFor(() => expect(restored.draft().submission?.status).toBe("sending"));
    expect(restored.queue.enqueue).toHaveBeenCalledOnce();
    expect(restored.store.view().threadMeta.thread!.draft!.input).toBe("Composer draft");
  });

  it("blocks partial sends on errors and supports retrying the same recording", async () => {
    const transcribe = vi
      .fn()
      .mockRejectedValueOnce(new Error("bad audio"))
      .mockResolvedValue("Recovered");
    const f = await fixture(transcribe);
    await f.accept("voice");
    await f.manager.submitUserInput(
      "thread",
      draftKey,
      { answers: {}, currentQuestionId: "first" },
      ["voice"],
    );
    await vi.waitFor(() =>
      expect(f.store.view().voiceTranscriptions?.["question:voice"]?.status).toBe("failed"),
    );
    expect(f.queue.enqueue).not.toHaveBeenCalled();
    await f.manager.retryUserInputRecording("thread", "voice");
    await vi.waitFor(() => expect(f.queue.enqueue).toHaveBeenCalledOnce());
    expect(f.draft().answers.first).toEqual(["Recovered"]);
  });

  it("cancels pending sending without losing clips and discards results for closed questions", async () => {
    let finish!: (text: string) => void;
    const f = await fixture(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    await f.accept("voice");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await f.manager.submitUserInput(
      "thread",
      draftKey,
      { answers: { first: ["Keep"] }, currentQuestionId: "first" },
      ["voice"],
    );
    await f.manager.cancelUserInputSubmission("thread", draftKey);
    expect(f.draft().submission).toBeUndefined();
    expect(f.draft().answers.first).toEqual(["Keep"]);
    await f.store.update((state) => {
      delete state.threadMeta.thread!.userInputDrafts;
    });
    finish("Late text");
    await vi.waitFor(() =>
      expect(f.store.view().voiceTranscriptions?.["question:voice"]).toBeUndefined(),
    );
    expect(f.queue.enqueue).not.toHaveBeenCalled();
    expect(f.store.view().threadMeta.thread!.userInputDrafts).toBeUndefined();
  });
});
