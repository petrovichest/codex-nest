import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { DEFAULT_SESSION_SETTINGS } from "@codexnest/protocol";
import type {
  ModelOption,
  Project,
  SessionSettings,
  TaskDefaults,
  TranscriptionConfigResponse,
  TranscriptionProvider,
  UpdateThreadDraftRequest,
  UpdateThreadSettingsRequest,
} from "@codexnest/protocol";

import { useConnection } from "../connection";
import { localizeKnownServerText, useI18n } from "../i18n";
import { deleteNewSessionDraft, loadNewSessionDraft, saveNewSessionDraft } from "../offline-store";
import type { OptimisticMessage } from "../state";
import type { ConnectionSettings } from "../storage";
import { Composer, type ComposerImage } from "./Composer";
import { NewTaskIcon } from "./Icons";
import { NewSessionInspector } from "./SessionInspector";
import { WorkspaceHeader } from "./WorkspaceHeader";

const DRAFT_SAVE_DELAY_MS = 500;

type NewSessionDraftSnapshot = {
  projectId: string;
  value: UpdateThreadDraftRequest;
  settings: SessionSettings;
  defaultSettings: SessionSettings;
};

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
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedProjectId = searchParams.get("projectId") ?? "";
  const projectId =
    projects.find((candidate) => candidate.id === requestedProjectId)?.id ?? projects[0]?.id ?? "";
  const models = state.snapshot?.models ?? [];
  const defaultSettings = useMemo(
    () =>
      initialSettings(state.snapshot?.defaultReasoningEffort, models, state.snapshot?.taskDefaults),
    [models, state.snapshot?.defaultReasoningEffort, state.snapshot?.taskDefaults],
  );
  const hydrationDefaultsRef = useRef({ defaultSettings, models });
  const [input, setInput] = useState("");
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [goalMode, setGoalMode] = useState(false);
  const [settings, setSettings] = useState<SessionSettings>(() => defaultSettings);
  const [draftHydrated, setDraftHydrated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const draftTouchedRef = useRef(false);
  const discardDraftRef = useRef(false);
  const draftTimerRef = useRef<number | null>(null);
  const latestDraftRef = useRef<NewSessionDraftSnapshot | null>(null);
  const draftSaveChainRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (requestedProjectId === projectId) return;
    setSearchParams(projectId ? { projectId } : {}, { replace: true });
  }, [projectId, requestedProjectId, setSearchParams]);

  const project = useMemo(
    () => projects.find((candidate) => candidate.id === projectId) ?? null,
    [projectId, projects],
  );

  useEffect(() => {
    if (!projectId) {
      setDraftHydrated(true);
      return;
    }
    let active = true;
    void loadNewSessionDraft(api.settings, projectId).then((draft) => {
      if (!active) return;
      if (draft && !draftTouchedRef.current) {
        const restoredSettings = normalizeSavedSettings(
          draft.settings,
          hydrationDefaultsRef.current.defaultSettings,
          hydrationDefaultsRef.current.models,
        );
        setInput(draft.value.input);
        setImages(draft.value.images);
        setGoalMode(restoredSettings.collaborationMode === "default" && draft.value.goalMode);
        setSettings(restoredSettings);
      }
      setDraftHydrated(true);
    });
    return () => {
      active = false;
    };
  }, [api.settings, projectId]);

  latestDraftRef.current =
    draftHydrated && projectId
      ? {
          projectId,
          value: { input, images, goalMode, annotations: [] },
          settings,
          defaultSettings,
        }
      : null;

  function enqueueDraftSave(snapshot: NewSessionDraftSnapshot): Promise<void> {
    const request = draftSaveChainRef.current
      .catch(() => undefined)
      .then(() => persistNewSessionDraft(api.settings, snapshot));
    draftSaveChainRef.current = request;
    return request;
  }

  function flushDraft(): Promise<void> {
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    const snapshot = latestDraftRef.current;
    return snapshot ? enqueueDraftSave(snapshot) : draftSaveChainRef.current;
  }

  useEffect(() => {
    if (!draftHydrated || !projectId || discardDraftRef.current) return;
    if (draftTimerRef.current !== null) window.clearTimeout(draftTimerRef.current);
    const timer = window.setTimeout(() => {
      if (draftTimerRef.current === timer) draftTimerRef.current = null;
      const snapshot = latestDraftRef.current;
      if (snapshot && !discardDraftRef.current) void enqueueDraftSave(snapshot);
    }, DRAFT_SAVE_DELAY_MS);
    draftTimerRef.current = timer;
  }, [draftHydrated, goalMode, images, input, projectId, settings]);

  useEffect(() => {
    const flushBeforePageExit = () => {
      if (!discardDraftRef.current) void flushDraft();
    };
    window.addEventListener("pagehide", flushBeforePageExit);
    return () => {
      window.removeEventListener("pagehide", flushBeforePageExit);
      if (!discardDraftRef.current) void flushDraft();
      else if (draftTimerRef.current !== null) window.clearTimeout(draftTimerRef.current);
    };
  }, []);

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
      discardDraftRef.current = true;
      if (draftTimerRef.current !== null) {
        window.clearTimeout(draftTimerRef.current);
        draftTimerRef.current = null;
      }
      await draftSaveChainRef.current.catch(() => undefined);
      await deleteNewSessionDraft(api.settings, projectId);
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
          onInput={(value) => {
            draftTouchedRef.current = true;
            setInput(value);
          }}
          images={images}
          onImagesChange={(value) => {
            draftTouchedRef.current = true;
            setImages(value);
          }}
          onSubmit={submit}
          busy={busy}
          settings={settings}
          onSettingsChange={(patch) => {
            draftTouchedRef.current = true;
            if (patch.collaborationMode !== undefined && patch.collaborationMode !== "default") {
              setGoalMode(false);
            }
            setSettings((current) => applySettingsPatch(current, patch));
          }}
          goalMode={goalMode}
          onGoalModeChange={(value) => {
            draftTouchedRef.current = true;
            setGoalMode(value);
          }}
          models={models}
          projects={projects}
          projectId={projectId}
          onProjectChange={(nextProjectId) => {
            void flushDraft();
            setSearchParams({ projectId: nextProjectId }, { replace: true });
          }}
          onNewProject={onNewProject}
          transcriptionConfig={transcriptionConfig}
          transcriptionProvider={transcriptionProvider}
          onTranscribe={async (audio, durationMs) => {
            if (!transcriptionProvider) {
              throw new Error(t("Распознавание речи не настроено"));
            }
            return (await api.transcribe(audio, durationMs)).text;
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

function normalizeSavedSettings(
  saved: SessionSettings,
  defaults: SessionSettings,
  models: ModelOption[],
): SessionSettings {
  const collaborationMode = ["default", "plan", "team"].includes(saved.collaborationMode)
    ? saved.collaborationMode
    : defaults.collaborationMode;
  if (!models.length) {
    return {
      ...defaults,
      ...saved,
      collaborationMode,
    };
  }
  const savedModel = saved.model
    ? models.find((candidate) => candidate.id === saved.model)
    : undefined;
  const model = savedModel ?? models.find((candidate) => candidate.isDefault) ?? models[0];
  const next: SessionSettings = { collaborationMode };
  if (savedModel) next.model = savedModel.id;
  const reasoningEffort = saved.reasoningEffort ?? defaults.reasoningEffort;
  if (
    reasoningEffort &&
    model?.reasoningEfforts.some((option) => option.value === reasoningEffort)
  ) {
    next.reasoningEffort = reasoningEffort;
  }
  const serviceTier = saved.serviceTier ?? defaults.serviceTier;
  if (serviceTier && model?.serviceTiers.some((tier) => tier.id === serviceTier)) {
    next.serviceTier = serviceTier;
  }
  const personality = saved.personality ?? defaults.personality;
  if (personality && model?.supportsPersonality) next.personality = personality;
  return next;
}

async function persistNewSessionDraft(
  connectionSettings: ConnectionSettings,
  snapshot: NewSessionDraftSnapshot,
): Promise<void> {
  if (
    snapshot.value.input === "" &&
    snapshot.value.images.length === 0 &&
    !snapshot.value.goalMode &&
    sessionSettingsEqual(snapshot.settings, snapshot.defaultSettings)
  ) {
    await deleteNewSessionDraft(connectionSettings, snapshot.projectId);
    return;
  }
  await saveNewSessionDraft(
    connectionSettings,
    snapshot.projectId,
    snapshot.value,
    snapshot.settings,
  );
}

function sessionSettingsEqual(left: SessionSettings, right: SessionSettings): boolean {
  return (
    left.collaborationMode === right.collaborationMode &&
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    left.serviceTier === right.serviceTier &&
    left.personality === right.personality
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
