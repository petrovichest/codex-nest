import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { TranscriptionConfigResponse } from "@codexnest/protocol";

import { AttentionPanel } from "./AttentionPanel";

const connection = vi.hoisted(() => vi.fn());

vi.mock("../connection", () => ({ useConnection: connection }));

describe("AttentionPanel", () => {
  it("responds to approvals through the existing API", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    connection.mockReturnValue({ api: { respond } });
    render(
      <AttentionPanel
        requests={[
          {
            id: "attention",
            threadId: "thread",
            turnId: "turn",
            itemId: "item",
            createdAt: 1,
            kind: "commandApproval",
            command: "npm test",
            cwd: "/work",
            reason: "Нужно проверить изменения",
            networkHost: null,
            canAcceptForSession: true,
            proposedPolicyChanges: [],
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Разрешить один раз" }));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("attention", {
        kind: "approval",
        decision: "accept",
      }),
    );
  });

  it("shows user-input questions one at a time and submits all answers at the end", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    connection.mockReturnValue({ api: { respond } });
    render(
      <AttentionPanel
        requests={[
          {
            id: "questions",
            threadId: "thread",
            turnId: "turn",
            itemId: "item",
            createdAt: 1,
            kind: "userInput",
            autoResolutionMs: null,
            questions: [
              {
                id: "storage",
                header: "Хранение",
                question: "Где хранить вложения?",
                isOther: true,
                isSecret: false,
                options: [
                  { label: "На сервере", description: "Единое хранилище." },
                  { label: "В проекте", description: "Только локальные файлы." },
                ],
              },
              {
                id: "source",
                header: "Источники",
                question: "Как выбирать изображение?",
                isOther: false,
                isSecret: false,
                options: [
                  { label: "Камера", description: "Сделать новый снимок." },
                  { label: "Галерея", description: "Выбрать готовый файл." },
                ],
              },
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText("Вопрос 1 из 2")).toBeInTheDocument();
    expect(screen.getByText("Где хранить вложения?")).toBeInTheDocument();
    expect(screen.queryByText("Как выбирать изображение?")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Далее" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Далее" }).parentElement).toHaveClass(
      "user-input-actions",
    );

    fireEvent.click(screen.getByRole("radio", { name: /На сервере/ }));
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));

    expect(screen.getByText("Вопрос 2 из 2")).toBeInTheDocument();
    expect(screen.queryByText("Где хранить вложения?")).not.toBeInTheDocument();
    expect(screen.getByText("Как выбирать изображение?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Отправить ответы" })).toBeDisabled();
    expect(respond).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("radio", { name: /Галерея/ }));
    fireEvent.click(screen.getByRole("button", { name: "Отправить ответы" }));

    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("questions", {
        kind: "userInput",
        answers: { storage: ["На сервере"], source: ["Галерея"] },
      }),
    );
  });

  it("records a freeform answer, inserts the transcript at the cursor, and waits for submit", async () => {
    const track = { stop: vi.fn() };
    installMediaRecorder(async () => ({ getTracks: () => [track] }) as unknown as MediaStream);
    const respond = vi.fn().mockResolvedValue(undefined);
    const updatedTimingEstimate = {
      sampleCount: 6,
      estimatedFixedProcessingMs: 1_500,
      estimatedProcessingMsPerAudioSecond: 3_000,
    };
    let resolveTranscription:
      | ((response: { text: string; timingEstimate: typeof updatedTimingEstimate }) => void)
      | undefined;
    const transcribe = vi.fn(
      () =>
        new Promise<{ text: string; timingEstimate: typeof updatedTimingEstimate }>((resolve) => {
          resolveTranscription = resolve;
        }),
    );
    const timingChanged = vi.fn();
    connection.mockReturnValue({ api: { respond, transcribe } });
    render(
      <AttentionPanel
        requests={[
          {
            id: "questions",
            threadId: "thread",
            turnId: "turn",
            itemId: "item",
            createdAt: 1,
            kind: "userInput",
            autoResolutionMs: null,
            questions: [
              {
                id: "details",
                header: "Детали",
                question: "Что учесть?",
                isOther: true,
                isSecret: false,
                options: [{ label: "Ничего", description: "Оставить как есть." }],
              },
            ],
          },
        ]}
        transcriptionConfig={{
          ...transcriptionConfig,
          timingEstimate: {
            sampleCount: 5,
            estimatedFixedProcessingMs: 2_000,
            estimatedProcessingMsPerAudioSecond: 0,
          },
        }}
        transcriptionProvider="local"
        onTranscriptionTimingEstimateChange={timingChanged}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Свой ответ" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Начало конец" } });
    input.focus();
    input.setSelectionRange(7, 7);
    fireEvent.select(input);

    const start = screen.getByRole("button", { name: "Начать запись" });
    fireEvent.pointerDown(start);
    fireEvent.click(start);
    const stop = await screen.findByRole("button", { name: "Остановить запись" });
    expect(input).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Отправить ответы" })).toBeDisabled();

    fireEvent.click(stop);
    expect(await screen.findByRole("button", { name: "Распознаём запись" })).toHaveTextContent(
      "≈0:02",
    );
    await act(async () =>
      resolveTranscription?.({
        text: "голос",
        timingEstimate: updatedTimingEstimate,
      }),
    );
    await waitFor(() => expect(input).toHaveValue("Начало голос конец"));
    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ type: "audio/webm;codecs=opus" }),
      expect.any(Number),
    );
    expect(respond).not.toHaveBeenCalled();
    expect(timingChanged).toHaveBeenCalledWith(updatedTimingEstimate);
    expect(track.stop).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Отправить ответы" }));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("questions", {
        kind: "userInput",
        answers: { details: ["Начало голос конец"] },
      }),
    );
  });

  it("offers voice only for freeform answers, including secret questions", () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    connection.mockReturnValue({ api: { respond, transcribe: vi.fn() } });
    render(
      <AttentionPanel
        requests={[
          {
            id: "questions",
            threadId: "thread",
            turnId: "turn",
            itemId: "item",
            createdAt: 1,
            kind: "userInput",
            autoResolutionMs: null,
            questions: [
              {
                id: "choice",
                header: "Режим",
                question: "Какой режим?",
                isOther: false,
                isSecret: false,
                options: [{ label: "Обычный", description: "Без дополнений." }],
              },
              {
                id: "token",
                header: "Токен",
                question: "Какой токен?",
                isOther: true,
                isSecret: true,
                options: null,
              },
            ],
          },
        ]}
        transcriptionConfig={transcriptionConfig}
        transcriptionProvider="local"
      />,
    );

    expect(screen.queryByRole("button", { name: "Начать запись" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /Обычный/ }));
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));

    const secret = screen.getByLabelText("Свой ответ");
    expect(secret).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Начать запись" })).toBeInTheDocument();
  });

  it("cancels an active answer recording without changing the answer", async () => {
    const track = { stop: vi.fn() };
    installMediaRecorder(async () => ({ getTracks: () => [track] }) as unknown as MediaStream);
    const transcribe = vi.fn();
    connection.mockReturnValue({
      api: { respond: vi.fn().mockResolvedValue(undefined), transcribe },
    });
    render(
      <AttentionPanel
        requests={[freeformRequest()]}
        transcriptionConfig={transcriptionConfig}
        transcriptionProvider="local"
      />,
    );
    const input = screen.getByRole("textbox", { name: "Свой ответ" });
    fireEvent.change(input, { target: { value: "Не менять" } });

    fireEvent.click(screen.getByRole("button", { name: "Начать запись" }));
    await screen.findByRole("button", { name: "Остановить запись" });
    fireEvent.click(screen.getByRole("button", { name: "Отменить запись" }));

    await screen.findByRole("button", { name: "Начать запись" });
    expect(input).toHaveValue("Не менять");
    expect(transcribe).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("preserves the answer and recovers after transcription errors", async () => {
    installMediaRecorder(
      async () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream,
    );
    connection.mockReturnValue({
      api: {
        respond: vi.fn().mockResolvedValue(undefined),
        transcribe: vi.fn().mockRejectedValue(new Error("STT недоступен")),
      },
    });
    render(
      <AttentionPanel
        requests={[freeformRequest()]}
        transcriptionConfig={transcriptionConfig}
        transcriptionProvider="local"
      />,
    );
    const input = screen.getByRole("textbox", { name: "Свой ответ" });
    fireEvent.change(input, { target: { value: "Сохранить" } });

    fireEvent.click(screen.getByRole("button", { name: "Начать запись" }));
    fireEvent.click(await screen.findByRole("button", { name: "Остановить запись" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("STT недоступен");
    expect(input).toHaveValue("Сохранить");
    expect(screen.getByRole("button", { name: "Начать запись" })).toBeEnabled();
  });

  it("disables voice when STT is not configured and releases the microphone on unmount", async () => {
    connection.mockReturnValue({
      api: { respond: vi.fn().mockResolvedValue(undefined), transcribe: vi.fn() },
    });
    const disabled = render(
      <AttentionPanel
        requests={[freeformRequest()]}
        transcriptionConfig={{ ...transcriptionConfig, providers: [], provider: null }}
      />,
    );
    expect(screen.getByRole("button", { name: "Распознавание речи не настроено" })).toBeDisabled();
    disabled.unmount();

    const track = { stop: vi.fn() };
    installMediaRecorder(async () => ({ getTracks: () => [track] }) as unknown as MediaStream);
    const active = render(
      <AttentionPanel
        requests={[freeformRequest()]}
        transcriptionConfig={transcriptionConfig}
        transcriptionProvider="local"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Начать запись" }));
    await screen.findByRole("button", { name: "Остановить запись" });
    active.unmount();
    expect(track.stop).toHaveBeenCalledOnce();
  });
});

const transcriptionConfig: TranscriptionConfigResponse = {
  providers: ["local"],
  provider: "local",
  localUrl: "http://127.0.0.1:8178/inference",
  openAiApiKeyConfigured: false,
  openAiModel: "gpt-4o-transcribe",
  language: "ru",
  refineLocal: false,
  refinementModel: "gpt-5.6-luna",
  maxRecordingSeconds: 300,
  maxUploadBytes: 24 * 1024 * 1024,
  timingEstimate: {
    sampleCount: 0,
    estimatedFixedProcessingMs: null,
    estimatedProcessingMsPerAudioSecond: null,
  },
};

function freeformRequest() {
  return {
    id: "questions",
    threadId: "thread",
    turnId: "turn",
    itemId: "item",
    createdAt: 1,
    kind: "userInput" as const,
    autoResolutionMs: null,
    questions: [
      {
        id: "details",
        header: "Детали",
        question: "Что учесть?",
        isOther: true,
        isSecret: false,
        options: null,
      },
    ],
  };
}

function installMediaRecorder(getUserMedia: () => Promise<MediaStream>) {
  class FakeMediaRecorder extends EventTarget {
    static isTypeSupported = vi.fn(() => true);
    readonly mimeType: string;
    state: RecordingState = "inactive";

    constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
      super();
      this.mimeType = options?.mimeType ?? "audio/webm";
    }

    start() {
      this.state = "recording";
    }

    stop() {
      if (this.state === "inactive") return;
      this.state = "inactive";
      const data = new Blob(["audio"], { type: this.mimeType });
      const dataEvent = new Event("dataavailable") as BlobEvent;
      Object.defineProperty(dataEvent, "data", { value: data });
      this.dispatchEvent(dataEvent);
      this.dispatchEvent(new Event("stop"));
    }
  }

  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(getUserMedia) },
  });
}
