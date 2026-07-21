import type { FormEvent, KeyboardEvent } from "react";

import type {
  ModelOption,
  Project,
  SessionSettings,
  UpdateThreadSettingsRequest,
} from "@codexnest/protocol";

import { PlusIcon, SendIcon, StopIcon } from "./Icons";
import { SettingsPicker } from "./SettingsPicker";

export function Composer({
  input,
  onInput,
  onSubmit,
  busy,
  running = false,
  settings,
  onSettingsChange,
  settingsBusy = false,
  models,
  projects,
  projectId,
  onProjectChange,
  onNewProject,
  onStop,
  error,
}: {
  input: string;
  onInput(value: string): void;
  onSubmit(event: FormEvent): void;
  busy: boolean;
  running?: boolean;
  settings: SessionSettings;
  onSettingsChange(value: UpdateThreadSettingsRequest): void;
  settingsBusy?: boolean;
  models: ModelOption[];
  projects?: Project[];
  projectId?: string;
  onProjectChange?(projectId: string): void;
  onNewProject?(): void;
  onStop?(): void;
  error: string | null;
}) {
  const creating = projects !== undefined;
  const canSubmit = Boolean(input.trim()) && !busy && (!creating || Boolean(projectId));

  function keyboardSubmit(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <form className="composer" onSubmit={onSubmit}>
      {creating && projects.length === 0 && (
        <div className="composer-empty-projects">
          <span>Чтобы начать задачу, добавьте рабочую папку.</span>
          <button type="button" onClick={onNewProject}>
            <PlusIcon /> Добавить проект
          </button>
        </div>
      )}
      <div className="composer-box">
        <textarea
          aria-label={running ? "Направить текущую задачу" : "Сообщение для Codex"}
          rows={2}
          value={input}
          onChange={(event) => onInput(event.target.value)}
          onKeyDown={keyboardSubmit}
          placeholder={running ? "Направить текущую задачу…" : "Спросите что угодно"}
        />
        <div className="composer-toolbar">
          <div className="composer-options">
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
            />
            {running && (
              <span className="composer-hint">Сообщение будет добавлено в текущий ход</span>
            )}
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
              aria-label={running ? "Направить" : "Отправить"}
              className="composer-action send"
              disabled={!canSubmit}
            >
              <SendIcon />
            </button>
          </div>
        </div>
      </div>
      {error && <div className="composer-error">{error}</div>}
    </form>
  );
}
