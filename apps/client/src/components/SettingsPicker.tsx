import type {
  ModelOption,
  SessionSettings,
  ThreadGoal,
  UpdateThreadGoalRequest,
  UpdateThreadSettingsRequest,
} from "@codexnest/protocol";

import { BrainIcon, ChevronDownIcon, ModelIcon, PlanIcon, TargetIcon } from "./Icons";

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
  const model = effectiveModel(models, value.model);

  return (
    <div className="settings-picker">
      <SettingSelect
        ariaLabel="Модель"
        disabled={disabled || models.length === 0}
        icon={<ModelIcon />}
        value={value.model ?? ""}
        onChange={(selected) => changeModel(selected || null)}
      >
        <option value="">{model?.displayName ?? "Модель"}</option>
        {models.map((option) => (
          <option value={option.id} key={option.id}>
            {option.displayName}
          </option>
        ))}
      </SettingSelect>

      <SettingSelect
        ariaLabel="Уровень рассуждений"
        disabled={disabled || !model}
        icon={<BrainIcon />}
        iconOnly
        value={value.reasoningEffort ?? ""}
        onChange={(selected) => onChange({ reasoningEffort: selected || null })}
      >
        <option value="">Reasoning</option>
        {model?.reasoningEfforts.map((option) => (
          <option value={option.value} key={option.value}>
            {option.value}
          </option>
        ))}
      </SettingSelect>

      <button
        aria-label={
          value.collaborationMode === "plan"
            ? "Выключить режим планирования"
            : "Включить режим планирования"
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

      {goal ? (
        <details className="goal-picker" data-dismiss-on-outside-click>
          <summary className="setting-control goal-toggle active" aria-label="Управление целью">
            <TargetIcon />
          </summary>
          <div className="goal-popover">
            <div className="goal-popover-heading">
              <strong>{goalStatusLabel(goal.status)}</strong>
              <span>{formatGoalUsage(goal)}</span>
            </div>
            <p>{goal.objective}</p>
            <div className="goal-popover-actions">
              {goal.status === "active" && (
                <button
                  type="button"
                  disabled={goalBusy}
                  onClick={() => onGoalUpdate?.({ status: "paused" })}
                >
                  Пауза
                </button>
              )}
              {["paused", "blocked"].includes(goal.status) && (
                <button
                  type="button"
                  disabled={goalBusy}
                  onClick={() => onGoalUpdate?.({ status: "active" })}
                >
                  Продолжить
                </button>
              )}
              <button type="button" disabled={goalBusy} onClick={onGoalClear}>
                Очистить
              </button>
            </div>
          </div>
        </details>
      ) : (
        <button
          aria-label={goalMode ? "Выключить режим цели" : "Включить режим цели"}
          aria-pressed={goalMode}
          className={`setting-control goal-toggle${goalMode ? " active" : ""}`}
          disabled={disabled || !model}
          type="button"
          onClick={() => {
            const next = !goalMode;
            if (next && value.collaborationMode === "plan") {
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

function goalStatusLabel(status: ThreadGoal["status"]): string {
  const labels: Record<ThreadGoal["status"], string> = {
    active: "Цель активна",
    paused: "Цель на паузе",
    blocked: "Цель заблокирована",
    usageLimited: "Достигнут лимит использования",
    budgetLimited: "Достигнут бюджет цели",
    complete: "Цель выполнена",
  };
  return labels[status];
}

function formatGoalUsage(goal: ThreadGoal): string {
  const minutes = Math.floor(goal.timeUsedSeconds / 60);
  const seconds = goal.timeUsedSeconds % 60;
  const time = minutes ? `${minutes}м ${seconds}с` : `${seconds}с`;
  return `${goal.tokensUsed.toLocaleString()} токенов · ${time}`;
}

function SettingSelect({
  ariaLabel,
  icon,
  iconOnly = false,
  children,
  ...props
}: {
  ariaLabel: string;
  icon: React.ReactNode;
  iconOnly?: boolean;
  children: React.ReactNode;
  disabled: boolean;
  value: string;
  onChange(value: string): void;
}) {
  return (
    <label className={`setting-control setting-select${iconOnly ? " icon-only" : ""}`}>
      {icon}
      <select
        aria-label={ariaLabel}
        disabled={props.disabled}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      >
        {children}
      </select>
      {!iconOnly && <ChevronDownIcon className="setting-select-chevron" />}
    </label>
  );
}

function effectiveModel(models: ModelOption[], modelId?: string): ModelOption | undefined {
  if (modelId) return models.find((model) => model.id === modelId);
  return models.find((model) => model.isDefault) ?? models[0];
}
