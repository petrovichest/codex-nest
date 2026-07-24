import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { DEFAULT_SESSION_SETTINGS } from "@codexnest/protocol";
import type {
  ModelOption,
  Project,
  SessionSettings,
  TaskDefaults,
  TranscriptionConfigResponse,
  TranscriptionProvider,
  UpdateThreadSettingsRequest,
} from "@codexnest/protocol";

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
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [input, setInput] = useState("");
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [goalMode, setGoalMode] = useState(false);
  const [settings, setSettings] = useState<SessionSettings>(() =>
    initialSettings(
      state.snapshot?.defaultReasoningEffort,
      state.snapshot?.models ?? [],
      state.snapshot?.taskDefaults,
    ),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);

  useEffect(() => {
    if (!projectId && projects[0]) setProjectId(projects[0].id);
  }, [projectId, projects]);

  const project = useMemo(
    () => projects.find((candidate) => candidate.id === projectId) ?? null,
    [projectId, projects],
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!projectId || (!input.trim() && !images.length) || (goalMode && !input.trim())) return;
    const clientMessageId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    const createdAt = Date.now();
    setBusy(true);
    setError(null);
    try {
      const result = await api.createThread({
        projectId,
        input,
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
          <h2>{t("Что поручим Codex?")}</h2>
          <p>
            {t("Опишите задачу — работа продолжится на сервере, даже если закрыть приложение.")}
          </p>
        </div>
        <Composer
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
          models={state.snapshot?.models ?? []}
          projects={projects}
          projectId={projectId}
          onProjectChange={setProjectId}
          onNewProject={onNewProject}
          transcriptionConfig={transcriptionConfig}
          transcriptionProvider={transcriptionProvider}
          onTranscribe={async (audio) => {
            if (!transcriptionProvider) {
              throw new Error(t("Распознавание речи не настроено"));
            }
            return (await api.transcribe(audio)).text;
          }}
          error={error}
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
