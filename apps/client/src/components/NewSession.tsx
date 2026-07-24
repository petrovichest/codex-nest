import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { DEFAULT_SESSION_SETTINGS } from "@codexnest/protocol";
import type {
  AgentId,
  ModelOption,
  Project,
  SessionSettings,
  TaskDefaults,
  TranscriptionConfigResponse,
  TranscriptionProvider,
  UpdateThreadSettingsRequest,
} from "@codexnest/protocol";

import { agentLabel, backendFor, defaultAgent, modelsForAgent, snapshotBackends } from "../agents";
import { useConnection } from "../connection";
import { localizeKnownServerText, useI18n } from "../i18n";
import type { OptimisticMessage } from "../state";
import { Composer, type ComposerImage } from "./Composer";
import { NewTaskIcon } from "./Icons";
import { NewSessionInspector } from "./SessionInspector";
import { WorkspaceHeader } from "./WorkspaceHeader";

export function NewSession({
  projects,
  transcriptionConfig = null,
  transcriptionProvider = null,
  onOpenNavigation,
  onNewProject,
}: {
  projects: Project[];
  transcriptionConfig?: TranscriptionConfigResponse | null;
  transcriptionProvider?: TranscriptionProvider | null;
  onOpenNavigation(): void;
  onNewProject(): void;
}) {
  const { api, state, dispatch } = useConnection();
  const { language, t } = useI18n();
  const navigate = useNavigate();
  const snapshot = state.snapshot;
  const backends = useMemo(() => snapshotBackends(snapshot), [snapshot]);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [input, setInput] = useState("");
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [goalMode, setGoalMode] = useState(false);
  const [agent, setAgent] = useState<AgentId>(() => defaultAgent(snapshot));
  const [settings, setSettings] = useState<SessionSettings>(() =>
    initialSettings(
      snapshot?.defaultReasoningEffort,
      modelsForAgent(snapshot, defaultAgent(snapshot)),
      snapshot?.taskDefaults,
    ),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);

  const showAgentPicker = backends.length >= 2;
  const selectedBackend = backendFor(snapshot, agent);
  const agentModels = selectedBackend?.models ?? [];
  const backendBlockedReason =
    selectedBackend && selectedBackend.connection.state !== "ready"
      ? (localizeKnownServerText(language, selectedBackend.connection.message) ??
        t("{{agent}} недоступен", { agent: agentLabel(agent) }))
      : null;

  useEffect(() => {
    if (!projectId && projects[0]) setProjectId(projects[0].id);
  }, [projectId, projects]);

  // Switching agent re-seeds settings from the chosen backend's models (a Codex model id is
  // not valid for Claude and vice versa) and drops goal mode, which is Codex-only.
  function changeAgent(next: AgentId) {
    if (next === agent) return;
    setAgent(next);
    setGoalMode(false);
    setError(null);
    setSettings(
      initialSettings(
        snapshot?.defaultReasoningEffort,
        modelsForAgent(snapshot, next),
        snapshot?.taskDefaults,
      ),
    );
  }

  const project = useMemo(
    () => projects.find((candidate) => candidate.id === projectId) ?? null,
    [projectId, projects],
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!projectId || (!input.trim() && !images.length) || (goalMode && !input.trim())) return;
    if (backendBlockedReason) return;
    const clientMessageId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    const createdAt = Date.now();
    setBusy(true);
    setError(null);
    try {
      const result = await api.createThread({
        projectId,
        input,
        agent,
        ...(images.length ? { images: images.map((image) => image.url) } : {}),
        ...(goalMode ? { goal: true } : {}),
        clientMessageId,
        settings: {
          ...settings,
          ...(settings.reasoningEffort === undefined && state.snapshot?.defaultReasoningEffort
            ? { reasoningEffort: null }
            : {}),
        },
      });
      dispatch({ type: "thread", thread: result.thread });
      dispatch({
        type: "optimistic.add",
        message: {
          id: clientMessageId,
          threadId: result.thread.id,
          text: input.trim(),
          images: images.map((image) => image.url),
          createdAt,
          destination: "turn",
          turnId: result.turnId,
        } satisfies OptimisticMessage,
      });
      navigate(`/threads/${encodeURIComponent(result.thread.id)}`, {
        state: {
          focusComposer: true,
          ...(result.goalWarning
            ? {
                notice: localizeKnownServerText(language, result.goalWarning) ?? result.goalWarning,
              }
            : {}),
        },
      });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? (localizeKnownServerText(language, caught.message) ?? caught.message)
          : t("Не удалось создать задачу"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="thread-workspace new-session-page">
      <div className="conversation-pane">
        <WorkspaceHeader
          title={t("Новая задача")}
          subtitle={project?.displayName ?? t("Выберите проект")}
          onOpenNavigation={onOpenNavigation}
          onToggleInspector={() => setInspectorOpen((value) => !value)}
        />
        <div className="new-session-empty">
          <span className="new-session-glyph">
            <NewTaskIcon />
          </span>
          <h2>{t("Что поручим {{agent}}?", { agent: agentLabel(agent) })}</h2>
          <p>
            {t("Опишите задачу — работа продолжится на сервере, даже если закрыть приложение.")}
          </p>
          {showAgentPicker && (
            <div className="agent-segmented" role="radiogroup" aria-label={t("Агент")}>
              {backends.map((backend) => (
                <button
                  key={backend.agent}
                  type="button"
                  role="radio"
                  aria-checked={agent === backend.agent}
                  className={`agent-segment${agent === backend.agent ? " selected" : ""}`}
                  onClick={() => changeAgent(backend.agent)}
                >
                  {agentLabel(backend.agent)}
                </button>
              ))}
            </div>
          )}
        </div>
        <Composer
          agent={agent}
          autoFocus
          input={input}
          onInput={setInput}
          images={images}
          onImagesChange={setImages}
          onSubmit={submit}
          busy={busy}
          settings={settings}
          onSettingsChange={(patch) => {
            if (patch.collaborationMode === "plan") setGoalMode(false);
            setSettings((current) => applySettingsPatch(current, patch));
          }}
          goalMode={goalMode}
          onGoalModeChange={setGoalMode}
          models={agentModels}
          blocked={Boolean(backendBlockedReason)}
          projects={projects}
          projectId={projectId}
          onProjectChange={setProjectId}
          onNewProject={onNewProject}
          transcriptionConfig={transcriptionConfig}
          transcriptionProvider={transcriptionProvider}
          onTranscribe={async (audio, durationMs) => {
            if (!transcriptionProvider) {
              throw new Error(t("Распознавание речи не настроено"));
            }
            return (await api.transcribe(audio, durationMs)).text;
          }}
          error={error ?? backendBlockedReason}
        />
      </div>
      <NewSessionInspector
        open={inspectorOpen}
        project={project}
        onClose={() => setInspectorOpen(false)}
      />
      {inspectorOpen && (
        <button
          className="inspector-backdrop"
          aria-label={t("Закрыть сведения")}
          onClick={() => setInspectorOpen(false)}
        />
      )}
    </div>
  );
}

function initialSettings(
  defaultReasoningEffort: string | undefined,
  models: ModelOption[],
  taskDefaults?: TaskDefaults,
): SessionSettings {
  const settings = { ...DEFAULT_SESSION_SETTINGS };
  const model = models.find((candidate) => candidate.isDefault) ?? models[0];
  if (
    defaultReasoningEffort &&
    (!model || model.reasoningEfforts.some((option) => option.value === defaultReasoningEffort))
  ) {
    settings.reasoningEffort = defaultReasoningEffort;
  }
  if (
    taskDefaults?.serviceTier &&
    model?.serviceTiers.some((tier) => tier.id === taskDefaults.serviceTier)
  ) {
    settings.serviceTier = taskDefaults.serviceTier;
  }
  if (taskDefaults?.personality && model?.supportsPersonality) {
    settings.personality = taskDefaults.personality;
  }
  return settings;
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
