import { describe, expect, it, vi } from "vitest";

import { ClaudeVersionError, readClaudeVersion, type VersionRunner } from "./sdk";

describe("readClaudeVersion", () => {
  it("parses the leading semver from `--version` output", async () => {
    const run: VersionRunner = vi.fn(async () => ({
      stdout: "2.1.218 (Claude Code)\n",
      stderr: "",
    }));
    await expect(readClaudeVersion("claude", run)).resolves.toBe("2.1.218");
    expect(run).toHaveBeenCalledWith("claude", ["--version"], { timeout: 10_000 });
  });

  it("throws a spawn error when the binary cannot be executed", async () => {
    const run: VersionRunner = vi.fn(async () => {
      throw new Error("spawn claude ENOENT");
    });
    await expect(readClaudeVersion("claude", run)).rejects.toMatchObject({
      name: "ClaudeVersionError",
      kind: "spawn",
    });
  });

  it("throws a parse error when the output carries no version", async () => {
    const run: VersionRunner = vi.fn(async () => ({ stdout: "not a version", stderr: "" }));
    const error = await readClaudeVersion("claude", run).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClaudeVersionError);
    expect((error as ClaudeVersionError).kind).toBe("parse");
  });
});
