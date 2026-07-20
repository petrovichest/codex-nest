import { describe, expect, it } from "vitest";

import { parseThreadList, parseThreadRead, ProtocolShapeError } from "./guards";

const thread = {
  id: "thread-1",
  preview: "Hello",
  cwd: "/srv/project",
  createdAt: 1,
  updatedAt: 2,
  name: null,
  status: { type: "idle" },
  turns: [],
};

describe("app-server response guards", () => {
  it("accepts the fields CodexNest uses and ignores additive protocol fields", () => {
    const response = {
      data: [{ ...thread, futureThreadField: { enabled: true } }],
      nextCursor: null,
      futurePageField: "ignored",
    };

    expect(parseThreadList(response).data[0]?.id).toBe("thread-1");
  });

  it("rejects a response that omits a field used by the projection", () => {
    expect(() =>
      parseThreadRead({
        thread: {
          ...thread,
          cwd: undefined,
        },
      }),
    ).toThrow(ProtocolShapeError);
  });

  it("rejects malformed pagination envelopes", () => {
    expect(() => parseThreadList({ data: [thread], nextCursor: 42 })).toThrow(
      "Invalid app-server response shape for thread/list",
    );
  });
});
