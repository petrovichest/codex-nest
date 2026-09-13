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

  it("does not send through a receiver without the durable contract", async () => {
    const { store, bridge, request } = await setup();
    const legacy = new DurableDelivery(store, { ...bridge, deliveryVersion: undefined });
    await expect(legacy.send("thread", "message", hash, "turn/start", params)).rejects.toThrow(
      "совместимая сборка",
    );
    expect(request).not.toHaveBeenCalled();
  });
});
