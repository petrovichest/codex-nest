import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { JsonlTransport, RpcTimeoutError, type JsonlProcess, type RpcError } from "./transport";

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

function harness() {
  const child = new FakeChild();
  const written: string[] = [];
  child.stdin.on("data", (chunk) => written.push(chunk.toString()));
  const transport = new JsonlTransport(child as unknown as JsonlProcess);
  return { child, written, transport };
}

afterEach(() => vi.useRealTimers());

describe("JsonlTransport", () => {
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

  it("kills the child and rejects pending requests after malformed JSON", async () => {
    const { child, transport } = harness();
    const pending = transport.request("thread/list", {});
    child.stdout.write("not-json\n");
    await expect(pending).rejects.toThrow("Malformed JSON");
    expect(child.killed).toBe(true);
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
