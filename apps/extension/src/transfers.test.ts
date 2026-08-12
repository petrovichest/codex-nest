import { describe, expect, it, vi } from "vitest";

import { FileTransferRegistry } from "./transfers";

describe("FileTransferRegistry", () => {
  it("assembles ordered project-file chunks and validates size", async () => {
    const requested: string[] = [];
    const registry = new FileTransferRegistry((id) => requested.push(id));
    const result = registry.receive({
      kind: "project_file",
      transferId: "transfer",
      name: "hello.txt",
      mediaType: "text/plain",
      size: 5,
    });
    expect(requested).toEqual(["transfer"]);
    registry.accept({
      type: "file.transfer",
      transferId: "transfer",
      chunkIndex: 1,
      chunkCount: 2,
      data: "bG8=",
    });
    registry.accept({
      type: "file.transfer",
      transferId: "transfer",
      chunkIndex: 0,
      chunkCount: 2,
      data: "aGVs",
    });
    await expect(result).resolves.toMatchObject({
      name: "hello.txt",
      size: 5,
      chunks: ["aGVs", "bG8="],
    });
  });

  it("rejects a transfer larger than 100 MB before requesting it", async () => {
    const request = vi.fn();
    const registry = new FileTransferRegistry(request);
    await expect(
      registry.receive({
        kind: "project_file",
        transferId: "large",
        name: "large.bin",
        mediaType: "application/octet-stream",
        size: 100 * 1024 * 1024 + 1,
      }),
    ).rejects.toThrow(/100 MB/);
    expect(request).not.toHaveBeenCalled();
  });
});
