import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertUniqueProjectPath,
  canonicalProjectPath,
  pathContains,
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
    expect(await canonicalProjectPath(link)).toBe(canonical);
    expect(() =>
      assertUniqueProjectPath(
        [{ id: "one", displayName: "One", path: canonical, createdAt: "x", updatedAt: "x" }],
        canonical,
      ),
    ).toThrow("already registered");
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
