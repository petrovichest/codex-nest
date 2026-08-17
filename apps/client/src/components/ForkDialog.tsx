import { useEffect, useRef, useState, type RefObject } from "react";

import { useConnection } from "../connection";
import {
  type ForkEstimateResponse,
  type ForkMode,
  type ForkModeEstimate,
  type ForkOperationSummary,
} from "../forks";
import { localizeKnownServerText, useI18n, type Translate } from "../i18n";
import { CheckIcon, GitBranchIcon, XIcon } from "./Icons";
import { Dialog } from "./Dialog";

const UNKNOWN_EXACT: ForkModeEstimate = {
  available: true,
  estimatedBytes: null,
  estimatedSeconds: null,
  unavailableReason: null,
};

export function ForkDialog({
  sourceThreadId,
  sourceTitle,
  lastTurnId,
  agentMessageId,
  openerRef,
  onClose,
  onCreated,
}: {
  sourceThreadId: string;
  sourceTitle: string;
  lastTurnId: string;
  agentMessageId: string;
  openerRef?: RefObject<HTMLElement | null>;
  onClose(): void;
  onCreated(operation: ForkOperationSummary): void;
}) {
  const { api } = useConnection();
  const { language, t } = useI18n();
  const operationIdRef = useRef(createOperationId());
  const submittingRef = useRef(false);
  const [estimate, setEstimate] = useState<ForkEstimateResponse | null>(null);
  const [estimateFailed, setEstimateFailed] = useState(false);
  const [mode, setMode] = useState<ForkMode | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api
      .estimateFork(sourceThreadId, { lastTurnId, agentMessageId })
      .then((response) => {
        if (!active) return;
        setEstimate(response);
        setMode(
          response.compressed.available ? "compressed" : response.exact.available ? "exact" : null,
        );
      })
      .catch(() => {
        if (!active) return;
        setEstimateFailed(true);
        setMode("exact");
      });
    return () => {
      active = false;
    };
  }, [agentMessageId, api, lastTurnId, sourceThreadId]);

  const compressed = estimate?.compressed ?? {
    ...UNKNOWN_EXACT,
    available: false,
    unavailableReason: estimateFailed
      ? t("Не удалось рассчитать сжатую ветку. Точная копия всё ещё доступна.")
      : null,
  };
  const exact = estimate?.exact ?? UNKNOWN_EXACT;
  const selectedEstimate = mode === "compressed" ? compressed : mode === "exact" ? exact : null;

  function close() {
    if (!submittingRef.current) onClose();
  }

  async function create() {
    if (!mode || !selectedEstimate?.available || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const { operation } = await api.createForkOperation(sourceThreadId, {
        operationId: operationIdRef.current,
        lastTurnId,
        agentMessageId,
        mode,
      });
      onCreated(operation);
    } catch (caught) {
      submittingRef.current = false;
      setSubmitting(false);
      setError(
        caught instanceof Error
          ? (localizeKnownServerText(language, caught.message) ?? caught.message)
          : t("Не удалось начать создание ответвления"),
      );
    }
  }

  return (
    <Dialog
      titleId="fork-dialog-title"
      className="fork-dialog"
      backdropClassName="fork-dialog-backdrop"
      closeOnBackdrop={!submitting}
      closeOnEscape={!submitting}
      returnFocusRef={openerRef}
      onClose={close}
    >
      <div className="dialog-header fork-dialog-header">
        <div className="dialog-heading">
          <span className="dialog-eyebrow">{t("Новое ответвление")}</span>
          <h2 id="fork-dialog-title">{t("Как перенести контекст?")}</h2>
          <p>{t("Выберите баланс между скоростью и буквальной точностью истории.")}</p>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label={t("Закрыть")}
          disabled={submitting}
          onClick={close}
        >
          <XIcon />
        </button>
      </div>

      <div className="fork-source-summary">
        <span className="fork-source-icon" aria-hidden="true">
          <GitBranchIcon />
        </span>
        <span className="fork-source-copy">
          <strong>{sourceTitle}</strong>
          <small>
            {estimate || estimateFailed
              ? t("Исходный контекст · {{size}}", {
                  size: estimate
                    ? formatForkBytes(estimate.sourceBytes, language, t)
                    : t("размер неизвестен"),
                })
              : t("Считаем…")}
          </small>
        </span>
      </div>

      <div className="fork-choice-rail" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div
        className="fork-mode-options"
        role="radiogroup"
        aria-label={t("Способ переноса контекста")}
      >
        <ForkModeCard
          mode="compressed"
          title={t("Сжатая")}
          badge={t("Рекомендуем")}
          description={t(
            "Переносит смысл и решения в компактном контексте без выдуманных сообщений.",
          )}
          estimate={compressed}
          loading={!estimate && !estimateFailed}
          checked={mode === "compressed"}
          onChange={setMode}
          t={t}
          language={language}
        />
        <ForkModeCard
          mode="exact"
          title={t("Точная")}
          description={t(
            "Копирует доступную историю буквально. Для большой сессии это займёт больше времени и места.",
          )}
          estimate={exact}
          loading={!estimate && !estimateFailed}
          checked={mode === "exact"}
          onChange={setMode}
          t={t}
          language={language}
        />
      </div>

      {error && (
        <div className="dialog-notice danger" role="alert">
          {error}
        </div>
      )}
      <div className="dialog-actions fork-dialog-actions">
        <button type="button" disabled={submitting} onClick={close}>
          {t("Отмена")}
        </button>
        <button
          type="button"
          className="primary"
          disabled={!mode || !selectedEstimate?.available || submitting}
          aria-busy={submitting || undefined}
          onClick={() => void create()}
        >
          {submitting ? t("Создаём…") : t("Создать ответвление")}
        </button>
      </div>
    </Dialog>
  );
}

