import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

const faults = vi.hoisted(() => ({ failSync: false }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof FsPromises>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (faults.failSync && String(args[0]).endsWith(".upload")) {
        handle.sync = async () => {
          throw new Error("Injected disk sync failure");
        };
      }
      return handle;
    },
  };
});

import { AttachmentStore } from "./attachments";

const directories: string[] = [];
afterEach(async () => {
  faults.failSync = false;
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("durable attachments", () => {
  it("returns a complete attachment that can be reopened by a new store", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexnest-attachment-"));
    directories.push(root);
    const path = join(root, "state.sqlite");
    const attachment = await new AttachmentStore(path).save(
      "thread",
      "example.txt",
      "text/plain",
      Readable.from(["one", "two"]),
    );
    expect(await readFile(attachment.path, "utf8")).toBe("onetwo");
    expect(await new AttachmentStore(path).validate("thread", [attachment])).toEqual([attachment]);
  });

  it("does not acknowledge a file when persistence fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexnest-attachment-"));
    directories.push(root);
    const store = new AttachmentStore(join(root, "state.sqlite"));
    faults.failSync = true;
    await expect(
      store.save("thread", "example.txt", "text/plain", Readable.from(["keep in composer"])),
    ).rejects.toThrow("disk sync failure");
    const [threadDirectory] = await readdir(store.root);
    expect(await readdir(join(store.root, threadDirectory!))).toEqual([]);
  });
});
