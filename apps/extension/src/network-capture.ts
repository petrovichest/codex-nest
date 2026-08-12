import { MAX_NETWORK_BODY_BYTES } from "./protocol";

type CdpCommand = <T>(
  tabId: number,
  method: string,
  parameters?: Record<string, unknown>,
) => Promise<T>;

interface BodyResult {
  ok: boolean;
  bytes?: Uint8Array;
}

interface BodyDescriptor {
  bodyId: string;
  byteLength: number;
  sha256: string;
  mediaType: string | null;
  encoding: string;
}

interface RawEvent {
  event: string;
  payload: Record<string, unknown>;
}

interface PendingExchange {
  tabId: number;
  requestId: string;
  exchangeId: string;
  chainId: string;
  redirectIndex: number;
  redirectedFromExchangeId: string | null;
  redirectedToExchangeId: string | null;
  requestEvent: Record<string, unknown>;
  request: Record<string, unknown>;
  responseEvent?: Record<string, unknown>;
  response?: Record<string, unknown>;
  failureEvent?: Record<string, unknown>;
  requestExtraInfo?: Record<string, unknown>;
  responseExtraInfo?: Record<string, unknown>;
  expectsExtraInfo: boolean;
  rawEvents: RawEvent[];
  startedAt: number;
  completedAt?: number;
  requestBody: Promise<BodyResult>;
  responseBody?: Promise<BodyResult>;
  terminal: boolean;
  emitted: boolean;
}

interface RequestChain {
  chainId: string;
  current: PendingExchange | null;
  hops: PendingExchange[];
  queuedRequestExtra: Record<string, unknown>[];
  queuedResponseExtra: Record<string, unknown>[];
}

export interface CompletedNetworkCapture {
  threadId: string;
  tabId: number;
  requestId: string;
  exchangeId: string;
  metadata: Uint8Array;
  requestBody?: Uint8Array;
  requestBodySha256?: string;
  responseBody?: Uint8Array;
  responseBodySha256?: string;
  summary: {
    at: number;
    method: string;
    url: string;
    resourceType?: string;
    status?: number;
    mimeType?: string;
    failed?: string;
  };
}

export interface DroppedNetworkCapture {
  threadId: string;
  tabId: number;
  exchangeId: string;
  reason: string;
}

export class CdpNetworkCaptureAssembler {
  private readonly tabs = new Map<number, Map<string, RequestChain>>();

  constructor(
    private readonly command: CdpCommand,
    private readonly threadForTab: (tabId: number) => string | null,
    private readonly onComplete: (capture: CompletedNetworkCapture) => void,
    private readonly onDrop: (capture: DroppedNetworkCapture) => void = () => undefined,
  ) {}

  accept(tabId: number, method: string, value: unknown): void {
    const payload = isRecord(value) ? value : {};
    if (method === "Network.requestWillBeSent") {
      this.requestWillBeSent(tabId, payload);
    } else if (method === "Network.requestWillBeSentExtraInfo") {
      this.requestExtraInfo(tabId, payload);
    } else if (method === "Network.responseReceived") {
      this.responseReceived(tabId, payload);
    } else if (method === "Network.responseReceivedExtraInfo") {
      this.responseExtraInfo(tabId, payload);
    } else if (method === "Network.loadingFinished") {
      this.loadingFinished(tabId, payload);
    } else if (method === "Network.loadingFailed") {
      this.loadingFailed(tabId, payload);
    }
  }

  forget(tabId: number): void {
    for (const chain of this.tabs.get(tabId)?.values() ?? []) {
      for (const hop of chain.hops) {
        if (hop.emitted) continue;
        hop.emitted = true;
        this.drop(hop, "Tab detached before the network exchange was complete");
      }
    }
    this.tabs.delete(tabId);
  }