function ForkModeCard({
  mode,
  title,
  badge,
  description,
  estimate,
  loading,
  checked,
  onChange,
  t,
  language,
}: {
  mode: ForkMode;
  title: string;
  badge?: string;
  description: string;
  estimate: ForkModeEstimate;
  loading: boolean;
  checked: boolean;
  onChange(mode: ForkMode): void;
  t: Translate;
  language: "ru" | "en";
}) {
  const unavailable = !estimate.available;
  return (
    <label
      className={`fork-mode-card${checked ? " selected" : ""}${unavailable ? " unavailable" : ""}`}
    >
      <input
        type="radio"
        name="fork-mode"
        value={mode}
        checked={checked}
        disabled={unavailable}
        onChange={() => onChange(mode)}
      />
      <span className="fork-mode-heading">
        <strong>{title}</strong>
        {badge && estimate.available && (
          <span className="fork-mode-badge">
            <CheckIcon />
            {badge}
          </span>
        )}
      </span>
      <span className="fork-mode-description">{description}</span>
      <span className="fork-mode-metrics">
        {loading ? (
          <span>{t("Считаем…")}</span>
        ) : unavailable ? (
          <span className="fork-mode-unavailable">
            {estimate.unavailableReason || t("Этот способ сейчас недоступен")}
          </span>
        ) : (
          <>
            <span>
              <small>{t("Объём")}</small>
              {formatForkBytes(estimate.estimatedBytes, language, t)}
            </span>
            <span>
              <small>{t("Время")}</small>
              {formatForkTime(estimate.estimatedSeconds, t)}
            </span>
          </>
        )}
      </span>
    </label>
  );
}

export function formatForkBytes(bytes: number | null, language: "ru" | "en", t: Translate): string {
  if (bytes === null) return t("неизвестно");
  const units = [t("Б"), t("КБ"), t("МБ"), t("ГБ")];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${new Intl.NumberFormat(language === "ru" ? "ru-RU" : "en-US", {
    maximumFractionDigits: unit === 0 ? 0 : value < 10 ? 1 : 0,
  }).format(value)} ${units[unit]}`;
}

export function formatForkTime(value: ForkModeEstimate["estimatedSeconds"], t: Translate): string {
  if (!value) return t("неизвестно");
  const compact = (seconds: number) =>
    seconds < 60
      ? t("{{count}} с", { count: seconds })
      : t("{{count}} мин", { count: Math.ceil(seconds / 60) });
  return value.minSeconds === value.maxSeconds
    ? `≈ ${compact(value.minSeconds)}`
    : `≈ ${compact(value.minSeconds)}–${compact(value.maxSeconds)}`;
}

function createOperationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}
