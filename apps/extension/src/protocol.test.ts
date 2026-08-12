import { describe, expect, it } from "vitest";

import {
  BROWSER_PROTOCOL,
  BROWSER_PROTOCOL_VERSION,
  MAX_WEBSOCKET_MESSAGE_BYTES,
  TOOL_RESULT_CHUNK_BYTES,
  browserToolResultFrames,
  browserWebSocketUrl,
  isServerFrame,
  normaliseBaseUrl,
} from "./protocol";

describe("browser protocol", () => {
  it("normalises HTTP URLs and uses the dedicated WebSocket endpoint", () => {
    expect(normaliseBaseUrl("127.0.0.1:4310/ ")).toBe("http://127.0.0.1:4310");
    expect(browserWebSocketUrl("https://nest.example/base?q=lost")).toBe(
      "wss://nest.example/api/v1/browser-extension/events",
    );
  });

  it("rejects non-HTTP setup URLs", () => {
    expect(() => normaliseBaseUrl("file:///tmp/nest")).toThrow(/HTTP or HTTPS/);
  });

  it("requires the exact hello protocol and version", () => {
    expect(
      isServerFrame({
        type: "server.hello",
        protocol: BROWSER_PROTOCOL,
        version: BROWSER_PROTOCOL_VERSION,
        locale: "en",
        projects: [],
        threads: [],
      }),
    ).toBe(true);
    expect(
      isServerFrame({
        type: "server.hello",
        protocol: BROWSER_PROTOCOL,
        version: 2,
        locale: "en",
        projects: [],
        threads: [],
      }),
    ).toBe(false);
  });

  it("chunks large tool results into bounded UTF-8 WebSocket messages", () => {
    const result = {
      content: [
        { type: "text", text: "🙂".repeat(30_000) },
        { type: "text", text: '\0\\"'.repeat(20_000) },
      ],
    };
    const frames = browserToolResultFrames("call-1", result);

    expect(frames.length).toBeGreaterThan(1);
    expect(
      frames.every(
        (frame) =>
          frame.type === "tool.result.chunk" &&
          new TextEncoder().encode(frame.data).byteLength <= TOOL_RESULT_CHUNK_BYTES &&
          new TextEncoder().encode(JSON.stringify(frame)).byteLength <= MAX_WEBSOCKET_MESSAGE_BYTES,
      ),
    ).toBe(true);
    const serialized = frames
      .map((frame) => (frame.type === "tool.result.chunk" ? frame.data : ""))
      .join("");
    expect(JSON.parse(serialized)).toEqual(result);
  });
});
