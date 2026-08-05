import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";

import {
  isClientFrame,
  isRecord,
  SYNC_PROTOCOL_VERSION,
  type AppSnapshot,
  type ServerEvent,
  type ServerFrame,
} from "@codexnest/protocol";

import { verifyToken } from "./auth";
import { isAllowedRequestOrigin } from "./origin";
import type { AppProjection } from "./projection";
import type { StateStore } from "./state/store";
import type { PersistedProjectionEvent } from "./state/store";

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
  let sendMetricTimer: NodeJS.Timeout | undefined;
  let pendingSendMetric: { committedAt: number; sentAt: number } | null = null;
  const recordProjectionSent = (committedAt: number) => {
    pendingSendMetric = { committedAt, sentAt: Date.now() };
    if (sendMetricTimer) return;
    sendMetricTimer = setTimeout(() => {
      sendMetricTimer = undefined;
      const metric = pendingSendMetric;
      pendingSendMetric = null;
      if (metric) store.markProjectionSent(metric.committedAt, metric.sentAt);
    }, 100);
    sendMetricTimer.unref();
  };
  const eventListener = (committed: PersistedProjectionEvent<ServerEvent>, event: ServerEvent) => {
    const sent = broadcast({
      type: "patch",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      epoch: committed.epoch,
      revision: committed.revision,
      event,
    });
    if (sent) recordProjectionSent(committed.createdAt);
  };
  const resyncListener = (snapshot: AppSnapshot) => {
    broadcast({ type: "resync", protocolVersion: SYNC_PROTOCOL_VERSION, snapshot });
  };
  const broadcast = (frame: ServerFrame): boolean => {
    const payload = JSON.stringify(frame);
    let sent = false;
    for (const socket of authenticatedSockets) {
      if (socket.bufferedAmount > 2 * 1024 * 1024) {
        app.log.warn({ bufferedBytes: socket.bufferedAmount }, "terminating slow websocket client");
        socket.terminate();
        continue;
      }
      sendSerialized(socket, payload);
      sent = true;
    }
    return sent;
  };
  projection.on("event", eventListener);
  projection.on("resync", resyncListener);
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
    if (sendMetricTimer) clearTimeout(sendMetricTimer);
    const metric = pendingSendMetric;
    if (metric) store.markProjectionSent(metric.committedAt, metric.sentAt);
    projection.off("event", eventListener);
    projection.off("resync", resyncListener);
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
      if (
        !authenticated &&
        isRecord(frame) &&
        frame.type === "authenticate" &&
        frame.protocolVersion !== SYNC_PROTOCOL_VERSION
      ) {
        send(socket, {
          type: "error",
          error: {
            code: "client_update_required",
            message: "Клиент CodexNest устарел. Обновите приложение и повторите подключение.",
          },
        });
        socket.close(1008, "Client update required");
        return;
      }
      if (!isClientFrame(frame)) {
        socket.close(1008, "Invalid frame");
        return;
      }
      if (!authenticated) {
        if (
          frame.type !== "authenticate" ||
          !verifyToken(frame.token, store.snapshot().auth.tokenSha256)
        ) {
          socket.close(1008, "Unauthorized");
          return;
        }
        authenticated = true;
        clearTimeout(timeout);
        authenticatedSockets.add(socket);
        const replay =
          frame.cursor && projection.status === "ready"
            ? store.replayProjection<ServerEvent>(frame.cursor)
            : null;
        if (replay !== null) {
          const current = store.projectionCursor();
          send(socket, {
            type: "replay",
            protocolVersion: SYNC_PROTOCOL_VERSION,
            epoch: current.epoch,
            fromRevision: frame.cursor?.revision ?? current.revision,
            toRevision: current.revision,
            patches: replay.map(({ revision, patch }) => ({ revision, event: patch })),
          });
        } else {
          send(socket, {
            type: "snapshot",
            protocolVersion: SYNC_PROTOCOL_VERSION,
            snapshot: projection.snapshot(),
          });
        }
        if (frame.threadId) {
          send(socket, {
            type: "thread.open",
            protocolVersion: SYNC_PROTOCOL_VERSION,
            threadId: frame.threadId,
            detail: projection.projectedThread(frame.threadId),
          });
        }
        return;
      }
      if (frame.type === "ping") send(socket, { type: "pong" });
    });
    socket.on("close", () => {
      clearTimeout(timeout);
      authenticatedSockets.delete(socket);
      sockets.delete(socket);
    });
  });
}

function allowedOrigin(request: FastifyRequest, allowedOrigins: Set<string>): boolean {
  return isAllowedRequestOrigin(request, allowedOrigins);
}

function send(socket: WebSocket, frame: ServerFrame): void {
  sendSerialized(socket, JSON.stringify(frame));
}

function sendSerialized(socket: WebSocket, payload: string): void {
  if (socket.readyState === 1) socket.send(payload);
}
