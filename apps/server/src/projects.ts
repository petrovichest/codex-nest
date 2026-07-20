import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { Project } from "@codexnest/protocol";

export async function canonicalProjectPath(input: string): Promise<string> {
  if (!isAbsolute(input)) throw new ProjectValidationError("Project path must be absolute");
  let info;
  try {
    info = await stat(input);
  } catch {
    throw new ProjectValidationError("Project path does not exist");
  }
  if (!info.isDirectory()) throw new ProjectValidationError("Project path must be a directory");
  return realpath(input);
}

export function createProject(name: string, path: string): Project {
  const trimmedName = name.trim();
  if (!trimmedName) throw new ProjectValidationError("Project name is required");
  const now = new Date().toISOString();
  return { id: randomUUID(), displayName: trimmedName, path, createdAt: now, updatedAt: now };
}

export function assertUniqueProjectPath(
  projects: Project[],
  path: string,
  exceptId?: string,
): void {
  if (projects.some((project) => project.id !== exceptId && project.path === path)) {
    throw new ProjectConflictError("This project directory is already registered");
  }
}

export function projectForCwd(projects: Project[], cwd: string): Project | undefined {
  const normalized = resolve(cwd);
  return projects
    .filter((project) => pathContains(project.path, normalized))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

export function pathContains(parent: string, candidate: string): boolean {
  const difference = relative(parent, candidate);
  return (
    difference === "" ||
    (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference))
  );
}

export class ProjectValidationError extends Error {}
export class ProjectConflictError extends Error {}
