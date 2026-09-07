import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { HistoryCache, type CachedTurnsPage } from "./history-cache";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("retains dialogue in cached pages and rejects pages from the old summary-only schema", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-history-cache-test-"));
  directories.push(directory);
  const statePath = join(directory, "state.json");
  const cache = new HistoryCache(statePath);
  const page: CachedTurnsPage = {
    threadId: "thread",
    cursor: null,
    direction: "desc",
    threadUpdatedAt: 20,
    historyRevision: 0,
    nextCursor: null,
    backwardsCursor: null,
    turns: [
      {
        id: "turn",
        status: "completed",
        startedAt: 10,
        completedAt: 20,
        durationMs: 10,
        itemsLoaded: false,
        progress: {
          startedAt: 10,
          explanation: null,
          steps: [],
          filesChanged: 0,
          additions: 0,
          deletions: 0,
        },
        items: [
          {
            type: "agentMessage",
            id: "reply",
            status: "completed",
            phase: "commentary",
            text: "Пояснение между квизами",
            images: [],
            timestamp: 15,
          },
        ],
      },
    ],
  };
  await cache.set(page);
  expect(await new HistoryCache(statePath).get("thread", null, "desc")).toEqual(page);
  const cacheRoot = `${statePath}.history-cache`;
  const [threadDirectory] = await readdir(cacheRoot);
  const parent = join(cacheRoot, threadDirectory!);
  const [filename] = await readdir(parent);
  const path = join(parent, filename!);
  const oldPage = JSON.parse(await readFile(path, "utf8"));
  oldPage.schemaVersion = 3;
  oldPage.turns[0].items = [];
  await writeFile(path, JSON.stringify(oldPage));
  expect(await new HistoryCache(statePath).get("thread", null, "desc")).toBeNull();
});
