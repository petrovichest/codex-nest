import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";

import { isClientFrame, type ServerFrame } from "@codexnest/protocol";

import { verifyToken } from "./auth";
import { isAllowedRequestOrigin } from "./origin";
import type { AppProjection } from "./projection";
import type { StateStore } from "./state/store";

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
  const eventListener = (sequence: number, event: unknown) => {
    const frame: ServerFrame = isResyncRequired(event)
      ? { type: "snapshot", snapshot: projection.snapshot() }
      : ({ type: "event", sequence, event } as ServerFrame);
    broadcast(frame);
  };
  const broadcast = (frame: ServerFrame) => {
    const payload = JSON.stringify(frame);
    for (const socket of authenticatedSockets) {
      if (socket.bufferedAmount > 2 * 1024 * 1024) {
        app.log.warn({ bufferedBytes: socket.bufferedAmount }, "terminating slow websocket client");
        socket.terminate();
        continue;
      }
      sendSerialized(socket, payload);
    }
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
        send(socket, { type: "snapshot", snapshot: projection.snapshot() });
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

function isResyncRequired(event: unknown): event is { type: "resync.required" } {
  return (
    !!event && typeof event === "object" && "type" in event && event.type === "resync.required"
  );
}
