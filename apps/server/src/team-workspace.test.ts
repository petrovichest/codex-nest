import { execFile } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  computeTeamWorkspaceDelta,
  createTeamWorkspace,
  discardTeamWorkspace,
  integrateTeamWorkspace,
  TeamWorkspaceConflictError,
  TeamWorkspacePathError,
  validateTeamWorkspaceWritePaths,
} from "./team-workspace";
import type { TeamWorkspaceError } from "./team-workspace";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Team Git workspaces", () => {
  it("rejects non-Git and unborn repositories with typed errors", async () => {
    const plain = await temporaryDirectory("codexnest-team-plain-");
    await expect(createTeamWorkspace(plain, "plain")).rejects.toMatchObject<
      Partial<TeamWorkspaceError>
    >({ code: "not_repository" });

    const unborn = await temporaryDirectory("codexnest-team-unborn-");
    await git(unborn, "init", "--quiet");
    await expect(createTeamWorkspace(unborn, "unborn")).rejects.toMatchObject<
      Partial<TeamWorkspaceError>
    >({ code: "unborn_repository" });
  });

  it("creates a clean detached worktree beneath the Git common directory", async () => {
    const repository = await createRepository({ "tracked.txt": "committed\n" });
    const workspace = await createTeamWorkspace(repository, "clean task");

    expect(workspace.worktreePath.startsWith(`${workspace.gitCommonDir}/`)).toBe(true);
    await expect(readFile(join(workspace.worktreePath, "tracked.txt"), "utf8")).resolves.toBe(
      "committed\n",
    );
    await expect(gitOutput(workspace.worktreePath, "status", "--porcelain")).resolves.toBe("");
    await expect(
      execFileAsync("git", ["-C", workspace.worktreePath, "symbolic-ref", "-q", "HEAD"]),
    ).rejects.toMatchObject({ code: 1 });
    await expect(computeTeamWorkspaceDelta(workspace)).resolves.toEqual({
      changedPaths: [],
      changes: [],
    });
  });

  it("overlays staged, unstaged, untracked, deleted, binary, mode and symlink state", async () => {
    const repository = await createRepository({
      ".gitignore": "ignored.txt\n",
      "binary.bin": Buffer.from([0, 1, 2]),
      "deleted.txt": "delete me\n",
      "script.sh": "#!/bin/sh\nexit 0\n",
      "staged.txt": "committed\n",
      "target-one.txt": "one\n",
      "target-two.txt": "two\n",
    });
    await symlink("target-one.txt", join(repository, "link"));
    await git(repository, "add", "link");
    await commit(repository, "add symlink");

    await writeFile(join(repository, "staged.txt"), "staged\n");
    await git(repository, "add", "staged.txt");
    await writeFile(join(repository, "staged.txt"), "staged and unstaged\n");
    await unlink(join(repository, "deleted.txt"));
    await writeFile(join(repository, "binary.bin"), Buffer.from([255, 0, 128, 64]));
    await chmod(join(repository, "script.sh"), 0o755);
    await unlink(join(repository, "link"));
    await symlink("target-two.txt", join(repository, "link"));
    await writeFile(join(repository, "untracked.txt"), "untracked\n");
    await writeFile(join(repository, "ignored.txt"), "ignored\n");

    const indexBefore = await readFile(join(repository, ".git", "index"));
    const workspace = await createTeamWorkspace(repository, "dirty");

    await expect(readFile(join(workspace.worktreePath, "staged.txt"), "utf8")).resolves.toBe(
      "staged and unstaged\n",
    );
    await expect(access(join(workspace.worktreePath, "deleted.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(workspace.worktreePath, "binary.bin"))).resolves.toEqual(
      Buffer.from([255, 0, 128, 64]),
    );
    expect((await lstat(join(workspace.worktreePath, "script.sh"))).mode & 0o111).not.toBe(0);
    await expect(readlink(join(workspace.worktreePath, "link"))).resolves.toBe("target-two.txt");
    await expect(readFile(join(workspace.worktreePath, "untracked.txt"), "utf8")).resolves.toBe(
      "untracked\n",
    );
    await expect(access(join(workspace.worktreePath, "ignored.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(repository, ".git", "index"))).toEqual(indexBefore);
    expect((await computeTeamWorkspaceDelta(workspace)).changedPaths).toEqual([]);
  });

  it("computes and integrates file, binary, mode, symlink, deletion and creation deltas", async () => {
    const repository = await createRepository({
      "already.txt": "baseline\n",
      "binary.bin": Buffer.from([1, 2, 3]),
      "deleted.txt": "old\n",
      "script.sh": "#!/bin/sh\n",
      "target.txt": "target\n",
      "text.txt": "old text\n",
    });
    await symlink("target.txt", join(repository, "link"));
    await git(repository, "add", "link");
    await commit(repository, "add link");
    const workspace = await createTeamWorkspace(repository, "integrate");

    await writeFile(join(workspace.worktreePath, "already.txt"), "final\n");
    await writeFile(join(workspace.worktreePath, "binary.bin"), Buffer.from([0, 255, 0, 9]));
    await unlink(join(workspace.worktreePath, "deleted.txt"));
    await chmod(join(workspace.worktreePath, "script.sh"), 0o755);
    await writeFile(join(workspace.worktreePath, "text.txt"), "new text\n");
    await unlink(join(workspace.worktreePath, "link"));
    await symlink("text.txt", join(workspace.worktreePath, "link"));
    await mkdir(join(workspace.worktreePath, "new-dir"));
    await writeFile(join(workspace.worktreePath, "new-dir", "new.txt"), "new\n");

    // A path independently changed to exactly the child's result is an idempotent no-op.
    await writeFile(join(repository, "already.txt"), "final\n");
    const indexBefore = await readFile(join(repository, ".git", "index"));
    const expectedPaths = [
      "already.txt",
      "binary.bin",
      "deleted.txt",
      "link",
      "new-dir/new.txt",
      "script.sh",
      "text.txt",
    ];
    expect((await computeTeamWorkspaceDelta(workspace)).changedPaths).toEqual(expectedPaths);

    const result = await integrateTeamWorkspace(workspace, [
      "already.txt",
      "binary.bin",
      "deleted.txt",
      "link",
      "new-dir",
      "script.sh",
      "text.txt",
    ]);

    expect(result.changedPaths).toEqual(expectedPaths);
    expect(result.alreadyAppliedPaths).toEqual(["already.txt"]);
    expect(result.appliedPaths).toEqual(expectedPaths.filter((path) => path !== "already.txt"));
    await expect(readFile(join(repository, "text.txt"), "utf8")).resolves.toBe("new text\n");
    await expect(readFile(join(repository, "binary.bin"))).resolves.toEqual(
      Buffer.from([0, 255, 0, 9]),
    );
    await expect(access(join(repository, "deleted.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readlink(join(repository, "link"))).resolves.toBe("text.txt");
    await expect(readFile(join(repository, "new-dir", "new.txt"), "utf8")).resolves.toBe("new\n");
    expect((await lstat(join(repository, "script.sh"))).mode & 0o111).not.toBe(0);
    expect(await readFile(join(repository, ".git", "index"))).toEqual(indexBefore);
  });

  it.skipIf(process.platform === "win32")(
    "preserves exact file permissions and detects permission-only conflicts",
    async () => {
      const repository = await createRepository({ "private.txt": "secret\n" });
      await chmod(join(repository, "private.txt"), 0o600);
      const workspace = await createTeamWorkspace(repository, "private mode");

      expect((await lstat(join(workspace.worktreePath, "private.txt"))).mode & 0o777).toBe(0o600);
      await chmod(join(workspace.worktreePath, "private.txt"), 0o640);
      expect((await computeTeamWorkspaceDelta(workspace)).changedPaths).toEqual(["private.txt"]);
      await integrateTeamWorkspace(workspace, ["private.txt"]);
      expect((await lstat(join(repository, "private.txt"))).mode & 0o777).toBe(0o640);

      const conflicting = await createTeamWorkspace(repository, "private conflict");
      await chmod(join(conflicting.worktreePath, "private.txt"), 0o600);
      await chmod(join(repository, "private.txt"), 0o660);
      await expect(integrateTeamWorkspace(conflicting, ["private.txt"])).rejects.toBeInstanceOf(
        TeamWorkspaceConflictError,
      );
      expect((await lstat(join(repository, "private.txt"))).mode & 0o777).toBe(0o660);
    },
  );

  it("rejects path escapes and changes outside the allowed write roots", async () => {
    expect(() =>
      validateTeamWorkspaceWritePaths([
        "../outside",
        "/absolute",
        "C:\\outside",
        "a/../b",
        ".git/config",
        "nested/.GiT/config",
      ]),
    ).toThrowError(TeamWorkspacePathError);
    try {
      validateTeamWorkspaceWritePaths(["../outside", "/absolute"]);
      throw new Error("expected path validation to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_path", paths: ["../outside", "/absolute"] });
    }

    const repository = await createRepository({ "tracked.txt": "old\n" });
    const workspace = await createTeamWorkspace(repository, "scope");
    await writeFile(join(workspace.worktreePath, "tracked.txt"), "child\n");

    await expect(integrateTeamWorkspace(workspace, ["somewhere-else"])).rejects.toMatchObject({
      code: "path_not_allowed",
      paths: ["tracked.txt"],
    });
    await expect(readFile(join(repository, "tracked.txt"), "utf8")).resolves.toBe("old\n");
  });

  it("refuses to follow a parent symlink outside the repository", async () => {
    const repository = await createRepository({ "tracked.txt": "old\n" });
    const outside = await temporaryDirectory("codexnest-team-outside-");
    const workspace = await createTeamWorkspace(repository, "symlink escape");
    await mkdir(join(workspace.worktreePath, "nested"));
    await writeFile(join(workspace.worktreePath, "nested", "new.txt"), "child\n");
    await symlink(outside, join(repository, "nested"));

    await expect(integrateTeamWorkspace(workspace, ["nested"])).rejects.toMatchObject({
      code: "workspace_conflict",
      conflicts: [
        expect.objectContaining({
          path: "nested/new.txt",
          reason: "unsafe_parent_path",
        }),
      ],
    });
    await expect(access(join(outside, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports every conflict before writing any parent path", async () => {
    const repository = await createRepository({
      "a.txt": "a baseline\n",
      "b.txt": "b baseline\n",
      "c.txt": "c baseline\n",
      "equal.txt": "equal baseline\n",
    });
    const workspace = await createTeamWorkspace(repository, "conflicts");
    await writeFile(join(workspace.worktreePath, "a.txt"), "a child\n");
    await writeFile(join(workspace.worktreePath, "b.txt"), "b child\n");
    await writeFile(join(workspace.worktreePath, "c.txt"), "c child\n");
    await writeFile(join(workspace.worktreePath, "equal.txt"), "equal child\n");
    await writeFile(join(repository, "a.txt"), "a parent\n");
    await writeFile(join(repository, "b.txt"), "b parent\n");
    await writeFile(join(repository, "equal.txt"), "equal child\n");

    try {
      await integrateTeamWorkspace(workspace, ["a.txt", "b.txt", "c.txt", "equal.txt"]);
      throw new Error("expected integration to conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(TeamWorkspaceConflictError);
      expect((error as TeamWorkspaceConflictError).conflicts.map((entry) => entry.path)).toEqual([
        "a.txt",
        "b.txt",
      ]);
    }
    await expect(readFile(join(repository, "a.txt"), "utf8")).resolves.toBe("a parent\n");
    await expect(readFile(join(repository, "b.txt"), "utf8")).resolves.toBe("b parent\n");
    await expect(readFile(join(repository, "c.txt"), "utf8")).resolves.toBe("c baseline\n");
    await expect(readFile(join(repository, "equal.txt"), "utf8")).resolves.toBe("equal child\n");
  });

  it("preserves a concurrent parent file created after the baseline leaf is captured", async () => {
    const repository = await createRepository({ "tracked.txt": "baseline\n" });
    const workspace = await createTeamWorkspace(repository, "atomic install race");
    await writeFile(join(workspace.worktreePath, "tracked.txt"), "child\n");
    const destination = join(repository, "tracked.txt");
    let injected = false;

    await expect(
      integrateTeamWorkspace(workspace, ["tracked.txt"], {
        afterCapture: async (phase, path) => {
          if (phase !== "apply" || path !== "tracked.txt" || injected) return;
          injected = true;
          await writeFile(destination, "concurrent parent\n");
        },
      }),
    ).rejects.toMatchObject({ code: "apply_failed" });
    await expect(readFile(destination, "utf8")).resolves.toBe("concurrent parent\n");
  });

  it("does not roll back over a concurrent edit of an installed child file", async () => {
    const repository = await createRepository({ "tracked.txt": "baseline\n" });
    const workspace = await createTeamWorkspace(repository, "atomic rollback race");
    await writeFile(join(workspace.worktreePath, "tracked.txt"), "child\n");
    const destination = join(repository, "tracked.txt");
    let injected = false;

    await expect(
      integrateTeamWorkspace(workspace, ["tracked.txt"], {
        afterInstall: async (phase, path) => {
          if (phase !== "apply" || path !== "tracked.txt" || injected) return;
          injected = true;
          await writeFile(destination, "concurrent parent\n");
        },
      }),
    ).rejects.toMatchObject({ code: "apply_failed" });
    await expect(readFile(destination, "utf8")).resolves.toBe("concurrent parent\n");
  });

  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "rolls back earlier writes and newly-created directories after an apply failure",
    async () => {
      const repository = await createRepository({ "first.txt": "baseline\n" });
      await mkdir(join(repository, "locked"));
      const workspace = await createTeamWorkspace(repository, "rollback");
      await writeFile(join(workspace.worktreePath, "first.txt"), "child\n");
      await mkdir(join(workspace.worktreePath, "created"));
      await writeFile(join(workspace.worktreePath, "created", "new.txt"), "new\n");
      await mkdir(join(workspace.worktreePath, "locked"));
      await writeFile(join(workspace.worktreePath, "locked", "failure.txt"), "fail\n");
      const indexBefore = await readFile(join(repository, ".git", "index"));
      await chmod(join(repository, "locked"), 0o500);

      try {
        await expect(
          integrateTeamWorkspace(workspace, ["first.txt", "created", "locked"]),
        ).rejects.toMatchObject({ code: "apply_failed" });
      } finally {
        await chmod(join(repository, "locked"), 0o700);
      }

      await expect(readFile(join(repository, "first.txt"), "utf8")).resolves.toBe("baseline\n");
      await expect(access(join(repository, "created"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(repository, "locked", "failure.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(join(repository, ".git", "index"))).toEqual(indexBefore);
    },
  );

  it("discards linked worktrees and tolerates repeated cleanup", async () => {
    const repository = await createRepository({ "tracked.txt": "value\n" });
    const workspace = await createTeamWorkspace(repository, "cleanup");
    const unrelated = await temporaryDirectory("codexnest-team-unrelated-worktree-");
    await rm(unrelated, { recursive: true, force: true });
    await git(repository, "worktree", "add", "--detach", unrelated, "HEAD");
    await rm(unrelated, { recursive: true, force: true });
    expect(await gitOutput(repository, "worktree", "list", "--porcelain")).toContain(
      workspace.worktreePath,
    );

    await discardTeamWorkspace(workspace);
    await expect(access(workspace.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await gitOutput(repository, "worktree", "list", "--porcelain")).not.toContain(
      workspace.worktreePath,
    );
    await expect(discardTeamWorkspace(workspace)).resolves.toBeUndefined();
    expect(await gitOutput(repository, "worktree", "list", "--porcelain")).toContain(unrelated);
  });
});

async function createRepository(files: Record<string, string | Buffer>): Promise<string> {
  const directory = await temporaryDirectory("codexnest-team-repository-");
  await git(directory, "init", "--quiet");
  for (const [path, contents] of Object.entries(files)) {
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (parent) await mkdir(join(directory, parent), { recursive: true });
    await writeFile(join(directory, path), contents);
  }
  await git(directory, "add", ".");
  await commit(directory, "initial");
  return directory;
}

async function commit(cwd: string, message: string): Promise<void> {
  await git(
    cwd,
    "-c",
    "user.name=CodexNest Test",
    "-c",
    "user.email=test@codexnest.invalid",
    "commit",
    "--quiet",
    "-m",
    message,
  );
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout;
}
