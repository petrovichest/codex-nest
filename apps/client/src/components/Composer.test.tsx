import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionSettings, TranscriptionConfigResponse } from "@codexnest/protocol";

import { Composer, type ComposerImage, type ComposerTranscriptionStatus } from "./Composer";

const models = [
  {
    id: "gpt-sol",
    displayName: "GPT-5.6-Sol",
    description: "",
    isDefault: true,
    reasoningEfforts: [{ value: "high", description: null, isDefault: true }],
    serviceTiers: [],
    supportsPersonality: true,
  },
  {
    id: "gpt-terra",
    displayName: "GPT-5.6-Terra",
    description: "",
    isDefault: false,
    reasoningEfforts: [{ value: "high", description: null, isDefault: true }],
    serviceTiers: [],
    supportsPersonality: true,
  },
  {
    id: "other",
    displayName: "Other Model",
    description: "",
    isDefault: false,
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
  it("renders compact model names without a chevron and tracks the selected label width", () => {
    render(<Harness />);
    const model = screen.getByRole("combobox", { name: "Модель" });
    const control = model.closest("label");

    expect(
      within(model)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["По умолчанию · 5.6sol", "5.6sol", "5.6terra", "Other Model"]);
    expect(control?.querySelector(".setting-select-value")).toHaveTextContent("5.6sol");
    expect(control?.querySelector(".setting-select-chevron")).toBeNull();

    fireEvent.change(model, { target: { value: "gpt-terra" } });
    expect(control?.querySelector(".setting-select-value")).toHaveTextContent("5.6terra");
  });

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

  it("renders voice auto-send as a compact remembered toggle", () => {
    render(<Harness transcriptionConfig={transcriptionConfig} />);
    const toggle = screen.getByRole("button", {
      name: "Включить автоотправку голосового ввода",
    });

    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveClass("voice-send-toggle");
    expect(toggle.querySelectorAll("svg")).toHaveLength(1);

    fireEvent.click(toggle);
    expect(
      screen.getByRole("button", {
        name: "Выключить автоотправку голосового ввода",
      }),
    ).toHaveAttribute("aria-pressed", "true");
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

  it("opens draft images as a gallery and keeps their remove buttons visible", async () => {
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

    const first = await screen.findByRole("button", { name: "Открыть изображение one.png" });
    expect(screen.getByRole("button", { name: "Открыть изображение two.jpg" })).toBeInTheDocument();
    const removeFirst = screen.getByRole("button", { name: "Удалить изображение one.png" });
    expect(screen.getByRole("button", { name: "Удалить изображение two.jpg" })).toBeInTheDocument();

    fireEvent.click(first);
    const dialog = screen.getByRole("dialog", { name: "Просмотр изображений" });
    expect(within(dialog).getByAltText("one.png")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Следующее изображение" }));
    expect(within(dialog).getByAltText("two.jpg")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Закрыть" }));
    expect(first).toHaveFocus();

    fireEvent.click(removeFirst);

    await waitFor(() => expect(screen.queryByAltText("one.png")).toBeNull());
    expect(screen.getByAltText("two.jpg")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Просмотр изображений" })).toBeNull();
  });

  it("attaches pasted clipboard images without cancelling ordinary paste behavior", async () => {
    render(<Harness />);
    const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    const png = new File(["clipboard-one"], "", { type: "image/png" });
    const jpeg = new File(["clipboard-two"], "screen.jpg", { type: "image/jpeg" });

    expect(
      fireEvent.paste(textarea, {
        clipboardData: {
          items: [
            { kind: "file", type: "image/png", getAsFile: () => png },
            { kind: "file", type: "image/jpeg", getAsFile: () => jpeg },
          ],
          files: [],
        },
      }),
    ).toBe(true);

    expect(await screen.findByAltText("pasted-image-1.png")).toBeInTheDocument();
    expect(screen.getByAltText("screen.jpg")).toBeInTheDocument();
    expect(
      fireEvent.paste(textarea, {
        clipboardData: {
          items: [{ kind: "string", type: "text/plain", getAsFile: () => null }],
          files: [],
        },
      }),
    ).toBe(true);
    expect(screen.getAllByRole("img")).toHaveLength(2);
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
    let resolveTranscription: ((transcript: string) => void) | undefined;
    const onTranscribe = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveTranscription = resolve;
        }),
    );
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
    expect(within(stop).getByText("0:00")).toBeInTheDocument();
    expect(stop).toHaveClass("timing");
    expect(
      screen.getByRole("button", { name: "Включить автоотправку голосового ввода" }),
    ).toBeDisabled();
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
    const transcribing = await screen.findByRole("button", { name: "Распознаём запись" });
    expect(within(transcribing).getByText("0:00")).toBeInTheDocument();
    expect(transcribing).toHaveClass("timing");
    await act(async () => resolveTranscription?.("голос"));
    await waitFor(() => expect(textarea).toHaveValue("Начало голос конец"));
    expect(onTranscribe).toHaveBeenCalledWith(
      expect.objectContaining({ type: "audio/webm;codecs=opus" }),
      expect.any(Number),
    );
    expect(track.stop).toHaveBeenCalled();
    expect(textarea).not.toHaveAttribute("readonly");
    view.rerender(
      <Harness
        initialInput="Начало конец"
        transcriptionConfig={transcriptionConfig}
        onTranscribe={onTranscribe}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Включить автоотправку голосового ввода" }),
    ).toBeEnabled();
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

  it("shows upload, queue, and learned countdowns in the draft composer", () => {
    const view = render(
      <Harness
        initialInput="Черновик"
        transcriptionConfig={transcriptionConfig}
        transcriptionStatus={{
          elapsedSeconds: 2,
          estimatedTotalSeconds: 10,
        }}
      />,
    );

    expect(
      within(screen.getByRole("button", { name: "Распознаём запись" })).getByText("≈0:08"),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "На сервере · распознаём · осталось ≈ 0:08",
    );
    expect(screen.getByRole("status")).toHaveClass("sr-only");
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toHaveAttribute(
      "readonly",
    );

    view.rerender(
      <Harness
        initialInput="Черновик"
        transcriptionConfig={transcriptionConfig}
        transcriptionStatus={{
          elapsedSeconds: 13,
          estimatedTotalSeconds: 10,
        }}
      />,
    );
    expect(
      within(screen.getByRole("button", { name: "Распознаём запись" })).getByText("+0:03"),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "На сервере · распознаём · дольше прогноза на 0:03",
    );

    view.rerender(
      <Harness
        initialInput="Черновик"
        transcriptionConfig={transcriptionConfig}
        transcriptionStatus={{
          elapsedSeconds: 4,
          estimatedTotalSeconds: null,
        }}
      />,
    );
    expect(
      within(screen.getByRole("button", { name: "Распознаём запись" })).getByText("0:04"),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("На сервере · распознаём · прошло 0:04");

    view.rerender(
      <Harness
        initialInput="Черновик"
        transcriptionConfig={transcriptionConfig}
        transcriptionStatus={{
          elapsedSeconds: 4,
          estimatedTotalSeconds: null,
          status: "queued",
        }}
      />,
    );
    expect(
      within(screen.getByRole("button", { name: "Запись на сервере · можно закрыть" })).getByText(
        "0:04",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("На сервере · ожидание 0:04");

    view.rerender(
      <Harness
        initialInput="Черновик"
        transcriptionConfig={transcriptionConfig}
        voiceInputLocked
      />,
    );
    expect(view.container.querySelector(".microphone")).toBeDisabled();
    expect(view.container.querySelector(".microphone")).not.toHaveClass("timing");
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toHaveAttribute(
      "readonly",
    );
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
  timingEstimate: {
    sampleCount: 0,
    estimatedFixedProcessingMs: null,
    estimatedProcessingMsPerAudioSecond: null,
  },
};

function Harness({
  busy = false,
  hasSupplementalContent = false,
  initialInput = "",
  transcriptionConfig: speechConfig,
  onTranscribe,
  transcriptionStatus = null,
  voiceInputLocked = false,
}: {
  busy?: boolean;
  hasSupplementalContent?: boolean;
  initialInput?: string;
  transcriptionConfig?: TranscriptionConfigResponse;
  onTranscribe?(audio: Blob): Promise<string>;
  transcriptionStatus?: ComposerTranscriptionStatus | null;
  voiceInputLocked?: boolean;
}) {
  const [input, setInput] = useState(initialInput);
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [settings, setSettings] = useState<SessionSettings>({ collaborationMode: "default" });
  const [voiceMode, setVoiceMode] = useState<"draft" | "send">("draft");
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
      voiceMode={voiceMode}
      onVoiceModeChange={setVoiceMode}
      voiceInputLocked={voiceInputLocked}
      transcriptionStatus={transcriptionStatus}
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
