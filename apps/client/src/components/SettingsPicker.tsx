import type {
  ModelOption,
  SessionSettings,
  UpdateThreadSettingsRequest,
} from "@codexnest/protocol";

import { BrainIcon, ChevronDownIcon, ModelIcon, PlanIcon, SlidersIcon } from "./Icons";

export function SettingsPicker({
  models,
  value,
  disabled,
  onChange,
}: {
  models: ModelOption[];
  value: SessionSettings;
  disabled: boolean;
  onChange(value: UpdateThreadSettingsRequest): void;
}) {
  const model = effectiveModel(models, value.model);

  return (
    <>
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
        disabled={disabled || !model}
        type="button"
        onClick={() =>
          onChange({
            collaborationMode: value.collaborationMode === "plan" ? "default" : "plan",
          })
        }
      >
        <PlanIcon />
        <span>План</span>
      </button>

      <details className="settings-picker" data-dismiss-on-outside-click>
        <summary
          aria-disabled={disabled}
          aria-label="Дополнительные настройки"
          className="setting-control"
          onClick={(event) => {
            if (disabled) event.preventDefault();
          }}
        >
          <SlidersIcon />
          <span>Ещё</span>
          <ChevronDownIcon className="settings-chevron" />
        </summary>
        <div className="settings-grid">
          <label>
            Service tier
            <select
              disabled={disabled || !model}
              value={value.serviceTier ?? ""}
              onChange={(event) => onChange({ serviceTier: event.target.value || null })}
            >
              <option value="">По умолчанию</option>
              {model?.serviceTiers.map((tier) => (
                <option value={tier.id} key={tier.id}>
                  {tier.displayName}
                </option>
              ))}
            </select>
          </label>
          {model?.supportsPersonality && (
            <label>
              Personality
              <select
                disabled={disabled}
                value={value.personality ?? ""}
                onChange={(event) => onChange({ personality: event.target.value || null })}
              >
                <option value="">По умолчанию</option>
                <option value="friendly">Дружелюбная</option>
                <option value="pragmatic">Прагматичная</option>
                <option value="none">Без personality</option>
              </select>
            </label>
          )}
        </div>
      </details>
    </>
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

function SettingSelect({
  ariaLabel,
  icon,
  children,
  ...props
}: {
  ariaLabel: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  disabled: boolean;
  value: string;
  onChange(value: string): void;
}) {
  return (
    <label className="setting-control setting-select">
      {icon}
      <select
        aria-label={ariaLabel}
        disabled={props.disabled}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      >
        {children}
      </select>
      <ChevronDownIcon className="setting-select-chevron" />
    </label>
  );
}

function effectiveModel(models: ModelOption[], modelId?: string): ModelOption | undefined {
  if (modelId) return models.find((model) => model.id === modelId);
  return models.find((model) => model.isDefault) ?? models[0];
}
