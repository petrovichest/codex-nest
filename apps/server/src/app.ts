import { access } from "node:fs/promises";
import { resolve } from "node:path";

import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { LogController, type FastifyInstance } from "fastify";

import { registerApi, type ApiServices } from "./api";
import type { AppConfig } from "./config";
import { isAllowedRequestOrigin } from "./origin";
import { registerEventsWebSocket } from "./websocket";

export async function buildApp(config: AppConfig, services: ApiServices): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.CODEXNEST_LOG_LEVEL ?? "info",
      redact: {
        paths: [
          "req.headers.authorization",
          "headers.authorization",
          "req.headers.x-codexnest-restart-token",
          "headers.x-codexnest-restart-token",
          "token",
          "fcmToken",
          "input",
          "images",
          "output",
          "prompt",
          "proxy",
          "req.body.proxy",
          "body.proxy",
          "openAiApiKey",
          "req.body.openAiApiKey",
          "body.openAiApiKey",
        ],
        censor: "[redacted]",
      },
    },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1_048_576,
    forceCloseConnections: true,
  });

  await app.register(cors, {
    origin(origin, callback) {
      callback(null, !origin || config.allowedOrigins.has(origin));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type", "x-codexnest-audio-duration-ms"],
  });
  await app.register(websocket, {
    options: { maxPayload: 64 * 1024 },
    preClose(done) {
      for (const client of this.websocketServer.clients) client.terminate();
      this.websocketServer.close(() => done());
    },
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!isAllowedRequestOrigin(request, config.allowedOrigins)) {
      return reply
        .code(403)
        .send({ error: { code: "unauthorized", message: "Origin not allowed" } });
    }
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' http: https: ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    return payload;
  });

  registerApi(app, services);
  registerEventsWebSocket(
    app,
    services.projection,
    services.store,
    config.allowedOrigins,
    config.websocketAuthTimeoutMs,
  );

  if (await directoryExists(config.clientDist)) {
    await app.register(fastifyStatic, {
      root: config.clientDist,
      prefix: "/",
      wildcard: false,
    });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: { code: "not_found", message: "Route not found" } });
      }
      return reply.type("text/html").sendFile("index.html", resolve(config.clientDist));
    });
  }

  return app;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
