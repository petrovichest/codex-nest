import { Browser } from "@capacitor/browser";
import { useEffect, useRef, useState } from "react";

import type {
  AttentionRequest,
  AttentionResponse,
  ElicitationPrimitive,
  PermissionGrant,
  TranscriptionConfigResponse,
  TranscriptionProvider,
  TranscriptionTimingEstimate,
} from "@codexnest/protocol";

import { useConnection } from "../connection";
import { localizeKnownServerText, useI18n, type Translate } from "../i18n";
import { AlertIcon, MicrophoneIcon, XIcon } from "./Icons";
import {
  estimatedTranscriptionSeconds,
  formatEstimatedTranscriptionTime,
  formatRecordingTime,
  insertTranscriptAtSelection,
  microphoneUnavailableReason,
  recordingErrorMessage,
  recordingMimeType,
  type TextSelection,
} from "./speech-input";

export function AttentionPanel({
  requests,
  transcriptionConfig = null,
  transcriptionProvider = null,
  onTranscriptionTimingEstimateChange,
}: {
  requests: AttentionRequest[];
  transcriptionConfig?: TranscriptionConfigResponse | null;
  transcriptionProvider?: TranscriptionProvider | null;
  onTranscriptionTimingEstimateChange?(estimate: TranscriptionTimingEstimate): void;
}) {
  const { t } = useI18n();
  if (!requests.length) return null;
  return (
    <section className="attention-stack" aria-label={t("Требуется внимание")}>
      {requests.map((request) => (
        <AttentionCard
          request={request}
          transcriptionConfig={transcriptionConfig}
          transcriptionProvider={transcriptionProvider}
          onTranscriptionTimingEstimateChange={onTranscriptionTimingEstimateChange}
          key={request.id}
        />
      ))}
    </section>
  );
}

