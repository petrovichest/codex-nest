import { describe, expect, it, vi } from "vitest";

import type { ClaudeQuery, ClaudeSdk } from "./sdk";
import { ClaudeTitleGenerator } from "./title";

/** A one-shot fake query that yields a fixed script then ends. */
function scriptedQuery(messages: unknown[]): ClaudeQuery {
  async function* generate(): AsyncGenerator<unknown, void, unknown> {
    for (const message of messages) yield message;
  }
  const iterator = generate() as ClaudeQuery;
  iterator.interrupt = async () => undefined;
  return iterator;
}

function sdkWith(messages: unknown[]): {
  sdk: Pick<ClaudeSdk, "query">;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(() => scriptedQuery(messages));
  return { sdk: { query }, query };
}

describe("ClaudeTitleGenerator", () => {
  it("returns the normalized title from the success result", async () => {
    const { sdk, query } = sdkWith([
      { type: "system", subtype: "init", session_id: "s" },
      { type: "result", subtype: "success", result: '"Настроить деплой"' },
    ]);
    const title = await new ClaudeTitleGenerator(sdk, "claude").generate("Set up deploy", {
      cwd: "/work",
    });
    expect(title).toBe("Настроить деплой");
    // Tools disabled + no session persistence so no extra Claude session is registered.
    const options = query.mock.calls[0]![0].options;
    expect(options).toMatchObject({
      model: "haiku",
      maxTurns: 1,
      persistSession: false,
      tools: [],
    });
    expect(options.settingSources).toEqual([]);
  });

  it("throws when the model returns an empty or oversized title", async () => {
    const { sdk } = sdkWith([{ type: "result", subtype: "success", result: "   " }]);
    await expect(
      new ClaudeTitleGenerator(sdk, "claude").generate("hi", { cwd: "/work" }),
    ).rejects.toThrow(/invalid|empty/i);

    const big = sdkWith([{ type: "result", subtype: "success", result: "x".repeat(80) }]);
    await expect(
      new ClaudeTitleGenerator(big.sdk, "claude").generate("hi", { cwd: "/work" }),
    ).rejects.toThrow(/invalid/i);
  });

  it("throws when no success result arrives", async () => {
    const { sdk } = sdkWith([{ type: "result", subtype: "error_during_execution" }]);
    await expect(
      new ClaudeTitleGenerator(sdk, "claude").generate("hi", { cwd: "/work" }),
    ).rejects.toThrow(/empty/i);
  });
});
