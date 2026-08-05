import { afterEach, describe, expect, it, vi } from "vitest";

import type { ThreadDraft } from "@codexnest/protocol";

import { ApiClient } from "./api";

describe("ApiClient", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not send the server-only draft timestamp back to the draft endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient({ baseUrl: "https://codexnest.example", token: "token" });
    const restoredDraft: ThreadDraft = {
      input: "Текст",
      images: [],
      goalMode: false,
      annotations: [],
      updatedAt: 123,
    };

    await api.updateThreadDraft("thread", restoredDraft);

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      input: "Текст",
      images: [],
      goalMode: false,
      annotations: [],
    });
  });

  it("cancels a voice transcription without deleting its thread", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient({ baseUrl: "https://codexnest.example", token: "token" });

    await api.cancelVoiceTranscription("thread/id");

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://codexnest.example/api/v1/threads/thread%2Fid/voice-transcriptions"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("posts an inclusive fork point to the encoded thread endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ thread: { id: "fork" } }), {
        headers: { "Content-Type": "application/json" },
        status: 201,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient({ baseUrl: "https://codexnest.example", token: "token" });
    api.setProjectionCursor({ epoch: "epoch", revision: 17 });

    await api.forkThread("thread/id", {
      lastTurnId: "turn",
      agentMessageId: "answer",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://codexnest.example/api/v1/threads/thread%2Fid/forks"),
      expect.objectContaining({
        method: "POST",
        body: expect.any(String),
      }),
    );
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({
      lastTurnId: "turn",
      agentMessageId: "answer",
      expectedThreadId: "thread/id",
      expectedRevision: 17,
      commandId: expect.stringMatching(/^fork:/u),
    });
  });

  it("blocks contextual commands until an explicit projection sync", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient({ baseUrl: "https://codexnest.example", token: "token" });

    await expect(
      api.startTurn("thread", { input: "hello", clientMessageId: "message" }),
    ).rejects.toMatchObject({ code: "sync_required" });
    expect(fetchMock).not.toHaveBeenCalled();

    api.setProjectionCursor({ epoch: "epoch", revision: 9 });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ turnId: "turn" }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );
    await api.startTurn("thread", { input: "hello", clientMessageId: "message" });
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      input: "hello",
      clientMessageId: "message",
      expectedThreadId: "thread",
      expectedRevision: 9,
      commandId: "message",
    });
  });

  it("keeps queued desired-state messages valid across later projection revisions", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "message", status: "queued" }), {
        headers: { "Content-Type": "application/json" },
        status: 202,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient({ baseUrl: "https://codexnest.example", token: "token" });
    api.setProjectionCursor({ epoch: "epoch", revision: 9 });

    await api.enqueue("thread", { input: "hello", clientMessageId: "message" });

    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      input: "hello",
      clientMessageId: "message",
      expectedThreadId: "thread",
      commandId: "message",
    });
  });

  it("targets the separate force-restart endpoints", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accepted: true }), {
          headers: { "Content-Type": "application/json" },
          status: 202,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ operation: "idle" }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient({ baseUrl: "https://codexnest.example", token: "token" });

    await expect(api.forceRestartApp()).resolves.toEqual({ accepted: true });
    await expect(api.forceRestartCodex()).resolves.toMatchObject({ operation: "idle" });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      new URL("https://codexnest.example/api/v1/settings/app/force-restart"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      new URL("https://codexnest.example/api/v1/settings/codex/force-restart"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("retries project thread creation after an ambiguous connection failure", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ thread: { id: "thread" } }), {
          headers: { "Content-Type": "application/json" },
          status: 201,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient({ baseUrl: "https://codexnest.example", token: "token" });

    const creation = api.createProjectThread("project");
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(creation).resolves.toMatchObject({ thread: { id: "thread" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["successful", 200],
    ["error", 500],
  ])("keeps the default timeout active while consuming a %s JSON body", async (_label, status) => {
    vi.useFakeTimers();
    const jsonMock = vi.fn();
    const fetchMock = vi.fn().mockImplementation((_url: URL, init: RequestInit) => {
      jsonMock.mockImplementation(
        () =>
          new Promise((_, reject) => {
            init.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("The operation was aborted", "AbortError")),
              { once: true },
            );
          }),
      );
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: jsonMock,
      } as unknown as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient({ baseUrl: "https://codexnest.example", token: "token" });

    const request = api.summary();
    const rejection = expect(request).rejects.toMatchObject(
      status === 200 ? { name: "AbortError" } : { code: "http_error", status: 500 },
    );
    await vi.advanceTimersByTimeAsync(29_999);

    expect(jsonMock).toHaveBeenCalledOnce();
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    await rejection;
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not automatically retry turn item reads", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error("connection lost"));
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient({ baseUrl: "https://codexnest.example", token: "token" });

    const request = api.readTurnItems("thread/id", "turn/id");
    const rejection = expect(request).rejects.toMatchObject({ code: "connection_failed" });
    await vi.runAllTimersAsync();

    await rejection;
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
