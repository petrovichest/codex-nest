import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertUniqueProjectPath,
  canonicalProjectPath,
  createDirectory,
  createProject,
  listDirectories,
  pathContains,
  ProjectConflictError,
  ProjectForbiddenError,
  ProjectNotFoundError,
  ProjectValidationError,
  projectForCwd,
} from "./projects";

const directories: string[] = [];
afterEach(async () =>
  Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  ),
);

describe("projects", () => {
  it("canonicalizes symlinks and rejects duplicate real paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexnest-project-test-"));
    directories.push(root);
    const actual = join(root, "actual");
    const link = join(root, "link");
    await mkdir(actual);
    await symlink(actual, link);
    const canonical = await realpath(actual);
    expect(await canonicalProjectPath(link, root)).toBe(canonical);
    expect(() =>
      assertUniqueProjectPath(
        [{ id: "one", displayName: "One", path: canonical, createdAt: "x", updatedAt: "x" }],
        canonical,
      ),
    ).toThrow("already registered");
  });

  it("lists sorted directories, including safe symlinks, but excludes files and escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexnest-directory-test-"));
    const outside = await mkdtemp(join(tmpdir(), "codexnest-directory-outside-"));
    directories.push(root, outside);
    await mkdir(join(root, "folder10"));
    await mkdir(join(root, "folder2"));
    await mkdir(join(root, ".hidden"));
    await writeFile(join(root, "file.txt"), "not a directory");
    await symlink(join(root, "folder2"), join(root, "inside-link"));
    await symlink(outside, join(root, "outside-link"));

    const listing = await listDirectories(undefined, root);

    expect(listing).toMatchObject({ rootPath: root, path: root, parentPath: null });
    expect(listing.directories.map((entry) => entry.name)).toEqual([
      ".hidden",
      "folder2",
      "folder10",
      "inside-link",
    ]);
  });

  it("rejects paths outside the root, missing directories, and inaccessible directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexnest-directory-test-"));
    directories.push(root);
    const locked = join(root, "locked");
    await mkdir(locked);

    await expect(listDirectories(join(root, ".."), root)).rejects.toBeInstanceOf(
      ProjectValidationError,
    );
    await expect(listDirectories(join(root, "missing"), root)).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );

    await chmod(locked, 0o000);
    try {
      await expect(listDirectories(locked, root)).rejects.toBeInstanceOf(ProjectForbiddenError);
    } finally {
      await chmod(locked, 0o700);
    }
  });

  it("creates one folder level, supports safe symlink parents, and validates names", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexnest-directory-test-"));
    directories.push(root);
    const actual = join(root, "actual");
    const link = join(root, "link");
    await mkdir(actual);
    await symlink(actual, link);

    const created = await createDirectory(link, "new-project", root);
    expect(created).toEqual({
      rootPath: root,
      path: join(link, "new-project"),
      parentPath: link,
      directories: [],
    });
    expect(await realpath(join(actual, "new-project"))).toBe(
      join(await realpath(actual), "new-project"),
    );

    for (const name of ["", "   ", ".", "..", "nested/name", "nested\\name", "bad\0name"]) {
      await expect(createDirectory(root, name, root)).rejects.toBeInstanceOf(
        ProjectValidationError,
      );
    }
    await expect(createDirectory(link, "new-project", root)).rejects.toBeInstanceOf(
      ProjectConflictError,
    );
    await expect(createDirectory(join(root, ".."), "escape", root)).rejects.toBeInstanceOf(
      ProjectValidationError,
    );
  });

  it("derives a project name from the selected folder while storing the canonical path", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexnest-project-test-"));
    directories.push(root);
    const actual = join(root, "actual");
    const alias = join(root, "friendly-name");
    await mkdir(actual);
    await symlink(actual, alias);

    const canonical = await canonicalProjectPath(alias, root);
    expect(createProject(alias, canonical)).toMatchObject({
      displayName: "friendly-name",
      path: await realpath(actual),
    });
  });

  it("uses segment boundaries and the longest nested project", () => {
    expect(pathContains("/work/app", "/work/application")).toBe(false);
    const projects = [
      { id: "root", displayName: "Root", path: "/work", createdAt: "x", updatedAt: "x" },
      { id: "nested", displayName: "Nested", path: "/work/app", createdAt: "x", updatedAt: "x" },
    ];
    expect(projectForCwd(projects, "/work/app/src")?.id).toBe("nested");
  });
});