  private requestWillBeSent(tabId: number, payload: Record<string, unknown>): void {
    const requestId = stringValue(payload.requestId);
    if (!requestId) return;
    const request = isRecord(payload.request) ? payload.request : {};
    const chains = this.tabs.get(tabId) ?? new Map<string, RequestChain>();
    this.tabs.set(tabId, chains);
    let chain = chains.get(requestId);
    const redirectResponse = isRecord(payload.redirectResponse) ? payload.redirectResponse : null;
    if (!chain || (!redirectResponse && chain.current)) {
      chain = createChain();
      chains.set(requestId, chain);
    }

    const previous = redirectResponse ? chain.current : null;
    const exchangeId = crypto.randomUUID();
    if (previous && redirectResponse) {
      previous.redirectedToExchangeId = exchangeId;
      previous.response = redirectResponse;
      previous.responseEvent = payload;
      previous.expectsExtraInfo = payload.redirectHasExtraInfo === true;
      previous.rawEvents.push(rawEvent("Network.requestWillBeSent", payload));
      previous.terminal = true;
      previous.completedAt = Date.now();
      previous.responseBody =
        redirectResponse.encodedDataLength === 0
          ? Promise.resolve({ ok: true })
          : this.captureResponseBody(tabId, requestId, redirectResponse);
      this.assignQueuedExtra(chain, previous);
      this.maybeComplete(chain, previous);
    }

    const hop: PendingExchange = {
      tabId,
      requestId,
      exchangeId,
      chainId: chain.chainId,
      redirectIndex: previous ? previous.redirectIndex + 1 : 0,
      redirectedFromExchangeId: previous?.exchangeId ?? null,
      redirectedToExchangeId: null,
      requestEvent: payload,
      request,
      expectsExtraInfo: false,
      rawEvents: [rawEvent("Network.requestWillBeSent", payload)],
      startedAt: Date.now(),
      requestBody: this.captureRequestBody(tabId, requestId, request),
      terminal: false,
      emitted: false,
    };
    chain.current = hop;
    chain.hops.push(hop);
    this.assignQueuedExtra(chain, hop);
  }

  private requestExtraInfo(tabId: number, payload: Record<string, unknown>): void {
    const chain = this.ensureChain(tabId, payload.requestId);
    if (!chain) return;
    const hop = chain.hops.find((candidate) => !candidate.emitted && !candidate.requestExtraInfo);
    if (!hop) {
      chain.queuedRequestExtra.push(payload);
      return;
    }
    hop.requestExtraInfo = payload;
    hop.rawEvents.push(rawEvent("Network.requestWillBeSentExtraInfo", payload));
    this.maybeComplete(chain, hop);
  }

  private responseReceived(tabId: number, payload: Record<string, unknown>): void {
    const chain = this.chain(tabId, payload.requestId);
    const hop = chain?.current;
    if (!chain || !hop) return;
    hop.responseEvent = payload;
    hop.response = isRecord(payload.response) ? payload.response : {};
    hop.expectsExtraInfo = payload.hasExtraInfo === true;
    hop.rawEvents.push(rawEvent("Network.responseReceived", payload));
    this.assignQueuedExtra(chain, hop);
  }

  private responseExtraInfo(tabId: number, payload: Record<string, unknown>): void {
    const chain = this.ensureChain(tabId, payload.requestId);
    if (!chain) return;
    const hop = chain.hops.find(
      (candidate) =>
        !candidate.emitted &&
        candidate.expectsExtraInfo &&
        candidate.response !== undefined &&
        !candidate.responseExtraInfo,
    );
    if (!hop) {
      chain.queuedResponseExtra.push(payload);
      return;
    }
    hop.responseExtraInfo = payload;
    hop.rawEvents.push(rawEvent("Network.responseReceivedExtraInfo", payload));
    this.maybeComplete(chain, hop);
  }

