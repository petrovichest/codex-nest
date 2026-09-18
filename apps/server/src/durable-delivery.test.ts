import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DurableDelivery, type DeliveryBridge } from "./durable-delivery";
import { messageContentHash } from "./message-queue";
import { StateStore } from "./state/store";
import { RpcError } from "./codex/transport";
import { BridgeUnavailableError } from "./codex/bridge";

const directories: string[] = [];
const hash = messageContentHash("hello", [], [], false);
const params = {
  threadId: "thread",
  clientUserMessageId: "message",
  input: ["hello"],
  model: "original",
};
const deliveryReceipt = { version: 1, clientId: "message", threadId: "thread", turnId: "turn" };

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-delivery-"));
  directories.push(directory);
  const store = new StateStore(join(directory, "state.json"));
  await store.load();
  const request = vi.fn(async () => ({ turn: { id: "turn" }, deliveryReceipt }));
  const bridge = { deliveryVersion: 1, request } as unknown as DeliveryBridge;
  return { store, request, bridge, sender: new DurableDelivery(store, bridge) };
}

describe("DurableDelivery", () => {
  it("keeps original pasted presentation after acceptance and a restart", async () => {
    const { store, sender } = await setup();
    const presentation = {
      input: "Check abc",
      inlinePastes: [{ id: "short", start: 6, end: 9 }],
      pasteBlocks: [{ id: "large", text: "# Log\n42" }],
    };
    const pastedHash = messageContentHash(
      presentation.input,
      [],
      [],
      false,
      undefined,
      undefined,
      presentation,
    );
    expect(pastedHash).not.toBe(messageContentHash(presentation.input, [], [], false));
    await sender.send(
      "thread",
      "message",
      pastedHash,
      "turn/start",
      params,
      undefined,
      presentation,
    );
    const reopened = new StateStore(store.path);
    await reopened.load();
    expect(reopened.view().messageReceipts?.message?.presentation).toEqual(presentation);
    expect(reopened.view().messageReceipts?.message?.request).toBeUndefined();
  });

  it("treats a receiver restart as retryable and replays the frozen command after reconnection", async () => {
    const { store, request, sender } = await setup();
    request.mockRejectedValueOnce(new Error("reply lost"));
    await expect(sender.send("thread", "message", hash, "turn/start", params)).rejects.toThrow(
      "reply lost",
    );
    const bridge = {
      ready: false,
      deliveryVersion: undefined as number | undefined,
      request,
    } as DeliveryBridge & { ready: boolean; deliveryVersion: number | undefined };
    const recovered = new DurableDelivery(store, bridge);
    await expect(recovered.replay("message")).rejects.toBeInstanceOf(BridgeUnavailableError);
    expect(store.view().messageReceipts?.message?.request).toEqual({
      method: "turn/start",
      params,
    });
    bridge.ready = true;
    bridge.deliveryVersion = 1;
    await expect(recovered.replay("message")).resolves.toEqual(deliveryReceipt);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("keeps a definitive rejection after restart without retrying the native command", async () => {
    const { store, request, bridge, sender } = await setup();
    request.mockRejectedValueOnce(
      new RpcError(-32602, "blocked by hook", { delivery: "rejected" }),
    );
    await expect(sender.send("thread", "message", hash, "turn/start", params)).rejects.toThrow(
      "blocked by hook",
    );
    const reopened = new StateStore(store.path);
    await reopened.load();
    await expect(new DurableDelivery(reopened, bridge).replay("message")).rejects.toThrow(
      "отклонил",
    );
    expect(reopened.view().messageReceipts?.message).toMatchObject({
      status: "rejected",
      turnId: null,
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("keeps the exact command across restart and a change of route or settings", async () => {
    const { store, request, bridge, sender } = await setup();
    request.mockRejectedValueOnce(new Error("reply lost"));
    await expect(sender.send("thread", "message", hash, "turn/start", params)).rejects.toThrow(
      "reply lost",
    );
    const reopened = new StateStore(store.path);
    await reopened.load();
    const recovered = new DurableDelivery(reopened, bridge);
    await expect(
      recovered.send("thread", "message", hash, "turn/steer", {
        ...params,
        model: "changed",
        expectedTurnId: "another-turn",
      }),
    ).resolves.toEqual(deliveryReceipt);
    expect(request.mock.calls).toEqual([
      ["turn/start", params],
      ["turn/start", params],
    ]);
    expect(reopened.view().messageReceipts?.message).toEqual({
      threadId: "thread",
      turnId: "turn",
      contentHash: hash,
      createdAt: expect.any(Number),
      status: "delivered",
      deliveryVersion: 1,
    });
  });

  it("replays a committed receipt after restart without calling Codex again", async () => {
    const { store, request, bridge, sender } = await setup();
    await sender.send("thread", "message", hash, "turn/start", params);
    const reopened = new StateStore(store.path);
    await reopened.load();
    await expect(new DurableDelivery(reopened, bridge).replay("message")).resolves.toEqual(
      deliveryReceipt,
    );
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    { turn: { id: "turn" } },
    { deliveryReceipt: { ...deliveryReceipt, version: 2 } },
    { deliveryReceipt: { ...deliveryReceipt, clientId: "another-message" } },
    { deliveryReceipt: { ...deliveryReceipt, threadId: "another-thread" } },
    { deliveryReceipt, turn: { id: "another-turn" } },
  ])("retains the command when the response does not prove its delivery: %j", async (response) => {
    const { store, request, sender } = await setup();
    request.mockResolvedValueOnce(response as never);
    await expect(sender.send("thread", "message", hash, "turn/start", params)).rejects.toThrow();
    expect(store.view().messageReceipts?.message).toMatchObject({
      status: "prepared",
      turnId: null,
      request: { method: "turn/start", params },
    });
  });

  it("rejects reuse with different content before contacting the receiver", async () => {
    const { request, sender } = await setup();
    await sender.send("thread", "message", hash, "turn/start", params);
    await expect(
      sender.send(
        "thread",
        "message",
        messageContentHash("changed", [], [], false),
        "turn/start",
        params,
      ),
    ).rejects.toThrow("уже использован");
    expect(request).toHaveBeenCalledOnce();
  });

  it("sends through an ordinary receiver and replays its local acknowledgement without another RPC", async () => {
    const { store, request } = await setup();
    request.mockResolvedValue({
      turn: { id: "turn", items: [], status: "inProgress", error: null },
    } as never);
    const legacy = new DurableDelivery(store, { request } as unknown as DeliveryBridge);
    await expect(legacy.send("thread", "message", hash, "turn/start", params)).resolves.toEqual({
      turnId: "turn",
    });
    const reopened = new StateStore(store.path);
    await reopened.load();
    await expect(
      new DurableDelivery(reopened, { request } as unknown as DeliveryBridge).replay("message"),
    ).resolves.toEqual({ turnId: "turn" });
    expect(reopened.view().messageReceipts?.message).toMatchObject({
      status: "delivered",
      turnId: "turn",
    });
    expect(reopened.view().messageReceipts?.message?.deliveryVersion).toBeUndefined();
    expect(request).toHaveBeenCalledOnce();
  });

  it("keeps an ambiguous ordinary send across restart without resending when history is empty", async () => {
    const { store, request } = await setup();
    request.mockRejectedValueOnce(new Error("connection lost"));
    const bridge = { request } as unknown as DeliveryBridge;
    await expect(
      new DurableDelivery(store, bridge).send("thread", "message", hash, "turn/start", params),
    ).rejects.toThrow("connection lost");
    request.mockResolvedValue({ data: [], nextCursor: null } as never);
    const reopened = new StateStore(store.path);
    await reopened.load();
    await expect(
      new DurableDelivery(reopened, bridge).send("thread", "message", hash, "turn/start", params),
    ).rejects.toThrow("без повторной отправки");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "turn/start",
      "thread/turns/list",
    ]);
    expect(reopened.view().messageReceipts?.message?.status).toBe("prepared");
  });

  it("does not dispatch concurrent ordinary retries twice", async () => {
    const { store } = await setup();
    const request = vi.fn(async (method: string) =>
      method === "turn/start"
        ? { turn: { id: "turn", items: [], status: "inProgress", error: null } }
        : { data: [], nextCursor: null },
    );
    const sender = new DurableDelivery(store, { request } as unknown as DeliveryBridge);
    const results = await Promise.allSettled([
      sender.send("thread", "message", hash, "turn/start", params),
      sender.send("thread", "message", hash, "turn/start", params),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
    expect(store.view().messageReceipts?.message?.status).toBe("delivered");
  });

  it("never downgrades a prepared native command to the ordinary protocol", async () => {
    const { store, request, sender } = await setup();
    request.mockRejectedValueOnce(new Error("connection lost"));
    await expect(sender.send("thread", "message", hash, "turn/start", params)).rejects.toThrow();
    await expect(
      new DurableDelivery(store, { request } as unknown as DeliveryBridge).send(
        "thread",
        "message",
        hash,
        "turn/start",
        params,
      ),
    ).rejects.toThrow("совместимая сборка");
    expect(request).toHaveBeenCalledOnce();
  });
});
