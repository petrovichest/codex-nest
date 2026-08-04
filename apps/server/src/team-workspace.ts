import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";

const WORKTREE_DIRECTORY = "codexnest-team-worktrees";
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export type TeamWorkspaceFileState =
  | {
      type: "file";
      mode: number;
      digest: string;
    }
  | {
      type: "symlink";
      target: string;
    };

/** Serializable fields intended to be persisted by the Team orchestration caller. */
export interface TeamWorkspaceMetadata {
  repositoryRoot: string;
  gitCommonDir: string;
  worktreePath: string;
  head: string;
  baseline: Record<string, TeamWorkspaceFileState>;
}

export interface TeamWorkspaceChange {
  path: string;
  baseline: TeamWorkspaceFileState | null;
  final: TeamWorkspaceFileState | null;
}

export interface TeamWorkspaceDelta {
  changedPaths: string[];
  changes: TeamWorkspaceChange[];
}

export interface TeamWorkspaceIntegrationResult {
  changedPaths: string[];
  appliedPaths: string[];
  alreadyAppliedPaths: string[];
}

/** @internal Deterministic synchronization points for filesystem race regression tests. */
interface TeamWorkspaceIntegrationTestHooks {
  afterCapture?: (phase: "apply" | "rollback", path: string) => Promise<void>;
  afterInstall?: (phase: "apply" | "rollback", path: string) => Promise<void>;
}

export type TeamWorkspaceErrorCode =
  | "not_repository"
  | "unborn_repository"
  | "invalid_path"
  | "invalid_metadata"
  | "workspace_missing"
  | "unsupported_entry"
  | "path_not_allowed"
  | "workspace_conflict"
  | "apply_failed"
  | "git_failed";

export class TeamWorkspaceError extends Error {
  constructor(
    public readonly code: TeamWorkspaceErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "TeamWorkspaceError";
  }
}

export interface TeamWorkspaceConflict {
  path: string;
  reason: "parent_changed" | "unsafe_parent_path" | "unsupported_parent_entry";
  baseline: TeamWorkspaceFileState | null;
  current: TeamWorkspaceFileState | null;
  final: TeamWorkspaceFileState | null;
}

export class TeamWorkspaceConflictError extends TeamWorkspaceError {
  constructor(public readonly conflicts: TeamWorkspaceConflict[]) {
    super(
      "workspace_conflict",
      `The parent workspace changed at ${conflicts.length} path${conflicts.length === 1 ? "" : "s"}`,
    );
    this.name = "TeamWorkspaceConflictError";
  }
}

export class TeamWorkspacePathError extends TeamWorkspaceError {
  constructor(
    code: "invalid_path" | "path_not_allowed",
    message: string,
    public readonly paths: string[],
  ) {
    super(code, message);
    this.name = "TeamWorkspacePathError";
  }
}

/**
 * Creates a detached linked worktree and overlays the parent's current tracked and
 * non-ignored untracked files. The parent index, HEAD and refs are never changed.
 */
export async function createTeamWorkspace(
  cwd: string,
  taskId: string,
): Promise<TeamWorkspaceMetadata> {
  const repository = await resolveRepository(cwd);
  const container = join(repository.gitCommonDir, WORKTREE_DIRECTORY);
  await mkdir(container, { recursive: true });
  const slug = taskSlug(taskId);
  const worktreePath = join(container, `${slug}-${randomUUID()}`);
  let worktreeAdded = false;

  try {
    await git(repository.repositoryRoot, [
      "worktree",
      "add",
      "--detach",
      "--no-checkout",
      worktreePath,
      repository.head,
    ]);
    worktreeAdded = true;
    // --no-checkout starts the linked worktree with an empty private index. Populate
    // only that private index from HEAD before overlaying the parent's live files.
    await git(worktreePath, ["reset", "--mixed", "--quiet", repository.head]);

    const paths = await listedWorkspacePaths(repository.repositoryRoot);
    const baseline = emptyManifest();
    for (const path of paths) {
      const entry = await readWorkspaceEntry(repository.repositoryRoot, path);
      if (!entry) continue;
      await copyWorkspaceEntry(repository.repositoryRoot, worktreePath, path, entry);
      const copied = await readWorkspaceEntry(worktreePath, path);
      if (!sameEntry(entry, copied)) {
        throw new TeamWorkspaceError(
          "apply_failed",
          `The parent path changed while the workspace was being created: ${path}`,
        );
      }
      defineManifestEntry(baseline, path, entry);
    }

    return {
      repositoryRoot: repository.repositoryRoot,
      gitCommonDir: repository.gitCommonDir,
      worktreePath,
      head: repository.head,
      baseline,
    };
  } catch (error) {
    if (worktreeAdded) {
      await removeLinkedWorktree(repository.repositoryRoot, worktreePath).catch(() => undefined);
    } else {
      await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
    }
    await removeEmptyDirectory(container);
    if (error instanceof TeamWorkspaceError) throw error;
    throw new TeamWorkspaceError("git_failed", "Failed to create the Team workspace", {
      cause: error,
    });
  }
}