  private loadingFinished(tabId: number, payload: Record<string, unknown>): void {
    const chain = this.chain(tabId, payload.requestId);
    const hop = chain?.current;
    if (!chain || !hop) return;
    hop.rawEvents.push(rawEvent("Network.loadingFinished", payload));
    hop.terminal = true;
    hop.completedAt = Date.now();
    hop.responseBody =
      numberValue(payload.encodedDataLength, 0) > MAX_NETWORK_BODY_BYTES
        ? Promise.resolve({ ok: false })
        : hop.response
          ? this.captureResponseBody(tabId, hop.requestId, hop.response)
          : Promise.resolve({ ok: false });
    this.maybeComplete(chain, hop);
  }

  private loadingFailed(tabId: number, payload: Record<string, unknown>): void {
    const chain = this.chain(tabId, payload.requestId);
    const hop = chain?.current;
    if (!chain || !hop) return;
    hop.failureEvent = payload;
    hop.rawEvents.push(rawEvent("Network.loadingFailed", payload));
    hop.terminal = true;
    hop.completedAt = Date.now();
    if (hop.response) hop.responseBody = Promise.resolve({ ok: false });
    this.maybeComplete(chain, hop);
  }

  private assignQueuedExtra(chain: RequestChain, hop: PendingExchange): void {
    if (!hop.requestExtraInfo && chain.queuedRequestExtra.length) {
      const payload = chain.queuedRequestExtra.shift()!;
      hop.requestExtraInfo = payload;
      hop.rawEvents.push(rawEvent("Network.requestWillBeSentExtraInfo", payload));
    }
    if (hop.expectsExtraInfo && !hop.responseExtraInfo && chain.queuedResponseExtra.length) {
      const payload = chain.queuedResponseExtra.shift()!;
      hop.responseExtraInfo = payload;
      hop.rawEvents.push(rawEvent("Network.responseReceivedExtraInfo", payload));
    }
  }

  private maybeComplete(chain: RequestChain, hop: PendingExchange): void {
    if (
      hop.emitted ||
      !hop.terminal ||
      (hop.expectsExtraInfo && (!hop.requestExtraInfo || !hop.responseExtraInfo))
    ) {
      return;
    }
    hop.emitted = true;
    void this.complete(hop)
      .catch((error) => this.drop(hop, errorMessage(error)))
      .finally(() => {
        chain.hops = chain.hops.filter((candidate) => candidate !== hop);
        if (chain.current === hop) chain.current = null;
        if (!chain.current && chain.hops.length === 0) {
          this.tabs.get(hop.tabId)?.delete(hop.requestId);
        }
      });
  }

