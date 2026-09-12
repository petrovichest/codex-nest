import type { CodexRateLimitsResponse } from "@codexnest/protocol";
import { useI18n } from "../i18n";
import { Dialog } from "./Dialog";
import { XIcon } from "./Icons";

export function RateLimitsDialog({
  limits,
  loading,
  error,
  updatedAt,
  onRefresh,
  onClose,
}: {
  limits: CodexRateLimitsResponse | null;
  loading: boolean;
  error: boolean;
  updatedAt: number | null;
  onRefresh(): void;
  onClose(): void;
}) {
  const { language, t } = useI18n();
  const unknown = t("Не сообщено");
  const status = (value: boolean | null | undefined) =>
    value == null ? unknown : value ? t("Да") : t("Нет");
  const formatDate = (value: number) =>
    new Date(value).toLocaleString(language, { dateStyle: "medium", timeStyle: "long" });
  return (
    <Dialog
      titleId="rate-limits-title"
      className="rate-limits-dialog"
      closeOnBackdrop
      closeOnEscape
      onClose={onClose}
    >
      <div className="dialog-header">
        <h2 id="rate-limits-title">{t("Лимиты Codex")}</h2>
        <button className="icon-button" type="button" aria-label={t("Закрыть")} onClick={onClose}>
          <XIcon />
        </button>
      </div>
      {error && (
        <p role="alert">
          {limits
            ? t("Не удалось обновить. Ниже — последние полученные данные, они могут устареть.")
            : t("Не удалось получить лимиты")}
        </p>
      )}
      <div className="rate-limit-windows">
        {(["primary", "secondary"] as const).map((key) => {
          const window = limits?.[key];
          return (
            <section key={key}>
              <h3>{key === "primary" ? t("Основное окно") : t("Дополнительное окно")}</h3>
              <dl className="rate-limit-facts">
                <dt>{t("Осталось")}</dt>
                <dd>
                  {window ? `${Math.max(0, Math.min(100, 100 - window.usedPercent))}%` : unknown}
                </dd>
                <dt>{t("Длительность")}</dt>
                <dd>
                  {window?.windowDurationMins != null
                    ? t("{{count}} мин", { count: window.windowDurationMins })
                    : unknown}
                </dd>
                <dt>{t("Сброс окна")}</dt>
                <dd>{window?.resetsAt != null ? formatDate(window.resetsAt) : unknown}</dd>
              </dl>
            </section>
          );
        })}
      </div>
      <dl className="rate-limit-facts">
        <dt>{t("Обычное использование разрешено")}</dt>
        <dd>{status(limits?.ordinaryUsageAllowed)}</dd>
        <dt>{t("Порог расходов достигнут")}</dt>
        <dd>{status(limits?.spendControlReached)}</dd>
        <dt>{t("Причина ограничения")}</dt>
        <dd>{limits?.rateLimitReachedType ?? unknown}</dd>
      </dl>
      <p className="search-context">
        {t(
          "Процент и время сброса не гарантируют доступность. Codex сообщает ограничения отдельно.",
        )}
      </p>
      {updatedAt !== null && (
        <p className="search-context">{t("Получено: {{date}}", { date: formatDate(updatedAt) })}</p>
      )}
      <div className="dialog-actions">
        <button type="button" disabled={loading} aria-busy={loading} onClick={onRefresh}>
          {loading ? t("Обновляем…") : t("Обновить")}
        </button>
      </div>
    </Dialog>
  );
}