/** Computes the content/type/mode delta from the persisted task-start baseline. */
export async function computeTeamWorkspaceDelta(
  metadata: TeamWorkspaceMetadata,
): Promise<TeamWorkspaceDelta> {
  await verifyWorkspace(metadata);
  const finalManifest = await captureFinalManifest(metadata);
  const paths = [
    ...new Set([...Object.keys(metadata.baseline), ...Object.keys(finalManifest)]),
  ].sort();
  const changes: TeamWorkspaceChange[] = [];
  for (const path of paths) {
    const baseline = metadata.baseline[path] ?? null;
    const final = finalManifest[path] ?? null;
    if (!sameEntry(baseline, final)) changes.push({ path, baseline, final });
  }
  return { changedPaths: changes.map((change) => change.path), changes };
}

/**
 * Applies the child delta only where the parent still equals the baseline. All
 * conflicts and path-policy failures are collected before any parent path is written.
 */
export async function integrateTeamWorkspace(
  metadata: TeamWorkspaceMetadata,
  allowedWritePaths: readonly string[],
  testHooks: TeamWorkspaceIntegrationTestHooks = {},
): Promise<TeamWorkspaceIntegrationResult> {
  const allowed = validateTeamWorkspaceWritePaths(allowedWritePaths);
  const delta = await computeTeamWorkspaceDelta(metadata);
  const denied = delta.changedPaths.filter((path) => !isAllowedPath(path, allowed));
  if (denied.length > 0) {
    throw new TeamWorkspacePathError(
      "path_not_allowed",
      `The task changed ${denied.length} path${denied.length === 1 ? "" : "s"} outside its write scope`,
      denied,
    );
  }

  const preflight = await inspectParent(metadata.repositoryRoot, delta.changes);
  if (preflight.conflicts.length > 0) {
    throw new TeamWorkspaceConflictError(preflight.conflicts);
  }
  if (preflight.pending.length === 0) {
    return {
      changedPaths: delta.changedPaths,
      appliedPaths: [],
      alreadyAppliedPaths: preflight.alreadyApplied,
    };
  }

  const rollbackRoot = join(metadata.gitCommonDir, `codexnest-team-rollback-${randomUUID()}`);
  const backup = emptyManifest();
  const createdDirectories = new Set<string>();
  const attempted: TeamWorkspaceChange[] = [];
  let retainRollback = false;
  await mkdir(rollbackRoot);

  try {
    for (const change of delta.changes) {
      const current = await readWorkspaceEntry(metadata.repositoryRoot, change.path);
      if (current) {
        await copyWorkspaceEntry(metadata.repositoryRoot, rollbackRoot, change.path, current);
        defineManifestEntry(backup, change.path, current);
      }
    }

    // Re-run the complete parent preflight after taking backups and before the first write.
    const confirmed = await inspectParent(metadata.repositoryRoot, delta.changes);
    if (confirmed.conflicts.length > 0) {
      throw new TeamWorkspaceConflictError(confirmed.conflicts);
    }

    const newlyApplied: string[] = [];
    const alreadyApplied = new Set([...preflight.alreadyApplied, ...confirmed.alreadyApplied]);
    for (const change of confirmed.pending) {
      const current = await readWorkspaceEntry(metadata.repositoryRoot, change.path);
      if (sameEntry(current, change.final)) {
        alreadyApplied.add(change.path);
        continue;
      }
      if (!sameEntry(current, change.baseline)) {
        throw new TeamWorkspaceError(
          "apply_failed",
          `The parent path changed while the delta was being applied: ${change.path}`,
        );
      }
      attempted.push(change);
      await applyChange(metadata, change, createdDirectories, testHooks);
      newlyApplied.push(change.path);
    }

    const verified = await inspectParent(metadata.repositoryRoot, delta.changes);
    const finalConflicts = [
      ...verified.conflicts,
      ...verified.pending.map((change) => ({
        path: change.path,
        reason: "parent_changed" as const,
        baseline: change.baseline,
        current: change.baseline,
        final: change.final,
      })),
    ];
    if (finalConflicts.length > 0) throw new TeamWorkspaceConflictError(finalConflicts);

    return {
      changedPaths: delta.changedPaths,
      appliedPaths: newlyApplied,
      alreadyAppliedPaths: [...alreadyApplied].sort(),
    };
  } catch (error) {
    if (error instanceof TeamWorkspaceConflictError && attempted.length === 0) throw error;
    const rollbackErrors = await rollbackParent(
      metadata.repositoryRoot,
      rollbackRoot,
      attempted,
      backup,
      createdDirectories,
      testHooks,
    );
    retainRollback = rollbackErrors.length > 0;
    const detail = rollbackErrors.length
      ? `; rollback also failed for: ${rollbackErrors.join(", ")}; the rollback backup was retained in the Git common directory`
      : "";
    if (error instanceof TeamWorkspaceConflictError && rollbackErrors.length === 0) throw error;
    throw new TeamWorkspaceError(
      "apply_failed",
      `Failed to integrate the Team workspace${detail}`,
      { cause: error },
    );
  } finally {
    if (!retainRollback) {
      await rm(rollbackRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Removes a linked task worktree. Safe to call repeatedly with persisted metadata. */
export async function discardTeamWorkspace(metadata: TeamWorkspaceMetadata): Promise<void> {
  validateMetadata(metadata);
  await verifyRepositoryMetadata(metadata);
  await removeLinkedWorktree(metadata.repositoryRoot, metadata.worktreePath).catch(
    async (error) => {
      try {
        await rm(metadata.worktreePath, { recursive: true, force: true });
        await removeLinkedWorktreeRegistration(metadata);
      } catch (cleanupError) {
        throw new TeamWorkspaceError("git_failed", "Failed to discard the Team workspace", {
          cause: cleanupError ?? error,
        });
      }
    },
  );
  await removeEmptyDirectory(join(metadata.gitCommonDir, WORKTREE_DIRECTORY));
}

/** Validates and canonicalizes repository-relative write roots. */
export function validateTeamWorkspaceWritePaths(paths: readonly string[]): string[] {
  const canonical = new Set<string>();
  const invalid: string[] = [];
  for (const path of paths) {
    try {
      validateRepositoryPath(path);
      canonical.add(path);
    } catch {
      invalid.push(path);
    }
  }
  if (invalid.length > 0) {
    throw new TeamWorkspacePathError(
      "invalid_path",
      `Invalid repository-relative write path${invalid.length === 1 ? "" : "s"}: ${invalid.join(", ")}`,
      invalid,
    );
  }
  return [...canonical].sort();
}

async function resolveRepository(cwd: string): Promise<{
  repositoryRoot: string;
  gitCommonDir: string;
  head: string;
}> {
  let repositoryRoot: string;
  try {
    const inside = (await gitText(cwd, ["rev-parse", "--is-inside-work-tree"])).trim();
    if (inside !== "true") throw new Error("not a working tree");
    repositoryRoot = await realpath((await gitText(cwd, ["rev-parse", "--show-toplevel"])).trim());
  } catch (error) {
    throw new TeamWorkspaceError(
      "not_repository",
      "Team workspaces require an existing Git working tree",
      { cause: error },
    );
  }

  let head: string;
  try {
    head = (await gitText(repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  } catch (error) {
    throw new TeamWorkspaceError(
      "unborn_repository",
      "Team workspaces require a repository with an initial commit",
      { cause: error },
    );
  }

  try {
    const gitCommonDir = await realpath(
      (
        await gitText(repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
      ).trim(),
    );
    return { repositoryRoot, gitCommonDir, head };
  } catch (error) {
    throw new TeamWorkspaceError("git_failed", "Failed to locate the Git common directory", {
      cause: error,
    });
  }
}

async function verifyWorkspace(metadata: TeamWorkspaceMetadata): Promise<void> {
  validateMetadata(metadata);
  await verifyRepositoryMetadata(metadata);
  let worktreeRoot: string;
  let commonDir: string;
  try {
    worktreeRoot = await realpath(
      (await gitText(metadata.worktreePath, ["rev-parse", "--show-toplevel"])).trim(),
    );
    commonDir = await realpath(
      (
        await gitText(metadata.worktreePath, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ])
      ).trim(),
    );
  } catch (error) {
    throw new TeamWorkspaceError("workspace_missing", "The Team worktree is unavailable", {
      cause: error,
    });
  }
  if (
    worktreeRoot !== resolve(metadata.worktreePath) ||
    commonDir !== resolve(metadata.gitCommonDir)
  ) {
    throw new TeamWorkspaceError(
      "invalid_metadata",
      "The Team worktree does not belong to the persisted Git repository",
    );
  }
}

async function verifyRepositoryMetadata(metadata: TeamWorkspaceMetadata): Promise<void> {
  let repositoryRoot: string;
  let commonDir: string;
  try {
    repositoryRoot = await realpath(
      (await gitText(metadata.repositoryRoot, ["rev-parse", "--show-toplevel"])).trim(),
    );
    commonDir = await realpath(
      (
        await gitText(metadata.repositoryRoot, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ])
      ).trim(),
    );
  } catch (error) {
    throw new TeamWorkspaceError(
      "workspace_missing",
      "The persisted parent Git repository is unavailable",
      { cause: error },
    );
  }
  if (
    repositoryRoot !== resolve(metadata.repositoryRoot) ||
    commonDir !== resolve(metadata.gitCommonDir)
  ) {
    throw new TeamWorkspaceError(
      "invalid_metadata",
      "The persisted parent path does not match the Team workspace repository",
    );
  }
}

function validateMetadata(metadata: TeamWorkspaceMetadata): void {
  if (
    !metadata ||
    typeof metadata !== "object" ||
    !isAbsolute(metadata.repositoryRoot) ||
    !isAbsolute(metadata.gitCommonDir) ||
    !isAbsolute(metadata.worktreePath) ||
    !/^[a-f\d]{40,64}$/iu.test(metadata.head) ||
    !metadata.baseline ||
    typeof metadata.baseline !== "object" ||
    Array.isArray(metadata.baseline)
  ) {
    throw new TeamWorkspaceError("invalid_metadata", "Invalid persisted Team workspace metadata");
  }

  const container = resolve(metadata.gitCommonDir, WORKTREE_DIRECTORY);
  const worktreeRelative = relative(container, resolve(metadata.worktreePath));
  if (
    !worktreeRelative ||
    worktreeRelative.startsWith(`..${sep}`) ||
    worktreeRelative === ".." ||
    isAbsolute(worktreeRelative) ||
    worktreeRelative.includes(sep)
  ) {
    throw new TeamWorkspaceError(
      "invalid_metadata",
      "The persisted worktree path is outside the Git common directory",
    );
  }

  for (const [path, entry] of Object.entries(metadata.baseline)) {
    try {
      validateRepositoryPath(path);
    } catch (error) {
      throw new TeamWorkspaceError("invalid_metadata", `Invalid baseline path: ${path}`, {
        cause: error,
      });
    }
    if (
      !entry ||
      typeof entry !== "object" ||
      (entry.type === "file" &&
        (!Number.isInteger(entry.mode) ||
          entry.mode < 0 ||
          entry.mode > 0o777 ||
          !/^[a-f\d]{64}$/iu.test(entry.digest))) ||
      (entry.type === "symlink" && typeof entry.target !== "string") ||
      (entry.type !== "file" && entry.type !== "symlink")
    ) {
      throw new TeamWorkspaceError("invalid_metadata", `Invalid baseline entry for path: ${path}`);
    }
  }
}

async function captureFinalManifest(
  metadata: TeamWorkspaceMetadata,
): Promise<Record<string, TeamWorkspaceFileState>> {
  const candidates = new Set([
    ...Object.keys(metadata.baseline),
    ...(await listedWorkspacePaths(metadata.worktreePath)),
  ]);
  const manifest = emptyManifest();
  for (const path of [...candidates].sort()) {
    const entry = await readWorkspaceEntry(metadata.worktreePath, path);
    if (entry) defineManifestEntry(manifest, path, entry);
  }
  return manifest;
}

async function listedWorkspacePaths(cwd: string): Promise<string[]> {
  const output = await git(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  const paths = output.toString("utf8").split("\0").filter(Boolean);
  for (const path of paths) validateRepositoryPath(path);
  return [...new Set(paths)].sort();
}

async function readWorkspaceEntry(
  root: string,
  path: string,
): Promise<TeamWorkspaceFileState | null> {
  validateRepositoryPath(path);
  try {
    return await withStableParentDirectory(root, path, false, undefined, (parent, leaf) =>
      readAbsoluteEntry(join(parent, leaf), path),
    );
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return null;
    throw error;
  }
}

async function copyWorkspaceEntry(
  sourceRoot: string,
  destinationRoot: string,
  path: string,
  expected: TeamWorkspaceFileState,
  createdDirectories?: Set<string>,
): Promise<void> {
  const source = await readWorkspaceEntry(sourceRoot, path);
  if (!sameEntry(source, expected)) {
    throw new TeamWorkspaceError("apply_failed", `Source path changed before copy: ${path}`);
  }
  await ensureParentDirectories(destinationRoot, path, createdDirectories);
  const destination = repositoryPath(destinationRoot, path);
  const destinationParent = parentPath(path);
  const parent = destinationParent
    ? repositoryPath(destinationRoot, destinationParent)
    : resolve(destinationRoot);
  await copyWorkspaceEntryToDestination(sourceRoot, path, expected, parent, destination);
}

async function copyWorkspaceEntryToDestination(
  sourceRoot: string,
  path: string,
  expected: TeamWorkspaceFileState,
  destinationParent: string,
  destination: string,
): Promise<void> {
  const temporary = await prepareWorkspaceEntry(sourceRoot, path, expected, destinationParent);
  try {
    await removeFileOrSymlink(destination);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function prepareWorkspaceEntry(
  sourceRoot: string,
  path: string,
  expected: TeamWorkspaceFileState,
  destinationParent: string,
): Promise<string> {
  const temporary = join(destinationParent, `.codexnest-prepared-${randomUUID()}`);
  try {
    await withStableParentDirectory(
      sourceRoot,
      path,
      false,
      undefined,
      async (sourceParent, leaf) => {
        const source = join(sourceParent, leaf);
        if (expected.type === "file") {
          let handle: FileHandle | undefined;
          try {
            handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
            const actual = await readFileHandleEntry(handle, path);
            if (!sameEntry(actual, expected)) {
              throw new TeamWorkspaceError(
                "apply_failed",
                `Source path changed before copy: ${path}`,
              );
            }
            await copyFile(await fileDescriptorPath(handle), temporary, constants.COPYFILE_EXCL);
            await chmod(temporary, expected.mode);
          } finally {
            await handle?.close().catch(() => undefined);
          }
        } else {
          const target = await readlink(source);
          if (target !== expected.target) {
            throw new TeamWorkspaceError(
              "apply_failed",
              `Source path changed before copy: ${path}`,
            );
          }
          await symlink(target, temporary);
        }
      },
    );
    const copied = await readAbsoluteEntry(temporary, path);
    if (!sameEntry(copied, expected)) {
      throw new TeamWorkspaceError("apply_failed", `Source path changed during copy: ${path}`);
    }
    return temporary;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function replaceWorkspaceEntry(
  sourceRoot: string,
  sourcePath: string,
  replacement: TeamWorkspaceFileState | null,
  expectedCurrent: TeamWorkspaceFileState | null,
  destinationParent: string,
  destination: string,
  phase: "apply" | "rollback",
  testHooks: TeamWorkspaceIntegrationTestHooks,
): Promise<void> {
  const prepared = replacement
    ? await prepareWorkspaceEntry(sourceRoot, sourcePath, replacement, destinationParent)
    : undefined;
  const displaced = expectedCurrent
    ? join(destinationParent, `.codexnest-displaced-${randomUUID()}`)
    : undefined;
  let displacedEntry: TeamWorkspaceFileState | null = null;
  let displacedMatchesExpected = false;
  let removeDisplaced = false;
  try {
    if (displaced) {
      try {
        await rename(destination, displaced);
      } catch (error) {
        if (!isFileSystemError(error, "ENOENT")) throw error;
        throw parentChangedConflict(sourcePath, expectedCurrent, null, replacement);
      }
      displacedEntry = await readAbsoluteEntry(displaced, sourcePath);
      displacedMatchesExpected = sameEntry(displacedEntry, expectedCurrent);
      if (!displacedMatchesExpected) {
        throw parentChangedConflict(sourcePath, expectedCurrent, displacedEntry, replacement);
      }
    } else {
      const current = await readAbsoluteEntry(destination, sourcePath);
      if (current !== null) {
        throw parentChangedConflict(sourcePath, expectedCurrent, current, replacement);
      }
    }
    await testHooks.afterCapture?.(phase, sourcePath);

    if (replacement && prepared) {
      try {
        await installEntryWithoutOverwrite(prepared, replacement, destination);
      } catch (error) {
        if (!isFileSystemError(error, "EEXIST")) throw error;
        const current = await readAbsoluteEntry(destination, sourcePath).catch(() => null);
        throw parentChangedConflict(sourcePath, expectedCurrent, current, replacement);
      }
    }
    await testHooks.afterInstall?.(phase, sourcePath);
    if (displaced && displacedEntry) {
      const latestDisplaced = await readAbsoluteEntry(displaced, sourcePath);
      if (!sameEntry(latestDisplaced, displacedEntry)) {
        displacedEntry = latestDisplaced;
        displacedMatchesExpected = false;
        throw parentChangedConflict(sourcePath, expectedCurrent, latestDisplaced, replacement);
      }
    }
    removeDisplaced = true;
  } catch (error) {
    if (displaced && displacedEntry) {
      const restored = await restoreEntryWithoutOverwrite(
        displaced,
        displacedEntry,
        destination,
      ).catch(() => false);
      removeDisplaced = restored || displacedMatchesExpected;
    }
    throw error;
  } finally {
    if (prepared) await rm(prepared, { force: true }).catch(() => undefined);
    if (displaced && removeDisplaced) {
      await rm(displaced, { force: true }).catch(() => undefined);
    }
  }
}

async function installEntryWithoutOverwrite(
  source: string,
  entry: TeamWorkspaceFileState,
  destination: string,
): Promise<void> {
  if (entry.type === "file") {
    await link(source, destination);
  } else {
    await symlink(entry.target, destination);
  }
}

async function restoreEntryWithoutOverwrite(
  source: string,
  entry: TeamWorkspaceFileState,
  destination: string,
): Promise<boolean> {
  try {
    await installEntryWithoutOverwrite(source, entry, destination);
    return true;
  } catch (error) {
    if (!isFileSystemError(error, "EEXIST")) throw error;
    return false;
  }
}

function parentChangedConflict(
  path: string,
  baseline: TeamWorkspaceFileState | null,
  current: TeamWorkspaceFileState | null,
  final: TeamWorkspaceFileState | null,
): TeamWorkspaceConflictError {
  return new TeamWorkspaceConflictError([
    { path, reason: "parent_changed", baseline, current, final },
  ]);
}

async function applyChange(
  metadata: TeamWorkspaceMetadata,
  change: TeamWorkspaceChange,
  createdDirectories: Set<string>,
  testHooks: TeamWorkspaceIntegrationTestHooks,
): Promise<void> {
  await withStableParentDirectory(
    metadata.repositoryRoot,
    change.path,
    true,
    createdDirectories,
    async (parent, leaf) => {
      const destination = join(parent, leaf);
      const current = await readAbsoluteEntry(destination);
      if (sameEntry(current, change.final)) return;
      if (!sameEntry(current, change.baseline)) {
        throw new TeamWorkspaceConflictError([
          {
            path: change.path,
            reason: "parent_changed",
            baseline: change.baseline,
            current,
            final: change.final,
          },
        ]);
      }
      await replaceWorkspaceEntry(
        metadata.worktreePath,
        change.path,
        change.final,
        change.baseline,
        parent,
        destination,
        "apply",
        testHooks,
      );
      const applied = await readAbsoluteEntry(destination);
      if (!sameEntry(applied, change.final)) {
        throw new TeamWorkspaceError(
          "apply_failed",
          `Failed to verify applied path: ${change.path}`,
        );
      }
    },
  );
}

async function inspectParent(
  repositoryRoot: string,
  changes: TeamWorkspaceChange[],
): Promise<{
  conflicts: TeamWorkspaceConflict[];
  pending: TeamWorkspaceChange[];
  alreadyApplied: string[];
}> {
  const conflicts: TeamWorkspaceConflict[] = [];
  const pending: TeamWorkspaceChange[] = [];
  const alreadyApplied: string[] = [];
  for (const change of changes) {
    let current: TeamWorkspaceFileState | null;
    try {
      current = await readWorkspaceEntry(repositoryRoot, change.path);
    } catch (error) {
      conflicts.push({
        path: change.path,
        reason:
          error instanceof TeamWorkspaceError && error.code === "unsupported_entry"
            ? "unsupported_parent_entry"
            : "unsafe_parent_path",
        baseline: change.baseline,
        current: null,
        final: change.final,
      });
      continue;
    }
    if (sameEntry(current, change.final)) {
      alreadyApplied.push(change.path);
    } else if (sameEntry(current, change.baseline)) {
      pending.push(change);
    } else {
      conflicts.push({
        path: change.path,
        reason: "parent_changed",
        baseline: change.baseline,
        current,
        final: change.final,
      });
    }
  }
  return { conflicts, pending, alreadyApplied };
}

async function rollbackParent(
  repositoryRoot: string,
  rollbackRoot: string,
  attempted: TeamWorkspaceChange[],
  backup: Record<string, TeamWorkspaceFileState>,
  createdDirectories: Set<string>,
  testHooks: TeamWorkspaceIntegrationTestHooks,
): Promise<string[]> {
  const errors: string[] = [];
  for (const change of [...attempted].reverse()) {
    const path = change.path;
    try {
      const entry = backup[path];
      await withStableParentDirectory(
        repositoryRoot,
        path,
        Boolean(entry),
        undefined,
        async (parent, leaf) => {
          const destination = join(parent, leaf);
          const current = await readAbsoluteEntry(destination);
          if (sameEntry(current, change.baseline)) return;
          if (!sameEntry(current, change.final)) {
            throw new TeamWorkspaceError(
              "workspace_conflict",
              `The parent path changed while rollback was pending: ${path}`,
            );
          }
          await replaceWorkspaceEntry(
            rollbackRoot,
            path,
            entry ?? null,
            change.final,
            parent,
            destination,
            "rollback",
            testHooks,
          );
          const restored = await readAbsoluteEntry(destination);
          if (!sameEntry(restored, change.baseline)) {
            throw new TeamWorkspaceError("apply_failed", `Failed to roll back path: ${path}`);
          }
        },
      );
    } catch {
      errors.push(path);
    }
  }
  for (const directory of [...createdDirectories].sort(
    (left, right) => right.length - left.length,
  )) {
    await rmdir(directory).catch((error) => {
      if (!isFileSystemError(error, "ENOENT") && !isFileSystemError(error, "ENOTEMPTY")) {
        errors.push(relative(repositoryRoot, directory));
      }
    });
  }
  return [...new Set(errors)];
}

async function withStableParentDirectory<T>(
  root: string,
  path: string,
  create: boolean,
  createdDirectories: Set<string> | undefined,
  operation: (parent: string, leaf: string) => Promise<T>,
): Promise<T> {
  validateRepositoryPath(path);
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const handles: FileHandle[] = [];
  let logical = resolve(root);
  try {
    let current = await open(logical, flags);
    handles.push(current);
    let currentPath = await fileDescriptorPath(current);
    const segments = path.split("/");
    const leaf = segments.pop()!;
    for (const segment of segments) {
      const child = join(currentPath, segment);
      logical = join(logical, segment);
      try {
        current = await open(child, flags);
      } catch (error) {
        if (!create && isFileSystemError(error, "ENOENT")) throw error;
        if (!create || !isFileSystemError(error, "ENOENT")) {
          throw new TeamWorkspacePathError(
            "invalid_path",
            `Unsafe path ancestor: ${parentPath(path)}`,
            [path],
          );
        }
        try {
          await mkdir(child);
          createdDirectories?.add(logical);
        } catch (mkdirError) {
          if (!isFileSystemError(mkdirError, "EEXIST")) throw mkdirError;
        }
        current = await open(child, flags);
      }
      handles.push(current);
      currentPath = await fileDescriptorPath(current);
    }
    return await operation(currentPath, leaf);
  } finally {
    await Promise.all(handles.reverse().map((handle) => handle.close().catch(() => undefined)));
  }
}

async function fileDescriptorPath(handle: FileHandle): Promise<string> {
  const candidates =
    process.platform === "linux"
      ? [`/proc/self/fd/${handle.fd}`]
      : [`/dev/fd/${handle.fd}`, `/proc/self/fd/${handle.fd}`];
  for (const candidate of candidates) {
    try {
      await lstat(candidate);
      return candidate;
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
    }
  }
  throw new TeamWorkspaceError(
    "apply_failed",
    "Secure Team workspace integration requires file-descriptor paths",
  );
}

async function ensureParentDirectories(
  root: string,
  path: string,
  createdDirectories?: Set<string>,
): Promise<void> {
  const segments = path.split("/").slice(0, -1);
  let current = resolve(root);
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new TeamWorkspacePathError(
          "invalid_path",
          `Unsafe path ancestor: ${relative(root, current)}`,
          [path],
        );
      }
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
      try {
        await mkdir(current);
        createdDirectories?.add(current);
      } catch (mkdirError) {
        if (!isFileSystemError(mkdirError, "EEXIST")) throw mkdirError;
        const metadata = await lstat(current);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw mkdirError;
      }
    }
  }
}

async function readAbsoluteEntry(
  path: string,
  logicalPath?: string,
): Promise<TeamWorkspaceFileState | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) return null;
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      try {
        return { type: "symlink", target: await readlink(path) };
      } catch (error) {
        if (isFileSystemError(error, "ENOENT")) return null;
        if (isFileSystemError(error, "EINVAL")) continue;
        throw error;
      }
    }
    if (!metadata.isFile()) {
      if (!logicalPath) return null;
      throw new TeamWorkspaceError(
        "unsupported_entry",
        `Team workspaces do not support non-file Git entries: ${logicalPath}`,
      );
    }
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      return await readFileHandleEntry(handle, logicalPath);
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) return null;
      if (isFileSystemError(error, "ELOOP")) continue;
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  throw new TeamWorkspaceError(
    "apply_failed",
    `Path changed repeatedly while it was being inspected: ${logicalPath ?? path}`,
  );
}

async function readFileHandleEntry(
  handle: FileHandle,
  logicalPath?: string,
): Promise<TeamWorkspaceFileState | null> {
  const metadata = await handle.stat();
  if (!metadata.isFile()) {
    if (!logicalPath) return null;
    throw new TeamWorkspaceError(
      "unsupported_entry",
      `Team workspaces do not support non-file Git entries: ${logicalPath}`,
    );
  }
  return {
    type: "file",
    mode: metadata.mode & 0o777,
    digest: await digestFileHandle(handle),
  };
}

async function digestFileHandle(handle: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream("", { fd: handle.fd, autoClose: false, start: 0 });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function sameEntry(
  left: TeamWorkspaceFileState | null,
  right: TeamWorkspaceFileState | null,
): boolean {
  if (left === null || right === null) return left === right;
  if (left.type !== right.type) return false;
  return left.type === "file"
    ? right.type === "file" && left.mode === right.mode && left.digest === right.digest
    : right.type === "symlink" && left.target === right.target;
}

function validateRepositoryPath(path: string): void {
  const segments = typeof path === "string" ? path.split("/") : [];
  if (
    typeof path !== "string" ||
    !path ||
    path.includes("\0") ||
    path.includes("\\") ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    path.endsWith("/") ||
    segments.some(
      (segment) =>
        !segment || segment === "." || segment === ".." || segment.toLowerCase() === ".git",
    )
  ) {
    throw new TeamWorkspacePathError(
      "invalid_path",
      `Path must be canonical and repository-relative: ${path}`,
      [path],
    );
  }
}

function repositoryPath(root: string, path: string): string {
  validateRepositoryPath(path);
  return resolve(root, ...path.split("/"));
}

function parentPath(path: string): string {
  const segments = path.split("/");
  segments.pop();
  return segments.join("/");
}

function isAllowedPath(path: string, allowed: string[]): boolean {
  return allowed.some((root) => path === root || path.startsWith(`${root}/`));
}

function emptyManifest(): Record<string, TeamWorkspaceFileState> {
  return {};
}

function defineManifestEntry(
  manifest: Record<string, TeamWorkspaceFileState>,
  path: string,
  entry: TeamWorkspaceFileState,
): void {
  Object.defineProperty(manifest, path, {
    value: entry,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function taskSlug(taskId: string): string {
  const slug = taskId
    .trim()
    .replace(/[^a-z\d._-]+/giu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug && slug !== "." && slug !== ".." ? slug : "task";
}

async function removeLinkedWorktree(repositoryRoot: string, worktreePath: string): Promise<void> {
  await git(repositoryRoot, ["worktree", "remove", "--force", worktreePath]);
  await rm(worktreePath, { recursive: true, force: true });
}

async function removeLinkedWorktreeRegistration(metadata: TeamWorkspaceMetadata): Promise<void> {
  const registrationsRoot = join(metadata.gitCommonDir, "worktrees");
  let entries;
  try {
    entries = await readdir(registrationsRoot, { withFileTypes: true });
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const registration = join(registrationsRoot, entry.name);
    let gitdir: string;
    try {
      gitdir = (await readFile(join(registration, "gitdir"), "utf8")).trim();
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) continue;
      throw error;
    }
    if (resolve(gitdir, "..") !== resolve(metadata.worktreePath)) continue;
    await rm(registration, { recursive: true, force: true });
    return;
  }
}

async function removeFileOrSymlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) throw error;
  }
}

async function removeEmptyDirectory(path: string): Promise<void> {
  await rmdir(path).catch((error) => {
    if (!isFileSystemError(error, "ENOENT") && !isFileSystemError(error, "ENOTEMPTY")) {
      throw error;
    }
  });
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  return (await git(cwd, args)).toString("utf8");
}

async function git(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      {
        encoding: "buffer",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolvePromise(stdout);
      },
    );
  });
}
