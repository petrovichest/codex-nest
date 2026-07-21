import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { readGitChanges } from "./git-changes";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("readGitChanges", () => {
  it("reports clean repositories", async () => {
    const directory = await createRepository();
    await expect(readGitChanges(directory)).resolves.toEqual({
      state: "clean",
      filesChanged: 0,
      additions: 0,
      deletions: 0,
    });
  });

  it("combines staged, unstaged, untracked, deleted, renamed and binary changes", async () => {
    const directory = await createRepository();
    await writeFile(join(directory, "tracked.txt"), "one\nchanged\nadded\n");
    await git(directory, "add", "tracked.txt");
    await writeFile(join(directory, "tracked.txt"), "one\nchanged\nadded\nworking\n");
    await rm(join(directory, "deleted.txt"));
    await git(directory, "mv", "before.txt", "after.txt");
    await writeFile(join(directory, "untracked.txt"), "new one\nnew two");
    await writeFile(join(directory, "untracked.bin"), Buffer.from([0, 1, 2, 3]));

    await expect(readGitChanges(directory)).resolves.toEqual({
      state: "dirty",
      filesChanged: 5,
      additions: 5,
      deletions: 3,
    });
  });

  it("counts files in repositories without a first commit", async () => {
    const directory = await createEmptyRepository();
    await writeFile(join(directory, "staged.txt"), "first\nsecond\n");
    await git(directory, "add", "staged.txt");
    await writeFile(join(directory, "untracked.txt"), "third");

    await expect(readGitChanges(directory)).resolves.toEqual({
      state: "dirty",
      filesChanged: 2,
      additions: 3,
      deletions: 0,
    });
  });

  it("returns a normal state outside a Git repository", async () => {
    const directory = await temporaryDirectory("codexnest-not-git-");
    await expect(readGitChanges(directory)).resolves.toEqual({
      state: "notRepository",
      filesChanged: 0,
      additions: 0,
      deletions: 0,
    });
  });

  it("surfaces Git execution failures and timeouts", async () => {
    const directory = await temporaryDirectory("codexnest-git-failure-");
    await expect(
      readGitChanges(directory, { binary: join(directory, "missing-git") }),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const slowGit = join(directory, "slow-git");
    await writeFile(slowGit, "#!/bin/sh\nsleep 1\n");
    await chmod(slowGit, 0o700);
    await expect(
      readGitChanges(directory, { binary: slowGit, timeoutMs: 10 }),
    ).rejects.toMatchObject({ killed: true });
  });
});

async function createRepository(): Promise<string> {
  const directory = await createEmptyRepository();
  await writeFile(join(directory, "tracked.txt"), "one\nold\n");
  await writeFile(join(directory, "deleted.txt"), "gone one\ngone two\n");
  await writeFile(join(directory, "before.txt"), "same\n");
  await git(directory, "add", ".");
  await git(
    directory,
    "-c",
    "user.name=CodexNest Test",
    "-c",
    "user.email=test@codexnest.invalid",
    "commit",
    "-m",
    "initial",
  );
  return directory;
}

async function createEmptyRepository(): Promise<string> {
  const directory = await temporaryDirectory("codexnest-git-test-");
  await git(directory, "init", "--quiet");
  return directory;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args]);
}
