import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type {
  ModelOption,
  Project,
  SessionSettings,
  ThreadGoal,
  UpdateThreadGoalRequest,
  UpdateThreadSettingsRequest,
} from "@codexnest/protocol";

import { PlusIcon, SendIcon, StopIcon, XIcon } from "./Icons";
import { SettingsPicker } from "./SettingsPicker";

export type ComposerImage = {
  id: string;
  name: string;
  url: string;
};

const KEYBOARD_VIEWPORT_DELTA = 120;

function viewportHeight(): number {
  return Math.min(window.innerHeight, window.visualViewport?.height ?? window.innerHeight);
}

export function Composer({
  input,
  onInput,
  images,
  onImagesChange,
  onSubmit,
  busy,
  running = false,
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
  error,
  autoFocus = false,
  hasSupplementalContent = false,
}: {
  input: string;
  onInput(value: string): void;
  images: ComposerImage[];
  onImagesChange(value: ComposerImage[]): void;
  onSubmit(event: FormEvent): void;
  busy: boolean;
  running?: boolean;
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
  error: string | null;
  autoFocus?: boolean;
  hasSupplementalContent?: boolean;
}) {
  const creating = projects !== undefined;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef<HTMLDivElement>(null);
  const viewportBaselineRef = useRef(viewportHeight());
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const hasContent = Boolean(input.trim()) || images.length > 0 || hasSupplementalContent;
  const canSubmit =
    hasContent &&
    (!goalMode || Boolean(input.trim())) &&
    !busy &&
    (!creating || Boolean(projectId));

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

  function keyboardSubmit(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  async function addImages(files: FileList | null) {
    if (!files?.length) return;
    setAttachmentError(null);
    try {
      const added = await Promise.all(
        Array.from(files).map(async (file) => ({
          id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
          name: file.name,
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

  return (
    <form className={`composer${keyboardOpen ? " keyboard-open" : ""}`} onSubmit={onSubmit}>
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
          aria-label={running ? "Направить текущую задачу" : "Сообщение для Codex"}
          rows={2}
          maxLength={goalMode ? 4_000 : undefined}
          value={input}
          onChange={(event) => onInput(event.target.value)}
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
              onChange={(event) => void addImages(event.target.files)}
            />
            <button
              aria-label="Добавить изображения"
              className="composer-add-image"
              type="button"
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
              disabled={running || busy || settingsBusy}
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
          </div>
          <div className="composer-actions">
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
      {(error || attachmentError) && (
        <div className="composer-error">{error ?? attachmentError}</div>
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
