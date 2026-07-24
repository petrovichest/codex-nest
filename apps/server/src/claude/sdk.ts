import { execFile } from "node:child_process";
import { promisify } from "node:util";

// This module is the ONLY place allowed to import "@anthropic-ai/claude-agent-sdk".
// Everything CodexNest consumes from the SDK is re-expressed here as narrow local
// types so the rest of the server never depends on the SDK's (very large) type
// surface, and so unit tests can supply a fake seam without importing the real SDK.

const execFileAsync = promisify(execFile);

export type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
      is_error?: boolean;
    }
  | { type: "image"; source?: { type: string; media_type?: string; data?: string } }
  | { type: string; [key: string]: unknown };

export interface ClaudeApiMessage {
  role: "user" | "assistant";
  content: string | ClaudeContentBlock[];
  stop_reason?: string | null;
  model?: string;
}

/** One entry from `getSessionMessages` — the SDK-normalized transcript shape. */
export interface ClaudeTranscriptMessage {
  type: "user" | "assistant" | "system";
  uuid: string;
  session_id: string;
  message: ClaudeApiMessage;
  parent_tool_use_id: string | null;
  parent_agent_id: string | null;
  /** ISO timestamp; present at runtime although absent from the SDK's declared type. */
  timestamp?: string;
}

/** Subset of `getSessionInfo`'s result that CodexNest reads. */
export interface ClaudeSessionInfo {
  sessionId: string;
  summary?: string;
  lastModified: number;
  fileSize?: number;
  customTitle?: string;
  firstPrompt?: string;
  cwd?: string;
  gitBranch?: string;
  createdAt?: number;
}

export interface ClaudeSessionReadOptions {
  dir: string;
}

export interface ClaudeQueryParams {
  prompt: string | AsyncIterable<unknown>;
  options?: Record<string, unknown>;
}

/** The interrupt receipt (`still_queued` uuids survive) advertised via `interrupt_receipt_v1`. */
export interface ClaudeInterruptReceipt {
  still_queued?: string[];
}

/**
 * The live query handle: an async generator of SDK messages plus `interrupt()`. Narrowed
 * from the SDK's `Query` so the consumer never depends on the full SDK surface.
 */
export interface ClaudeQuery extends AsyncGenerator<unknown, void, unknown> {
  interrupt(): Promise<ClaudeInterruptReceipt | undefined>;
}

/**
 * The injectable Claude SDK seam. `query` drives live turns (Stage 3); fakes supply a
 * controllable ClaudeQuery. ALL imports of the real SDK stay confined to this module.
 */
export interface ClaudeSdk {
  query(params: ClaudeQueryParams): ClaudeQuery;
  getSessionMessages(
    sessionId: string,
    options: ClaudeSessionReadOptions,
  ): Promise<ClaudeTranscriptMessage[]>;
  getSessionInfo(
    sessionId: string,
    options: ClaudeSessionReadOptions,
  ): Promise<ClaudeSessionInfo | null>;
}

/** Loads the real SDK via dynamic import so it is never pulled into unit tests. */
export async function loadRealSdk(): Promise<ClaudeSdk> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return {
    query: (params: ClaudeQueryParams) => sdk.query(params as never) as unknown as ClaudeQuery,
    getSessionMessages: async (sessionId, options) =>
      (await sdk.getSessionMessages(sessionId, options)) as unknown as ClaudeTranscriptMessage[],
    getSessionInfo: async (sessionId, options) =>
      ((await sdk.getSessionInfo(sessionId, options)) ??
        null) as unknown as ClaudeSessionInfo | null,
  };
}

export type VersionRunner = (
  bin: string,
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

const defaultVersionRunner: VersionRunner = async (bin, args, options) => {
  const result = await execFileAsync(bin, args, {
    timeout: options.timeout,
    maxBuffer: 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

export class ClaudeVersionError extends Error {
  constructor(
    public readonly kind: "spawn" | "parse",
    message: string,
  ) {
    super(message);
    this.name = "ClaudeVersionError";
  }
}

/**
 * Runs `<bin> --version` (10s timeout) and returns the leading semver parsed from
 * output like `2.1.218 (Claude Code)`. Throws {@link ClaudeVersionError} with
 * `kind: "spawn"` when the binary cannot be executed and `kind: "parse"` when the
 * output carries no version.
 */
export async function readClaudeVersion(
  bin: string,
  run: VersionRunner = defaultVersionRunner,
): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await run(bin, ["--version"], { timeout: 10_000 }));
  } catch (error) {
    throw new ClaudeVersionError("spawn", error instanceof Error ? error.message : String(error));
  }
  const match = /(\d+\.\d+\.\d+)/.exec(stdout);
  if (!match) {
    throw new ClaudeVersionError(
      "parse",
      `Не удалось определить версию Claude Code: ${stdout.trim()}`,
    );
  }
  return match[1]!;
}
