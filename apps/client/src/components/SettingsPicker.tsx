import type {
  ModelOption,
  SessionSettings,
  ThreadGoal,
  UpdateThreadGoalRequest,
  UpdateThreadSettingsRequest,
} from "@codexnest/protocol";

import { useI18n, type Translate } from "../i18n";
import { ModelIcon, PlanIcon, TargetIcon, TeamIcon } from "./Icons";

export function SettingsPicker({
  models,
  value,
  disabled,
  onChange,
  goalMode,
  goal,
  goalBusy = false,
  onGoalModeChange,
  onGoalUpdate,
  onGoalClear,
}: {
  models: ModelOption[];
  value: SessionSettings;
  disabled: boolean;
  onChange(value: UpdateThreadSettingsRequest): void;
  goalMode: boolean;
  goal?: ThreadGoal | null;
  goalBusy?: boolean;
  onGoalModeChange?(value: boolean): void;
  onGoalUpdate?(value: UpdateThreadGoalRequest): void;
  onGoalClear?(): void;
}) {
  const { language, t } = useI18n();
  const model = effectiveModel(models, value.model);
  const modelDisplayName = model ? compactModelName(model.displayName) : t("Модель");
  const defaultEffort = model?.reasoningEfforts.find((option) => option.isDefault)?.value;
  const effortDisplayName = value.reasoningEffort ?? defaultEffort ?? t("По умолчанию");

  return (
    <div className="settings-picker">
      <details className="model-picker" data-dismiss-on-outside-click>
        <summary
          aria-label={t("Модель и уровень рассуждений")}
          className={`setting-control model-toggle${disabled || !models.length ? " disabled" : ""}`}
          title={`${modelDisplayName} · ${effortDisplayName}`}
          onClick={(event) => {
            if (disabled || !models.length) event.preventDefault();
          }}
        >
          <ModelIcon />
          <span>{modelDisplayName}</span>
        </summary>
        <div className="model-popover">
          <label>
            <span>{t("Модель")}</span>
            <select
              aria-label={t("Модель")}
              disabled={disabled || models.length === 0}
              value={value.model ?? ""}
              onChange={(event) => changeModel(event.target.value || null)}
            >
              <option value="">
                {t("По умолчанию")} · {modelDisplayName}
              </option>
              {models.map((option) => (
                <option value={option.id} key={option.id}>
                  {option.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("Уровень рассуждений")}</span>
            <select
              aria-label={t("Уровень рассуждений")}
              disabled={disabled || !model}
              value={value.reasoningEffort ?? ""}
              onChange={(event) => onChange({ reasoningEffort: event.target.value || null })}
            >
              <option value="">
                {t("По умолчанию")}
                {defaultEffort ? ` · ${defaultEffort}` : ""}
              </option>
              {model?.reasoningEfforts.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.value}
                </option>
              ))}
            </select>
          </label>
        </div>
      </details>

      <button
        aria-label={
          value.collaborationMode === "plan"
            ? t("Выключить режим планирования")
            : t("Включить режим планирования")
        }
        aria-pressed={value.collaborationMode === "plan"}
        className={`setting-control plan-toggle${value.collaborationMode === "plan" ? " active" : ""}`}
        disabled={disabled || !model || Boolean(goal)}
        type="button"
        onClick={() => {
          onGoalModeChange?.(false);
          onChange({
            collaborationMode: value.collaborationMode === "plan" ? "default" : "plan",
          });
        }}
      >
        <PlanIcon />
      </button>

      <button
        aria-label={
          value.collaborationMode === "team"
            ? t("Выключить командный режим")
            : t("Включить командный режим")
        }
        aria-pressed={value.collaborationMode === "team"}
        className={`setting-control team-toggle${value.collaborationMode === "team" ? " active" : ""}`}
        disabled={disabled || !model || Boolean(goal)}
        type="button"
        onClick={() => {
          onGoalModeChange?.(false);
          onChange({
            collaborationMode: value.collaborationMode === "team" ? "default" : "team",
          });
        }}
      >
        <TeamIcon />
      </button>

      {goal ? (
        <details className="goal-picker" data-dismiss-on-outside-click>
          <summary
            className="setting-control goal-toggle active"
            aria-label={t("Управление целью")}
          >
            <TargetIcon />
          </summary>
          <div className="goal-popover">
            <div className="goal-popover-heading">
              <strong>{goalStatusLabel(goal.status, t)}</strong>
              <span>{formatGoalUsage(goal, language, t)}</span>
            </div>
            <p>{goal.objective}</p>
            <div className="goal-popover-actions">
              {goal.status === "active" && (
                <button
                  type="button"
                  disabled={goalBusy}
                  onClick={() => onGoalUpdate?.({ status: "paused" })}
                >
                  {t("Пауза")}
                </button>
              )}
              {["paused", "blocked"].includes(goal.status) && (
                <button
                  type="button"
                  disabled={goalBusy}
                  onClick={() => onGoalUpdate?.({ status: "active" })}
                >
                  {t("Продолжить")}
                </button>
              )}
              <button type="button" disabled={goalBusy} onClick={onGoalClear}>
                {t("Очистить")}
              </button>
            </div>
          </div>
        </details>
      ) : (
        <button
          aria-label={goalMode ? t("Выключить режим цели") : t("Включить режим цели")}
          aria-pressed={goalMode}
          className={`setting-control goal-toggle${goalMode ? " active" : ""}`}
          disabled={disabled || !model}
          type="button"
          onClick={() => {
            const next = !goalMode;
            if (next && value.collaborationMode !== "default") {
              onChange({ collaborationMode: "default" });
            }
            onGoalModeChange?.(next);
          }}
        >
          <TargetIcon />
        </button>
      )}
    </div>
  );

  function changeModel(modelId: string | null) {
    const nextModel = effectiveModel(models, modelId ?? undefined);
    const patch: UpdateThreadSettingsRequest = { model: modelId };
    if (
      value.reasoningEffort &&
      !nextModel?.reasoningEfforts.some((option) => option.value === value.reasoningEffort)
    ) {
      patch.reasoningEffort =
        nextModel?.reasoningEfforts.find((option) => option.isDefault)?.value ?? null;
    }
    if (
      value.serviceTier &&
      !nextModel?.serviceTiers.some((option) => option.id === value.serviceTier)
    ) {
      patch.serviceTier = null;
    }
    if (value.personality && !nextModel?.supportsPersonality) patch.personality = null;
    onChange(patch);
  }
}

