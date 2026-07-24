import type {
  AgentId,
  ModelOption,
  PermissionPreset,
  SessionSettings,
  ThreadGoal,
  UpdateThreadGoalRequest,
  UpdateThreadSettingsRequest,
} from "@codexnest/protocol";

import { useI18n, type Translate } from "../i18n";
import { BrainIcon, ModelIcon, PlanIcon, ShieldIcon, TargetIcon } from "./Icons";

const PERMISSION_PRESET_LABELS: Record<PermissionPreset, string> = {
  ask: "Спрашивать",
  auto: "Авто",
  "full-access": "Полный доступ",
};

export function SettingsPicker({
  agent,
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
  agent: AgentId;
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
  // Goals and the service-tier/personality knobs are Codex-only; Claude exposes a per-session
  // permission preset instead. The plan (collaborationMode) toggle stays for both agents.
  const isClaude = agent === "claude";
  const modelDisplayName = model ? compactModelName(model.displayName) : t("Модель");

  return (
    <div className="settings-picker">
      <SettingSelect
        ariaLabel={t("Модель")}
        disabled={disabled || models.length === 0}
        displayValue={modelDisplayName}
        icon={<ModelIcon />}
        value={value.model ?? ""}
        onChange={(selected) => changeModel(selected || null)}
      >
        <option value="">
          {t("По умолчанию")} · {modelDisplayName}
        </option>
        {models.map((option) => (
          <option value={option.id} key={option.id}>
            {compactModelName(option.displayName)}
          </option>
        ))}
      </SettingSelect>

      <SettingSelect
        ariaLabel={t("Уровень рассуждений")}
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

      {isClaude && (
        <SettingSelect
          ariaLabel={t("Режим разрешений")}
          disabled={disabled}
          icon={<ShieldIcon />}
          value={value.permissionPreset ?? "ask"}
          onChange={(selected) => onChange({ permissionPreset: selected as PermissionPreset })}
        >
          {(Object.keys(PERMISSION_PRESET_LABELS) as PermissionPreset[]).map((preset) => (
            <option value={preset} key={preset}>
              {t(PERMISSION_PRESET_LABELS[preset])}
            </option>
          ))}
        </SettingSelect>
      )}

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

      {!isClaude &&
        (goal ? (
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
              if (next && value.collaborationMode === "plan") {
                onChange({ collaborationMode: "default" });
              }
              onGoalModeChange?.(next);
            }}
          >
            <TargetIcon />
          </button>
        ))}
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

function SettingSelect({
  ariaLabel,
  displayValue,
  icon,
  iconOnly = false,
  children,
  ...props
}: {
  ariaLabel: string;
  displayValue?: string;
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
      {!iconOnly && <span className="setting-select-value">{displayValue}</span>}
      <select
        aria-label={ariaLabel}
        disabled={props.disabled}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      >
        {children}
      </select>
    </label>
  );
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
