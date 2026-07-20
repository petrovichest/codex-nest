import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";

import type { Project, SessionSettings } from "@codexnest/protocol";

import { useConnection } from "../connection";
import { SettingsPicker } from "./SettingsPicker";

export function NewSession({ projects, onClose }: { projects: Project[]; onClose(): void }) {
  const { api, state } = useConnection();
  const navigate = useNavigate();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [input, setInput] = useState("");
  const [settings, setSettings] = useState<SessionSettings>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.createThread({ projectId, input, settings });
      onClose();
      navigate(`/threads/${encodeURIComponent(result.thread.id)}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось создать сессию");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <div className="row-between">
          <h2>Новая сессия</h2>
          <button type="button" className="icon-button" onClick={onClose}>
            ×
          </button>
        </div>
        {!projects.length ? (
          <div className="warning">Сначала зарегистрируйте проект.</div>
        ) : (
          <>
            <label>
              Проект
              <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                {projects.map((project) => (
                  <option value={project.id} key={project.id}>
                    {project.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Задача
              <textarea
                autoFocus
                rows={6}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Что должен сделать Codex?"
                required
              />
            </label>
            <SettingsPicker
              models={state.snapshot?.models ?? []}
              value={settings}
              onChange={setSettings}
            />
            {error && <div className="error-banner">{error}</div>}
            <button className="primary" disabled={busy || !projectId || !input.trim()}>
              {busy ? "Создаём…" : "Создать"}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
