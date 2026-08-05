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

function managedTaskFixture(id: string, createdAt: number) {
  return {
    id,
    childThreadId: `${id}-child`,
    title: `Task ${id}`,
    prompt: `Complete ${id}.`,
    status: "completed",
    createdAt,
    lastActivityAt: createdAt,
  };
}

function validManagedTeamSerializedState(): any {
  return {
    schemaVersion: 1,
    auth: {},
    projects: [],
    threadMeta: {
      parent: {
        pinned: false,
        lastReadUpdatedAt: 0,
        managedTeamToolsAvailable: true,
        teamOrchestration: {
          tasks: {
            base: managedTaskFixture("base", 1),
            task: {
              ...managedTaskFixture("task", 2),
              dependsOn: ["base"],
              access: {
                mode: "isolatedWrite",
                writePaths: ["apps/server/src"],
                network: false,
              },
              timeoutMinutes: 30,
              tokenBudget: 10_000,
              tokensUsed: 100,
              timeUsedSeconds: 10,
              workspace: {
                lifecycle: "ready",
                repositoryRoot: "/work/project",
                gitCommonDir: "/work/project/.git",
                worktreePath: "/work/project/.git/codexnest-team-worktrees/task",
                head: "a".repeat(40),
                baseline: {
                  "apps/server/src/api.ts": {
                    type: "file",
                    mode: 0o600,
                    digest: "b".repeat(64),
                  },
                },
                createdAt: 2,
                updatedAt: 2,
              },
              result: {
                outcome: "success",
                summary: "Done",
                checks: [{ name: "state tests", outcome: "passed" }],
                source: "submitted",
              },
            },
          },
        },
      },
    },
    devices: {},
    uiLanguage: "en",
  };
}

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
              childThreadSource: "codexnest-managed:receipt",
              startMessageId: "codexnest-team-task:task",
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
              delivery: {
                status: "claimed",
                claimId: "claim",
                markerId: "codexnest-team-claim:claim",
                dispatchStartedAt: 3,
                contextHash: "a".repeat(64),
              },
            },
            sleeping: {
              id: "sleeping",
              childThreadId: "sleeping-child",
              title: "Проверить результат позже",
              prompt: "Проверить результат через час.",
              status: "running",
              createdAt: 3,
              lastActivityAt: 4,
              expectedWakeAt: 3_604_000,
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
      state.teamToolOperations = {
        receipt: {
          threadId: "parent",
          turnId: "parent-turn",
          callId: "call",
          tool: "spawn_task",
          argumentsHash: "b".repeat(64),
          status: "applied",
          createdAt: 1,
          updatedAt: 2,
          taskId: "task",
          childThreadSource: "codexnest-managed:receipt",
          response: {
            success: true,
            contentItems: [{ type: "inputText", text: '{"taskId":"task"}' }],
          },
        },
      };
    });
    await store.checkpoint();

    const reloaded = new StateStore(path);
    await reloaded.load();
    expect(reloaded.snapshot().threadMeta.parent).toMatchObject({
      teamOrchestration: {
        tasks: {
          task: {
            childThreadId: "child",
            status: "completed",
            terminalTurnId: "child-turn",
            startMessageId: "codexnest-team-task:task",
            result: {
              summary: "Интерфейс проверен",
              source: "submitted",
            },
          },
          sleeping: {
            childThreadId: "sleeping-child",
            status: "running",
            expectedWakeAt: 3_604_000,
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
    expect(reloaded.snapshot().teamToolOperations).toMatchObject({
      receipt: {
        status: "applied",
        taskId: "task",
        response: { success: true },
      },
    });
  });

  it("round-trips the current managed Team task state", async () => {
    const { path } = await temporaryState();
    const store = new StateStore(path);
    await store.load();
    await store.update((state) => {
      state.threadMeta.parent = {
        pinned: false,
        lastReadUpdatedAt: 0,
        managedTeamToolsAvailable: true,
        teamOrchestration: {
          tasks: {
            legacy: {
              id: "legacy",
              childThreadId: "legacy-child",
              title: "Legacy task",
              prompt: "Keep the minimal stored shape valid.",
              status: "completed",
              createdAt: 1,
              lastActivityAt: 2,
              result: { summary: "Legacy result", source: "submitted" },
            },
            isolated: {
              id: "isolated",
              childThreadId: "isolated-child",
              title: "Isolated task",
              prompt: "Implement the scoped change.",
              status: "completed",
              dependsOn: ["legacy"],
              access: {
                mode: "isolatedWrite",
                writePaths: ["apps/server/src", "apps/server/package.json"],
                network: false,
              },
              resolvedModel: "gpt-5.6-codex",
              resolvedReasoningEffort: "high",
              resolvedServiceTier: "priority",
              timeoutMinutes: 30,
              tokenBudget: 50_000,
              tokensUsed: 12_345,
              timeUsedSeconds: 83.5,
              createdAt: 3,
              startedAt: 4,
              lastActivityAt: 5,
              workspace: {
                lifecycle: "integrated",
                repositoryRoot: "/work/project",
                gitCommonDir: "/work/project/.git",
                worktreePath: "/work/project/.git/codexnest-team-worktrees/isolated",
                head: "a".repeat(40),
                baseline: {
                  "apps/server/src/api.ts": {
                    type: "file",
                    mode: 0o600,
                    digest: "b".repeat(64),
                  },
                  "apps/server/run": { type: "symlink", target: "scripts/run.sh" },
                },
                createdAt: 4,
                updatedAt: 6,
                changedPaths: ["apps/server/src/api.ts"],
              },
              result: {
                outcome: "success",
                summary: "Implemented and checked",
                details: "The scoped change is ready.",
                checks: [{ name: "state tests", outcome: "passed", details: "12 passed" }],
                risks: ["Integration still needs the root test suite."],
                artifacts: [
                  { label: "Patch", path: "apps/server/src/api.ts" },
                  { label: "Reference", url: "https://example.test/result/isolated" },
                ],
                source: "submitted",
              },
            },
            followup: {
              id: "followup",
              childThreadId: "isolated-child",
              title: "Follow-up task",
              prompt: "Continue after the delivered predecessor.",
              status: "failed",
              predecessorTaskId: "isolated",
              access: { mode: "readOnly", network: true },
              resolvedModel: "gpt-5.6-codex",
              resolvedReasoningEffort: null,
              resolvedServiceTier: null,
              timeoutMinutes: 5,
              tokenBudget: 1_000,
              tokensUsed: 1_001,
              timeUsedSeconds: 301,
              failureReason: "The hard task budget was exhausted.",
              budgetReason: "tokenBudget",
              createdAt: 7,
              lastActivityAt: 8,
              resultCandidate: {
                outcome: "partial",
                summary: "Stopped at the budget boundary",
                checks: [{ name: "typecheck", outcome: "notRun" }],
                submittedAt: 8,
                callId: "result-call",
              },
            },
          },
        },
      };
      state.teamToolOperations = {
        integration: {
          threadId: "parent",
          turnId: "parent-turn",
          callId: "integrate-call",
          tool: "integrate_task",
          argumentsHash: "c".repeat(64),
          status: "prepared",
          createdAt: 9,
          updatedAt: 9,
          taskId: "isolated",
        },
      };
    });

    const reloaded = new StateStore(path);
    await reloaded.load();
    expect(reloaded.snapshot().threadMeta.parent).toMatchObject({
      managedTeamToolsAvailable: true,
      teamOrchestration: {
        tasks: {
          legacy: {
            result: { summary: "Legacy result" },
          },
          isolated: {
            dependsOn: ["legacy"],
            access: { mode: "isolatedWrite", network: false },
            resolvedModel: "gpt-5.6-codex",
            timeoutMinutes: 30,
            tokenBudget: 50_000,
            tokensUsed: 12_345,
            workspace: {
              lifecycle: "integrated",
              changedPaths: ["apps/server/src/api.ts"],
              baseline: {
                "apps/server/src/api.ts": { mode: 0o600 },
              },
            },
            result: {
              outcome: "success",
              checks: [{ name: "state tests", outcome: "passed" }],
              artifacts: [
                { label: "Patch", path: "apps/server/src/api.ts" },
                { label: "Reference", url: "https://example.test/result/isolated" },
              ],
            },
          },
          followup: {
            predecessorTaskId: "isolated",
            budgetReason: "tokenBudget",
            failureReason: "The hard task budget was exhausted.",
            resultCandidate: { outcome: "partial" },
          },
        },
      },
    });
    expect(reloaded.snapshot().teamToolOperations?.integration).toMatchObject({
      tool: "integrate_task",
      status: "prepared",
      taskId: "isolated",
    });
  });

  it("migrates the latest versioned Team state to the single managed-tool contract", async () => {
    const { path } = await temporaryState();
    const state = validManagedTeamSerializedState();
    delete state.threadMeta.parent.managedTeamToolsAvailable;
    state.threadMeta.parent.teamToolsVersion = 2;
    await writeFile(path, JSON.stringify(state), "utf8");

    const store = new StateStore(path);
    await store.load();

    expect(store.snapshot().threadMeta.parent).toMatchObject({
      managedTeamToolsAvailable: true,
      teamOrchestration: { tasks: { task: { id: "task" } } },
    });
    expect("teamToolsVersion" in store.snapshot().threadMeta.parent!).toBe(false);
  });

  it("keeps empty legacy Team chats but retires their orchestration mode", async () => {
    const { path } = await temporaryState();
    const state = validManagedTeamSerializedState();
    delete state.threadMeta.parent.managedTeamToolsAvailable;
    state.threadMeta.parent.teamToolsVersion = 1;
    state.threadMeta.parent.settings = {
      collaborationMode: "team",
      model: "gpt-a",
      reasoningEffort: "high",
    };
    state.threadMeta.parent.teamOrchestration = { tasks: {} };
    await writeFile(path, JSON.stringify(state), "utf8");

    const store = new StateStore(path);
    await store.load();

    expect(store.snapshot().threadMeta.parent).toMatchObject({
      settings: { collaborationMode: "default" },
    });
    expect(store.snapshot().threadMeta.parent?.managedTeamToolsAvailable).toBeUndefined();
    expect(store.snapshot().threadMeta.parent?.teamOrchestration).toBeUndefined();
  });

  it("fails closed instead of discarding unfinished legacy Team work", async () => {
    const { path } = await temporaryState();
    const state = validManagedTeamSerializedState();
    delete state.threadMeta.parent.managedTeamToolsAvailable;
    state.threadMeta.parent.teamToolsVersion = 1;
    await writeFile(path, JSON.stringify(state), "utf8");

    await expect(new StateStore(path).load()).rejects.toThrow(
      "Unsupported unfinished legacy Team orchestration in CodexNest state",
    );
  });

  it("rejects malformed or pathologically unsafe managed Team task state", async () => {
    const cases: Array<[string, (state: any) => void]> = [
      [
        "invalid managed-tool capability",
        (state) => (state.threadMeta.parent.managedTeamToolsAvailable = false),
      ],
      [
        "missing dependency",
        (state) => (state.threadMeta.parent.teamOrchestration.tasks.task.dependsOn = ["missing"]),
      ],
      [
        "self dependency",
        (state) => (state.threadMeta.parent.teamOrchestration.tasks.task.dependsOn = ["task"]),
      ],
      [
        "dependency cycle",
        (state) => {
          state.threadMeta.parent.teamOrchestration.tasks.base.dependsOn = ["task"];
        },
      ],
      [
        "too many dependencies",
        (state) => {
          const tasks = state.threadMeta.parent.teamOrchestration.tasks;
          for (let index = 0; index < 51; index += 1) {
            const id = `dependency-${index}`;
            tasks[id] = managedTaskFixture(id, index + 10);
          }
          tasks.task.dependsOn = Object.keys(tasks).filter((id) => id.startsWith("dependency-"));
        },
      ],
      [
        "write path traversal",
        (state) =>
          (state.threadMeta.parent.teamOrchestration.tasks.task.access.writePaths = ["../api.ts"]),
      ],
      [
        "Git metadata write path",
        (state) =>
          (state.threadMeta.parent.teamOrchestration.tasks.task.access.writePaths = [
            "nested/.GiT/config",
          ]),
      ],
      [
        "read-only write path",
        (state) =>
          (state.threadMeta.parent.teamOrchestration.tasks.task.access = {
            mode: "readOnly",
            writePaths: ["apps"],
          }),
      ],
      [
        "invalid timeout",
        (state) => (state.threadMeta.parent.teamOrchestration.tasks.task.timeoutMinutes = 1_441),
      ],
      [
        "invalid token usage",
        (state) => (state.threadMeta.parent.teamOrchestration.tasks.task.tokensUsed = -1),
      ],
      [
        "oversized structured result",
        (state) => {
          state.threadMeta.parent.teamOrchestration.tasks.task.result.checks = Array.from(
            { length: 101 },
            (_, index) => ({ name: `check-${index}`, outcome: "passed" }),
          );
        },
      ],
      [
        "unsafe artifact URL",
        (state) =>
          (state.threadMeta.parent.teamOrchestration.tasks.task.result.artifacts = [
            { label: "secret", url: "file:///etc/passwd" },
          ]),
      ],
      [
        "external worktree",
        (state) =>
          (state.threadMeta.parent.teamOrchestration.tasks.task.workspace.worktreePath =
            "/work/other/task"),
      ],
      [
        "baseline traversal",
        (state) => {
          state.threadMeta.parent.teamOrchestration.tasks.task.workspace.baseline = {
            "../outside": { type: "file", mode: 0o644, digest: "b".repeat(64) },
          };
        },
      ],
      [
        "invalid baseline digest",
        (state) =>
          (state.threadMeta.parent.teamOrchestration.tasks.task.workspace.baseline[
            "apps/server/src/api.ts"
          ].digest = "short"),
      ],
      [
        "invalid baseline mode",
        (state) =>
          (state.threadMeta.parent.teamOrchestration.tasks.task.workspace.baseline[
            "apps/server/src/api.ts"
          ].mode = 0o1000),
      ],
    ];

    for (const [name, mutate] of cases) {
      const { path } = await temporaryState();
      const state = validManagedTeamSerializedState();
      mutate(state);
      await writeFile(path, JSON.stringify(state), "utf8");
      await expect(new StateStore(path).load(), name).rejects.toThrow(
        "Corrupt thread metadata in CodexNest state",
      );
    }
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