function goalStatusLabel(status: ThreadGoal["status"], t: Translate): string {
  const labels: Record<ThreadGoal["status"], string> = {
    active: "Цель активна",
    paused: "Цель на паузе",
    blocked: "Цель заблокирована",
    usageLimited: "Достигнут лимит использования",
    budgetLimited: "Достигнут бюджет цели",
    complete: "Цель выполнена",
  };
  return t(labels[status]);
}

function formatGoalUsage(goal: ThreadGoal, language: "en" | "ru", t: Translate): string {
  const minutes = Math.floor(goal.timeUsedSeconds / 60);
  const seconds = goal.timeUsedSeconds % 60;
  const time = minutes
    ? t("{{count}}м {{seconds}}с", { count: minutes, seconds })
    : t("{{count}}с", { count: seconds });
  const modulo100 = goal.tokensUsed % 100;
  const modulo10 = goal.tokensUsed % 10;
  const tokenLabel =
    language === "en"
      ? goal.tokensUsed === 1
        ? "{{count}} токен"
        : "{{count}} токенов"
      : modulo100 >= 11 && modulo100 <= 14
        ? "{{count}} токенов"
        : modulo10 === 1
          ? "{{count}} токен"
          : modulo10 >= 2 && modulo10 <= 4
            ? "{{count}} токена"
            : "{{count}} токенов";
  return `${t(tokenLabel, { count: goal.tokensUsed.toLocaleString(language) })} · ${time}`;
}

function effectiveModel(models: ModelOption[], modelId?: string): ModelOption | undefined {
  if (modelId) return models.find((model) => model.id === modelId);
  return models.find((model) => model.isDefault) ?? models[0];
}

function compactModelName(displayName: string): string {
  const match = /^gpt-([0-9]+(?:\.[0-9]+)*)(?:-(.+))?$/i.exec(displayName.trim());
  if (!match) return displayName;
  const [, version, variant] = match;
  return variant ? `${version}${variant.replaceAll("-", "").toLowerCase()}` : version;
}
