import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import {
  isFontSize,
  resetTypography,
  setTypographySize,
  TYPOGRAPHY_DEFAULTS,
  TYPOGRAPHY_MAX,
  TYPOGRAPHY_MIN,
  TYPOGRAPHY_ROLES,
  useTypography,
  type TypographyRole,
  type TypographySettings as FontSizes,
} from "../typography";
import { RefreshIcon, SlidersIcon } from "./Icons";
import { SettingsGroup, SettingsRow } from "./SettingsPresentation";

export function TypographySettings() {
  const { t } = useI18n();
  const sizes = useTypography();
  return (
    <SettingsGroup
      title={t("Шрифты")}
      icon={<SlidersIcon />}
      className="typography-settings"
      description={t(
        "Каждый размер настраивается отдельно. Изменения видны сразу и сохраняются на этом устройстве.",
      )}
    >
      {(Object.keys(TYPOGRAPHY_ROLES) as TypographyRole[]).map((role) => (
        <FontSizeRow key={role} role={role} sizes={sizes} />
      ))}
      <div className="typography-reset">
        <button type="button" onClick={resetTypography}>
          {t("Вернуть стандартные размеры")}
        </button>
      </div>
    </SettingsGroup>
  );
}

function FontSizeRow({ role, sizes }: { role: TypographyRole; sizes: FontSizes }) {
  const { t } = useI18n();
  const definition = TYPOGRAPHY_ROLES[role];
  const label = t(definition.label);
  const size = sizes[role];
  const [draft, setDraft] = useState(String(size));
  useEffect(() => {
    setDraft(String(sizes[role]));
  }, [role, sizes]);
  const restore = () => setDraft(String(size));
  return (
    <SettingsRow
      label={label}
      labelFor={`font-size-${role}`}
      className="typography-row"
      description={
        <span
          className="typography-example"
          data-font-role={role}
          style={{ fontSize: `var(${definition.token})` }}
        >
          {t(definition.example)}
        </span>
      }
    >
      <div className="typography-size-control">
        <input
          id={`font-size-${role}`}
          type="number"
          inputMode="numeric"
          min={TYPOGRAPHY_MIN}
          max={TYPOGRAPHY_MAX}
          step={1}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            const next = event.target.valueAsNumber;
            if (isFontSize(next)) setTypographySize(role, next);
          }}
          onBlur={restore}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === "Escape") {
              event.preventDefault();
              restore();
            }
          }}
        />
        <span className="typography-unit" aria-hidden="true">
          px
        </span>
        <button
          type="button"
          className="icon-button"
          aria-label={t("Сбросить размер: {{name}}", { name: label })}
          title={t("Стандартный размер: {{size}} px", { size: TYPOGRAPHY_DEFAULTS[role] })}
          onClick={() => {
            setTypographySize(role, TYPOGRAPHY_DEFAULTS[role]);
            setDraft(String(TYPOGRAPHY_DEFAULTS[role]));
          }}
        >
          <RefreshIcon />
        </button>
      </div>
    </SettingsRow>
  );
}
