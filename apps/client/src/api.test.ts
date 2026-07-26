import { afterEach, describe, expect, it, vi } from "vitest";

import type { ThreadDraft } from "@codexnest/protocol";

import { ApiClient } from "./api";

describe("ApiClient", () => {
  afterEach(() => vi.unstubAllGlobals());

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
});
