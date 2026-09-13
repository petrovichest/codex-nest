import type { AppServerState, DeliveryReceipt } from "@codexnest/protocol";

import type { StateStore } from "./state/store";
import { RpcError } from "./codex/transport";
import { BridgeUnavailableError } from "./codex/bridge";

export interface DeliveryBridge {
  readonly deliveryVersion?: number;
  readonly ready?: boolean;
  readonly state?: AppServerState;
  request<T>(method: string, params: unknown): Promise<T>;
}

export class DeliveryContractError extends Error {}

export function requireDurableReceiver(bridge: DeliveryBridge): void {
  if (bridge.ready === false) throw new BridgeUnavailableError(bridge.state ?? "unavailable");
  if (bridge.deliveryVersion !== 1) {
    throw new DeliveryContractError(
      "Для надёжной отправки требуется совместимая сборка Codex. Сообщение сохранено.",
    );
  }
}

/** Keeps the exact native command until the receiver proves durable acceptance. */
export class DurableDelivery {
  constructor(
    private readonly store: StateStore,
    private readonly bridge: DeliveryBridge,
  ) {}

  async send(
    threadId: string,
    clientId: string,
    contentHash: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<DeliveryReceipt> {
    requireDurableReceiver(this.bridge);
    await this.store.update((state) => {
      state.messageReceipts ??= {};
      const existing = state.messageReceipts[clientId];
      if (existing) {
        if (existing.status === "canceled") throw new DeliveryContractError("Сообщение отменено.");
        if (existing.threadId !== threadId || existing.contentHash !== contentHash) {
          throw new DeliveryContractError("Идентификатор сообщения уже использован.");
        }
        if (existing.deliveryVersion !== 1) {
          throw new DeliveryContractError("Доставка старого сообщения не подтверждена Codex.");
        }
        return;
      }
      state.messageReceipts[clientId] = {
        threadId,
        turnId: null,
        contentHash,
        createdAt: Date.now(),
        status: "prepared",
        deliveryVersion: 1,
        request: { method, params: structuredClone(params) },
      };
    });
    return this.replay(clientId);
  }

  async replay(clientId: string): Promise<DeliveryReceipt> {
    const saved = this.store.view().messageReceipts?.[clientId];
    if (!saved || saved.deliveryVersion !== 1 || saved.status === "canceled") {
      throw new DeliveryContractError("Нет подтверждения доставки сообщения.");
    }
    if (saved.status === "delivered" && saved.turnId) {
      return { version: 1, clientId, threadId: saved.threadId, turnId: saved.turnId };
    }
    if (saved.status === "rejected") {
      throw new DeliveryContractError(
        "Codex отклонил сообщение. Его можно отменить и отправить заново.",
      );
    }
    requireDurableReceiver(this.bridge);
    if (!saved.request) {
      throw new DeliveryContractError("Требуется совместимая сборка Codex. Сообщение сохранено.");
    }
    let result: unknown;
    try {
      result = await this.bridge.request<unknown>(saved.request.method, saved.request.params);
    } catch (error) {
      if (
        error instanceof RpcError &&
        error.code === -32602 &&
        (error.data as { delivery?: string } | undefined)?.delivery === "rejected"
      ) {
        await this.store.update((state) => {
          const current = state.messageReceipts?.[clientId];
          if (current?.status !== "prepared") return;
          current.status = "rejected";
          delete current.request;
        });
      }
      throw error;
    }
    const receipt = requireDeliveryReceipt(result, clientId, saved.threadId);
    const response = result as { turn?: { id?: string }; turnId?: string };
    if (!receipt.turnId || receipt.turnId !== (response.turn?.id ?? response.turnId)) {
      throw new DeliveryContractError("Codex не подтвердил ход сообщения.");
    }
    await this.store.update((state) => {
      const current = state.messageReceipts?.[clientId];
      if (!current || current.status === "canceled") {
        throw new DeliveryContractError("Состояние доставки изменилось.");
      }
      current.status = "delivered";
      current.turnId = receipt.turnId;
      delete current.request;
    });
    return receipt;
  }
}

export function requireDeliveryReceipt(
  result: unknown,
  clientId: string,
  threadId?: string,
): DeliveryReceipt {
  const receipt = (result as { deliveryReceipt?: Partial<DeliveryReceipt> } | null)
    ?.deliveryReceipt;
  if (
    receipt?.version !== 1 ||
    receipt.clientId !== clientId ||
    typeof receipt.threadId !== "string" ||
    (threadId !== undefined && receipt.threadId !== threadId) ||
    (receipt.turnId !== null && typeof receipt.turnId !== "string")
  ) {
    throw new DeliveryContractError(
      "Codex не подтвердил сохранение сообщения. Сообщение сохранено в очереди.",
    );
  }
  return receipt as DeliveryReceipt;
}