  private async complete(hop: PendingExchange): Promise<void> {
    const threadId = this.threadForTab(hop.tabId);
    if (!threadId) return;
    let requestBody: BodyResult;
    let responseBody: BodyResult;
    try {
      requestBody = await hop.requestBody;
      if (!requestBody.ok) {
        this.drop(hop, "Request body is unavailable or exceeds the capture limit", threadId);
        return;
      }
      responseBody = hop.responseBody ? await hop.responseBody : { ok: true };
      if (!responseBody.ok) {
        this.drop(hop, "Response body is unavailable or exceeds the capture limit", threadId);
        return;
      }
    } catch (error) {
      this.drop(hop, errorMessage(error), threadId);
      return;
    }

    const requestBytes = requestBody.bytes;
    const responseBytes = responseBody.bytes;
    const requestBodyDescriptor = requestBytes
      ? await bodyDescriptor(requestBytes, hop.request, hop.requestExtraInfo)
      : null;
    const responseBodyDescriptor = responseBytes
      ? await bodyDescriptor(responseBytes, hop.response ?? {}, hop.responseExtraInfo)
      : null;
    const requestHeaders = headers(hop.requestExtraInfo, hop.request);
    const responseHeaders = headers(hop.responseExtraInfo, hop.response ?? {});
    const response = hop.response;
    const failure = hop.failureEvent;
    const metadataValue = {
      schemaVersion: 1,
      provider: "chrome",
      exchange: {
        exchangeId: hop.exchangeId,
        threadId,
        tabId: hop.tabId,
        redirect: {
          chainId: hop.chainId,
          index: hop.redirectIndex,
          redirectedFromExchangeId: hop.redirectedFromExchangeId,
          redirectedToExchangeId: hop.redirectedToExchangeId,
        },
        request: {
          url: stringValue(hop.request.url),
          method: stringValue(hop.request.method) || "GET",
          headers: requestHeaders,
          timestamp: numberValue(hop.requestEvent.timestamp, hop.startedAt),
          wallTime: nullableNumber(hop.requestEvent.wallTime),
          httpVersion: null,
          resourceType: nullableString(hop.requestEvent.type),
          initiator: hop.requestEvent.initiator ?? null,
          body: requestBodyDescriptor,
        },
        response: response
          ? {
              url: stringValue(response.url) || stringValue(hop.request.url),
              status: numberValue(response.status, 0),
              statusText: stringValue(response.statusText),
              headers: responseHeaders,
              timestamp: numberValue(hop.responseEvent?.timestamp, hop.completedAt ?? Date.now()),
              httpVersion: nullableString(response.protocol),
              mediaType: nullableString(response.mimeType),
              remoteAddress:
                typeof response.remoteIPAddress === "string"
                  ? {
                      ip: response.remoteIPAddress,
                      port: nullableNumber(response.remotePort),
                    }
                  : null,
              fromCache: response.fromDiskCache === true || response.fromPrefetchCache === true,
              fromServiceWorker: response.fromServiceWorker === true,
              body: responseBodyDescriptor,
            }
          : null,
        failure: failure
          ? {
              timestamp: numberValue(failure.timestamp, hop.completedAt ?? Date.now()),
              errorText: stringValue(failure.errorText) || "Failed",
              canceled: failure.canceled === true,
              blockedReason: nullableString(failure.blockedReason),
            }
          : null,
        startedAt: hop.startedAt,
        completedAt: hop.completedAt ?? null,
      },
      rawEvents: hop.rawEvents,
    };
    const metadata = new TextEncoder().encode(JSON.stringify(metadataValue));
    if (metadata.byteLength > MAX_NETWORK_BODY_BYTES) {
      this.drop(hop, "Network metadata exceeds the capture limit", threadId);
      return;
    }
    this.onComplete({
      threadId,
      tabId: hop.tabId,
      requestId: hop.requestId,
      exchangeId: hop.exchangeId,
      metadata,
      ...(requestBytes
        ? { requestBody: requestBytes, requestBodySha256: requestBodyDescriptor!.sha256 }
        : {}),
      ...(responseBytes
        ? { responseBody: responseBytes, responseBodySha256: responseBodyDescriptor!.sha256 }
        : {}),
      summary: {
        at: hop.startedAt,
        method: stringValue(hop.request.method) || "GET",
        url: stringValue(hop.request.url),
        resourceType: nullableString(hop.requestEvent.type) ?? undefined,
        status: response ? numberValue(response.status, 0) : undefined,
        mimeType: response ? (nullableString(response.mimeType) ?? undefined) : undefined,
        failed: failure ? stringValue(failure.errorText) || "Failed" : undefined,
      },
    });
  }

  private drop(hop: PendingExchange, reason: string, threadId?: string): void {
    const owner = threadId ?? this.threadForTab(hop.tabId);
    if (!owner) return;
    this.onDrop({
      threadId: owner,
      tabId: hop.tabId,
      exchangeId: hop.exchangeId,
      reason: reason.slice(0, 1_024),
    });
  }

