import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionSettings, TranscriptionConfigResponse } from "@codexnest/protocol";

import { Composer, type ComposerImage } from "./Composer";

const models = [
  {
    id: "gpt",
    displayName: "GPT",
    description: "",
    isDefault: true,
    reasoningEfforts: [{ value: "high", description: null, isDefault: true }],
    serviceTiers: [],
    supportsPersonality: true,
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
});

describe("Composer", () => {
  it("renders reasoning, plan, and goal as compact icon-only controls", () => {
    const view = render(<Harness />);
    const settings = view.container.querySelector(".settings-picker");
    const reasoning = screen.getByRole("combobox", { name: "Уровень рассуждений" });
    const plan = screen.getByRole("button", { name: "Включить режим планирования" });
    const goal = screen.getByRole("button", { name: "Включить режим цели" });

    expect(settings).toBeInTheDocument();
    expect(reasoning.closest("label")).toHaveClass("icon-only");
    expect(reasoning.closest("label")?.querySelectorAll("svg")).toHaveLength(1);
    expect(plan.querySelector("span")).toBeNull();
    expect(plan.querySelectorAll("svg")).toHaveLength(1);
    expect(goal.querySelector("span")).toBeNull();
    expect(goal.querySelectorAll("svg")).toHaveLength(1);

    fireEvent.change(reasoning, { target: { value: "high" } });
    expect(reasoning).toHaveValue("high");
  });

  it("starts at two rows, grows to its cap, and then enables internal scrolling", () => {
    render(<Harness />);
    const textarea = screen.getByRole("textbox", {
      name: "Сообщение для Codex",
    }) as HTMLTextAreaElement;
    expect(textarea).toHaveAttribute("rows", "2");

    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 240 });
    fireEvent.change(textarea, { target: { value: "Длинное\n".repeat(30) } });
    expect(textarea).toHaveStyle({ height: "190px", overflowY: "auto" });

    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 52 });
    fireEvent.change(textarea, { target: { value: "Короткое" } });
    expect(textarea).toHaveStyle({ height: "52px", overflowY: "hidden" });
  });

  it("adds multiple images and removes a preview only after selecting it", async () => {
    const view = render(<Harness />);
    const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        files: [
          new File(["one"], "one.png", { type: "image/png" }),
          new File(["two"], "two.jpg", { type: "image/jpeg" }),
        ],
      },
    });

    const first = await screen.findByRole("button", { name: "Выбрать изображение one.png" });
    expect(screen.getByRole("button", { name: "Выбрать изображение two.jpg" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Удалить изображение one.png" })).toBeNull();

    fireEvent.click(first);
    fireEvent.click(screen.getByRole("button", { name: "Удалить изображение one.png" }));

    await waitFor(() => expect(screen.queryByAltText("one.png")).toBeNull());
    expect(screen.getByAltText("two.jpg")).toBeInTheDocument();
  });

  it("enables sending when annotations provide supplemental content", () => {
    const view = render(<Harness />);
    expect(screen.getByRole("button", { name: "Отправить" })).toBeDisabled();

    view.rerender(<Harness hasSupplementalContent />);
    expect(screen.getByRole("button", { name: "Отправить" })).toBeEnabled();
  });

  it("keeps textarea focus for buttons across the page while the mobile keyboard is open", () => {
    const initialHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    const onExternalClick = vi.fn();
    const view = render(
      <>
        <button type="button" onClick={onExternalClick}>
          Внешнее действие
        </button>
        <Harness />
      </>,
    );
    const onSubmit = vi.fn((event: Event) => event.preventDefault());
    view.container.querySelector("form")?.addEventListener("submit", onSubmit);
    const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    const external = screen.getByRole("button", { name: "Внешнее действие" });
    const addImage = screen.getByRole("button", { name: "Добавить изображения" });
    const send = screen.getByRole("button", { name: "Отправить" });

    fireEvent.change(textarea, { target: { value: "Сообщение" } });
    textarea.focus();
    expect(fireEvent.pointerDown(external)).toBe(true);

    Object.defineProperty(window, "innerHeight", { configurable: true, value: 500 });
    fireEvent(window, new Event("resize"));
    expect(fireEvent.pointerDown(external)).toBe(false);
    expect(fireEvent.pointerDown(addImage)).toBe(false);
    expect(fireEvent.pointerDown(send)).toBe(false);
    expect(textarea).toHaveFocus();

    fireEvent.click(external);
    fireEvent.click(send);
    expect(onExternalClick).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledOnce();
    Object.defineProperty(window, "innerHeight", { configurable: true, value: initialHeight });
  });

  it("removes the mobile safe-area gap while the keyboard shrinks the viewport", () => {
    const initialHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    const view = render(<Harness />);
    const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    const composer = view.container.querySelector(".composer");

    textarea.focus();
    expect(textarea).toHaveFocus();
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 500 });
    fireEvent(window, new Event("resize"));
    expect(composer).toHaveClass("keyboard-open");

    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    fireEvent(window, new Event("resize"));
    expect(composer).not.toHaveClass("keyboard-open");
    Object.defineProperty(window, "innerHeight", { configurable: true, value: initialHeight });
  });

  it("records on the first click and inserts the transcript at the saved cursor", async () => {
    const track = { stop: vi.fn() };
    installMediaRecorder(async () => ({ getTracks: () => [track] }) as unknown as MediaStream);
    const onTranscribe = vi.fn(async () => "голос");
    const view = render(
      <Harness
        initialInput="Начало конец"
        transcriptionConfig={transcriptionConfig}
        onTranscribe={onTranscribe}
      />,
    );
    const textarea = screen.getByRole("textbox", {
      name: "Сообщение для Codex",
    }) as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(7, 7);
    fireEvent.select(textarea);

    const start = screen.getByRole("button", { name: "Начать запись" });
    fireEvent.pointerDown(start);
    fireEvent.click(start);
    const stop = await screen.findByRole("button", { name: "Остановить запись" });
    expect(textarea).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Отправить" })).toBeDisabled();
    view.rerender(
      <Harness
        busy
        initialInput="Начало конец"
        transcriptionConfig={transcriptionConfig}
        onTranscribe={onTranscribe}
      />,
    );
    expect(stop).toBeEnabled();

    fireEvent.click(stop);
    await waitFor(() => expect(textarea).toHaveValue("Начало голос конец"));
    expect(onTranscribe).toHaveBeenCalledWith(
      expect.objectContaining({ type: "audio/webm;codecs=opus" }),
    );
    expect(track.stop).toHaveBeenCalled();
    expect(textarea).not.toHaveAttribute("readonly");
  });

  it("keeps the existing text when microphone permission is denied", async () => {
    installMediaRecorder(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    render(
      <Harness
        initialInput="Не менять"
        transcriptionConfig={transcriptionConfig}
        onTranscribe={vi.fn(async () => "текст")}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Начать запись" }));
    expect(await screen.findByText(/Нет доступа к микрофону/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toHaveValue("Не менять");
  });

  it("disables the microphone when the server has no configured provider", () => {
    render(<Harness transcriptionConfig={{ ...transcriptionConfig, providers: [] }} />);
    expect(screen.getByRole("button", { name: "Распознавание речи не настроено" })).toBeDisabled();
  });
});

const transcriptionConfig: TranscriptionConfigResponse = {
  providers: ["local", "openai"],
  provider: "local",
  localUrl: "http://127.0.0.1:8178/inference",
  openAiApiKeyConfigured: true,
  openAiModel: "gpt-4o-transcribe",
  language: "ru",
  refineLocal: true,
  refinementModel: "gpt-5.6-luna",
  maxRecordingSeconds: 300,
  maxUploadBytes: 24 * 1024 * 1024,
};

function Harness({
  busy = false,
  hasSupplementalContent = false,
  initialInput = "",
  transcriptionConfig: speechConfig,
  onTranscribe,
}: {
  busy?: boolean;
  hasSupplementalContent?: boolean;
  initialInput?: string;
  transcriptionConfig?: TranscriptionConfigResponse;
  onTranscribe?(audio: Blob): Promise<string>;
}) {
  const [input, setInput] = useState(initialInput);
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [settings, setSettings] = useState<SessionSettings>({ collaborationMode: "default" });
  return (
    <Composer
      input={input}
      onInput={setInput}
      images={images}
      onImagesChange={setImages}
      onSubmit={(event) => event.preventDefault()}
      busy={busy}
      settings={settings}
      onSettingsChange={(patch) =>
        setSettings((current) => {
          const next = { ...current };
          for (const [key, value] of Object.entries(patch)) {
            if (value === null) delete next[key as keyof SessionSettings];
            else if (value !== undefined) Object.assign(next, { [key]: value });
          }
          return next;
        })
      }
      models={models}
      transcriptionConfig={speechConfig}
      transcriptionProvider={speechConfig?.provider ?? null}
      onTranscribe={onTranscribe}
      error={null}
      hasSupplementalContent={hasSupplementalContent}
    />
  );
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
