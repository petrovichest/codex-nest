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
});
