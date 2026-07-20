import { EventEmitter } from "node:events";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import type { ServerNotification, ServerRequest } from "./generated/index";

export interface JsonlProcess {
  stdin: Writable;
  stdout: Readable;
  stderr?: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

interface PendingRequest {
  method: string;
  timer: NodeJS.Timeout;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export class RpcTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`RPC ${method} timed out after ${timeoutMs}ms`);
    this.name = "RpcTimeoutError";
  }
}

export class JsonlTransport extends EventEmitter {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly reader: Interface;
  private nextRequestId = 1;
  private closed = false;

  constructor(private readonly child: JsonlProcess) {
    super();
    this.reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.reader.on("line", (line) => this.onLine(line));
    child.once("exit", (code, signal) => {
      this.failAll(new Error(`codex app-server exited (${code ?? signal ?? "unknown"})`));
      this.closed = true;
      this.emit("exit", code, signal);
    });
  }

  request<T>(method: string, params: unknown, timeoutMs = 15_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("codex app-server transport is closed"));
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcTimeoutError(method, timeoutMs));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        method,
        timer,
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.write(params === undefined ? { id, method } : { id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  respond(id: number | string, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  shutdown(reason = new Error("codex app-server transport stopped")): void {
    if (this.closed) return;
    this.closed = true;
    this.reader.close();
    this.failAll(reason);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private write(envelope: object): void {
    if (this.closed) throw new Error("codex app-server transport is closed");
    this.child.stdin.write(`${JSON.stringify(envelope)}\n`);
  }

  private onLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.protocolFault("Malformed JSON received from codex app-server");
      return;
    }
    if (!isRecord(value)) {
      this.protocolFault("Non-object JSON-RPC envelope received from codex app-server");
      return;
    }

    if ((typeof value.id === "number" || typeof value.id === "string") && "method" in value) {
      if (typeof value.method !== "string" || !("params" in value)) {
        this.protocolFault("Malformed server request received from codex app-server");
        return;
      }
      this.emit("request", value as unknown as ServerRequest);
      return;
    }

    if (typeof value.method === "string" && !("id" in value)) {
      this.emit("notification", value as unknown as ServerNotification);
      return;
    }

    if (typeof value.id !== "number") {
      this.protocolFault("Malformed JSON-RPC response received from codex app-server");
      return;
    }
    const pending = this.pending.get(value.id);
    if (!pending) {
      this.emit("unknownResponse", value.id);
      return;
    }
    this.pending.delete(value.id);
    clearTimeout(pending.timer);
    if (isRpcError(value.error)) {
      pending.reject(new RpcError(value.error.code, value.error.message, value.error.data));
    } else if ("result" in value) {
      pending.resolve(value.result);
    } else {
      pending.reject(new Error(`Malformed RPC response for ${pending.method}`));
    }
  }

  private protocolFault(message: string): void {
    const error = new Error(message);
    this.failAll(error);
    this.closed = true;
    this.reader.close();
    this.emit("protocolError", error);
    this.child.kill("SIGTERM");
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isRpcError(value: unknown): value is JsonRpcErrorShape {
  return isRecord(value) && typeof value.code === "number" && typeof value.message === "string";
}
