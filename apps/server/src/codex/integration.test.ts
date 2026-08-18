import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { hasForkMaterializedCompaction, readFreshCompaction } from "../fork-rollout";
import { CodexBridge } from "./bridge";
import type { ServerNotification } from "./generated/index";
import type {
  ThreadForkResponse,
  ThreadReadResponse,
  ThreadStartResponse,
  ThreadTurnsListResponse,
  Turn,
} from "./generated/v2/index";
import type { JsonlProcess } from "./transport";

const enabled = process.env.RUN_CODEX_INTEGRATION === "1";

describe.skipIf(!enabled)("real Codex CLI integration", () => {
  it("initializes the installed CLI and reads one thread/list page without starting a model turn", async () => {
    const bridge = realBridge();
    let lastDetail: unknown;
    bridge.on("state", (_state, detail) => {
      lastDetail = detail;
    });
    await bridge.start();
    expect(bridge.state, JSON.stringify(lastDetail)).toBe("ready");
    const page = await bridge.request<{ data: unknown[]; nextCursor: string | null }>(
      "thread/list",
      { limit: 1, sortKey: "updated_at", sortDirection: "desc", archived: false },
      30_000,
    );
    expect(Array.isArray(page.data)).toBe(true);
    bridge.stop();
  }, 45_000);

  it(
    "injects native compaction unchanged and completes a context-aware follow-up turn",
    async () => {
      const bridge = realBridge();
      const threadIds: string[] = [];
      const sentinel = `CODEXNEST-COMPACT-${randomUUID()}`;
      let acceptanceDirectory: string | null = null;
      const cleanupErrors: string[] = [];
      let testError: unknown;
      let lastDetail: unknown;
      bridge.on("state", (_state, detail) => {
        lastDetail = detail;
      });

      try {
        await bridge.start();
        expect(bridge.state, JSON.stringify(lastDetail)).toBe("ready");
        const requestedSourcePath =
          process.env.RUN_CODEX_COMPACTION_ACCEPTANCE === "1"
            ? process.env.CODEXNEST_COMPACTION_SOURCE_PATH
            : undefined;
        if (process.env.RUN_CODEX_COMPACTION_ACCEPTANCE === "1" && !requestedSourcePath) {
          throw new Error("CODEXNEST_COMPACTION_SOURCE_PATH is required for compaction acceptance");
        }
        const acceptanceSourcePath = requestedSourcePath
          ? await (async () => {
              acceptanceDirectory = await mkdtemp(
                join(
                  process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
                  "codexnest-compaction-acceptance-",
                ),
              );
              const snapshot = join(acceptanceDirectory, basename(requestedSourcePath));
              await copyFile(requestedSourcePath, snapshot);
              return snapshot;
            })()
          : undefined;
        const originalSource = acceptanceSourcePath ? await stat(acceptanceSourcePath) : null;
        const source = acceptanceSourcePath
          ? await bridge.request<ThreadForkResponse>(
              "thread/fork",
              {
                threadId: "ignored-when-path-is-present",
                path: acceptanceSourcePath,
                excludeTurns: true,
                approvalPolicy: "never",
                sandbox: "read-only",
                developerInstructions:
                  "Automated compaction integration test. Do not use tools, access files, or browse. Answer only as requested.",
                threadSource: `codexnest-compact-acceptance:${sentinel}`,
              },
              300_000,
            )
          : await startIntegrationThread(bridge, {
              threadSource: `codexnest-compact-source:${sentinel}`,
            });
        if (acceptanceSourcePath) {
          expect(source.thread.path).toBeTruthy();
          expect(resolve(source.thread.path!)).not.toBe(resolve(acceptanceSourcePath));
          expect(source.thread.id).not.toBe(sessionIdFromRolloutPath(acceptanceSourcePath));
        }
        threadIds.push(source.thread.id);
        if (!acceptanceSourcePath) {
          await materializeIntegrationThread(bridge, source.thread.id);
        }
        const sourceTurn = await waitForCompletedTurn(bridge, source.thread.id, () =>
          bridge.request(
            "turn/start",
            {
              threadId: source.thread.id,
              input: [
                {
                  type: "text",
                  text: `Remember this exact code for a later context-transfer check: ${sentinel}. Reply only ACK.`,
                  text_elements: [],
                },
              ],
              effort: "low",
            },
            300_000,
          ),
        );
        expect(sourceTurn.status).toBe("completed");

        const sourceRead = await bridge.request<ThreadReadResponse>(
          "thread/read",
          { threadId: source.thread.id, includeTurns: false },
          30_000,
        );
        expect(sourceRead.thread.path).toBeTruthy();
        const sourcePath = sourceRead.thread.path!;
        const compactStartBytes = (await stat(sourcePath)).size;
        if (acceptanceSourcePath) {
          expect(compactStartBytes).toBeGreaterThanOrEqual(200 * 1024 * 1024);
        }
        const compactTurn = await waitForCompletedTurn(bridge, source.thread.id, () =>
          bridge.request("thread/compact/start", { threadId: source.thread.id }, 300_000),
        );
        expect(compactTurn.status).toBe("completed");
        const replacement = await readFreshCompaction(sourcePath, compactStartBytes);
        expect(replacement).not.toBeNull();
        const replacementBytes = Buffer.byteLength(JSON.stringify(replacement));
        const replacementDigest = digest(replacement);
        if (acceptanceSourcePath) {
          expect(replacementBytes).toBeLessThanOrEqual(5 * 1024 * 1024);
        }
        const compactItem = replacement!.at(-1)!;
        expect(compactItem.type).toBe("compaction");
        expect(typeof compactItem.encrypted_content).toBe("string");
        const witness = {
          id: typeof compactItem.id === "string" ? compactItem.id : null,
          encryptedContent: String(compactItem.encrypted_content),
        };

        const target = await startIntegrationThread(bridge, {
          model: source.model,
          modelProvider: source.modelProvider,
          cwd: source.cwd,
          threadSource: `codexnest-compact-target:${sentinel}`,
        });
        expect(target.thread.id).not.toBe(source.thread.id);
        threadIds.push(target.thread.id);
        await materializeIntegrationThread(bridge, target.thread.id);
        await bridge.request(
          "thread/inject_items",
          { threadId: target.thread.id, items: replacement },
          300_000,
        );
        expect(digest(replacement)).toBe(replacementDigest);
        const targetRead = await bridge.request<ThreadReadResponse>(
          "thread/read",
          { threadId: target.thread.id, includeTurns: false },
          30_000,
        );
        expect(targetRead.thread.path).toBeTruthy();
        if (acceptanceSourcePath) {
          expect(resolve(targetRead.thread.path!)).not.toBe(resolve(acceptanceSourcePath));
        }
        await expect(hasForkMaterializedCompaction(targetRead.thread.path, witness)).resolves.toBe(
          true,
        );
        const targetBytes = (await stat(targetRead.thread.path!)).size;
        const materialized = await materializedResponseItems(targetRead.thread.path!);
        expect(materialized.slice(-replacement!.length)).toEqual(replacement);
        if (acceptanceSourcePath) {
          expect(targetBytes).toBeLessThanOrEqual(5 * 1024 * 1024);
          expect(targetBytes).toBeLessThanOrEqual(replacementBytes + 1024 * 1024);
        } else {
          expect(targetBytes).toBeLessThan(1024 * 1024);
        }

        const followUp = await waitForCompletedTurn(bridge, target.thread.id, () =>
          bridge.request(
            "turn/start",
            {
              threadId: target.thread.id,
              input: [
                {
                  type: "text",
                  text: "Reply only with the exact code you were asked to remember before compaction.",
                  text_elements: [],
                },
              ],
              effort: "low",
            },
            300_000,
          ),
        );
        expect(followUp.status).toBe("completed");
        const turns = await bridge.request<ThreadTurnsListResponse>(
          "thread/turns/list",
          {
            threadId: target.thread.id,
            limit: 10,
            sortDirection: "desc",
            itemsView: "full",
          },
          30_000,
        );
        const completed = turns.data.find((turn) => turn.id === followUp.id) ?? followUp;
        const answer = completed.items
          .filter((item) => item.type === "agentMessage")
          .map((item) => item.text)
          .join("\n");
        expect(answer).toContain(sentinel);
        if (acceptanceSourcePath && originalSource) {
          const unchangedSource = await stat(acceptanceSourcePath);
          expect(unchangedSource.size).toBe(originalSource.size);
          expect(unchangedSource.mtimeMs).toBe(originalSource.mtimeMs);
          expect(unchangedSource.ino).toBe(originalSource.ino);
        }
      } catch (error) {
        testError = error;
      } finally {
        for (const threadId of threadIds.reverse()) {
          try {
            await bridge.request("thread/delete", { threadId }, 30_000);
          } catch (error) {
            cleanupErrors.push(`thread ${threadId}: ${String(error)}`);
          }
        }
        bridge.stop();
        if (acceptanceDirectory) {
          try {
            await rm(acceptanceDirectory, { recursive: true, force: true });
          } catch (error) {
            cleanupErrors.push(`snapshot ${acceptanceDirectory}: ${String(error)}`);
          }
        }
      }
      if (cleanupErrors.length) {
        const cleanupError = new Error(
          `Compaction integration cleanup failed: ${cleanupErrors.join("; ")}`,
        );
        if (testError) {
          throw new AggregateError([testError, cleanupError], "Compaction integration failed");
        }
        throw cleanupError;
      }
      if (testError) throw testError;
    },
    10 * 60_000,
  );
});

