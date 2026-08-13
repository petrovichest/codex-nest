import { EventEmitter } from "node:events";

import type {
  AttentionRequest,
  AttentionResponse,
  ElicitationSchema,
  PermissionGrant,
} from "@codexnest/protocol";

import type { ServerRequest } from "./codex/generated/index";
import type { JsonlTransport } from "./codex/transport";

interface PendingAttention {
  request: AttentionRequest;
  rpcId: number | string;
  method: string;
  transport: JsonlTransport;
  legacy: boolean;
  serverRequest: ServerRequest;
}

export class AttentionManager extends EventEmitter {
  private readonly pending = new Map<string, PendingAttention>();
  private nextId = 1;

  list(): AttentionRequest[] {
    return [...this.pending.values()].map(({ request }) => request);
  }

  get(id: string): AttentionRequest | undefined {
    return this.pending.get(id)?.request;
  }

  receive(serverRequest: ServerRequest, transport: JsonlTransport): AttentionRequest {
    const id = `attention-${this.nextId++}`;
    const request = normalizeAttention(id, serverRequest);
    if (request.kind === "unsupported") {
      transport.respondError(
        serverRequest.id,
        -32_601,
        `Method not supported: ${serverRequest.method}`,
      );
    }
    this.pending.set(id, {
      request,
      rpcId: serverRequest.id,
      method: serverRequest.method,
      transport,
      legacy:
        serverRequest.method === "execCommandApproval" ||
        serverRequest.method === "applyPatchApproval",
      serverRequest,
    });
    this.emit("upserted", request);
    return request;
  }

  resolve(id: string, response: AttentionResponse): AttentionRequest | null {
    const pending = this.pending.get(id);
    if (!pending || pending.request.kind === "unsupported") return null;
    const result = mapResponse(pending.request, response, pending.legacy, pending.serverRequest);
    this.pending.delete(id);
    pending.transport.respond(pending.rpcId, result);
    this.emit("removed", id);
    return pending.request;
  }

  expireByRpcId(rpcId: number | string): AttentionRequest | null {
    const found = [...this.pending.entries()].find(([, item]) => item.rpcId === rpcId);
    if (!found) return null;
    this.pending.delete(found[0]);
    this.emit("removed", found[0]);
    return found[1].request;
  }

  expireAll(): void {
    const ids = [...this.pending.keys()];
    this.pending.clear();
    for (const id of ids) this.emit("removed", id);
  }
}

