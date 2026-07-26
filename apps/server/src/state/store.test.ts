import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { StateStore } from "./store";

const directories: string[] = [];
async function temporaryState(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-state-test-"));
  directories.push(directory);
  return { directory, path: join(directory, "state.json") };
}
afterEach(async () =>
  Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  ),
);

describe("StateStore", () => {
  it("creates a private state file and serializes concurrent updates", async () => {
    const { path } = await temporaryState();
    const store = new StateStore(path);
    await store.load();
    expect(store.snapshot().uiLanguage).toBe("en");
    await Promise.all([
      store.update((state) => {
        state.devices.a = { fcmToken: "one", updatedAt: 1 };
      }),
      store.update((state) => {
        state.devices.b = { fcmToken: "two", updatedAt: 2 };
      }),
    ]);
    expect(Object.keys(store.snapshot().devices)).toEqual(["a", "b"]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ schemaVersion: 1 });
  });

  it("rejects corrupt and unsupported schemas", async () => {
    const { path } = await temporaryState();
    await writeFile(path, '{"schemaVersion":2}', "utf8");
    await expect(new StateStore(path).load()).rejects.toThrow("Unsupported or corrupt");
  });

  it("accepts legacy permission fields for backward-compatible state loading", async () => {
    const { path } = await temporaryState();
    const store = new StateStore(path);
    await store.load();
    await store.update((state) => {
      state.defaultReasoningEffort = "high";
      state.threadMeta.legacy = { pinned: false, lastReadUpdatedAt: 1 };
      state.threadMeta.configured = {
        pinned: false,
        lastReadUpdatedAt: 2,
        lastViewedUpdatedAt: 2,
        settings: {
          collaborationMode: "plan",
          model: "gpt",
          reasoningEffort: "high",
          approvalPolicy: "on-request",
          approvalsReviewer: "auto_review",
        },
      };
    });

    const reloaded = new StateStore(path);
    await reloaded.load();
    expect(reloaded.snapshot().defaultReasoningEffort).toBe("high");
    expect(reloaded.snapshot().threadMeta.legacy?.settings).toBeUndefined();
    expect(reloaded.snapshot().threadMeta.configured?.lastViewedUpdatedAt).toBe(2);
    expect(reloaded.snapshot().threadMeta.configured?.settings).toEqual({
      collaborationMode: "plan",
      model: "gpt",
      reasoningEffort: "high",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    });
  });

  it("loads legacy state and queued messages without the new optional fields", async () => {
    const { path } = await temporaryState();
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        auth: {},
        projects: [],
        threadMeta: {},
        devices: {},
        messageQueues: {
          thread: [
            {
              id: "queued",
              threadId: "thread",
              text: "Старое сообщение",
              createdAt: 1,
              status: "queued",
            },
          ],
        },
      }),
      "utf8",
    );

    const store = new StateStore(path);
    await store.load();
    expect(store.snapshot().uiLanguage).toBe("ru");
    expect(store.snapshot().messageQueues?.thread).toEqual([
      expect.objectContaining({ id: "queued", text: "Старое сообщение" }),
    ]);
    expect(store.snapshot().dismissedProjectPaths).toBeUndefined();
  });

  it("persists dismissed project paths without changing the state schema", async () => {
    const { path } = await temporaryState();
    const store = new StateStore(path);
    await store.load();
    await store.update((state) => {
      state.dismissedProjectPaths = ["/work/removed"];
    });

    const reloaded = new StateStore(path);
    await reloaded.load();
    expect(reloaded.snapshot()).toMatchObject({
      schemaVersion: 1,
      dismissedProjectPaths: ["/work/removed"],
    });
  });

  it("persists pending Team results and their timeline notices", async () => {
    const { path } = await temporaryState();
    const store = new StateStore(path);
    await store.load();
    await store.update((state) => {
      state.threadMeta.parent = {
        pinned: false,
        lastReadUpdatedAt: 0,
        teamOrchestration: {
          tasks: {
            task: {
              id: "task",
              childThreadId: "child",
              title: "Проверить интерфейс",
              prompt: "Проверить интерфейс и вернуть результат.",
              status: "completed",
              createdAt: 1,
              lastActivityAt: 2,
              terminalTurnId: "child-turn",
              result: {
                summary: "Интерфейс проверен",
                source: "submitted",
              },
            },
          },
        },
        timelineArtifacts: {
          "parent-turn": [
            {
              type: "orchestrationNotice",
              id: "notice",
              status: "completed",
              agents: [
                {
                  threadId: "child",
                  title: "Проверить интерфейс",
                  nickname: "reviewer",
                  outcome: "completed",
                },
              ],
              timestamp: 1,
              afterItemId: null,
            },
          ],
        },
      };
    });

    const reloaded = new StateStore(path);
    await reloaded.load();
    expect(reloaded.snapshot().threadMeta.parent).toMatchObject({
      teamOrchestration: {
        tasks: {
          task: {
            childThreadId: "child",
            status: "completed",
            terminalTurnId: "child-turn",
            result: {
              summary: "Интерфейс проверен",
              source: "submitted",
            },
          },
        },
      },
      timelineArtifacts: {
        "parent-turn": [
          {
            type: "orchestrationNotice",
            agents: [{ threadId: "child", outcome: "completed" }],
          },
        ],
      },
    });
  });

  it("reloads unmaterialized sessions and complete server drafts", async () => {
    const { path } = await temporaryState();
    const store = new StateStore(path);
    await store.load();
    await store.update((state) => {
      state.transcriptionTimings = {
        "local:http://127.0.0.1:8178/inference:raw": [
          { audioDurationMs: 2_000, processingMs: 6_000 },
          { audioDurationMs: 3_000, processingMs: 7_000 },
        ],
      };
      state.voiceTranscriptions = {
        thread: {
          id: "voice",
          threadId: "thread",
          mode: "steer",
          status: "queued",
          createdAt: 1,
          startedAt: null,
          audioDurationMs: 2_000,
          estimatedTotalSeconds: 6,
          error: null,
          contentType: "audio/webm",
          audioFile: "voice.webm",
          audioBytes: 5,
          selectionStart: 0,
          selectionEnd: 0,
          timingProfile: "local:test",
        },
      };
      state.threadMeta.thread = {
        pinned: false,
        lastReadUpdatedAt: 0,
        unmaterialized: true,
        draft: {
          input: "Черновик",
          images: [
            {
              id: "image",
              name: "draft.png",
              url: "data:image/png;base64,AA==",
            },
          ],
          goalMode: true,
          annotations: [
            {
              id: "annotation",
              messageId: "message",
              source: "agentMessage",
              quote: "Цитата",
              startOffset: 0,
              endOffset: 6,
              comment: "Комментарий",
              createdAt: 1,
            },
          ],
          updatedAt: 2,
        },
      };
    });

    const reloaded = new StateStore(path);
    await reloaded.load();
    expect(reloaded.snapshot().threadMeta.thread).toMatchObject({
      unmaterialized: true,
      draft: {
        input: "Черновик",
        images: [{ name: "draft.png" }],
        goalMode: true,
        annotations: [{ comment: "Комментарий" }],
      },
    });
    expect(reloaded.snapshot().transcriptionTimings).toEqual({
      "local:http://127.0.0.1:8178/inference:raw": [
        { audioDurationMs: 2_000, processingMs: 6_000 },
        { audioDurationMs: 3_000, processingMs: 7_000 },
      ],
    });
    expect(reloaded.snapshot().voiceTranscriptions?.thread).toMatchObject({
      id: "voice",
      mode: "steer",
      status: "queued",
      audioFile: "voice.webm",
    });
  });

  it("discards legacy timing coefficients that lack audio durations", async () => {
    const { path } = await temporaryState();
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        auth: {},
        projects: [],
        threadMeta: {},
        devices: {},
        uiLanguage: "ru",
        transcriptionTimings: {
          "local:http://127.0.0.1:8178/inference:raw": [2_000, 3_000],
        },
      }),
      "utf8",
    );

    const store = new StateStore(path);
    await store.load();
    expect(store.snapshot().transcriptionTimings).toEqual({
      "local:http://127.0.0.1:8178/inference:raw": [],
    });
  });

  it("reloads an externally rotated verifier and emits revocation", async () => {
    const { path } = await temporaryState();
    const store = new StateStore(path);
    await store.load();
    const rotated = store.snapshot();
    rotated.auth.tokenSha256 = "a".repeat(64);
    await writeFile(path, JSON.stringify(rotated), { mode: 0o600 });
    const revoked = new Promise<void>((resolve) => store.once("authRotated", resolve));
    await expect(store.refreshAuthVerifier()).resolves.toBe(true);
    await revoked;
    expect(store.snapshot().auth.tokenSha256).toBe("a".repeat(64));
  });
});
