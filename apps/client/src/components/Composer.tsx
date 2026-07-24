import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type {
  AgentId,
  ModelOption,
  Project,
  SessionSettings,
  ThreadGoal,
  TranscriptionConfigResponse,
  TranscriptionProvider,
  UpdateThreadGoalRequest,
  UpdateThreadSettingsRequest,
} from "@codexnest/protocol";

import { agentLabel } from "../agents";
import { MicrophoneIcon, PlusIcon, SendIcon, StopIcon, XIcon } from "./Icons";
import { SettingsPicker } from "./SettingsPicker";

export type ComposerImage = {
  id: string;
  name: string;
  url: string;
};

const KEYBOARD_VIEWPORT_DELTA = 120;
const RECORDING_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

type SpeechState = "idle" | "requesting" | "recording" | "transcribing";

function viewportHeight(): number {
  return Math.min(window.innerHeight, window.visualViewport?.height ?? window.innerHeight);
}

export function Composer({
  agent,
  input,
  onInput,
  images,
  onImagesChange,
  onSubmit,
  busy,
  running = false,
  blocked = false,
  settings,
  onSettingsChange,
  settingsBusy = false,
  goalMode = false,
  goal,
  goalBusy = false,
  onGoalModeChange,
  onGoalUpdate,
  onGoalClear,
  models,
  projects,
  projectId,
  onProjectChange,
  onNewProject,
  onStop,
  transcriptionConfig = null,
  transcriptionProvider = null,
  onTranscribe,
  error,
  autoFocus = false,
  hasSupplementalContent = false,
}: {
  agent: AgentId;
  input: string;
  onInput(value: string): void;
  images: ComposerImage[];
  onImagesChange(value: ComposerImage[]): void;
  onSubmit(event: FormEvent): void;
  busy: boolean;
  running?: boolean;
  /** Send is blocked (e.g. the thread's backend is unavailable); the reason shows above. */
  blocked?: boolean;
  settings: SessionSettings;
  onSettingsChange(value: UpdateThreadSettingsRequest): void;
  settingsBusy?: boolean;
  goalMode?: boolean;
  goal?: ThreadGoal | null;
  goalBusy?: boolean;
  onGoalModeChange?(value: boolean): void;
  onGoalUpdate?(value: UpdateThreadGoalRequest): void;
  onGoalClear?(): void;
  models: ModelOption[];
  projects?: Project[];
  projectId?: string;
  onProjectChange?(projectId: string): void;
  onNewProject?(): void;
  onStop?(): void;
  transcriptionConfig?: TranscriptionConfigResponse | null;
  transcriptionProvider?: TranscriptionProvider | null;
  onTranscribe?(audio: Blob): Promise<string>;
  error: string | null;
  autoFocus?: boolean;
  hasSupplementalContent?: boolean;
}) {
  const creating = projects !== undefined;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef<HTMLDivElement>(null);
  const viewportBaselineRef = useRef(viewportHeight());
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioBytesRef = useRef(0);
  const discardRecordingRef = useRef(false);
  const aliveRef = useRef(true);
  const recordingStartedAtRef = useRef(0);
  const recordingTimerRef = useRef<number | undefined>(undefined);
  const recordingLimitRef = useRef<number | undefined>(undefined);
  const insertionRef = useRef<{ start: number; end: number } | null>(null);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [speechState, setSpeechState] = useState<SpeechState>("idle");
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const speechBusy = speechState !== "idle";
  const hasContent = Boolean(input.trim()) || images.length > 0 || hasSupplementalContent;
  const canSubmit =
    hasContent &&
    (!goalMode || Boolean(input.trim())) &&
    !busy &&
    !blocked &&
    !speechBusy &&
    (!creating || Boolean(projectId));
  const speechUnavailable = microphoneUnavailableReason(
    transcriptionConfig,
    transcriptionProvider,
    onTranscribe,
  );

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const height = Math.min(textarea.scrollHeight, 190);
    textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > 190 ? "auto" : "hidden";
  }, [input]);

  useEffect(() => {
    if (selectedImageId && !images.some((image) => image.id === selectedImageId)) {
      setSelectedImageId(null);
    }
  }, [images, selectedImageId]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    function updateKeyboardState() {
      const height = viewportHeight();
      if (document.activeElement !== textarea) {
        viewportBaselineRef.current = height;
        setKeyboardOpen(false);
        return;
      }
      setKeyboardOpen(viewportBaselineRef.current - height > KEYBOARD_VIEWPORT_DELTA);
    }

    function captureViewportBaseline() {
      viewportBaselineRef.current = Math.max(viewportBaselineRef.current, viewportHeight());
      updateKeyboardState();
    }

    function preserveFocusForButton(event: PointerEvent) {
      const button = event.target instanceof Element ? event.target.closest("button") : null;
      if (
        button instanceof HTMLButtonElement &&
        !button.disabled &&
        document.activeElement === textarea &&
        viewportBaselineRef.current - viewportHeight() > KEYBOARD_VIEWPORT_DELTA
      ) {
        event.preventDefault();
      }
    }

    textarea.addEventListener("focus", captureViewportBaseline);
    textarea.addEventListener("blur", updateKeyboardState);
    document.addEventListener("pointerdown", preserveFocusForButton, true);
    window.addEventListener("resize", updateKeyboardState);
    window.visualViewport?.addEventListener("resize", updateKeyboardState);
    updateKeyboardState();
    return () => {
      textarea.removeEventListener("focus", captureViewportBaseline);
      textarea.removeEventListener("blur", updateKeyboardState);
      document.removeEventListener("pointerdown", preserveFocusForButton, true);
      window.removeEventListener("resize", updateKeyboardState);
      window.visualViewport?.removeEventListener("resize", updateKeyboardState);
    };
  }, []);

  useEffect(() => {
    if (!selectedImageId) return;
    function clearSelection(event: PointerEvent) {
      if (event.target instanceof Node && !attachmentsRef.current?.contains(event.target)) {
        setSelectedImageId(null);
      }
    }
    document.addEventListener("pointerdown", clearSelection);
    return () => document.removeEventListener("pointerdown", clearSelection);
  }, [selectedImageId]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      discardRecordingRef.current = true;
      clearRecordingTimers();
      const recorder = mediaRecorderRef.current;
      if (recorder?.state !== "inactive") recorder?.stop();
      stopMediaStream();
    };
  }, []);

  function keyboardSubmit(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  async function addImages(files: readonly File[]) {
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (!imageFiles.length) return;
    setAttachmentError(null);
    try {
      const added = await Promise.all(
        imageFiles.map(async (file, index) => ({
          id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
          name: file.name.trim() || pastedImageName(file.type, index),
          url: await readImage(file),
        })),
      );
      onImagesChange([...images, ...added]);
    } catch {
      setAttachmentError("Не удалось прочитать выбранное изображение");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function pasteImages(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = clipboardImageFiles(event.clipboardData);
    if (files.length) void addImages(files);
  }

  function captureInsertionPoint() {
    const textarea = textareaRef.current;
    insertionRef.current = textarea
      ? { start: textarea.selectionStart, end: textarea.selectionEnd }
      : { start: input.length, end: input.length };
  }

  async function startRecording() {
    if (speechState !== "idle" || busy) return;
    const unavailable = microphoneUnavailableReason(
      transcriptionConfig,
      transcriptionProvider,
      onTranscribe,
    );
    if (unavailable) {
      setSpeechError(unavailable);
      return;
    }
    const mimeType = recordingMimeType();
    if (!mimeType) {
      setSpeechError("Этот браузер не поддерживает запись WebM или MP4");
      return;
    }
    if (!insertionRef.current) {
      insertionRef.current = { start: input.length, end: input.length };
    }
    setSpeechError(null);
    setSpeechState("requesting");
    discardRecordingRef.current = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!aliveRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];
      audioBytesRef.current = 0;
      recorder.addEventListener("dataavailable", (event) => {
        if (!event.data.size) return;
        audioChunksRef.current.push(event.data);
        audioBytesRef.current += event.data.size;
        if (audioBytesRef.current >= (transcriptionConfig?.maxUploadBytes ?? 24 * 1024 * 1024)) {
          stopRecording();
        }
      });
      recorder.addEventListener("error", () => {
        discardRecordingRef.current = true;
        clearRecordingTimers();
        stopMediaStream();
        mediaRecorderRef.current = null;
        if (aliveRef.current) {
          setSpeechState("idle");
          setSpeechError("Не удалось записать аудио");
        }
      });
      recorder.addEventListener("stop", () => void finishRecording(mimeType));
      recorder.start(1_000);
      recordingStartedAtRef.current = Date.now();
      setRecordingSeconds(0);
      setSpeechState("recording");
      recordingTimerRef.current = window.setInterval(() => {
        setRecordingSeconds(
          Math.max(0, Math.floor((Date.now() - recordingStartedAtRef.current) / 1_000)),
        );
      }, 250);
      recordingLimitRef.current = window.setTimeout(
        stopRecording,
        (transcriptionConfig?.maxRecordingSeconds ?? 300) * 1_000,
      );
    } catch (caught) {
      stopMediaStream();
      if (aliveRef.current) {
        setSpeechState("idle");
        setSpeechError(recordingErrorMessage(caught));
      }
    }
  }

  function stopRecording() {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    clearRecordingTimers();
    if (aliveRef.current) setSpeechState("transcribing");
    recorder.stop();
    stopMediaStream();
  }

  async function finishRecording(mimeType: string) {
    clearRecordingTimers();
    stopMediaStream();
    mediaRecorderRef.current = null;
    const chunks = audioChunksRef.current;
    const bytes = audioBytesRef.current;
    audioChunksRef.current = [];
    audioBytesRef.current = 0;
    if (discardRecordingRef.current || !aliveRef.current) return;
    if (!chunks.length || !bytes) {
      setSpeechState("idle");
      setSpeechError("Запись не содержит аудио");
      return;
    }
    if (bytes > (transcriptionConfig?.maxUploadBytes ?? 24 * 1024 * 1024)) {
      setSpeechState("idle");
      setSpeechError("Запись слишком большая");
      return;
    }
    try {
      const transcript = await onTranscribe!(new Blob(chunks, { type: mimeType }));
      if (!aliveRef.current) return;
      insertTranscript(transcript);
      setSpeechError(null);
    } catch (caught) {
      if (aliveRef.current) {
        setSpeechError(caught instanceof Error ? caught.message : "Не удалось распознать запись");
      }
    } finally {
      if (aliveRef.current) setSpeechState("idle");
    }
  }

  function insertTranscript(transcript: string) {
    const clean = transcript.trim();
    if (!clean) throw new Error("Распознавание не вернуло текст");
    const selection = insertionRef.current ?? { start: input.length, end: input.length };
    const start = Math.min(selection.start, input.length);
    const end = Math.max(start, Math.min(selection.end, input.length));
    const before = input.slice(0, start);
    const after = input.slice(end);
    const leading = before && !/\s$/.test(before) ? " " : "";
    const trailing = after && !/^\s/.test(after) ? " " : "";
    const completeInsertion = `${leading}${clean}${trailing}`;
    let inserted = completeInsertion;
    if (goalMode) inserted = inserted.slice(0, Math.max(0, 4_000 - before.length - after.length));
    const next = `${before}${inserted}${after}`;
    onInput(next);
    const caret =
      before.length + inserted.length - (inserted === completeInsertion ? trailing.length : 0);
    window.setTimeout(() => {
      const textarea = textareaRef.current;
      textarea?.focus();
      textarea?.setSelectionRange(caret, caret);
      insertionRef.current = { start: caret, end: caret };
    });
  }

  function clearRecordingTimers() {
    if (recordingTimerRef.current !== undefined) {
      window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = undefined;
    }
    if (recordingLimitRef.current !== undefined) {
      window.clearTimeout(recordingLimitRef.current);
      recordingLimitRef.current = undefined;
    }
  }

  function stopMediaStream() {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  }

  return (
    <form
      className={`composer${keyboardOpen ? " keyboard-open" : ""}`}
      onSubmit={speechBusy ? (event) => event.preventDefault() : onSubmit}
    >
      {creating && projects.length === 0 && (
        <div className="composer-empty-projects">
          <span>Чтобы начать задачу, добавьте рабочую папку.</span>
          <button type="button" onClick={onNewProject}>
            <PlusIcon /> Добавить проект
          </button>
        </div>
      )}
      {images.length > 0 && (
        <div className="composer-attachments" ref={attachmentsRef} aria-label="Изображения">
          {images.map((image) => {
            const selected = selectedImageId === image.id;
            return (
              <div className={`composer-attachment${selected ? " selected" : ""}`} key={image.id}>
                <button
                  type="button"
                  className="composer-attachment-preview"
                  aria-label={`Выбрать изображение ${image.name}`}
                  aria-pressed={selected}
                  onClick={() => setSelectedImageId(image.id)}
                >
                  <img src={image.url} alt={image.name} />
                </button>
                {selected && (
                  <button
                    type="button"
                    className="composer-attachment-remove"
                    aria-label={`Удалить изображение ${image.name}`}
                    onClick={() => onImagesChange(images.filter((item) => item.id !== image.id))}
                  >
                    <XIcon />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="composer-box">
        <textarea
          ref={textareaRef}
          autoFocus={autoFocus}
          aria-label={running ? "Направить текущую задачу" : `Сообщение для ${agentLabel(agent)}`}
          rows={2}
          maxLength={goalMode ? 4_000 : undefined}
          readOnly={speechBusy}
          aria-busy={speechBusy}
          value={input}
          onChange={(event) => onInput(event.target.value)}
          onPaste={pasteImages}
          onSelect={captureInsertionPoint}
          onKeyDown={keyboardSubmit}
          placeholder={
            goalMode
              ? "Опишите проверяемый результат цели…"
              : running
                ? "Направить текущую задачу…"
                : "Спросите что угодно"
          }
        />
        <div className="composer-toolbar">
          <div className="composer-options">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(event) => void addImages(Array.from(event.target.files ?? []))}
            />
            <button
              aria-label="Добавить изображения"
              className="composer-add-image"
              type="button"
              disabled={speechBusy}
              onClick={() => fileInputRef.current?.click()}
            >
              <PlusIcon />
            </button>
            {creating && projects.length > 0 && (
              <label className="project-picker">
                <span className="sr-only">Проект</span>
                <select
                  aria-label="Проект"
                  value={projectId}
                  onChange={(event) => onProjectChange?.(event.target.value)}
                >
                  {projects.map((project) => (
                    <option value={project.id} key={project.id}>
                      {project.displayName}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <SettingsPicker
              agent={agent}
              disabled={running || busy || settingsBusy || speechBusy}
              models={models}
              value={settings}
              onChange={onSettingsChange}
              goalMode={goalMode}
              goal={goal}
              goalBusy={goalBusy}
              onGoalModeChange={onGoalModeChange}
              onGoalUpdate={onGoalUpdate}
              onGoalClear={onGoalClear}
            />
            {running && <span className="composer-hint">Сообщение будет добавлено в очередь</span>}
            {speechState === "recording" && (
              <span className="composer-recording-status" role="status">
                Запись {formatRecordingTime(recordingSeconds)}
              </span>
            )}
            {speechState === "transcribing" && (
              <span className="composer-recording-status" role="status">
                Распознаём…
              </span>
            )}
          </div>
          <div className="composer-actions">
            {transcriptionConfig && (
              <button
                aria-label={
                  speechState === "recording"
                    ? "Остановить запись"
                    : speechState === "requesting"
                      ? "Запрашиваем доступ к микрофону"
                      : speechState === "transcribing"
                        ? "Распознаём запись"
                        : speechUnavailable
                          ? speechUnavailable
                          : "Начать запись"
                }
                aria-pressed={speechState === "recording"}
                className={`composer-action microphone${speechState === "recording" ? " recording" : ""}`}
                disabled={
                  speechState === "requesting" ||
                  speechState === "transcribing" ||
                  (speechState === "idle" && (busy || Boolean(speechUnavailable)))
                }
                title={speechUnavailable ?? undefined}
                type="button"
                onPointerDown={speechState === "idle" ? captureInsertionPoint : undefined}
                onClick={() =>
                  speechState === "recording" ? stopRecording() : void startRecording()
                }
              >
                {speechState === "requesting" || speechState === "transcribing" ? (
                  <span className="spinner small" />
                ) : speechState === "recording" ? (
                  <StopIcon />
                ) : (
                  <MicrophoneIcon />
                )}
              </button>
            )}
            {running && onStop && (
              <button
                aria-label="Остановить задачу"
                className="composer-action stop"
                type="button"
                onClick={onStop}
              >
                <StopIcon />
              </button>
            )}
            <button
              aria-label={
                running ? "Добавить в очередь" : goalMode ? "Запустить цель" : "Отправить"
              }
              className="composer-action send"
              disabled={!canSubmit}
              type="submit"
            >
              <SendIcon />
            </button>
          </div>
        </div>
      </div>
      {(error || attachmentError || speechError) && (
        <div className="composer-error">{error ?? attachmentError ?? speechError}</div>
      )}
    </form>
  );
}

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("read failed"));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function clipboardImageFiles(data: DataTransfer): File[] {
  const itemFiles = Array.from(data.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .flatMap((item) => {
      const file = item.getAsFile();
      return file ? [file] : [];
    });
  if (itemFiles.length) return itemFiles;
  return Array.from(data.files).filter((file) => file.type.startsWith("image/"));
}

function pastedImageName(mimeType: string, index: number): string {
  const extension = mimeType.split("/")[1]?.replace(/[^a-z0-9.+-]/gi, "") || "png";
  return `pasted-image-${index + 1}.${extension}`;
}

function microphoneUnavailableReason(
  config: TranscriptionConfigResponse | null,
  provider: TranscriptionProvider | null,
  transcribe: ((audio: Blob) => Promise<string>) | undefined,
): string | null {
  if (!config || !provider || !config.providers.includes(provider) || !transcribe) {
    return "Распознавание речи не настроено";
  }
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.getUserMedia ||
    typeof MediaRecorder === "undefined"
  ) {
    return typeof window !== "undefined" && window.isSecureContext === false
      ? "Для доступа к микрофону откройте CodexNest по HTTPS"
      : "Запись с микрофона не поддерживается на этом устройстве";
  }
  return recordingMimeType() ? null : "Этот браузер не поддерживает запись WebM или MP4";
}

function recordingMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return (
    RECORDING_MIME_TYPES.find(
      (type) => !MediaRecorder.isTypeSupported || MediaRecorder.isTypeSupported(type),
    ) ?? null
  );
}

function recordingErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "Нет доступа к микрофону. Разрешите его в настройках приложения или браузера";
    }
    if (error.name === "NotFoundError") return "Микрофон не найден";
    if (error.name === "NotReadableError") return "Микрофон занят другим приложением";
  }
  return "Не удалось начать запись с микрофона";
}

function formatRecordingTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
