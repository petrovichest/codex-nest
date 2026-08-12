import { describe, expect, it, vi } from "vitest";

import {
  CdpNetworkCaptureAssembler,
  sha256,
  type CompletedNetworkCapture,
} from "./network-capture";
import { streamNetworkCapture, streamNetworkCaptureDrop } from "./network-stream";

describe("CDP network capture", () => {
  it("waits for a complete exchange and preserves exact request and binary response bytes", async () => {
    const captures: CompletedNetworkCapture[] = [];
    const command = vi.fn(async (_tabId: number, method: string) => {
      if (method === "Network.getRequestPostData") return { postData: "lossy fallback" };
      if (method === "Network.getResponseBody") {
        return { body: "Av4=", base64Encoded: true };
      }
      throw new Error(`Unexpected command ${method}`);
    });
    const assembler = new CdpNetworkCaptureAssembler(
      command,
      () => "thread-1",
      (capture) => captures.push(capture),
    );

    assembler.accept(7, "Network.requestWillBeSentExtraInfo", {
      requestId: "provider-1",
      headers: { "content-type": "application/octet-stream", "x-exact": "yes" },
    });
    assembler.accept(7, "Network.requestWillBeSent", {
      requestId: "provider-1",
      timestamp: 1,
      wallTime: 2,
      type: "Fetch",
      initiator: { type: "script", future: true },
      request: {
        url: "https://example.test/data",
        method: "POST",
        hasPostData: true,
        postDataEntries: [{ bytes: "AP8B" }],
        headers: { "content-type": "application/octet-stream" },
      },
      futureProviderField: { nested: true },
    });
    assembler.accept(7, "Network.responseReceived", {
      requestId: "provider-1",
      timestamp: 3,
      hasExtraInfo: true,
      response: {
        url: "https://example.test/data",
        status: 200,
        statusText: "OK",
        protocol: "h2",
        mimeType: "application/octet-stream",
        headers: { "content-type": "application/octet-stream" },
        remoteIPAddress: "127.0.0.1",
        remotePort: 443,
      },
    });
    assembler.accept(7, "Network.responseReceivedExtraInfo", {
      requestId: "provider-1",
      headers: { "content-type": "application/octet-stream", "x-raw": "kept" },
    });
    expect(captures).toHaveLength(0);
    assembler.accept(7, "Network.loadingFinished", {
      requestId: "provider-1",
      timestamp: 4,
      encodedDataLength: 3,
    });

    await vi.waitFor(() => expect(captures).toHaveLength(1));
    const capture = captures[0]!;
    expect([...capture.requestBody!]).toEqual([0, 255, 1]);
    expect([...capture.responseBody!]).toEqual([2, 254]);
    const metadata = JSON.parse(new TextDecoder().decode(capture.metadata));
    expect(metadata.exchange.request.body).toMatchObject({
      byteLength: 3,
      sha256: await sha256(capture.requestBody!),
    });
    expect(metadata.exchange.response.body).toMatchObject({
      byteLength: 2,
      sha256: await sha256(capture.responseBody!),
    });
    expect(metadata.rawEvents[0].payload.futureProviderField).toEqual({ nested: true });
    expect(metadata.rawEvents.map((event: { event: string }) => event.event)).toEqual([
      "Network.requestWillBeSent",
      "Network.requestWillBeSentExtraInfo",
      "Network.responseReceived",
      "Network.responseReceivedExtraInfo",
      "Network.loadingFinished",
    ]);

    const frames: Array<Record<string, unknown>> = [];
    await streamNetworkCapture(capture, (frame) => frames.push(frame));
    expect(frames[0]).toMatchObject({
      type: "network.capture.start",
      threadId: "thread-1",
      tabId: 7,
      exchangeId: capture.exchangeId,
      provider: "chrome",
    });
    expect(frames.at(-1)).toMatchObject({ type: "network.capture.commit" });
    const responseChunks = frames.filter(
      (frame) => frame.type === "network.capture.chunk" && frame.part === "responseBody",
    );
    expect(responseChunks).toHaveLength(1);
    expect(responseChunks[0]).toMatchObject({ offset: 0, data: "Av4=" });
  });

  it("emits redirect hops separately and links adjacent exchanges", async () => {
    const captures: CompletedNetworkCapture[] = [];
    const responseBodies = [
      { body: "cmVkaXJlY3Q=", base64Encoded: true },
      { body: "ZmluYWw=", base64Encoded: true },
    ];
    const assembler = new CdpNetworkCaptureAssembler(
      vi.fn(async (_tabId, method) => {
        if (method === "Network.getResponseBody") return responseBodies.shift();
        throw new Error(`Unexpected command ${method}`);
      }),
      () => "thread-redirect",
      (capture) => captures.push(capture),
    );

    assembler.accept(2, "Network.requestWillBeSent", {
      requestId: "redirect-request",
      timestamp: 1,
      request: { url: "https://example.test/old", method: "GET", headers: {} },
    });
    assembler.accept(2, "Network.requestWillBeSentExtraInfo", {
      requestId: "redirect-request",
      headers: {},
    });
    assembler.accept(2, "Network.requestWillBeSent", {
      requestId: "redirect-request",
      timestamp: 2,
      redirectHasExtraInfo: true,
      redirectResponse: {
        url: "https://example.test/old",
        status: 302,
        statusText: "Found",
        headers: { location: "https://example.test/final" },
      },
      request: { url: "https://example.test/final", method: "GET", headers: {} },
    });
    assembler.accept(2, "Network.responseReceivedExtraInfo", {
      requestId: "redirect-request",
      headers: { location: "https://example.test/final" },
    });
    assembler.accept(2, "Network.requestWillBeSentExtraInfo", {
      requestId: "redirect-request",
      headers: {},
    });
    assembler.accept(2, "Network.responseReceived", {
      requestId: "redirect-request",
      timestamp: 3,
      hasExtraInfo: true,
      response: {
        url: "https://example.test/final",
        status: 200,
        statusText: "OK",
        headers: {},
      },
    });
    assembler.accept(2, "Network.responseReceivedExtraInfo", {
      requestId: "redirect-request",
      headers: {},
    });
    assembler.accept(2, "Network.loadingFinished", {
      requestId: "redirect-request",
      timestamp: 4,
      encodedDataLength: 5,
    });

    await vi.waitFor(() => expect(captures).toHaveLength(2));
    const metadata = captures
      .map((capture) => JSON.parse(new TextDecoder().decode(capture.metadata)))
      .sort((left, right) => left.exchange.redirect.index - right.exchange.redirect.index);
    expect(metadata[0].exchange.redirect).toMatchObject({
      index: 0,
      redirectedFromExchangeId: null,
      redirectedToExchangeId: metadata[1].exchange.exchangeId,
    });
    expect(metadata[1].exchange.redirect).toMatchObject({
      index: 1,
      redirectedFromExchangeId: metadata[0].exchange.exchangeId,
      redirectedToExchangeId: null,
    });
    expect(metadata[0].exchange.response.status).toBe(302);
    expect(metadata[1].exchange.response.status).toBe(200);
  });

  it("drops the whole exchange when a body is unavailable or over 100 MiB", async () => {
    const captures: CompletedNetworkCapture[] = [];
    const drops: Array<Record<string, unknown>> = [];
    const command = vi.fn(async (_tabId: number, method: string) => {
      if (method === "Network.getRequestPostData") throw new Error("evicted");
      return { body: "ok", base64Encoded: false };
    });
    const assembler = new CdpNetworkCaptureAssembler(
      command,
      () => "thread-drop",
      (capture) => captures.push(capture),
      (capture) => drops.push(capture),
    );
    assembler.accept(1, "Network.requestWillBeSent", {
      requestId: "drop-1",
      request: { url: "https://example.test", method: "POST", hasPostData: true },
    });
    assembler.accept(1, "Network.responseReceived", {
      requestId: "drop-1",
      response: { url: "https://example.test", status: 200, headers: {} },
    });
    assembler.accept(1, "Network.loadingFinished", {
      requestId: "drop-1",
      encodedDataLength: 101 * 1024 * 1024,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(captures).toHaveLength(0);
    expect(drops).toEqual([
      expect.objectContaining({
        threadId: "thread-drop",
        tabId: 1,
        reason: expect.stringContaining("Request body"),
      }),
    ]);
    expect(command).toHaveBeenCalledWith(1, "Network.getRequestPostData", {
      requestId: "drop-1",
    });
    expect(command).not.toHaveBeenCalledWith(1, "Network.getResponseBody", expect.anything());

    const frames: Array<Record<string, unknown>> = [];
    await streamNetworkCaptureDrop(
      drops[0] as Parameters<typeof streamNetworkCaptureDrop>[0],
      (frame) => frames.push(frame),
    );
    expect(frames.map((frame) => frame.type)).toEqual([
      "network.capture.start",
      "network.capture.abort",
    ]);
    expect(frames[0]).toMatchObject({
      threadId: "thread-drop",
      tabId: 1,
      parts: { metadata: { byteLength: 0 } },
    });
  });
});