function AttentionCard({
  request,
  transcriptionConfig,
  transcriptionProvider,
  onTranscriptionTimingEstimateChange,
}: {
  request: AttentionRequest;
  transcriptionConfig: TranscriptionConfigResponse | null;
  transcriptionProvider: TranscriptionProvider | null;
  onTranscriptionTimingEstimateChange?(estimate: TranscriptionTimingEstimate): void;
}) {
  const connection = useConnection();
  const { api } = connection;
  const { language, t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function respond(response: AttentionResponse) {
    setBusy(true);
    setError(null);
    try {
      await api.respond(request.id, response);
      if (response.kind === "userInput") connection.clearUserInputDraft?.(request.id);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? (localizeKnownServerText(language, caught.message) ?? caught.message)
          : t("Запрос уже закрыт"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="attention-card">
      <div className="attention-heading">
        <AlertIcon />
        {t("Требуется внимание")}
      </div>
      {request.kind === "commandApproval" && (
        <>
          <h3>{t("Разрешить команду?")}</h3>
          {request.reason && <p>{request.reason}</p>}
          <pre>{request.command ?? t("Команда не указана")}</pre>
          {request.cwd && <div className="path">{request.cwd}</div>}
          {request.networkHost && (
            <div className="path">{t("Сетевой host: {{host}}", { host: request.networkHost })}</div>
          )}
          {!!request.proposedPolicyChanges.length && (
            <div className="policy-change">
              <strong>{t("Отдельные изменения policy")}</strong>
              {request.proposedPolicyChanges.map((change) => (
                <button
                  key={change.id}
                  disabled={busy}
                  onClick={() =>
                    void respond({ kind: "approvalAmendment", amendmentId: change.id })
                  }
                >
                  {localizeKnownServerText(language, change.label) ?? change.label}
                </button>
              ))}
              <small>{t("Обычное подтверждение эти правила не применяет.")}</small>
            </div>
          )}
          <ApprovalButtons busy={busy} canSession={request.canAcceptForSession} respond={respond} />
        </>
      )}
      {request.kind === "fileChangeApproval" && (
        <>
          <h3>{t("Разрешить изменения файлов?")}</h3>
          {request.reason && <p>{request.reason}</p>}
          {request.grantRoot && (
            <div className="path">
              {t("Запрошенный корень: {{root}}", { root: request.grantRoot })}
            </div>
          )}
          <ApprovalButtons busy={busy} canSession={request.canAcceptForSession} respond={respond} />
        </>
      )}
      {request.kind === "permissionApproval" && (
        <PermissionForm request={request} busy={busy} respond={respond} />
      )}
      {request.kind === "userInput" && (
        <UserInputForm
          request={request}
          busy={busy}
          transcriptionConfig={transcriptionConfig}
          transcriptionProvider={transcriptionProvider}
          onTranscriptionTimingEstimateChange={onTranscriptionTimingEstimateChange}
          respond={respond}
        />
      )}
      {request.kind === "elicitation" && (
        <ElicitationForm request={request} busy={busy} respond={respond} />
      )}
      {request.kind === "unsupported" && (
        <>
          <h3>{t("Несовместимое действие")}</h3>
          <p>{localizeKnownServerText(language, request.message) ?? request.message}</p>
          <code>{request.method}</code>
        </>
      )}
      {error && <div className="error-banner">{error}</div>}
    </article>
  );
}

function ApprovalButtons({
  busy,
  canSession,
  respond,
}: {
  busy: boolean;
  canSession: boolean;
  respond(response: AttentionResponse): Promise<void>;
}) {
  const { t } = useI18n();
  const decision = (value: "accept" | "acceptForSession" | "decline" | "cancel") =>
    void respond({ kind: "approval", decision: value });
  return (
    <div className="button-row">
      <button className="primary" disabled={busy} onClick={() => decision("accept")}>
        {t("Разрешить один раз")}
      </button>
      {canSession && (
        <button disabled={busy} onClick={() => decision("acceptForSession")}>
          {t("На сессию")}
        </button>
      )}
      <button className="danger" disabled={busy} onClick={() => decision("decline")}>
        {t("Отказать")}
      </button>
      <button disabled={busy} onClick={() => decision("cancel")}>
        {t("Отменить turn")}
      </button>
    </div>
  );
}

function PermissionForm({
  request,
  busy,
  respond,
}: {
  request: Extract<AttentionRequest, { kind: "permissionApproval" }>;
  busy: boolean;
  respond(response: AttentionResponse): Promise<void>;
}) {
  const { t } = useI18n();
  const [grant, setGrant] = useState<PermissionGrant>({});
  const paths = [
    ...(request.permissions.fileSystem?.read ?? []).map((path) => ({
      mode: "read" as const,
      path,
    })),
    ...(request.permissions.fileSystem?.write ?? []).map((path) => ({
      mode: "write" as const,
      path,
    })),
  ];
  function togglePath(mode: "read" | "write", path: string, checked: boolean) {
    const current = grant.fileSystem?.[mode] ?? [];
    setGrant({
      ...grant,
      fileSystem: {
        ...grant.fileSystem,
        [mode]: checked ? [...current, path] : current.filter((candidate) => candidate !== path),
      },
    });
  }
  return (
    <>
      <h3>{t("Дополнительные разрешения")}</h3>
      {request.reason && <p>{request.reason}</p>}
      <div className="path">{request.cwd}</div>
      {request.permissions.network?.enabled && (
        <label className="check">
          <input
            type="checkbox"
            checked={grant.network?.enabled ?? false}
            onChange={(event) => setGrant({ ...grant, network: { enabled: event.target.checked } })}
          />
          {t("Сеть")}
        </label>
      )}
      {paths.map(({ mode, path }) => (
        <label className="check" key={`${mode}-${path}`}>
          <input
            type="checkbox"
            checked={grant.fileSystem?.[mode]?.includes(path) ?? false}
            onChange={(event) => togglePath(mode, path, event.target.checked)}
          />
          {mode === "read" ? t("Чтение") : t("Запись")}: {path}
        </label>
      ))}
      <div className="button-row">
        <button
          className="primary"
          disabled={busy}
          onClick={() => void respond({ kind: "permission", permissions: grant, scope: "turn" })}
        >
          {t("Выдать на turn")}
        </button>
        <button
          disabled={busy}
          onClick={() => void respond({ kind: "permission", permissions: grant, scope: "session" })}
        >
          {t("На сессию")}
        </button>
        <button
          className="danger"
          disabled={busy}
          onClick={() => void respond({ kind: "permission", permissions: {}, scope: "turn" })}
        >
          {t("Отказать")}
        </button>
      </div>
    </>
  );
}

function UserInputForm({
  request,
  busy,
  transcriptionConfig,
  transcriptionProvider,
  onTranscriptionTimingEstimateChange,
  respond,
}: {
  request: Extract<AttentionRequest, { kind: "userInput" }>;
  busy: boolean;
  transcriptionConfig: TranscriptionConfigResponse | null;
  transcriptionProvider: TranscriptionProvider | null;
  onTranscriptionTimingEstimateChange?(estimate: TranscriptionTimingEstimate): void;
  respond(response: AttentionResponse): Promise<void>;
}) {
  const connection = useConnection();
  const { api } = connection;
  const updateUserInputDraft = connection.updateUserInputDraft;
  const flushUserInputDraft = connection.flushUserInputDraft;
  const { language, t } = useI18n();
  const providerDraft = connection.state?.userInputDrafts?.[request.id];
  const [viewDraft, setViewDraft] = useState(() => initialUserInputDraft(request, providerDraft));
  const [speechState, setSpeechState] = useState<
    "idle" | "requesting" | "recording" | "transcribing"
  >("idle");
  const [speechSeconds, setSpeechSeconds] = useState(0);
  const [speechEstimatedTotalSeconds, setSpeechEstimatedTotalSeconds] = useState<number | null>(
    null,
  );
  const [speechError, setSpeechError] = useState<string | null>(null);
  const answerInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioBytesRef = useRef(0);
  const discardRecordingRef = useRef(false);
  const recordingStartedAtRef = useRef(0);
  const recordingDurationMsRef = useRef(0);
  const speechTimerStartedAtRef = useRef(0);
  const speechTimerRef = useRef<number | undefined>(undefined);
  const recordingLimitRef = useRef<number | undefined>(undefined);
  const aliveRef = useRef(true);
  const timingEstimateRef = useRef<TranscriptionTimingEstimate | null>(
    transcriptionConfig?.timingEstimate ?? null,
  );
  const recordingTargetRef = useRef<{
    questionId: string;
    selection: TextSelection;
    value: string;
  } | null>(null);
  const requestedQuestionIndex = request.questions.findIndex(
    (candidate) => candidate.id === viewDraft.currentQuestionId,
  );
  const questionIndex = requestedQuestionIndex >= 0 ? requestedQuestionIndex : 0;
  const question = request.questions[questionIndex];
  const currentQuestionIdRef = useRef(question?.id ?? null);
  currentQuestionIdRef.current = question?.id ?? null;
  const isLastQuestion = questionIndex === request.questions.length - 1;
  const answers = viewDraft.answers;
  const currentAnswer = question ? answers[question.id]?.[0]?.trim() : "";
  const selectedOption = question?.options?.some(
    (option) => option.label === answers[question.id]?.[0],
  );
  const freeformAnswer = selectedOption ? "" : question ? (answers[question.id]?.[0] ?? "") : "";
  const speechBusy = speechState !== "idle";
  const speechUnavailable = microphoneUnavailableReason(
    transcriptionConfig,
    transcriptionProvider,
    true,
    t,
  );
  const speechTimerText =
    speechState === "recording"
      ? formatRecordingTime(speechSeconds)
      : speechState === "transcribing"
        ? formatEstimatedTranscriptionTime(speechSeconds, speechEstimatedTotalSeconds)
        : null;

  function updateDraft(
    draft: { answers: Record<string, string[]>; currentQuestionId: string | null },
    timing: "immediate" | "debounced",
  ) {
    setViewDraft(draft);
    updateUserInputDraft?.(request.id, draft, timing);
  }

  function updateAnswer(questionId: string, answer: string, timing: "immediate" | "debounced") {
    updateDraft(
      {
        answers: { ...answers, [questionId]: [answer] },
        currentQuestionId: question?.id ?? null,
      },
      timing,
    );
  }

  function navigateTo(index: number) {
    const target = request.questions[index];
    if (!target || busy || speechBusy) return;
    setSpeechError(null);
    recordingTargetRef.current = null;
    updateDraft({ answers, currentQuestionId: target.id }, "immediate");
  }

  function clearAnswer() {
    if (!question || busy || speechBusy) return;
    const nextAnswers = { ...answers };
    delete nextAnswers[question.id];
    setSpeechError(null);
    recordingTargetRef.current = null;
    updateDraft({ answers: nextAnswers, currentQuestionId: question.id }, "immediate");
  }

  function captureAnswerSelection() {
    if (!question) return;
    const input = answerInputRef.current;
    recordingTargetRef.current = {
      questionId: question.id,
      value: freeformAnswer,
      selection: input
        ? {
            start: input.selectionStart ?? freeformAnswer.length,
            end: input.selectionEnd ?? freeformAnswer.length,
          }
        : { start: freeformAnswer.length, end: freeformAnswer.length },
    };
  }

  function clearSpeechTimer() {
    if (speechTimerRef.current === undefined) return;
    window.clearInterval(speechTimerRef.current);
    speechTimerRef.current = undefined;
  }

  function clearRecordingLimit() {
    if (recordingLimitRef.current === undefined) return;
    window.clearTimeout(recordingLimitRef.current);
    recordingLimitRef.current = undefined;
  }

  function stopMediaStream() {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  }

  function startSpeechTimer(startedAt: number) {
    clearSpeechTimer();
    speechTimerStartedAtRef.current = startedAt;
    setSpeechSeconds(0);
    speechTimerRef.current = window.setInterval(() => {
      setSpeechSeconds(
        Math.max(0, Math.floor((Date.now() - speechTimerStartedAtRef.current) / 1_000)),
      );
    }, 250);
  }

  async function startRecording() {
    if (!question || speechState !== "idle" || busy || speechUnavailable) return;
    const mimeType = recordingMimeType();
    if (!mimeType) {
      setSpeechError(t("Этот браузер не поддерживает запись WebM или MP4"));
      return;
    }
    captureAnswerSelection();
    setSpeechError(null);
    setSpeechEstimatedTotalSeconds(null);
    setSpeechState("requesting");
    discardRecordingRef.current = false;
    recordingDurationMsRef.current = 0;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!aliveRef.current || currentQuestionIdRef.current !== question.id) {
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
        clearSpeechTimer();
        clearRecordingLimit();
        stopMediaStream();
        mediaRecorderRef.current = null;
        if (aliveRef.current) {
          setSpeechState("idle");
          setSpeechError(t("Не удалось записать аудио"));
        }
      });
      recorder.addEventListener("stop", () => void finishRecording(mimeType));
      recorder.start(1_000);
      recordingStartedAtRef.current = Date.now();
      startSpeechTimer(recordingStartedAtRef.current);
      setSpeechState("recording");
      recordingLimitRef.current = window.setTimeout(
        stopRecording,
        (transcriptionConfig?.maxRecordingSeconds ?? 300) * 1_000,
      );
    } catch (caught) {
      stopMediaStream();
      if (aliveRef.current) {
        setSpeechState("idle");
        setSpeechError(recordingErrorMessage(caught, t));
      }
    }
  }

  function stopRecording() {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    recordingDurationMsRef.current = Math.max(1, Date.now() - recordingStartedAtRef.current);
    setSpeechEstimatedTotalSeconds(
      estimatedTranscriptionSeconds(timingEstimateRef.current, recordingDurationMsRef.current),
    );
    clearSpeechTimer();
    clearRecordingLimit();
    setSpeechState("transcribing");
    startSpeechTimer(Date.now());
    recorder.stop();
    stopMediaStream();
  }

  function cancelRecording() {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    discardRecordingRef.current = true;
    setSpeechEstimatedTotalSeconds(null);
    clearSpeechTimer();
    clearRecordingLimit();
    recorder.stop();
    stopMediaStream();
  }

  async function finishRecording(mimeType: string) {
    clearRecordingLimit();
    stopMediaStream();
    mediaRecorderRef.current = null;
    const chunks = audioChunksRef.current;
    const bytes = audioBytesRef.current;
    audioChunksRef.current = [];
    audioBytesRef.current = 0;
    if (discardRecordingRef.current) {
      clearSpeechTimer();
      if (aliveRef.current) {
        setSpeechSeconds(0);
        setSpeechState("idle");
      }
      return;
    }
    if (!chunks.length || !bytes) {
      clearSpeechTimer();
      if (aliveRef.current) {
        setSpeechState("idle");
        setSpeechError(t("Запись не содержит аудио"));
      }
      return;
    }
    if (bytes > (transcriptionConfig?.maxUploadBytes ?? 24 * 1024 * 1024)) {
      clearSpeechTimer();
      if (aliveRef.current) {
        setSpeechState("idle");
        setSpeechError(t("Запись слишком большая"));
      }
      return;
    }
    const target = recordingTargetRef.current;
    try {
      const response = await api.transcribe(
        new Blob(chunks, { type: mimeType }),
        recordingDurationMsRef.current || Math.max(1, Date.now() - recordingStartedAtRef.current),
      );
      timingEstimateRef.current = response.timingEstimate;
      onTranscriptionTimingEstimateChange?.(response.timingEstimate);
      if (!aliveRef.current || !target || currentQuestionIdRef.current !== target.questionId) {
        return;
      }
      const inserted = insertTranscriptAtSelection(target.value, response.text, target.selection);
      if (!inserted) throw new Error(t("Распознавание не вернуло текст"));
      updateAnswer(target.questionId, inserted.value, "debounced");
      setSpeechError(null);
      window.setTimeout(() => {
        if (!aliveRef.current || currentQuestionIdRef.current !== target.questionId) return;
        answerInputRef.current?.focus();
        answerInputRef.current?.setSelectionRange(inserted.caret, inserted.caret);
      });
    } catch (caught) {
      if (aliveRef.current) {
        setSpeechError(
          caught instanceof Error
            ? (localizeKnownServerText(language, caught.message) ?? caught.message)
            : t("Не удалось распознать запись"),
        );
      }
    } finally {
      clearSpeechTimer();
      if (aliveRef.current) setSpeechState("idle");
    }
  }

  useEffect(() => {
    timingEstimateRef.current = transcriptionConfig?.timingEstimate ?? null;
  }, [transcriptionConfig?.timingEstimate]);

  useEffect(() => {
    if (!providerDraft) return;
    setViewDraft(initialUserInputDraft(request, providerDraft));
  }, [providerDraft, request]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      flushUserInputDraft?.(request.id);
      aliveRef.current = false;
      discardRecordingRef.current = true;
      clearSpeechTimer();
      clearRecordingLimit();
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      stopMediaStream();
    };
  }, [flushUserInputDraft, request.id]);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!question || busy || speechBusy) return;
        if (!isLastQuestion) {
          navigateTo(questionIndex + 1);
          return;
        }
        void respond({ kind: "userInput", answers: answeredUserInputValues(answers) });
      }}
    >
      <h3>{t("Codex просит уточнение")}</h3>
      {request.autoResolutionMs !== null && (
        <Countdown deadline={request.createdAt + request.autoResolutionMs} />
      )}
      {question && (
        <>
          <div className="user-input-progress">
            {t("Вопрос {{current}} из {{total}}", {
              current: questionIndex + 1,
              total: request.questions.length,
            })}
          </div>
          <nav className="user-input-steps" aria-label={t("Навигация по вопросам")}>
            {request.questions.map((candidate, index) => {
              const answered = Boolean(answers[candidate.id]?.[0]?.trim());
              const current = index === questionIndex;
              return (
                <button
                  aria-current={current ? "step" : undefined}
                  aria-label={t("Вопрос {{current}} из {{total}}: {{header}}{{answered}}", {
                    current: index + 1,
                    total: request.questions.length,
                    header: candidate.header,
                    answered: answered ? t(", есть ответ") : t(", без ответа"),
                  })}
                  className={`${current ? "current" : ""}${answered ? " answered" : ""}`}
                  disabled={busy || speechBusy}
                  key={candidate.id}
                  type="button"
                  onClick={() => navigateTo(index)}
                >
                  {index + 1}
                </button>
              );
            })}
          </nav>
          <fieldset key={question.id}>
            <legend>{question.header}</legend>
            <p>{question.question}</p>
            {question.options?.map((option) => (
              <label className="check" key={option.label}>
                <input
                  type="radio"
                  name={question.id}
                  value={option.label}
                  checked={answers[question.id]?.[0] === option.label}
                  onChange={() => updateAnswer(question.id, option.label, "immediate")}
                  disabled={busy || speechBusy}
                />
                <span>
                  {option.label}
                  <small>{option.description}</small>
                </span>
              </label>
            ))}
            {(question.isOther || !question.options) && (
              <>
                <div className="user-input-freeform">
                  <input
                    ref={answerInputRef}
                    aria-label={t("Свой ответ")}
                    type={question.isSecret ? "password" : "text"}
                    placeholder={t("Свой ответ")}
                    value={freeformAnswer}
                    onChange={(event) => updateAnswer(question.id, event.target.value, "debounced")}
                    onSelect={captureAnswerSelection}
                    disabled={busy}
                    readOnly={speechBusy}
                  />
                  {transcriptionConfig && (
                    <div className="user-input-voice-actions">
                      <button
                        aria-label={
                          speechState === "recording"
                            ? t("Остановить запись")
                            : speechState === "requesting"
                              ? t("Запрашиваем доступ к микрофону")
                              : speechState === "transcribing"
                                ? t("Распознаём запись")
                                : speechUnavailable
                                  ? speechUnavailable
                                  : t("Начать запись")
                        }
                        aria-pressed={speechState === "recording"}
                        className={`composer-action microphone user-input-microphone${speechState === "recording" ? " recording" : ""}${speechTimerText ? " timing" : ""}`}
                        disabled={
                          speechState === "requesting" ||
                          speechState === "transcribing" ||
                          (speechState === "idle" && (busy || Boolean(speechUnavailable)))
                        }
                        title={speechUnavailable ?? undefined}
                        type="button"
                        onPointerDown={speechState === "idle" ? captureAnswerSelection : undefined}
                        onClick={() =>
                          speechState === "recording" ? stopRecording() : void startRecording()
                        }
                      >
                        {speechTimerText ? (
                          <span className="composer-action-timer" aria-hidden="true">
                            {speechTimerText}
                          </span>
                        ) : speechState === "requesting" ? (
                          <span className="spinner small" />
                        ) : (
                          <MicrophoneIcon />
                        )}
                      </button>
                      {speechState === "recording" && (
                        <button
                          aria-label={t("Отменить запись")}
                          className="composer-action stop"
                          type="button"
                          onClick={cancelRecording}
                        >
                          <XIcon />
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {speechError && (
                  <div className="user-input-speech-error" role="alert">
                    {speechError}
                  </div>
                )}
              </>
            )}
          </fieldset>
          <div className="user-input-actions">
            {currentAnswer && (
              <button
                className="user-input-clear"
                disabled={busy || speechBusy}
                type="button"
                onClick={clearAnswer}
              >
                {t("Очистить ответ")}
              </button>
            )}
            <span className="user-input-navigation">
              {questionIndex > 0 && (
                <button
                  disabled={busy || speechBusy}
                  type="button"
                  onClick={() => navigateTo(questionIndex - 1)}
                >
                  {t("Назад")}
                </button>
              )}
              <button className="primary" disabled={busy || speechBusy}>
                {isLastQuestion ? t("Отправить ответы") : t("Далее")}
              </button>
            </span>
          </div>
          {providerDraft?.error && (
            <div className="user-input-draft-error" role="status">
              {t("Не удалось сохранить черновик. Повторим при следующем изменении.")}
            </div>
          )}
        </>
      )}
    </form>
  );
}

function initialUserInputDraft(
  request: Extract<AttentionRequest, { kind: "userInput" }>,
  draft: { answers: Record<string, string[]>; currentQuestionId: string | null } | null | undefined,
): { answers: Record<string, string[]>; currentQuestionId: string | null } {
  const source = draft ?? request.draft;
  const requestedId = source?.currentQuestionId;
  return {
    answers: Object.fromEntries(
      Object.entries(source?.answers ?? {}).map(([id, values]) => [id, [...values]]),
    ),
    currentQuestionId: request.questions.some((question) => question.id === requestedId)
      ? (requestedId ?? null)
      : (request.questions[0]?.id ?? null),
  };
}

function answeredUserInputValues(answers: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(answers)
      .filter(([, values]) => Boolean(values[0]?.trim()))
      .map(([id, values]) => [id, [values[0]!]]),
  );
}

function Countdown({ deadline }: { deadline: number }) {
  const { t } = useI18n();
  const [seconds, setSeconds] = useState(() =>
    Math.max(0, Math.ceil((deadline - Date.now()) / 1_000)),
  );
  useEffect(() => {
    const timer = window.setInterval(() => {
      setSeconds(Math.max(0, Math.ceil((deadline - Date.now()) / 1_000)));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [deadline]);
  return (
    <div className="timer">
      {seconds > 0
        ? t("Автовыбор через {{seconds}} сек.", { seconds })
        : t("Время автовыбора истекло")}
    </div>
  );
}

function ElicitationForm({
  request,
  busy,
  respond,
}: {
  request: Extract<AttentionRequest, { kind: "elicitation" }>;
  busy: boolean;
  respond(response: AttentionResponse): Promise<void>;
}) {
  const { t } = useI18n();
  const [content, setContent] = useState<Record<string, unknown>>({});
  const [validationError, setValidationError] = useState<string | null>(null);
  if (request.mode === "url") {
    return (
      <>
        <h3>{t("Действие во внешнем сервисе")}</h3>
        <p>{request.message}</p>
        <div className="button-row">
          <button
            className="primary"
            disabled={!request.url}
            onClick={() => request.url && void Browser.open({ url: request.url })}
          >
            {t("Открыть в браузере")}
          </button>
          <button
            className="danger"
            disabled={busy}
            onClick={() => void respond({ kind: "elicitation", action: "decline", content: null })}
          >
            {t("Отказать")}
          </button>
          <button
            disabled={busy}
            onClick={() => void respond({ kind: "elicitation", action: "cancel", content: null })}
          >
            {t("Отменить")}
          </button>
        </div>
      </>
    );
  }
  function submitForm() {
    const message = request.schema ? validateElicitation(request.schema, content, t) : null;
    if (message) {
      setValidationError(message);
      return;
    }
    void respond({ kind: "elicitation", action: "accept", content });
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submitForm();
      }}
    >
      <h3>{t("Форма инструмента")}</h3>
      <p>{request.message}</p>
      {request.schema &&
        Object.entries(request.schema.properties).map(([name, schema]) => (
          <ElicitationField
            key={name}
            name={name}
            schema={schema}
            required={request.schema!.required.includes(name)}
            value={content[name]}
            onChange={(value) => setContent({ ...content, [name]: value })}
          />
        ))}
      {validationError && <div className="error-banner">{validationError}</div>}
      <div className="button-row">
        <button className="primary" disabled={busy}>
          {t("Отправить")}
        </button>
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => void respond({ kind: "elicitation", action: "decline", content: null })}
        >
          {t("Отказать")}
        </button>
      </div>
    </form>
  );
}

function ElicitationField({
  name,
  schema,
  required,
  value,
  onChange,
}: {
  name: string;
  schema: ElicitationPrimitive;
  required: boolean;
  value: unknown;
  onChange(value: unknown): void;
}) {
  const { t } = useI18n();
  const label = schema.title ?? name;
  if (schema.type === "boolean") {
    return (
      <label className="check">
        <input
          type="checkbox"
          checked={Boolean(value ?? schema.default)}
          onChange={(event) => onChange(event.target.checked)}
        />
        {label}
      </label>
    );
  }
  if (schema.type === "array") {
    return (
      <fieldset>
        <legend>{label}</legend>
        {schema.items.enum?.map((option) => (
          <label className="check" key={option}>
            <input
              type="checkbox"
              checked={Array.isArray(value) && value.includes(option)}
              onChange={(event) => {
                const current = Array.isArray(value) ? value : [];
                onChange(
                  event.target.checked
                    ? [...current, option]
                    : current.filter((item) => item !== option),
                );
              }}
            />
            {option}
          </label>
        ))}
      </fieldset>
    );
  }
  if (schema.type === "string" && schema.enum) {
    return (
      <label>
        {label}
        <select
          required={required}
          value={String(value ?? schema.default ?? "")}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{t("Выберите")}</option>
          {schema.enum.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label>
      {label}
      <input
        type={
          schema.type === "string" ? (schema.format === "password" ? "password" : "text") : "number"
        }
        required={required}
        min={"minimum" in schema ? schema.minimum : undefined}
        max={"maximum" in schema ? schema.maximum : undefined}
        minLength={"minLength" in schema ? schema.minLength : undefined}
        maxLength={"maxLength" in schema ? schema.maxLength : undefined}
        value={String(value ?? schema.default ?? "")}
        onChange={(event) =>
          onChange(schema.type === "string" ? event.target.value : Number(event.target.value))
        }
      />
    </label>
  );
}

function validateElicitation(
  schema: NonNullable<Extract<AttentionRequest, { kind: "elicitation" }>["schema"]>,
  content: Record<string, unknown>,
  t: Translate,
): string | null {
  for (const name of schema.required) {
    const field = schema.properties[name];
    const value = content[name] ?? (field ? elicitationDefault(field) : undefined);
    if (value === undefined || value === "" || (Array.isArray(value) && !value.length)) {
      return t("Заполните обязательное поле «{{field}}»", {
        field: schema.properties[name]?.title ?? name,
      });
    }
  }
  for (const [name, field] of Object.entries(schema.properties)) {
    const value = content[name] ?? elicitationDefault(field);
    if (field.type === "array" && Array.isArray(value)) {
      if (field.minItems !== undefined && value.length < field.minItems)
        return t("Выберите больше значений в поле «{{field}}»", {
          field: field.title ?? name,
        });
      if (field.maxItems !== undefined && value.length > field.maxItems)
        return t("Выберите меньше значений в поле «{{field}}»", {
          field: field.title ?? name,
        });
    }
  }
  return null;
}

function elicitationDefault(field: ElicitationPrimitive): unknown {
  return "default" in field ? field.default : undefined;
}
