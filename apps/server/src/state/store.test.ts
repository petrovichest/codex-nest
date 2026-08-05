import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActivityItem, ThreadDetail } from "@codexnest/protocol";

import { StateStore } from "./store";

const directories: string[] = [];
async function temporaryState(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-state-test-"));
  directories.push(directory);
  return { directory, path: join(directory, "state.json") };
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function projectedDetail(turnCount: number): ThreadDetail {
  return {
    summary: {
      id: "thread",
      projectId: null,
      title: "Thread",
      preview: "",
      cwd: "/work",
      state: "idle",
      unread: false,
      unseen: false,
      pinned: false,
      archived: false,
      createdAt: 1,
      updatedAt: 2,
      currentTurnId: null,
      queuedMessageCount: 0,
      settings: { collaborationMode: "default" },
      relation: { kind: "session", sessionId: "thread" },
    },
    turns: Array.from({ length: turnCount }, (_, index) => ({
      id: `turn-${index}`,
      status: "completed" as const,
      startedAt: index,
      completedAt: index + 1,
      durationMs: 1,
      progress: {
        startedAt: index,
        explanation: null,
        steps: [],
        filesChanged: 0,
        additions: 0,
        deletions: 0,
      },
      items: [],
      itemsLoaded: false,
    })),
    queuedMessages: [],
    olderTurnsCursor: null,
    draft: null,
  };
}

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

function validTeamV2SerializedState(): any {
  return {
    schemaVersion: 1,
    auth: {},
    projects: [],
    threadMeta: {
      parent: {
        pinned: false,
        lastReadUpdatedAt: 0,
        teamToolsVersion: 2,
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
    const reloaded = new StateStore(path);
    await reloaded.load();
    expect(reloaded.snapshot()).toMatchObject({ schemaVersion: 1 });
    reloaded.close();
  });

  it("rejects corrupt and unsupported schemas", async () => {
    const { path } = await temporaryState();
    await writeFile(path, '{"schemaVersion":2}', "utf8");
    await expect(new StateStore(path).load()).rejects.toThrow("Unsupported or corrupt");
    expect(await readFile(path, "utf8")).toBe('{"schemaVersion":2}');
    expect(await readdir(join(path, ".."))).toEqual(["state.json"]);
  });

  it("imports sibling JSON through a durable backup and preserves WAL projection cursors", async () => {
    const { directory } = await temporaryState();
    const legacyPath = join(directory, "state.json");
    const sqlitePath = join(directory, "state.sqlite");
    const serialized = JSON.stringify({
      schemaVersion: 1,
      auth: {},
      projects: [],
      threadMeta: {},
      devices: {},
      uiLanguage: "ru",
    });
    await writeFile(legacyPath, serialized, { mode: 0o600 });

    const store = new StateStore(sqlitePath);
    await store.load();
    expect(store.snapshot().uiLanguage).toBe("ru");
    expect(await readFile(join(directory, "state.json.pre-sqlite.json"), "utf8")).toBe(serialized);
    expect((await readFile(sqlitePath)).subarray(0, 16).toString("binary")).toBe(
      "SQLite format 3\0",
    );

    store.commitProjection({ value: "snapshot" }, { type: "first" });
    const cursor = store.projectionCursor();
    store.close();

    const database = new DatabaseSync(sqlitePath, { readOnly: true });
    expect(database.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    database.close();
    const reloaded = new StateStore(sqlitePath);
    await reloaded.load();
    expect(reloaded.projectionCursor()).toEqual(cursor);
    expect(reloaded.projection<{ value: string }>().snapshot).toMatchObject({
      value: "snapshot",
      epoch: cursor.epoch,
      revision: cursor.revision,
    });
    reloaded.close();
  });

  it("rolls snapshot, revision, and journal back together when a patch cannot serialize", async () => {
    const { path } = await temporaryState();
    const store = new StateStore(path);
    await store.load();
    store.commitProjection({ value: "stable" }, { type: "stable" });
    const before = store.projection<{ value: string }>();

    expect(() =>
      store.commitProjection({ value: "partial" }, { type: "broken", value: 1n }),
    ).toThrow();

    expect(store.projection()).toEqual(before);
    expect(store.replayProjection(before)).toEqual([]);
    store.close();
  });

  it("rotates the epoch after a rollback restore without rewinding the revision", async () => {
    const { path } = await temporaryState();
    const store = new StateStore(path);
    await store.load();
    const committed = store.commitProjection({ value: "before-rollback" }, { type: "first" });
    store.close();

    await writeFile(`${path}.rotate-epoch`, "", { mode: 0o600 });
    const restored = new StateStore(path);
    await restored.load();
    const cursor = restored.projectionCursor();
    expect(cursor.revision).toBe(committed.revision);
    expect(cursor.epoch).not.toBe(committed.epoch);
    expect(restored.projection().snapshot).toMatchObject(cursor);
    expect(restored.replayProjection(committed)).toBeNull();
    restored.close();
  });

  it("falls back to a snapshot before replay can exceed the websocket frame budget", async () => {
    const { path } = await temporaryState();
    const store = new StateStore(path);
    await store.load();
    const cursor = store.projectionCursor();
    store.commitProjection({}, { type: "large", value: "x".repeat(800_000) });
    store.commitProjection({}, { type: "large", value: "y".repeat(800_000) });
    expect(store.replayProjection(cursor)).toBeNull();
    store.close();
  });

  it("keeps at least 24 hours and the last 50000 revisions before pruning replay", async () => {
    const { path } = await temporaryState();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = new StateStore(path);
    await store.load();
    const first = store.commitProjection({}, { type: "first" });
    vi.setSystemTime(24 * 60 * 60 * 1_000 + 1);
    const second = store.commitProjection({}, { type: "second" });
    expect(store.replayProjection({ epoch: first.epoch, revision: 0 })).toEqual([first, second]);
    expect(store.replayProjection({ epoch: second.epoch, revision: 1 })).toEqual([second]);
    store.close();

    const database = new DatabaseSync(path);
    database.prepare("UPDATE projection_meta SET revision = 50001 WHERE id = 1").run();
    database.close();
    const reloaded = new StateStore(path);
    await reloaded.load();
    const capped = reloaded.commitProjection({}, { type: "capped" });
    expect(capped.revision).toBe(50_002);
    expect(reloaded.replayProjection({ epoch: capped.epoch, revision: 0 })).toBeNull();
    expect(reloaded.replayProjection({ epoch: capped.epoch, revision: 50_001 })).toEqual([capped]);
    reloaded.close();
    const inspected = new DatabaseSync(path, { readOnly: true });
    expect(
      inspected.prepare("SELECT 1 FROM projection_events WHERE revision = 1").get(),
    ).toBeUndefined();
    expect(inspected.prepare("SELECT 1 FROM projection_events WHERE revision = 2").get()).toEqual({
      1: 1,
    });
    inspected.close();
    vi.useRealTimers();
  });

  it("keeps the last 20 turns, persists lazy technical items, and tombstones removals", async () => {
    const { path } = await temporaryState();
    const store = new StateStore(path);
    await store.load();
    const detail = projectedDetail(25);
    store.saveThreadProjection("thread", detail);
    expect(store.threadProjection<ThreadDetail>("thread")?.turns.map((turn) => turn.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `turn-${index + 5}`),
    );

    const command: ActivityItem = {
      type: "command",
      id: "technical",
      status: "completed",
      kind: "command",
      command: "npm test",
      cwd: "/work",
      output: "ok",
      exitCode: 0,
    };
    store.saveThreadItems("thread", "turn-24", [command]);
    const refreshed = projectedDetail(25);
    refreshed.turns[24]!.items = [
      {
        type: "agentMessage",
        id: "answer",
        status: "completed",
        text: "Done",
        images: [],
        timestamp: 25,
        phase: "final_answer",
      },
    ];
    store.saveThreadProjection("thread", refreshed);
    expect(store.threadProjection<ThreadDetail>("thread")?.turns.at(-1)).toMatchObject({
      id: "turn-24",
      itemsLoaded: true,
      items: [{ id: "technical" }, { id: "answer" }],
    });

    store.commitProjection({}, { type: "thread.removed", threadId: "thread" });
    store.commitProjection({}, { type: "thread.upserted", thread: detail.summary });
    expect(store.threadProjection("thread")).toBeNull();
    store.close();
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

  it("round-trips additive Team v2 task state while retaining v1 tasks", async () => {
    const { path } = await temporaryState();
    const store = new StateStore(path);
    await store.load();
    await store.update((state) => {
      state.threadMeta.parent = {
        pinned: false,
        lastReadUpdatedAt: 0,
        teamToolsVersion: 2,
        teamOrchestration: {
          tasks: {
            legacy: {
              id: "legacy",
              childThreadId: "legacy-child",
              title: "Legacy task",
              prompt: "Keep the v1 shape valid.",
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
      teamToolsVersion: 2,
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

  it("rejects malformed or pathologically unsafe Team v2 task state", async () => {
    const cases: Array<[string, (state: any) => void]> = [
      ["unsupported tool version", (state) => (state.threadMeta.parent.teamToolsVersion = 3)],
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
      const state = validTeamV2SerializedState();
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
    const external = new StateStore(path);
    await external.load();
    await external.update((state) => {
      state.auth.tokenSha256 = "a".repeat(64);
    });
    external.close();
    const revoked = new Promise<void>((resolve) => store.once("authRotated", resolve));
    await expect(store.refreshAuthVerifier()).resolves.toBe(true);
    await revoked;
    expect(store.snapshot().auth.tokenSha256).toBe("a".repeat(64));
  });
});
