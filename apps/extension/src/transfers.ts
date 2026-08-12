import {
  MAX_PROJECT_FILE_BYTES,
  type ProjectFileTransferDescriptor,
  type ServerFileTransferFrame,
} from "./protocol";
import { base64ByteLength } from "./cdp";

export interface ProjectFileData {
  name: string;
  mediaType: string;
  size: number;
  chunks: string[];
}

interface PendingTransfer {
  descriptor: ProjectFileTransferDescriptor;
  chunks: Array<string | undefined>;
  receivedBytes: number;
  receivedChunks: number;
  resolve: (value: ProjectFileData) => void;
  reject: (reason: Error) => void;
  timeout: number;
}

export class FileTransferRegistry {
  private readonly pending = new Map<string, PendingTransfer>();

  constructor(
    private readonly request: (transferId: string) => void,
    private readonly timeoutMs = 120_000,
  ) {}

  receive(descriptor: ProjectFileTransferDescriptor): Promise<ProjectFileData> {
    if (
      !Number.isInteger(descriptor.size) ||
      descriptor.size < 0 ||
      descriptor.size > MAX_PROJECT_FILE_BYTES
    ) {
      return Promise.reject(new Error("Project file must be 100 MB or smaller"));
    }
    if (this.pending.has(descriptor.transferId)) {
      return Promise.reject(new Error("Project file transfer is already in progress"));
    }
    const promise = new Promise<ProjectFileData>((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        this.pending.delete(descriptor.transferId);
        reject(new Error("Project file transfer timed out"));
      }, this.timeoutMs);
      this.pending.set(descriptor.transferId, {
        descriptor,
        chunks: [],
        receivedBytes: 0,
        receivedChunks: 0,
        resolve,
        reject,
        timeout,
      });
    });
    try {
      this.request(descriptor.transferId);
    } catch (error) {
      this.fail(descriptor.transferId, error instanceof Error ? error.message : String(error));
    }
    return promise;
  }

  accept(frame: ServerFileTransferFrame): void {
    const transfer = this.pending.get(frame.transferId);
    if (!transfer) return;
    if (
      frame.chunkCount < 1 ||
      frame.chunkIndex < 0 ||
      frame.chunkIndex >= frame.chunkCount ||
      (transfer.chunks.length > 0 && transfer.chunks.length !== frame.chunkCount)
    ) {
      this.fail(frame.transferId, "Invalid project file chunk sequence");
      return;
    }
    if (transfer.chunks[frame.chunkIndex] !== undefined) return;
    transfer.chunks.length = frame.chunkCount;
    transfer.chunks[frame.chunkIndex] = frame.data;
    transfer.receivedBytes += base64ByteLength(frame.data);
    transfer.receivedChunks += 1;
    if (
      transfer.receivedBytes > transfer.descriptor.size ||
      transfer.receivedBytes > MAX_PROJECT_FILE_BYTES
    ) {
      this.fail(frame.transferId, "Project file exceeds its declared size");
      return;
    }
    if (transfer.receivedChunks === frame.chunkCount) {
      if (transfer.receivedBytes !== transfer.descriptor.size) {
        this.fail(frame.transferId, "Project file size does not match its descriptor");
        return;
      }
      clearTimeout(transfer.timeout);
      this.pending.delete(frame.transferId);
      transfer.resolve({
        name: transfer.descriptor.name,
        mediaType: transfer.descriptor.mediaType,
        size: transfer.descriptor.size,
        chunks: transfer.chunks as string[],
      });
    }
  }

  acceptError(transferId: string, message: string): void {
    this.fail(transferId, message);
  }

  clear(reason = "Connection closed during project file transfer"): void {
    for (const [transferId] of this.pending) this.fail(transferId, reason);
  }

  private fail(transferId: string, message: string): void {
    const transfer = this.pending.get(transferId);
    if (!transfer) return;
    clearTimeout(transfer.timeout);
    this.pending.delete(transferId);
    transfer.reject(new Error(message));
  }
}
