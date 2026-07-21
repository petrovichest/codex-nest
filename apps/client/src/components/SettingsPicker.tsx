import type {
  ApprovalPolicy,
  ModelOption,
  SandboxMode,
  SessionSettings,
} from "@codexnest/protocol";

import { ChevronDownIcon, SlidersIcon } from "./Icons";

export function SettingsPicker({
  models,
  value,
  onChange,
}: {
  models: ModelOption[];
  value: SessionSettings;
  onChange(value: SessionSettings): void;
}) {
  const model = models.find((candidate) => candidate.id === value.model);
  const summary = [model?.displayName ?? "Модель по умолчанию", value.reasoningEffort]
    .filter(Boolean)
    .join(" · ");
  return (
    <details className="settings-picker">
      <summary>
        <SlidersIcon />
        <span>{summary}</span>
        <ChevronDownIcon className="settings-chevron" />
      </summary>
      <div className="settings-grid">
        <label>
          Модель
          <select
            value={value.model ?? ""}
            onChange={(event) => patch("model", event.target.value || undefined)}
          >
            <option value="">По умолчанию сервера</option>
            {models.map((option) => (
              <option value={option.id} key={option.id}>
                {option.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Reasoning
          <select
            value={value.reasoningEffort ?? ""}
            onChange={(event) => patch("reasoningEffort", event.target.value || undefined)}
          >
            <option value="">По умолчанию</option>
            {model?.reasoningEfforts.map((option) => (
              <option value={option.value} key={option.value}>
                {option.value}
              </option>
            ))}
          </select>
        </label>
        <label>
          Service tier
          <select
            value={value.serviceTier ?? ""}
            onChange={(event) => patch("serviceTier", event.target.value || undefined)}
          >
            <option value="">По умолчанию</option>
            {model?.serviceTiers.map((tier) => (
              <option value={tier.id} key={tier.id}>
                {tier.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sandbox
          <select
            value={value.sandboxMode ?? ""}
            onChange={(event) =>
              patch("sandboxMode", (event.target.value || undefined) as SandboxMode | undefined)
            }
          >
            <option value="">По умолчанию</option>
            <option value="read-only">Только чтение</option>
            <option value="workspace-write">Запись в workspace</option>
            <option value="danger-full-access">Полный доступ</option>
          </select>
        </label>
        <label>
          Approvals
          <select
            value={value.approvalPolicy ?? ""}
            onChange={(event) =>
              patch(
                "approvalPolicy",
                (event.target.value || undefined) as ApprovalPolicy | undefined,
              )
            }
          >
            <option value="">По умолчанию</option>
            <option value="untrusted">Для недоверенных команд</option>
            <option value="on-request">По запросу</option>
            <option value="granular">Все типы запросов отдельно</option>
            <option value="never">Не запрашивать</option>
          </select>
        </label>
        {model?.supportsPersonality && (
          <label>
            Personality
            <select
              value={value.personality ?? ""}
              onChange={(event) => patch("personality", event.target.value || undefined)}
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
  );

  function patch<K extends keyof SessionSettings>(key: K, child: SessionSettings[K]) {
    const next = { ...value, [key]: child };
    if (child === undefined) delete next[key];
    onChange(next);
  }
}
