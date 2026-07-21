import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { DEFAULT_SESSION_SETTINGS } from "@codexnest/protocol";
import type { Project, SessionSettings, UpdateThreadSettingsRequest } from "@codexnest/protocol";

import { useConnection } from "../connection";
import { Composer } from "./Composer";
import { NewTaskIcon } from "./Icons";
import { NewSessionInspector } from "./SessionInspector";
import { WorkspaceHeader } from "./WorkspaceHeader";

export function NewSession({
  projects,
  onOpenNavigation,
  onNewProject,
}: {
  projects: Project[];
  onOpenNavigation(): void;
  onNewProject(): void;
}) {
  const { api, state } = useConnection();
  const navigate = useNavigate();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [input, setInput] = useState("");
  const [settings, setSettings] = useState<SessionSettings>(() => ({
    ...DEFAULT_SESSION_SETTINGS,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia("(min-width: 1280px)").matches,
  );

  useEffect(() => {
    if (!projectId && projects[0]) setProjectId(projects[0].id);
  }, [projectId, projects]);

  const project = useMemo(
    () => projects.find((candidate) => candidate.id === projectId) ?? null,
    [projectId, projects],
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!projectId || !input.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.createThread({ projectId, input, settings });
      navigate(`/threads/${encodeURIComponent(result.thread.id)}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось создать задачу");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="thread-workspace new-session-page">
      <div className="conversation-pane">
        <WorkspaceHeader
          title="Новая задача"
          subtitle={project?.displayName ?? "Выберите проект"}
          onOpenNavigation={onOpenNavigation}
          onToggleInspector={() => setInspectorOpen((value) => !value)}
        />
        <div className="new-session-empty">
          <span className="new-session-glyph">
            <NewTaskIcon />
          </span>
          <h2>Что поручим Codex?</h2>
          <p>Опишите задачу — работа продолжится на сервере, даже если закрыть приложение.</p>
        </div>
        <Composer
          input={input}
          onInput={setInput}
          onSubmit={submit}
          busy={busy}
          settings={settings}
          onSettingsChange={(patch) => setSettings((current) => applySettingsPatch(current, patch))}
          models={state.snapshot?.models ?? []}
          projects={projects}
          projectId={projectId}
          onProjectChange={setProjectId}
          onNewProject={onNewProject}
          error={error}
        />
      </div>
      <NewSessionInspector
        open={inspectorOpen}
        project={project}
        connection={connectionLabel(state.network, state.snapshot?.connection.state)}
        onClose={() => setInspectorOpen(false)}
      />
      {inspectorOpen && (
        <button
          className="inspector-backdrop"
          aria-label="Закрыть сведения"
          onClick={() => setInspectorOpen(false)}
        />
      )}
    </div>
  );
}

function applySettingsPatch(
  current: SessionSettings,
  patch: UpdateThreadSettingsRequest,
): SessionSettings {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key as keyof SessionSettings];
    else if (value !== undefined) Object.assign(next, { [key]: value });
  }
  return next;
}

function connectionLabel(network: string, appServer?: string): string {
  if (network !== "connected") return "Нет связи";
  return appServer === "ready" ? "Локальный сервер готов" : "Codex недоступен";
}
