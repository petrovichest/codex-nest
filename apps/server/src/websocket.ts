import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";

import { isClientFrame, type ServerFrame } from "@codexnest/protocol";

import { verifyToken } from "./auth";
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
  store.on("authRotated", () => {
    for (const socket of sockets) socket.close(1008, "Token rotated");
  });
  app.get("/api/v1/events", { websocket: true }, (socket, request) => {
    sockets.add(socket);
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
    const eventListener = (sequence: number, event: unknown) => {
      if (authenticated) send(socket, { type: "event", sequence, event } as ServerFrame);
    };

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
          !verifyToken(frame.token, store.snapshot().auth.tokenSha256)
        ) {
          socket.close(1008, "Unauthorized");
          return;
        }
        authenticated = true;
        clearTimeout(timeout);
        projection.on("event", eventListener);
        send(socket, { type: "snapshot", snapshot: projection.snapshot() });
        return;
      }
      if (frame.type === "ping") send(socket, { type: "pong" });
    });
    socket.on("close", () => {
      clearTimeout(timeout);
      projection.off("event", eventListener);
      sockets.delete(socket);
    });
  });
}

function allowedOrigin(request: FastifyRequest, allowedOrigins: Set<string>): boolean {
  const origin = request.headers.origin;
  return !origin || allowedOrigins.has(origin);
}

function send(socket: WebSocket, frame: ServerFrame): void {
  if (socket.readyState === 1) socket.send(JSON.stringify(frame));
}