function normalizeAttention(id: string, request: ServerRequest): AttentionRequest {
  const createdAt = Date.now();
  switch (request.method) {
    case "item/commandExecution/requestApproval": {
      const params = request.params;
      return {
        id,
        kind: "commandApproval",
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        createdAt,
        command: params.command ?? null,
        cwd: params.cwd ?? null,
        reason: params.reason ?? null,
        networkHost: params.networkApprovalContext?.host ?? null,
        canAcceptForSession: params.availableDecisions?.includes("acceptForSession") ?? true,
        proposedPolicyChanges: [
          ...(params.proposedExecpolicyAmendment
            ? [
                {
                  id: "exec",
                  type: "exec" as const,
                  label: `Разрешать похожую команду: ${params.proposedExecpolicyAmendment.join(" ")}`,
                },
              ]
            : []),
          ...(params.proposedNetworkPolicyAmendments?.map((amendment, index) => ({
            id: `network-${index}`,
            type: "network" as const,
            label: `${amendment.action === "allow" ? "Разрешать" : "Запрещать"} сеть для ${amendment.host}`,
          })) ?? []),
        ],
      };
    }
    case "item/fileChange/requestApproval":
      return {
        id,
        kind: "fileChangeApproval",
        threadId: request.params.threadId,
        turnId: request.params.turnId,
        itemId: request.params.itemId,
        createdAt,
        reason: request.params.reason ?? null,
        grantRoot: request.params.grantRoot ?? null,
        canAcceptForSession: true,
      };
    case "item/permissions/requestApproval":
      return {
        id,
        kind: "permissionApproval",
        threadId: request.params.threadId,
        turnId: request.params.turnId,
        itemId: request.params.itemId,
        createdAt,
        cwd: request.params.cwd,
        reason: request.params.reason,
        permissions: mapPermission(request.params.permissions),
      };
    case "item/tool/requestUserInput":
      return {
        id,
        kind: "userInput",
        threadId: request.params.threadId,
        turnId: request.params.turnId,
        itemId: request.params.itemId,
        createdAt,
        autoResolutionMs: request.params.autoResolutionMs,
        draft: null,
        questions: request.params.questions.map((question) => ({
          id: question.id,
          header: question.header,
          question: question.question,
          isOther: question.isOther,
          isSecret: question.isSecret,
          options:
            question.options?.map((option) => ({
              label: option.label,
              description: option.description,
            })) ?? null,
        })),
      };
    case "mcpServer/elicitation/request":
      return {
        id,
        kind: "elicitation",
        threadId: request.params.threadId,
        turnId: request.params.turnId,
        itemId: null,
        createdAt,
        mode: request.params.mode === "url" ? "url" : "form",
        message: request.params.message,
        url: request.params.mode === "url" ? request.params.url : null,
        schema:
          request.params.mode === "form"
            ? mapElicitationSchema(request.params.requestedSchema)
            : null,
      };
    case "execCommandApproval":
      return {
        id,
        kind: "commandApproval",
        threadId: request.params.conversationId,
        turnId: null,
        itemId: request.params.callId,
        createdAt,
        command: request.params.command.join(" "),
        cwd: request.params.cwd,
        reason: request.params.reason,
        networkHost: null,
        canAcceptForSession: true,
        proposedPolicyChanges: [],
      };
    case "applyPatchApproval":
      return {
        id,
        kind: "fileChangeApproval",
        threadId: request.params.conversationId,
        turnId: null,
        itemId: request.params.callId,
        createdAt,
        reason: request.params.reason,
        grantRoot: request.params.grantRoot,
        canAcceptForSession: true,
      };
    default:
      return {
        id,
        kind: "unsupported",
        threadId: threadIdFrom(request.params),
        turnId: turnIdFrom(request.params),
        itemId: null,
        createdAt,
        method: request.method,
        message: "Эта версия Codex запросила действие, которое CodexNest пока не поддерживает.",
      };
  }
}

function mapResponse(
  request: AttentionRequest,
  response: AttentionResponse,
  legacy: boolean,
  serverRequest: ServerRequest,
): unknown {
  switch (request.kind) {
    case "commandApproval":
    case "fileChangeApproval": {
      if (response.kind === "approvalAmendment") {
        if (
          legacy ||
          request.kind !== "commandApproval" ||
          serverRequest.method !== "item/commandExecution/requestApproval"
        ) {
          throw new AttentionValidationError("Policy amendment is not available for this request");
        }
        if (response.amendmentId === "exec" && serverRequest.params.proposedExecpolicyAmendment) {
          return {
            decision: {
              acceptWithExecpolicyAmendment: {
                execpolicy_amendment: serverRequest.params.proposedExecpolicyAmendment,
              },
            },
          };
        }
        const match = /^network-(\d+)$/.exec(response.amendmentId);
        const amendment = match
          ? serverRequest.params.proposedNetworkPolicyAmendments?.[Number(match[1])]
          : undefined;
        if (amendment) {
          return {
            decision: { applyNetworkPolicyAmendment: { network_policy_amendment: amendment } },
          };
        }
        throw new AttentionValidationError("Unknown policy amendment");
      }
      if (response.kind !== "approval")
        throw new AttentionValidationError("Approval decision expected");
      if (!["accept", "acceptForSession", "decline", "cancel"].includes(response.decision)) {
        throw new AttentionValidationError("Invalid approval decision");
      }
      if (legacy) {
        const decision = {
          accept: "approved",
          acceptForSession: "approved_for_session",
          decline: "denied",
          cancel: "abort",
        } as const;
        return { decision: decision[response.decision] };
      }
      return { decision: response.decision };
    }
    case "permissionApproval":
      if (response.kind !== "permission")
        throw new AttentionValidationError("Permission grant expected");
      assertSubset(request.permissions, response.permissions);
      return { permissions: mapGrantedPermission(response.permissions), scope: response.scope };
    case "userInput":
      if (response.kind !== "userInput") throw new AttentionValidationError("User input expected");
      return {
        answers: Object.fromEntries(
          Object.entries(response.answers).map(([key, answers]) => [key, { answers }]),
        ),
      };
    case "elicitation":
      if (response.kind !== "elicitation")
        throw new AttentionValidationError("Elicitation response expected");
      return { action: response.action, content: response.content, _meta: null };
    case "unsupported":
      throw new AttentionValidationError("Unsupported request cannot be answered");
  }
}

