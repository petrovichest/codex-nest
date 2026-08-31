import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Readable } from "node:stream";

import type { ThreadFileAttachment } from "@codexnest/protocol";

import { pathContains } from "./projects";

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 250 * 1024 * 1024;

export class AttachmentTooLargeError extends Error {}
export class AttachmentValidationError extends Error {}

export class AttachmentStore {
  readonly root: string;

  constructor(statePath: string) {
    this.root = join(dirname(statePath), `${basename(statePath)}.attachments`);
  }

  async save(
    threadId: string,
    requestedName: string,
    requestedMediaType: string,
    body: Readable,
    contentLength?: number,
  ): Promise<ThreadFileAttachment> {
    if (contentLength !== undefined && contentLength > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentTooLargeError("File exceeds the 100 MiB limit");
    }
    const id = randomUUID();
    const name = safeFileName(requestedName);
    const mediaType = safeMediaType(requestedMediaType);
    const directory = join(this.threadDirectory(threadId), id);
    const temporaryPath = join(directory, ".upload");
    const path = join(directory, name);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const handle = await open(temporaryPath, "wx", 0o600);
    let size = 0;
    try {
      for await (const value of body) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
        size += chunk.length;
        if (size > MAX_ATTACHMENT_BYTES) {
          throw new AttachmentTooLargeError("File exceeds the 100 MiB limit");
        }
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
          if (bytesWritten <= 0) throw new Error("Failed to write file attachment");
          offset += bytesWritten;
        }
      }
      await handle.close();
      await rename(temporaryPath, path);
      return { id, name, path, size, mediaType };
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async validate(
    threadId: string,
    attachments: readonly ThreadFileAttachment[],
  ): Promise<ThreadFileAttachment[]> {
    let total = 0;
    const validated: ThreadFileAttachment[] = [];
    for (const attachment of attachments) {
      if (!isAttachmentShape(attachment)) {
        throw new AttachmentValidationError("Invalid file attachment");
      }
      const expected = this.attachmentPath(threadId, attachment.id, attachment.name);
      if (resolve(attachment.path) !== expected) {
        throw new AttachmentValidationError("File attachment does not belong to this session");
      }
      const current = await realpath(expected).catch(() => null);
      if (
        !current ||
        current !== expected ||
        !pathContains(this.threadDirectory(threadId), current)
      ) {
        throw new AttachmentValidationError("File attachment is unavailable");
      }
      const info = await Promise.all([stat(current), access(current, constants.R_OK)])
        .then(([value]) => value)
        .catch(() => null);
      if (!info?.isFile() || info.size !== attachment.size) {
        throw new AttachmentValidationError("File attachment is unavailable");
      }
      total += info.size;
      if (total > MAX_MESSAGE_ATTACHMENT_BYTES) {
        throw new AttachmentTooLargeError("Attachments exceed the 250 MiB message limit");
      }
      validated.push({ ...attachment, path: current });
    }
    return validated;
  }

  async remove(threadId: string, attachmentId: string): Promise<void> {
    if (!validAttachmentId(attachmentId)) {
      throw new AttachmentValidationError("Invalid file attachment id");
    }
    await rm(join(this.threadDirectory(threadId), attachmentId), {
      recursive: true,
      force: true,
    });
  }

  async removeThread(threadId: string): Promise<void> {
    await rm(this.threadDirectory(threadId), { recursive: true, force: true });
  }

  async resolveDownload(
    threadId: string,
    input: string,
  ): Promise<{ root: string; path: string; fileName: string; size: number } | null> {
    const root = this.threadDirectory(threadId);
    const path = await realpath(input).catch(() => null);
    if (!path || !pathContains(root, path)) return null;
    const info = await Promise.all([stat(path), access(path, constants.R_OK)])
      .then(([value]) => value)
      .catch(() => null);
    return info?.isFile() ? { root, path, fileName: basename(path), size: info.size } : null;
  }

  private threadDirectory(threadId: string): string {
    const key = createHash("sha256").update(threadId).digest("hex");
    return join(this.root, key);
  }

  private attachmentPath(threadId: string, id: string, name: string): string {
    if (!validAttachmentId(id) || safeFileName(name) !== name) {
      throw new AttachmentValidationError("Invalid file attachment");
    }
    return resolve(this.threadDirectory(threadId), id, name);
  }
}

export function isAttachmentShape(value: unknown): value is ThreadFileAttachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const attachment = value as Partial<ThreadFileAttachment>;
  return (
    validAttachmentId(attachment.id) &&
    typeof attachment.name === "string" &&
    attachment.name === safeFileName(attachment.name) &&
    typeof attachment.path === "string" &&
    attachment.path.length > 0 &&
    isAbsolute(attachment.path) &&
    typeof attachment.size === "number" &&
    Number.isSafeInteger(attachment.size) &&
    attachment.size >= 0 &&
    attachment.size <= MAX_ATTACHMENT_BYTES &&
    typeof attachment.mediaType === "string" &&
    attachment.mediaType === safeMediaType(attachment.mediaType)
  );
}

function validAttachmentId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
  );
}

function safeFileName(value: string): string {
  const normalized = basename(value.replace(/[\\/]/gu, "_"))
    .replace(/\p{Cc}/gu, "_")
    .trim();
  const fallback = normalized && normalized !== "." && normalized !== ".." ? normalized : "file";
  let result = "";
  for (const character of fallback) {
    if (Buffer.byteLength(result + character, "utf8") > 200) break;
    result += character;
  }
  return result || "file";
}

function safeMediaType(value: string): string {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(normalized)
    ? normalized
    : "application/octet-stream";
}
