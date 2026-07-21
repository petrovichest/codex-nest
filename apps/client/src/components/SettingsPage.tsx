import { type FormEvent, useCallback, useEffect, useState } from "react";

import type { GlobalPermissionSettings, PermissionPreset } from "@codexnest/protocol";

import { ApiClientError } from "../api";
import { useConnection } from "../connection";
import { ShieldIcon } from "./Icons";
import { WorkspaceHeader } from "./WorkspaceHeader";

const PRESETS: Array<{
  id: PermissionPreset;
  title: string;
  description: string;
}> = [
  {
    id: "ask",
    title: "Запрашивать разрешение",
    description: "Codex работает в проекте и спрашивает вас перед расширением доступа.",
  },
  {
    id: "auto",
    title: "Подтверждать автоматически",
    description: "Потенциально опасные действия проверяет отдельный reviewer Codex.",
  },
  {
    id: "full-access",
    title: "Полный доступ",
    description: "Неограниченный доступ к интернету и любым файлам пользователя на сервере.",
  },
];

export function SettingsPage({ onOpenNavigation }: { onOpenNavigation(): void }) {
  const { api } = useConnection();
  const [settings, setSettings] = useState<GlobalPermissionSettings | null>(null);
  const [selected, setSelected] = useState<PermissionPreset>("auto");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const current = await api.readPermissionSettings();
      setSettings(current);
      setSelected(current.preset ?? "auto");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось загрузить настройки");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updatePermissionSettings({
        preset: selected,
        expectedVersion: settings?.version ?? null,
      });
      setSettings(updated);
      setSelected(updated.preset ?? selected);
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.code === "conflict") {
        await load();
        setError("Конфигурация Codex изменилась. Проверьте значение и сохраните ещё раз.");
      } else {
        setError(caught instanceof Error ? caught.message : "Не удалось сохранить настройки");
      }
    } finally {
      setSaving(false);
    }
  }

  const changed = settings !== null && settings.preset !== selected;

  return (
    <div className="settings-workspace">
      <WorkspaceHeader
        title="Настройки"
        subtitle="Глобально для Codex на сервере"
        onOpenNavigation={onOpenNavigation}
      />
      <main className="settings-scroll">
        <form className="settings-card" onSubmit={save}>
          <div className="settings-card-heading">
            <span className="settings-card-icon">
              <ShieldIcon />
            </span>
            <div>
              <h2>Разрешения Codex</h2>
              <p>Выбранный режим применяется ко всем задачам со следующего хода.</p>
            </div>
          </div>

          {loading ? (
            <div className="settings-loading">
              <span className="spinner small" /> Загружаем конфигурацию…
            </div>
          ) : (
            <fieldset className="permission-presets" disabled={saving}>
              <legend className="sr-only">Режим разрешений</legend>
              {PRESETS.map((preset) => (
                <label
                  className={`permission-preset${selected === preset.id ? " selected" : ""}${preset.id === "full-access" ? " dangerous" : ""}`}
                  key={preset.id}
                >
                  <input
                    type="radio"
                    name="permission-preset"
                    value={preset.id}
                    checked={selected === preset.id}
                    onChange={() => setSelected(preset.id)}
                  />
                  <span>
                    <strong>{preset.title}</strong>
                    <small>{preset.description}</small>
                  </span>
                </label>
              ))}
            </fieldset>
          )}

          {!loading && settings?.preset === null && (
            <div className="settings-notice warning" role="status">
              Обнаружена нестандартная конфигурация. Выберите один из режимов и сохраните его.
            </div>
          )}
          {settings?.overridden && (
            <div className="settings-notice warning" role="status">
              {settings.message ?? "Настройка переопределена управляемой политикой Codex."}
            </div>
          )}
          {selected === "full-access" && !loading && (
            <div className="settings-notice danger" role="alert">
              Полный доступ снимает ограничения на файлы и сеть. Используйте его только на
              доверенном сервере.
            </div>
          )}
          {error && (
            <div className="settings-notice danger" role="alert">
              {error}
            </div>
          )}

          <div className="settings-actions">
            <button className="primary" disabled={loading || saving || !changed} type="submit">
              {saving ? "Сохраняем…" : "Сохранить"}
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}