  private captureRequestBody(
    tabId: number,
    requestId: string,
    request: Record<string, unknown>,
  ): Promise<BodyResult> {
    const entries = Array.isArray(request.postDataEntries) ? request.postDataEntries : [];
    const hasBody =
      request.hasPostData === true || typeof request.postData === "string" || entries.length > 0;
    if (!hasBody) return Promise.resolve({ ok: true });
    if (entries.length > 0) {
      try {
        if (!entries.every((entry) => isRecord(entry) && typeof entry.bytes === "string")) {
          return Promise.resolve({ ok: false });
        }
        const chunks = entries.map((entry) => decodeBase64(String(entry.bytes)));
        if (chunks.reduce((total, chunk) => total + chunk.byteLength, 0) > MAX_NETWORK_BODY_BYTES) {
          return Promise.resolve({ ok: false });
        }
        return Promise.resolve({ ok: true, bytes: concatenate(chunks) });
      } catch {
        return Promise.resolve({ ok: false });
      }
    }
    return this.command<{ postData?: unknown }>(tabId, "Network.getRequestPostData", {
      requestId,
    })
      .then((result) => {
        if (typeof result.postData !== "string") return { ok: false };
        const bytes = new TextEncoder().encode(result.postData);
        return bytes.byteLength <= MAX_NETWORK_BODY_BYTES ? { ok: true, bytes } : { ok: false };
      })
      .catch(() => ({ ok: false }));
  }

  private captureResponseBody(
    tabId: number,
    requestId: string,
    response: Record<string, unknown>,
  ): Promise<BodyResult> {
    const status = numberValue(response.status, 0);
    if (status === 204 || status === 205 || status === 304) return Promise.resolve({ ok: true });
    return this.command<{ body?: unknown; base64Encoded?: unknown }>(
      tabId,
      "Network.getResponseBody",
      { requestId },
    )
      .then((result) => {
        if (typeof result.body !== "string") return { ok: false };
        const bytes =
          result.base64Encoded === true
            ? decodeBase64(result.body)
            : new TextEncoder().encode(result.body);
        return bytes.byteLength <= MAX_NETWORK_BODY_BYTES ? { ok: true, bytes } : { ok: false };
      })
      .catch(() => ({ ok: false }));
  }

  private chain(tabId: number, requestId: unknown): RequestChain | undefined {
    return this.tabs.get(tabId)?.get(stringValue(requestId));
  }

  private ensureChain(tabId: number, requestIdValue: unknown): RequestChain | undefined {
    const requestId = stringValue(requestIdValue);
    if (!requestId) return undefined;
    const chains = this.tabs.get(tabId) ?? new Map<string, RequestChain>();
    this.tabs.set(tabId, chains);
    const chain = chains.get(requestId) ?? createChain();
    chains.set(requestId, chain);
    return chain;
  }
}

async function bodyDescriptor(
  bytes: Uint8Array,
  primary: Record<string, unknown>,
  extra?: Record<string, unknown>,
): Promise<BodyDescriptor> {
  const sourceHeaders = headers(extra, primary);
  return {
    bodyId: crypto.randomUUID(),
    byteLength: bytes.byteLength,
    sha256: await sha256(bytes),
    mediaType: headerValue(sourceHeaders, "content-type"),
    encoding: headerValue(sourceHeaders, "content-encoding") ?? "identity",
  };
}

function createChain(): RequestChain {
  return {
    chainId: crypto.randomUUID(),
    current: null,
    hops: [],
    queuedRequestExtra: [],
    queuedResponseExtra: [],
  };
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function headers(
  extra: Record<string, unknown> | undefined,
  primary: Record<string, unknown>,
): Array<{ name: string; value: string }> {
  const value = isRecord(extra?.headers)
    ? extra.headers
    : isRecord(primary.headers)
      ? primary.headers
      : {};
  return Object.entries(value).map(([name, header]) => ({ name, value: String(header) }));
}

function headerValue(values: Array<{ name: string; value: string }>, name: string): string | null {
  return values.find((header) => header.name.toLowerCase() === name)?.value ?? null;
}

function rawEvent(event: string, payload: Record<string, unknown>): RawEvent {
  return { event, payload: structuredClone(payload) };
}

function concatenate(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
