import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink, utimes } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { TurnView } from "@codexnest/protocol";

const CACHE_SCHEMA_VERSION = 3;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const CLEANUP_INTERVAL_MS = 60_000;

export interface CachedTurnsPage {
  threadId: string;
  cursor: string | null;
  direction: "asc" | "desc";
  threadUpdatedAt: number;
  historyRevision: number;
  turns: TurnView[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}

type StoredTurnsPage = CachedTurnsPage & {
  schemaVersion: typeof CACHE_SCHEMA_VERSION;
};

export class HistoryCache {
  private cleanupStartedAt = 0;

  constructor(
    statePath: string,
    private readonly maxBytes = DEFAULT_MAX_BYTES,
  ) {
    this.directory = `${statePath}.history-cache`;
  }

  private readonly directory: string;

  async get(
    threadId: string,
    cursor: string | null,
    direction: CachedTurnsPage["direction"],
  ): Promise<CachedTurnsPage | null> {
    const path = this.pagePath(threadId, cursor, direction);
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (!isStoredTurnsPage(parsed, threadId, cursor, direction)) {
        await unlink(path).catch(() => undefined);
        return null;
      }
      const now = new Date();
      void utimes(path, now, now).catch(() => undefined);
      return {
        threadId: parsed.threadId,
        cursor: parsed.cursor,
        direction: parsed.direction,
        threadUpdatedAt: parsed.threadUpdatedAt,
        historyRevision: parsed.historyRevision,
        turns: parsed.turns,
        nextCursor: parsed.nextCursor,
        backwardsCursor: parsed.backwardsCursor,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await unlink(path).catch(() => undefined);
      }
      return null;
    }
  }

  async set(page: CachedTurnsPage): Promise<void> {
    const target = this.pagePath(page.threadId, page.cursor, page.direction);
    const parent = dirname(target);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const temporary = join(parent, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(
        `${JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION, ...page })}\n`,
        "utf8",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, target);
      const directory = await open(parent, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    void this.cleanup().catch(() => undefined);
  }

  async invalidateThread(threadId: string): Promise<void> {
    await rm(this.threadDirectory(threadId), { recursive: true, force: true });
  }

  private async cleanup(): Promise<void> {
    const now = Date.now();
    if (now - this.cleanupStartedAt < CLEANUP_INTERVAL_MS) return;
    this.cleanupStartedAt = now;
    const threadDirectories = await readdir(this.directory, { withFileTypes: true }).catch(
      () => [],
    );
    const entries = (
      await Promise.all(
        threadDirectories
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => {
            const directory = join(this.directory, entry.name);
            const files = await readdir(directory).catch(() => []);
            return Promise.all(
              files
                .filter((file) => file.endsWith(".json"))
                .map(async (file) => {
                  const path = join(directory, file);
                  const details = await stat(path).catch(() => null);
                  return details
                    ? { path, bytes: details.size, accessedAt: details.atimeMs || details.mtimeMs }
                    : null;
                }),
            );
          }),
      )
    )
      .flat()
      .filter((entry): entry is { path: string; bytes: number; accessedAt: number } => !!entry);
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    if (total <= this.maxBytes) return;
    entries.sort((left, right) => left.accessedAt - right.accessedAt);
    for (const entry of entries) {
      if (total <= this.maxBytes) break;
      await unlink(entry.path).catch(() => undefined);
      total -= entry.bytes;
    }
  }

  private pagePath(
    threadId: string,
    cursor: string | null,
    direction: CachedTurnsPage["direction"],
  ): string {
    const key = digest(`${direction}\0${cursor ?? ""}`);
    return join(this.threadDirectory(threadId), `${key}.json`);
  }

  private threadDirectory(threadId: string): string {
    return join(this.directory, digest(threadId));
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isStoredTurnsPage(
  value: unknown,
  threadId: string,
  cursor: string | null,
  direction: CachedTurnsPage["direction"],
): value is StoredTurnsPage {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === CACHE_SCHEMA_VERSION &&
    value.threadId === threadId &&
    value.cursor === cursor &&
    value.direction === direction &&
    typeof value.threadUpdatedAt === "number" &&
    typeof value.historyRevision === "number" &&
    Array.isArray(value.turns) &&
    (value.nextCursor === null || typeof value.nextCursor === "string") &&
    (value.backwardsCursor === null || typeof value.backwardsCursor === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
