import { Capacitor } from "@capacitor/core";
import { type FormEvent, useCallback, useEffect, useState } from "react";

import type {
  GlobalPermissionSettings,
  PermissionPreset,
  TaskDefaults,
  TranscriptionConfigResponse,
  TranscriptionProvider,
} from "@codexnest/protocol";

import { ApiClientError } from "../api";
import {
  getBrowserNotificationPermission,
  requestBrowserNotificationPermission,
  type BrowserNotificationPermission,
} from "../browser-notifications";
import { useConnection } from "../connection";
import { BellIcon, MicrophoneIcon, ServerIcon, ShieldIcon, SlidersIcon } from "./Icons";
import { CodexSettingsCard } from "./CodexSettingsCard";
import { WorkspaceHeader } from "./WorkspaceHeader";

export type SidebarSide = "left" | "right";
export type ProjectListDirection = "bottom-up" | "top-down";

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

export function SettingsPage({
  onOpenNavigation,
  onSwitchServer,
  theme,
  onThemeChange,
  sidebarSide,
  onSidebarSideChange,
  projectListDirection,
  onProjectListDirectionChange,
  transcriptionConfig = null,
  transcriptionConfigError = null,
  transcriptionProvider = null,
  onTranscriptionProviderChange = () => undefined,
}: {
  onOpenNavigation(): void;
  onSwitchServer(): void;
  theme: string;
  onThemeChange(theme: string): void;
  sidebarSide: SidebarSide;
  onSidebarSideChange(side: SidebarSide): void;
  projectListDirection: ProjectListDirection;
  onProjectListDirectionChange(direction: ProjectListDirection): void;
  transcriptionConfig?: TranscriptionConfigResponse | null;
  transcriptionConfigError?: string | null;
  transcriptionProvider?: TranscriptionProvider | null;
  onTranscriptionProviderChange?(provider: TranscriptionProvider): void;
}) {
  const { api, state } = useConnection();
  const [settings, setSettings] = useState<GlobalPermissionSettings | null>(null);
  const [selected, setSelected] = useState<PermissionPreset>("auto");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialTaskDefaults = state?.snapshot?.taskDefaults ?? {};
  const [taskDefaults, setTaskDefaults] = useState<TaskDefaults>(initialTaskDefaults);
  const [savedTaskDefaults, setSavedTaskDefaults] = useState<TaskDefaults>(initialTaskDefaults);
  const [taskDefaultsSaving, setTaskDefaultsSaving] = useState(false);
  const [taskDefaultsError, setTaskDefaultsError] = useState<string | null>(null);
  const [notificationPermission, setNotificationPermission] =
    useState<BrowserNotificationPermission>(getBrowserNotificationPermission);
  const [notificationRequesting, setNotificationRequesting] = useState(false);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const defaultModel =
    state?.snapshot?.models.find((model) => model.isDefault) ?? state?.snapshot?.models[0];

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

  useEffect(() => {
    const current = state?.snapshot?.taskDefaults ?? {};
    setTaskDefaults(current);
    setSavedTaskDefaults(current);
  }, [state?.snapshot?.taskDefaults]);

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

  async function saveTaskDefaults(event: FormEvent) {
    event.preventDefault();
    setTaskDefaultsSaving(true);
    setTaskDefaultsError(null);
    try {
      const updated = await api.updateTaskDefaults({
        serviceTier: taskDefaults.serviceTier ?? null,
        personality: taskDefaults.personality ?? null,
      });
      setTaskDefaults(updated);
      setSavedTaskDefaults(updated);
    } catch (caught) {
      setTaskDefaultsError(
        caught instanceof Error ? caught.message : "Не удалось сохранить настройки новых задач",
      );
    } finally {
      setTaskDefaultsSaving(false);
    }
  }

  async function enableBrowserNotifications() {
    setNotificationRequesting(true);
    setNotificationError(null);
    try {
      setNotificationPermission(await requestBrowserNotificationPermission());
    } catch {
      setNotificationError("Не удалось запросить разрешение у браузера");
    } finally {
      setNotificationRequesting(false);
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
        <div className="settings-stack">
          <section className="settings-card">
            <div className="settings-card-heading">
              <span className="settings-card-icon">
                <SlidersIcon />
              </span>
              <div>
                <h2>Оформление</h2>
                <p>Настройки интерфейса применяются только на этом устройстве.</p>
              </div>
            </div>
            <label className="theme-setting">
              <span>Тема</span>
              <select value={theme} onChange={(event) => onThemeChange(event.target.value)}>
                <option value="system">Системная тема</option>
                <option value="light">Светлая тема</option>
                <option value="dark">Тёмная тема</option>
              </select>
            </label>
            <label className="theme-setting">
              <span>Боковая панель</span>
              <select
                value={sidebarSide}
                onChange={(event) => onSidebarSideChange(event.target.value as SidebarSide)}
              >
                <option value="left">Слева</option>
                <option value="right">Справа</option>
              </select>
            </label>
            <label className="theme-setting">
              <span>Порядок проектов</span>
              <select
                value={projectListDirection}
                onChange={(event) =>
                  onProjectListDirectionChange(event.target.value as ProjectListDirection)
                }
              >
                <option value="bottom-up">Снизу вверх</option>
                <option value="top-down">Сверху вниз</option>
              </select>
            </label>
          </section>

          <section className="settings-card">
            <div className="settings-card-heading">
              <span className="settings-card-icon">
                <MicrophoneIcon />
              </span>
              <div>
                <h2>Распознавание речи</h2>
                <p>Провайдер выбирается отдельно на каждом устройстве.</p>
              </div>
            </div>
            {transcriptionConfigError && (
              <div className="settings-notice danger" role="alert">
                Не удалось получить настройки распознавания: {transcriptionConfigError}
              </div>
            )}
            {!transcriptionConfig && !transcriptionConfigError && (
              <div className="settings-loading">
                <span className="spinner small" /> Загружаем провайдеры…
              </div>
            )}
            {transcriptionConfig?.providers.length === 0 && (
              <div className="settings-notice warning" role="status">
                Распознавание не настроено на сервере. Укажите локальный STT URL или API-ключ
                OpenAI.
              </div>
            )}
            {transcriptionConfig && transcriptionConfig.providers.length > 0 && (
              <>
                <label className="theme-setting">
                  <span>Провайдер</span>
                  <select
                    aria-label="Провайдер распознавания речи"
                    value={transcriptionProvider ?? ""}
                    onChange={(event) =>
                      onTranscriptionProviderChange(event.target.value as TranscriptionProvider)
                    }
                  >
                    {transcriptionConfig.providers.map((provider) => (
                      <option value={provider} key={provider}>
                        {provider === "local" ? "Локальная модель" : "OpenAI"}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="settings-notice" role="status">
                  {transcriptionProvider === "openai"
                    ? "Записи отправляются в OpenAI API через сервер CodexNest."
                    : "Записи обрабатываются локальной моделью на вашем сервере."}
                </div>
              </>
            )}
          </section>

          {!Capacitor.isNativePlatform() && (
            <section className="settings-card">
              <div className="settings-card-heading">
                <span className="settings-card-icon">
                  <BellIcon />
                </span>
                <div>
                  <h2>Уведомления браузера</h2>
                  <p>События приходят напрямую с вашего сервера, без Google и внешнего push.</p>
                </div>
              </div>
              {notificationPermission === "granted" && (
                <div className="settings-notice success" role="status">
                  Уведомления включены. Они приходят, пока вкладка открыта или свёрнута.
                </div>
              )}
              {notificationPermission === "denied" && (
                <div className="settings-notice danger" role="alert">
                  Уведомления заблокированы. Разрешите их в настройках сайта в браузере.
                </div>
              )}
              {notificationPermission === "unsupported" && (
                <div className="settings-notice warning" role="status">
                  Этот браузер не предоставляет системные уведомления для текущего подключения.
                  Некоторые браузеры требуют открыть CodexNest по HTTPS.
                </div>
              )}
              {notificationError && (
                <div className="settings-notice danger" role="alert">
                  {notificationError}
                </div>
              )}
              {notificationPermission === "default" && (
                <div className="settings-actions">
                  <button
                    className="primary"
                    disabled={notificationRequesting}
                    type="button"
                    onClick={() => void enableBrowserNotifications()}
                  >
                    {notificationRequesting ? "Запрашиваем…" : "Разрешить уведомления"}
                  </button>
                </div>
              )}
            </section>
          )}

          <form className="settings-card" onSubmit={saveTaskDefaults}>
            <div className="settings-card-heading">
              <span className="settings-card-icon">
                <SlidersIcon />
              </span>
              <div>
                <h2>Новые задачи</h2>
                <p>Эти значения применяются к новым задачам на всех подключённых устройствах.</p>
              </div>
            </div>
            <label className="theme-setting">
              <span>Service tier</span>
              <select
                disabled={!defaultModel || taskDefaultsSaving}
                value={taskDefaults.serviceTier ?? ""}
                onChange={(event) =>
                  setTaskDefaults((current) => ({
                    ...current,
                    serviceTier: event.target.value || undefined,
                  }))
                }
              >
                <option value="">По умолчанию</option>
                {defaultModel?.serviceTiers.map((tier) => (
                  <option value={tier.id} key={tier.id}>
                    {tier.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="theme-setting">
              <span>Personality</span>
              <select
                disabled={!defaultModel?.supportsPersonality || taskDefaultsSaving}
                value={taskDefaults.personality ?? ""}
                onChange={(event) =>
                  setTaskDefaults((current) => ({
                    ...current,
                    personality: event.target.value || undefined,
                  }))
                }
              >
                <option value="">По умолчанию</option>
                <option value="friendly">Дружелюбная</option>
                <option value="pragmatic">Прагматичная</option>
                <option value="none">Без personality</option>
              </select>
            </label>
            {taskDefaultsError && (
              <div className="settings-notice danger" role="alert">
                {taskDefaultsError}
              </div>
            )}
            <div className="settings-actions">
              <button
                className="primary"
                disabled={
                  taskDefaultsSaving ||
                  JSON.stringify(taskDefaults) === JSON.stringify(savedTaskDefaults)
                }
                type="submit"
              >
                {taskDefaultsSaving ? "Сохраняем…" : "Сохранить настройки новых задач"}
              </button>
            </div>
          </form>

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

          <CodexSettingsCard />

          <section className="settings-card">
            <div className="settings-card-heading">
              <span className="settings-card-icon">
                <ServerIcon />
              </span>
              <div>
                <h2>Сервер</h2>
                <p>Подключение к CodexNest на этом устройстве.</p>
              </div>
            </div>
            <div className="settings-actions">
              <button type="button" onClick={onSwitchServer}>
                Сменить сервер
              </button>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
