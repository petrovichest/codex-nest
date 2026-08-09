import { afterEach, describe, expect, it, vi } from "vitest";

import type { ThreadDraft } from "@codexnest/protocol";

import { ApiClient } from "./api";

describe("ApiClient", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("lists and updates skills for an encoded workspace", async () => {
    const catalog = { cwd: "/work/one two", skills: [], errors: [] };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(catalog), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ path: "/skill/SKILL.md", enabled: false }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient({ baseUrl: "https://codexnest.example", token: "token" });

    await expect(api.listSkills("/work/one two")).resolves.toEqual(catalog);
    await expect(
      api.updateSkillConfig({
        cwd: "/work/one two",
        path: "/skill/SKILL.md",
        enabled: false,
      }),
    ).resolves.toEqual({ path: "/skill/SKILL.md", enabled: false });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      new URL("https://codexnest.example/api/v1/skills?cwd=%2Fwork%2Fone+two&forceReload=false"),
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      new URL("https://codexnest.example/api/v1/skills/config"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          cwd: "/work/one two",
          path: "/skill/SKILL.md",
          enabled: false,
        }),
      }),
    );
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

  it("reads semantic artifacts for an encoded thread without caching", async () => {
    const response = { capability: "explicit", artifacts: [] };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient({ baseUrl: "https://codexnest.example", token: "token" });

    await expect(api.readThreadArtifacts("thread/id")).resolves.toEqual(response);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://codexnest.example/api/v1/threads/thread%2Fid/artifacts"),
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
  });

  it("marks an encoded thread as viewed and retries an ambiguous failure", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient({ baseUrl: "https://codexnest.example", token: "token" });

    const request = api.markViewed("thread/id", { observedUpdatedAt: 123 });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(request).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      new URL("https://codexnest.example/api/v1/threads/thread%2Fid/viewed"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ observedUpdatedAt: 123 }),
      }),
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

    await api.forkThread("thread/id", {
      lastTurnId: "turn",
      agentMessageId: "answer",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://codexnest.example/api/v1/threads/thread%2Fid/forks"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ lastTurnId: "turn", agentMessageId: "answer" }),
      }),
    );
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
