import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router";

import { DEFAULT_SESSION_SETTINGS } from "@codexnest/protocol";
import type {
  Project,
  ThreadSummary,
  TranscriptionConfigResponse,
  TranscriptionProvider,
  UpdateThreadDraftRequest,
} from "@codexnest/protocol";

import { ApiClientError } from "../api";
import { useConnection } from "../connection";
import { localizeKnownServerText, useI18n } from "../i18n";
import {
  deleteLocalDraft,
  deleteNewSessionDraft,
  loadNewSessionDraft,
  saveLocalDraft,
  saveNewSessionDraft,
} from "../offline-store";
import { Composer } from "./Composer";
import { NewTaskIcon } from "./Icons";
import { NewSessionInspector } from "./SessionInspector";
import { WorkspaceHeader } from "./WorkspaceHeader";

const DRAFT_SAVE_DELAY_MS = 500;

type PreparationSnapshot = {
  projectId: string;
  value: UpdateThreadDraftRequest;
  phase: "creating" | "transferring";
  threadId: string | null;
  thread: ThreadSummary | null;
  revision: number;
};

export function NewSession({
  projects,
  transcriptionConfig = null,
  transcriptionProvider = null,
  onOpenNavigation,
}: {
  projects: Project[];
  transcriptionConfig?: TranscriptionConfigResponse | null;
  transcriptionProvider?: TranscriptionProvider | null;
  onOpenNavigation(): void;
}) {
  const { api, state, dispatch } = useConnection();
  const { language, t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const projectId = searchParams.get("projectId") ?? "";
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const navigationProjectId = (location.state as { newSessionProjectId?: unknown } | null)
    ?.newSessionProjectId;
  const openedFromProject = navigationProjectId === projectId;
  const [admitted, setAdmitted] = useState(openedFromProject);
  const [rejected, setRejected] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [draftValue, setDraftValue] = useState<UpdateThreadDraftRequest>(emptyDraft);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const preparationRef = useRef<PreparationSnapshot>({
    projectId,
    value: emptyDraft(),
    phase: "creating",
    threadId: null,
    thread: null,
    revision: 0,
  });
  const draftTouchedRef = useRef(false);
  const admittedRef = useRef(openedFromProject);
  const aliveRef = useRef(true);
  const discardRef = useRef(false);
  const operationRef = useRef(false);
  const draftTimerRef = useRef<number | null>(null);
  const draftSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const models = state.snapshot?.models ?? [];
  const settings = useMemo(() => ({ ...DEFAULT_SESSION_SETTINGS }), []);

  function snapshotPreparation(): PreparationSnapshot {
    const current = preparationRef.current;
    return {
      ...current,
      value: {
        input: current.value.input,
        images: [...current.value.images],
        goalMode: current.value.goalMode,
        annotations: [...current.value.annotations],
      },
    };
  }

  function enqueuePreparationSave(snapshot: PreparationSnapshot): Promise<void> {
    const request = draftSaveChainRef.current
      .catch(() => undefined)
      .then(async () => {
        const saved = await saveNewSessionDraft(api.settings, snapshot.projectId, snapshot.value, {
          phase: snapshot.phase,
          threadId: snapshot.threadId,
          thread: snapshot.thread,
          revision: snapshot.revision,
        });
        if (!saved && aliveRef.current) setStorageWarning(true);
      });
    draftSaveChainRef.current = request;
    return request;
  }

  function flushPreparation(): Promise<void> {
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    if (!admittedRef.current || discardRef.current) return draftSaveChainRef.current;
    return enqueuePreparationSave(snapshotPreparation());
  }

  useEffect(() => {
    if (!project) {
      setHydrated(true);
      return;
    }
    let active = true;
    void (async () => {
      const stored = await loadNewSessionDraft(api.settings, project.id);
      if (!active) return;
      if (!stored && !openedFromProject) {
        setRejected(true);
        setHydrated(true);
        return;
      }

      const current = preparationRef.current;
      const value =
        stored && !draftTouchedRef.current
          ? normalizeDraft(stored.value)
          : current.projectId === project.id
            ? current.value
            : emptyDraft();
      const threadId = stored?.threadId ?? null;
      const preparation: PreparationSnapshot = {
        projectId: project.id,
        value,
        phase: threadId ? "transferring" : "creating",
        threadId,
        thread: stored?.thread?.id === threadId ? stored.thread : null,
        revision: Math.max(current.revision, stored?.revision ?? 0),
      };
      preparationRef.current = preparation;
      if (stored && !draftTouchedRef.current) setDraftValue(value);
      admittedRef.current = true;
      setAdmitted(true);
      await enqueuePreparationSave(snapshotPreparation());
      if (active) setHydrated(true);
    })();
    return () => {
      active = false;
    };
  }, [api.settings, openedFromProject, project?.id]);

  useEffect(() => {
    if (!hydrated || !admitted || discardRef.current) return;
    if (draftTimerRef.current !== null) window.clearTimeout(draftTimerRef.current);
    const timer = window.setTimeout(() => {
      if (draftTimerRef.current === timer) draftTimerRef.current = null;
      if (!discardRef.current) void enqueuePreparationSave(snapshotPreparation());
    }, DRAFT_SAVE_DELAY_MS);
    draftTimerRef.current = timer;
  }, [admitted, draftValue, hydrated]);

  useEffect(() => {
    if (!hydrated || !admitted || !project || operationRef.current) return;
    operationRef.current = true;
    setWorking(true);
    setError(null);
    void runPreparation(project)
      .catch(async (caught: unknown) => {
        if (
          caught instanceof ApiClientError &&
          caught.status === 404 &&
          preparationRef.current.threadId
        ) {
          preparationRef.current = {
            ...preparationRef.current,
            phase: "creating",
            threadId: null,
            thread: null,
          };
        }
        await flushPreparation();
        if (aliveRef.current) {
          setError(
            caught instanceof Error
              ? (localizeKnownServerText(language, caught.message) ?? caught.message)
              : t("Не удалось создать сессию"),
          );
        }
      })
      .finally(() => {
        operationRef.current = false;
        if (aliveRef.current) setWorking(false);
      });
  }, [admitted, hydrated, projectId, retryAttempt]);

  useEffect(() => {
    aliveRef.current = true;
    const flushBeforePageExit = () => {
      if (!discardRef.current) void flushPreparation();
    };
    window.addEventListener("pagehide", flushBeforePageExit);
    return () => {
      aliveRef.current = false;
      window.removeEventListener("pagehide", flushBeforePageExit);
      if (!discardRef.current) void flushPreparation();
      else if (draftTimerRef.current !== null) window.clearTimeout(draftTimerRef.current);
    };
  }, []);

  async function runPreparation(activeProject: Project): Promise<void> {
    let thread = preparationRef.current.thread;
    let threadId = preparationRef.current.threadId;
    if (!threadId) {
      const created = await api.createProjectThread(activeProject.id);
      thread = created.thread;
      threadId = thread.id;
      preparationRef.current = {
        ...preparationRef.current,
        phase: "transferring",
        threadId,
        thread,
      };
      await enqueuePreparationSave(snapshotPreparation());
    }

    if (!thread) {
      thread =
        state.snapshot?.threads.find((candidate) => candidate.id === threadId) ??
        (await api.readThread(threadId, undefined, { fresh: true })).summary;
      preparationRef.current = { ...preparationRef.current, thread };
      await enqueuePreparationSave(snapshotPreparation());
    }

    while (true) {
      const transferring = snapshotPreparation();
      const hasDraft =
        Boolean(transferring.value.input) ||
        transferring.value.images.length > 0 ||
        transferring.value.goalMode ||
        transferring.value.annotations.length > 0;
      const saved = hasDraft ? await saveTransferredDraft(api, threadId, transferring.value) : null;
      if (preparationRef.current.revision !== transferring.revision) continue;

      if (saved) {
        await saveLocalDraft(api.settings, threadId, transferring.value, saved.updatedAt);
      } else {
        await deleteLocalDraft(api.settings, threadId);
      }
      if (preparationRef.current.revision !== transferring.revision) continue;
      await flushPreparation();
      if (preparationRef.current.revision !== transferring.revision) continue;
      await deleteNewSessionDraft(api.settings, activeProject.id);
      if (preparationRef.current.revision !== transferring.revision) continue;

      discardRef.current = true;
      if (draftTimerRef.current !== null) {
        window.clearTimeout(draftTimerRef.current);
        draftTimerRef.current = null;
      }
      dispatch({ type: "thread", thread });
      dispatch({
        type: "detail",
        detail: {
          summary: thread,
          turns: [],
          queuedMessages: [],
          olderTurnsCursor: null,
          draft: saved,
        },
        page: "latest",
      });
      if (aliveRef.current) {
        navigate(`/threads/${encodeURIComponent(threadId)}`, {
          replace: true,
          state: { focusComposer: true },
        });
      }
      return;
    }
  }

  function updateDraft(value: UpdateThreadDraftRequest): void {
    draftTouchedRef.current = true;
    preparationRef.current = {
      ...preparationRef.current,
      value,
      revision: preparationRef.current.revision + 1,
    };
    setDraftValue(value);
  }

  function preventSubmit(event: FormEvent): void {
    event.preventDefault();
  }

  if (!project || rejected) return <Navigate to="/" replace />;
  if (!admitted) return null;

  return (
    <div className="thread-workspace new-session-page">
      <div className="conversation-pane">
        <WorkspaceHeader
          title={t("Новая задача")}
          subtitle={project.displayName}
          onOpenNavigation={onOpenNavigation}
          onToggleInspector={() => setInspectorOpen((value) => !value)}
        />
        <div className="new-session-empty">
          <span className="new-session-glyph">
            <NewTaskIcon />
          </span>
          <h2>{t("Что поручим Codex?")}</h2>
          <p>
            {working
              ? t("Готовим сессию — уже можно вводить сообщение.")
              : t("Черновик сохранён. Повторите создание сессии.")}
          </p>
        </div>
        <Composer
          autoFocus
          input={draftValue.input}
          onInput={(input) => updateDraft({ ...preparationRef.current.value, input })}
          images={draftValue.images}
          onImagesChange={(images) => updateDraft({ ...preparationRef.current.value, images })}
          onSubmit={preventSubmit}
          busy
          settings={settings}
          onSettingsChange={() => undefined}
          goalMode={false}
          onGoalModeChange={() => undefined}
          models={models}
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
        {storageWarning && (
          <p className="new-session-storage-warning" role="status">
            {t(
              "Локальное сохранение недоступно. Не закрывайте страницу, пока сессия не откроется.",
            )}
          </p>
        )}
        {error && (
          <button
            className="new-session-retry"
            type="button"
            disabled={working}
            onClick={() => setRetryAttempt((value) => value + 1)}
          >
            {t("Повторить")}
          </button>
        )}
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

function emptyDraft(): UpdateThreadDraftRequest {
  return { input: "", images: [], goalMode: false, annotations: [] };
}

function normalizeDraft(value: UpdateThreadDraftRequest): UpdateThreadDraftRequest {
  return {
    input: value.input,
    images: value.images,
    goalMode: false,
    annotations: [],
  };
}

async function saveTransferredDraft(
  api: ReturnType<typeof useConnection>["api"],
  threadId: string,
  value: UpdateThreadDraftRequest,
) {
  await saveLocalDraft(api.settings, threadId, value, Date.now());
  return api.updateThreadDraft(threadId, value, { retry: true });
}