function realBridge(): CodexBridge {
  const codexBin = process.env.CODEXNEST_CODEX_BIN ?? "codex";
  return new CodexBridge({
    codexBin,
    spawnProcess: () =>
      spawn(codexBin, ["app-server", "--listen", "stdio://"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      }) as unknown as JsonlProcess,
  });
}

async function startIntegrationThread(
  bridge: CodexBridge,
  overrides: {
    model?: string;
    modelProvider?: string;
    cwd?: string;
    threadSource?: string;
  } = {},
): Promise<ThreadStartResponse> {
  return bridge.request<ThreadStartResponse>(
    "thread/start",
    {
      cwd: overrides.cwd ?? process.cwd(),
      model: overrides.model,
      modelProvider: overrides.modelProvider,
      approvalPolicy: "never",
      sandbox: "read-only",
      environments: [],
      dynamicTools: [],
      threadSource: overrides.threadSource,
      developerInstructions:
        "Automated compaction integration test. Do not use tools, access files, or browse. Answer only as requested.",
    },
    30_000,
  );
}

async function materializeIntegrationThread(bridge: CodexBridge, threadId: string): Promise<void> {
  await bridge.request("thread/metadata/update", { threadId, gitInfo: { sha: null } }, 30_000);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function materializedResponseItems(path: string): Promise<Record<string, unknown>[]> {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
    .flatMap((entry) => {
      if (
        typeof entry === "object" &&
        entry !== null &&
        "type" in entry &&
        entry.type === "response_item" &&
        "payload" in entry &&
        typeof entry.payload === "object" &&
        entry.payload !== null &&
        !Array.isArray(entry.payload)
      ) {
        return [entry.payload as Record<string, unknown>];
      }
      return [];
    });
}

function sessionIdFromRolloutPath(path: string): string | null {
  return (
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(path)?.[1] ?? null
  );
}

function waitForCompletedTurn(
  bridge: CodexBridge,
  threadId: string,
  start: () => Promise<unknown>,
): Promise<Turn> {
  return new Promise<Turn>((resolve, reject) => {
    const timer = setTimeout(
      () => finish(undefined, new Error("Timed out waiting for turn")),
      300_000,
    );
    const finish = (turn?: Turn, error?: Error) => {
      clearTimeout(timer);
      bridge.off("notification", onNotification);
      if (error) reject(error);
      else resolve(turn!);
    };
    const onNotification = (notification: ServerNotification) => {
      if (notification.method !== "turn/completed" || notification.params.threadId !== threadId) {
        return;
      }
      finish(notification.params.turn);
    };
    bridge.on("notification", onNotification);
    void start().catch((error: unknown) =>
      finish(undefined, error instanceof Error ? error : new Error(String(error))),
    );
  });
}