function mapPermission(value: {
  network: { enabled: boolean | null } | null;
  fileSystem: { read: string[] | null; write: string[] | null } | null;
}): PermissionGrant {
  return {
    ...(value.network ? { network: { enabled: value.network.enabled ?? undefined } } : {}),
    ...(value.fileSystem
      ? {
          fileSystem: {
            read: value.fileSystem.read ?? undefined,
            write: value.fileSystem.write ?? undefined,
          },
        }
      : {}),
  };
}

function mapGrantedPermission(value: PermissionGrant): unknown {
  return {
    ...(value.network ? { network: { enabled: value.network.enabled ?? null } } : {}),
    ...(value.fileSystem
      ? {
          fileSystem: {
            read: value.fileSystem.read ?? null,
            write: value.fileSystem.write ?? null,
          },
        }
      : {}),
  };
}

function assertSubset(requested: PermissionGrant, granted: PermissionGrant): void {
  if (granted.network?.enabled && !requested.network?.enabled) {
    throw new AttentionValidationError("Cannot grant unrequested network access");
  }
  for (const mode of ["read", "write"] as const) {
    const allowed = new Set(requested.fileSystem?.[mode] ?? []);
    for (const path of granted.fileSystem?.[mode] ?? []) {
      if (!allowed.has(path))
        throw new AttentionValidationError("Cannot grant an unrequested path");
    }
  }
}

function mapElicitationSchema(value: {
  properties: Record<string, unknown>;
  required?: string[];
}): ElicitationSchema {
  return {
    properties: Object.fromEntries(
      Object.entries(value.properties).map(([name, schema]) => [
        name,
        mapElicitationPrimitive(schema),
      ]),
    ),
    required: value.required ?? [],
  };
}

function mapElicitationPrimitive(value: unknown): ElicitationSchema["properties"][string] {
  if (!isRecord(value) || typeof value.type !== "string") return { type: "string" };
  const common = {
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
  };
  if (value.type === "boolean") {
    return {
      type: "boolean",
      ...common,
      ...(typeof value.default === "boolean" ? { default: value.default } : {}),
    };
  }
  if (value.type === "number" || value.type === "integer") {
    return {
      type: value.type,
      ...common,
      ...(typeof value.minimum === "number" ? { minimum: value.minimum } : {}),
      ...(typeof value.maximum === "number" ? { maximum: value.maximum } : {}),
      ...(typeof value.default === "number" ? { default: value.default } : {}),
    };
  }
  if (value.type === "array") {
    const items = isRecord(value.items) ? value.items : {};
    return {
      type: "array",
      ...common,
      items: { type: "string", enum: stringOptions(items) },
      ...(typeof value.minItems === "number" ? { minItems: value.minItems } : {}),
      ...(typeof value.maxItems === "number" ? { maxItems: value.maxItems } : {}),
    };
  }
  return {
    type: "string",
    ...common,
    ...(typeof value.minLength === "number" ? { minLength: value.minLength } : {}),
    ...(typeof value.maxLength === "number" ? { maxLength: value.maxLength } : {}),
    ...(typeof value.format === "string" ? { format: value.format } : {}),
    ...(typeof value.default === "string" ? { default: value.default } : {}),
    ...(stringOptions(value) ? { enum: stringOptions(value) } : {}),
  };
}

function stringOptions(value: Record<string, unknown>): string[] | undefined {
  if (Array.isArray(value.enum) && value.enum.every((item) => typeof item === "string")) {
    return value.enum as string[];
  }
  if (Array.isArray(value.oneOf)) {
    const options = value.oneOf
      .map((item) => (isRecord(item) && typeof item.const === "string" ? item.const : undefined))
      .filter((item): item is string => !!item);
    return options.length ? options : undefined;
  }
  return undefined;
}

function threadIdFrom(params: unknown): string | null {
  return isRecord(params) && typeof params.threadId === "string" ? params.threadId : null;
}

function turnIdFrom(params: unknown): string | null {
  return isRecord(params) && typeof params.turnId === "string" ? params.turnId : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export class AttentionValidationError extends Error {}
