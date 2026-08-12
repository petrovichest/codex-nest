import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  connectUnixWebSocket,
  JsonlTransport,
  RpcTimeoutError,
  type JsonlProcess,
  type RpcError,
  type WebSocketClient,
} from "./transport";

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

class FakeWebSocket extends EventEmitter implements WebSocketClient {
  readyState = 0;
  readonly frames: string[] = [];

  constructor(private readonly autoRespond = true) {
    super();
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  send(data: string, callback: (error?: Error) => void): void {
    this.frames.push(data);
    const request = JSON.parse(data) as { id: number };
    if (this.autoRespond) {
      this.emit("message", Buffer.from(JSON.stringify({ id: request.id, result: { ok: true } })));
    }
    callback();
  }

  terminate(): void {
    this.readyState = 3;
    this.emit("close", 1000);
  }
}

function harness() {
  const child = new FakeChild();
  const written: string[] = [];
  child.stdin.on("data", (chunk) => written.push(chunk.toString()));
  const transport = new JsonlTransport(child as unknown as JsonlProcess);
  return { child, written, transport };
}

afterEach(() => vi.useRealTimers());

describe("JsonlTransport", () => {
  it("adapts JSONL envelopes to WebSocket frames over a Unix socket", async () => {
    const socket = new FakeWebSocket();
    let url = "";
    const child = connectUnixWebSocket("/tmp/app-server.sock", (value) => {
      url = value;
      return socket;
    });
    const transport = new JsonlTransport(child);
    const response = transport.request("initialize", {});
    socket.open();

    await expect(response).resolves.toEqual({ ok: true });
    expect(url).toBe("ws+unix:///tmp/app-server.sock:/");
    expect(socket.frames).toHaveLength(1);
    expect(socket.frames[0]).not.toContain("\n");
    transport.shutdown();
    child.kill();
  });

  it("reports the WebSocket close code and reason on stderr", async () => {
    const socket = new FakeWebSocket();
    const child = connectUnixWebSocket("/tmp/app-server.sock", () => socket);
    const stderr: string[] = [];
    child.stderr?.on("data", (chunk) => stderr.push(chunk.toString()));
    socket.open();

    socket.readyState = 3;
    socket.emit("close", 1009, Buffer.from("message too big"));

    expect(stderr.join("")).toContain("WebSocket closed (1009: message too big)");
  });

  it("keeps a multiline WebSocket frame as one JSON-RPC envelope", async () => {
    const socket = new FakeWebSocket(false);
    const child = connectUnixWebSocket("/tmp/app-server.sock", () => socket);
    const transport = new JsonlTransport(child);
    const response = transport.request("initialize", {});
    socket.open();

    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ id: 1, result: { text: "large response" } }, null, 2)),
    );

    await expect(response).resolves.toEqual({ text: "large response" });
    expect(transport.pendingCount).toBe(0);
    transport.shutdown();
  });

  it("correlates successful responses with monotonic ids", async () => {
    const { child, transport, written } = harness();
    const first = transport.request<{ ok: boolean }>("thread/list", {});
    const second = transport.request<string>("model/list", {});
    expect(written.join("")).toContain('"id":1');
    expect(written.join("")).toContain('"id":2');
    child.stdout.write('{"id":2,"result":"models"}\n');
    child.stdout.write('{"id":1,"result":{"ok":true}}\n');
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toBe("models");
  });

  it("maps JSON-RPC errors", async () => {
    const { child, transport } = harness();
    const pending = transport.request("thread/read", {});
    child.stdout.write('{"id":1,"error":{"code":-32001,"message":"missing"}}\n');
    await expect(pending).rejects.toEqual(
      expect.objectContaining<RpcError>({ code: -32001, message: "missing" }),
    );
  });

  it("ignores malformed output without dropping pending requests", async () => {
    const { child, transport } = harness();
    const pending = transport.request("thread/list", {});
    child.stdout.write("not-json\n");
    child.stdout.write('{"id":1,"result":{"ok":true}}\n');
    await expect(pending).resolves.toEqual({ ok: true });
    expect(child.killed).toBe(false);
    expect(transport.pendingCount).toBe(0);
  });

  it("times out a metadata request", async () => {
    vi.useFakeTimers();
    const { transport } = harness();
    const pending = transport.request("model/list", {}, 50);
    const assertion = expect(pending).rejects.toBeInstanceOf(RpcTimeoutError);
    await vi.advanceTimersByTimeAsync(51);
    await assertion;
  });

  it("reports unknown response ids without exposing them as notifications", () => {
    const { child, transport } = harness();
    const listener = vi.fn();
    transport.on("unknownResponse", listener);
    child.stdout.write('{"id":900,"result":{}}\n');
    expect(listener).toHaveBeenCalledWith(900);
  });

  it("rejects every pending request when the child exits", async () => {
    const { child, transport } = harness();
    const one = transport.request("one", {});
    const two = transport.request("two", {});
    child.emit("exit", 1, null);
    await expect(one).rejects.toThrow("exited");
    await expect(two).rejects.toThrow("exited");
  });
});
