import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";

import { isClientFrame, type ServerFrame } from "@codexnest/protocol";

import { verifyToken } from "./auth";
import { isAllowedRequestOrigin } from "./origin";
import type { AppProjection } from "./projection";
import type { StateStore } from "./state/store";

const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const RESYNC_LOW_WATER_BYTES = 256 * 1024;
const RESYNC_RETRY_MS = 50;

type DeliveryState = {
  snapshotNeeded: boolean;
  snapshotSending: boolean;
  backpressured: boolean;
  retryTimer?: NodeJS.Timeout;
};

export function registerEventsWebSocket(
  app: FastifyInstance,
  projection: AppProjection,
  store: StateStore,
  allowedOrigins: Set<string>,
  authTimeoutMs = 5_000,
): void {
  const sockets = new Set<WebSocket>();
  const authenticatedSockets = new Set<WebSocket>();
  const alive = new WeakMap<WebSocket, boolean>();
  const deliveryStates = new Map<WebSocket, DeliveryState>();
  const eventListener = (sequence: number, event: unknown) => {
    if (isResyncRequired(event)) {
      for (const socket of authenticatedSockets) requestSnapshot(socket);
      return;
    }
    broadcast({
      type: "event",
      sequence,
      version: { ...projection.version, sequence },
      event,
    } as ServerFrame);
  };
  const broadcast = (frame: ServerFrame) => {
    const payload = JSON.stringify(frame);
    const payloadBytes = Buffer.byteLength(payload);
    for (const socket of authenticatedSockets) {
      const state = deliveryStates.get(socket);
      if (!state) continue;
      if (state.snapshotNeeded || state.snapshotSending || state.retryTimer !== undefined) {
        state.snapshotNeeded = true;
        continue;
      }
      if (socket.bufferedAmount + payloadBytes > MAX_BUFFERED_BYTES) {
        if (!state.backpressured) {
          app.log.warn(
            { bufferedBytes: socket.bufferedAmount, nextFrameBytes: payloadBytes },
            "coalescing websocket updates under backpressure",
          );
        }
        state.backpressured = true;
        requestSnapshot(socket);
        continue;
      }
      sendSerialized(socket, payload);
    }
  };
  const requestSnapshot = (socket: WebSocket) => {
    const state = deliveryStates.get(socket);
    if (!state) return;
    state.snapshotNeeded = true;
    flushSnapshot(socket, state);
  };
  const flushSnapshot = (socket: WebSocket, state: DeliveryState) => {
    if (
      deliveryStates.get(socket) !== state ||
      !authenticatedSockets.has(socket) ||
      socket.readyState !== 1 ||
      state.snapshotSending ||
      state.retryTimer !== undefined ||
      !state.snapshotNeeded
    ) {
      return;
    }
    if (socket.bufferedAmount > RESYNC_LOW_WATER_BYTES) {
      state.retryTimer = setTimeout(() => {
        state.retryTimer = undefined;
        flushSnapshot(socket, state);
      }, RESYNC_RETRY_MS);
      state.retryTimer.unref();
      return;
    }
    state.snapshotNeeded = false;
    state.snapshotSending = true;
    const sent = sendSerialized(
      socket,
      JSON.stringify({ type: "snapshot", snapshot: projection.snapshot() } satisfies ServerFrame),
      (error) => {
        if (deliveryStates.get(socket) !== state) return;
        state.snapshotSending = false;
        if (error) {
          socket.terminate();
          return;
        }
        if (state.snapshotNeeded) {
          flushSnapshot(socket, state);
        } else {
          state.backpressured = false;
        }
      },
    );
    if (!sent) state.snapshotSending = false;
  };
  projection.on("event", eventListener);
  const heartbeat = setInterval(() => {
    for (const socket of sockets) {
      if (alive.get(socket) === false) {
        socket.terminate();
        continue;
      }
      alive.set(socket, false);
      if (socket.readyState === 1) socket.ping();
    }
  }, 30_000);
  heartbeat.unref();
  app.addHook("onClose", async () => {
    clearInterval(heartbeat);
    projection.off("event", eventListener);
    for (const state of deliveryStates.values()) {
      if (state.retryTimer) clearTimeout(state.retryTimer);
    }
    deliveryStates.clear();
  });
  store.on("authRotated", () => {
    for (const socket of sockets) socket.close(1008, "Token rotated");
  });
  app.get("/api/v1/events", { websocket: true }, (socket, request) => {
    sockets.add(socket);
    alive.set(socket, true);
    if (!allowedOrigin(request, allowedOrigins)) {
      socket.close(1008, "Origin not allowed");
      return;
    }
    const url = new URL(request.url, "http://localhost");
    if (url.searchParams.has("token") || url.searchParams.has("access_token")) {
      socket.close(1008, "Token must not be passed in URL");
      return;
    }
    let authenticated = false;
    const timeout = setTimeout(() => socket.close(1008, "Authentication timeout"), authTimeoutMs);
    timeout.unref();
    socket.on("pong", () => alive.set(socket, true));

    socket.on("message", (data) => {
      let frame: unknown;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        socket.close(1003, "Malformed frame");
        return;
      }
      if (!isClientFrame(frame)) {
        socket.close(1008, "Invalid frame");
        return;
      }
      if (!authenticated) {
        if (
          frame.type !== "authenticate" ||
          !verifyToken(frame.token, store.view().auth.tokenSha256)
        ) {
          socket.close(1008, "Unauthorized");
          return;
        }
        authenticated = true;
        clearTimeout(timeout);
        authenticatedSockets.add(socket);
        deliveryStates.set(socket, {
          snapshotNeeded: false,
          snapshotSending: false,
          backpressured: false,
        });
        requestSnapshot(socket);
        return;
      }
      if (frame.type === "ping") send(socket, { type: "pong" });
    });
    socket.on("close", () => {
      clearTimeout(timeout);
      authenticatedSockets.delete(socket);
      sockets.delete(socket);
      const state = deliveryStates.get(socket);
      if (state?.retryTimer) clearTimeout(state.retryTimer);
      deliveryStates.delete(socket);
    });
  });
}

function allowedOrigin(request: FastifyRequest, allowedOrigins: Set<string>): boolean {
  return isAllowedRequestOrigin(request, allowedOrigins);
}

function send(socket: WebSocket, frame: ServerFrame): void {
  sendSerialized(socket, JSON.stringify(frame));
}

function sendSerialized(
  socket: WebSocket,
  payload: string,
  callback?: (error?: Error) => void,
): boolean {
  if (socket.readyState !== 1) return false;
  socket.send(payload, callback);
  return true;
}

function isResyncRequired(event: unknown): event is { type: "resync.required" } {
  return (
    !!event && typeof event === "object" && "type" in event && event.type === "resync.required"
  );
}
