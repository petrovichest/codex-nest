import { Capacitor } from "@capacitor/core";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import type {
  AppUpdateStatus,
  CodexManagementStatus,
  GlobalPermissionSettings,
  PermissionPreset,
  TaskDefaults,
  TranscriptionConfigResponse,
  TranscriptionProvider,
  UiLanguage,
  UpdateTranscriptionSettingsRequest,
} from "@codexnest/protocol";

import { ApiClientError } from "../api";
import {
  getBrowserNotificationPermission,
  requestBrowserNotificationPermission,
  type BrowserNotificationPermission,
} from "../browser-notifications";
import { useConnection } from "../connection";
import { localizeKnownServerText, useI18n } from "../i18n";
import { BellIcon, MicrophoneIcon, ServerIcon, ShieldIcon, SlidersIcon } from "./Icons";
import { ApplicationSettingsCard } from "./ApplicationSettingsCard";
import { CodexSettingsCard, CodexSettingsProvider, ProxySettingsCard } from "./CodexSettingsCard";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { RecoverySettingsCard } from "./RecoverySettingsCard";

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
  onTranscriptionConfigChange = () => undefined,
  initialAppUpdateStatus = null,
  onAppUpdateStatusChange,
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
  onTranscriptionConfigChange?(config: TranscriptionConfigResponse): void;
  initialAppUpdateStatus?: AppUpdateStatus | null;
  onAppUpdateStatusChange?(status: AppUpdateStatus): void;
}) {
  const { api, state } = useConnection();
  const { language, setLanguage, t } = useI18n();
  const localizationRef = useRef({ language, t });
  localizationRef.current = { language, t };
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
  const [languageSaving, setLanguageSaving] = useState(false);
  const [languageError, setLanguageError] = useState<string | null>(null);
  const [appUpdateStatus, setAppUpdateStatus] = useState<AppUpdateStatus | null>(
    initialAppUpdateStatus,
  );
  const [codexManagementStatus, setCodexManagementStatus] = useState<CodexManagementStatus | null>(
    null,
  );
  const defaultModel =
    state?.snapshot?.models.find((model) => model.isDefault) ?? state?.snapshot?.models[0];

  useEffect(() => {
    if (initialAppUpdateStatus) setAppUpdateStatus(initialAppUpdateStatus);
  }, [initialAppUpdateStatus]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const current = await api.readPermissionSettings();
      setSettings(current);
      setSelected(current.preset ?? "auto");
    } catch (caught) {
      const localization = localizationRef.current;
      setError(
        caught instanceof Error
          ? (localizeKnownServerText(localization.language, caught.message) ?? caught.message)
          : localization.t("Не удалось загрузить настройки"),
      );
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
        setError(t("Конфигурация Codex изменилась. Проверьте значение и сохраните ещё раз."));
      } else {
        setError(
          caught instanceof Error
            ? (localizeKnownServerText(language, caught.message) ?? caught.message)
            : t("Не удалось сохранить настройки"),
        );
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
        caught instanceof Error
          ? (localizeKnownServerText(language, caught.message) ?? caught.message)
          : t("Не удалось сохранить настройки новых задач"),
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
      setNotificationError(t("Не удалось запросить разрешение у браузера"));
    } finally {
      setNotificationRequesting(false);
    }
  }

  async function changeLanguage(next: UiLanguage) {
    if (next === language || languageSaving) return;
    setLanguageSaving(true);
    setLanguageError(null);
    try {
      const updated = await api.updateUiLanguage({ language: next });
      setLanguage(updated.language);
    } catch (caught) {
      setLanguageError(
        caught instanceof Error
          ? (localizeKnownServerText(language, caught.message) ?? caught.message)
          : t("Не удалось сохранить язык интерфейса"),
      );
    } finally {
      setLanguageSaving(false);
    }
  }

  const changed = settings !== null && settings.preset !== selected;
  const acceptAppUpdateStatus = useCallback(
    (next: AppUpdateStatus) => {
      setAppUpdateStatus(next);
      onAppUpdateStatusChange?.(next);
    },
    [onAppUpdateStatusChange],
  );

  return (
    <div className="settings-workspace">
      <WorkspaceHeader
        title={t("Настройки")}
        subtitle={t("Интерфейс, Codex и подключение")}
        onOpenNavigation={onOpenNavigation}
      />
      <main className="settings-scroll">
        <CodexSettingsProvider onStatusChange={setCodexManagementStatus}>
          <div className="settings-stack">
            <ApplicationSettingsCard
              initialStatus={initialAppUpdateStatus}
              onStatusChange={acceptAppUpdateStatus}
            />

            <CodexSettingsCard />

            <RecoverySettingsCard appStatus={appUpdateStatus} codexStatus={codexManagementStatus} />

            <form className="settings-card" onSubmit={saveTaskDefaults}>
              <div className="settings-card-heading">
                <span className="settings-card-icon">
                  <SlidersIcon />
                </span>
                <div>
                  <h2>{t("Новые задачи")}</h2>
                  <p>
                    {t(
                      "Эти значения применяются к новым задачам на всех подключённых устройствах.",
                    )}
                  </p>
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
                  <option value="">{t("По умолчанию")}</option>
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
                  <option value="">{t("По умолчанию")}</option>
                  <option value="friendly">{t("Дружелюбная")}</option>
                  <option value="pragmatic">{t("Прагматичная")}</option>
                  <option value="none">{t("Без personality")}</option>
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
                  {taskDefaultsSaving ? t("Сохраняем…") : t("Сохранить настройки новых задач")}
                </button>
              </div>
            </form>

            <form className="settings-card" onSubmit={save}>
              <div className="settings-card-heading">
                <span className="settings-card-icon">
                  <ShieldIcon />
                </span>
                <div>
                  <h2>{t("Разрешения Codex")}</h2>
                  <p>{t("Выбранный режим применяется ко всем задачам со следующего хода.")}</p>
                </div>
              </div>

              {loading ? (
                <div className="settings-loading">
                  <span className="spinner small" /> {t("Загружаем конфигурацию…")}
                </div>
              ) : (
                <fieldset className="permission-presets" disabled={saving}>
                  <legend className="sr-only">{t("Режим разрешений")}</legend>
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
                        <strong>{t(preset.title)}</strong>
                        <small>{t(preset.description)}</small>
                      </span>
                    </label>
                  ))}
                </fieldset>
              )}

              {!loading && settings?.preset === null && (
                <div className="settings-notice warning" role="status">
                  {t(
                    "Обнаружена нестандартная конфигурация. Выберите один из режимов и сохраните его.",
                  )}
                </div>
              )}
              {settings?.overridden && (
                <div className="settings-notice warning" role="status">
                  {settings.message
                    ? (localizeKnownServerText(language, settings.message) ?? settings.message)
                    : t("Настройка переопределена управляемой политикой Codex.")}
                </div>
              )}
              {selected === "full-access" && !loading && (
                <div className="settings-notice danger" role="alert">
                  {t(
                    "Полный доступ снимает ограничения на файлы и сеть. Используйте его только на доверенном сервере.",
                  )}
                </div>
              )}
              {error && (
                <div className="settings-notice danger" role="alert">
                  {error}
                </div>
              )}

              <div className="settings-actions">
                <button className="primary" disabled={loading || saving || !changed} type="submit">
                  {saving ? t("Сохраняем…") : t("Сохранить")}
                </button>
              </div>
            </form>

            <TranscriptionSettingsCard
              config={transcriptionConfig}
              configError={transcriptionConfigError}
              onChange={onTranscriptionConfigChange}
            />

            {!Capacitor.isNativePlatform() && (
              <section className="settings-card">
                <div className="settings-card-heading">
                  <span className="settings-card-icon">
                    <BellIcon />
                  </span>
                  <div>
                    <h2>{t("Уведомления браузера")}</h2>
                    <p>
                      {t("События приходят напрямую с вашего сервера, без Google и внешнего push.")}
                    </p>
                  </div>
                </div>
                {notificationPermission === "granted" && (
                  <div className="settings-notice success" role="status">
                    {t("Уведомления включены. Они приходят, пока вкладка открыта или свёрнута.")}
                  </div>
                )}
                {notificationPermission === "denied" && (
                  <div className="settings-notice danger" role="alert">
                    {t("Уведомления заблокированы. Разрешите их в настройках сайта в браузере.")}
                  </div>
                )}
                {notificationPermission === "unsupported" && (
                  <div className="settings-notice warning" role="status">
                    {t(
                      "Этот браузер не предоставляет системные уведомления для текущего подключения. Некоторые браузеры требуют открыть CodexNest по HTTPS.",
                    )}
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
                      {notificationRequesting ? t("Запрашиваем…") : t("Разрешить уведомления")}
                    </button>
                  </div>
                )}
              </section>
            )}

            <section className="settings-card">
              <div className="settings-card-heading">
                <span className="settings-card-icon">
                  <SlidersIcon />
                </span>
                <div>
                  <h2>{t("Интерфейс")}</h2>
                  <p>
                    {t(
                      "Язык интерфейса синхронизируется через сервер; остальные настройки применяются только на этом устройстве.",
                    )}
                  </p>
                </div>
              </div>
              <label className="theme-setting">
                <span>{t("Язык интерфейса")}</span>
                <select
                  aria-label={t("Язык интерфейса")}
                  disabled={languageSaving}
                  value={language}
                  onChange={(event) => void changeLanguage(event.target.value as UiLanguage)}
                >
                  <option value="en">English</option>
                  <option value="ru">Русский</option>
                </select>
              </label>
              {languageError && (
                <div className="settings-notice danger" role="alert">
                  {languageError}
                </div>
              )}
              <label className="theme-setting">
                <span>{t("Тема")}</span>
                <select value={theme} onChange={(event) => onThemeChange(event.target.value)}>
                  <option value="system">{t("Системная тема")}</option>
                  <option value="light">{t("Светлая тема")}</option>
                  <option value="dark">{t("Тёмная тема")}</option>
                </select>
              </label>
              <label className="theme-setting">
                <span>{t("Боковая панель")}</span>
                <select
                  value={sidebarSide}
                  onChange={(event) => onSidebarSideChange(event.target.value as SidebarSide)}
                >
                  <option value="left">{t("Слева")}</option>
                  <option value="right">{t("Справа")}</option>
                </select>
              </label>
              <label className="theme-setting">
                <span>{t("Порядок проектов")}</span>
                <select
                  value={projectListDirection}
                  onChange={(event) =>
                    onProjectListDirectionChange(event.target.value as ProjectListDirection)
                  }
                >
                  <option value="top-down">{t("Сверху вниз")}</option>
                  <option value="bottom-up">{t("Снизу вверх")}</option>
                </select>
              </label>
            </section>

            <ProxySettingsCard />

            <section className="settings-card">
              <div className="settings-card-heading">
                <span className="settings-card-icon">
                  <ServerIcon />
                </span>
                <div>
                  <h2>{t("Сервер")}</h2>
                  <p>{t("Подключение к CodexNest на этом устройстве.")}</p>
                </div>
              </div>
              <div className="settings-actions">
                <button type="button" onClick={onSwitchServer}>
                  {t("Сменить сервер")}
                </button>
              </div>
            </section>
          </div>
        </CodexSettingsProvider>
      </main>
    </div>
  );
}

type TranscriptionForm = Omit<UpdateTranscriptionSettingsRequest, "openAiApiKey">;

function TranscriptionSettingsCard({
  config,
  configError,
  onChange,
}: {
  config: TranscriptionConfigResponse | null;
  configError: string | null;
  onChange(config: TranscriptionConfigResponse): void;
}) {
  const { api, state } = useConnection();
  const { language, t } = useI18n();
  const [form, setForm] = useState<TranscriptionForm>(() => transcriptionForm(config));
  const [apiKey, setApiKey] = useState("");
  const [removeApiKey, setRemoveApiKey] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const secure = secureServerUrl(api.settings?.baseUrl ?? "");
  const models = state?.snapshot?.models ?? [];

  useEffect(() => {
    if (!config) return;
    setForm(transcriptionForm(config));
    setApiKey("");
    setRemoveApiKey(false);
  }, [config]);

  async function saveTranscriptionSettings(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const keyUpdate = apiKey.trim()
        ? { openAiApiKey: apiKey.trim() }
        : removeApiKey
          ? { openAiApiKey: null }
          : {};
      const updated = await api.updateTranscriptionSettings({ ...form, ...keyUpdate });
      onChange(updated);
      setApiKey("");
      setRemoveApiKey(false);
      setNotice(t("Настройки применены на сервере для всех клиентов."));
    } catch (caught) {
      setError(
        caught instanceof Error
          ? (localizeKnownServerText(language, caught.message) ?? caught.message)
          : t("Не удалось сохранить настройки распознавания"),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings-card">
      <div className="settings-card-heading">
        <span className="settings-card-icon">
          <MicrophoneIcon />
        </span>
        <div>
          <h2>{t("Распознавание речи")}</h2>
          <p>{t("Эти настройки общие для всех клиентов и сохраняются на сервере.")}</p>
        </div>
      </div>
      {configError && (
        <div className="settings-notice danger" role="alert">
          {t("Не удалось получить настройки распознавания: {{error}}", {
            error: localizeKnownServerText(language, configError) ?? configError,
          })}
        </div>
      )}
      {!config && !configError && (
        <div className="settings-loading compact">
          <span className="spinner small" /> {t("Загружаем настройки…")}
        </div>
      )}
      {config && (
        <form className="transcription-settings-form" onSubmit={saveTranscriptionSettings}>
          <label className="theme-setting">
            <span>{t("Провайдер")}</span>
            <select
              aria-label={t("Провайдер распознавания речи")}
              disabled={saving}
              value={form.provider ?? ""}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  provider: event.target.value as TranscriptionProvider,
                }))
              }
            >
              <option value="" disabled>
                {t("Выберите провайдера")}
              </option>
              <option value="local">{t("Локальная модель")}</option>
              <option value="openai">OpenAI API</option>
            </select>
          </label>

          {form.provider === "local" && (
            <div className="transcription-provider-settings">
              <label className="theme-setting">
                <span>{t("URL локального STT")}</span>
                <input
                  aria-label={t("URL локального STT")}
                  disabled={saving}
                  placeholder="http://127.0.0.1:8178/inference"
                  spellCheck={false}
                  value={form.localUrl ?? ""}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      localUrl: event.target.value || null,
                    }))
                  }
                />
              </label>
              <label className="check">
                <input
                  checked={form.refineLocal}
                  disabled={saving}
                  type="checkbox"
                  onChange={(event) =>
                    setForm((current) => ({ ...current, refineLocal: event.target.checked }))
                  }
                />
                <span>{t("Расставлять пунктуацию и исправлять очевидные ошибки через Codex")}</span>
              </label>
              {form.refineLocal && (
                <label className="theme-setting">
                  <span>{t("Модель улучшения")}</span>
                  <select
                    aria-label={t("Модель улучшения расшифровки")}
                    disabled={saving}
                    value={form.refinementModel}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        refinementModel: event.target.value,
                      }))
                    }
                  >
                    {!models.some((model) => model.id === form.refinementModel) && (
                      <option value={form.refinementModel}>{form.refinementModel}</option>
                    )}
                    {models.map((model) => (
                      <option value={model.id} key={model.id}>
                        {model.displayName}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="settings-notice" role="status">
                {t(
                  "Аудио остаётся на сервере. При включённом улучшении в Codex отправляется только распознанный текст.",
                )}
              </div>
            </div>
          )}

          {form.provider === "openai" && (
            <div className="transcription-provider-settings">
              <label className="theme-setting">
                <span>{t("Модель OpenAI")}</span>
                <select
                  aria-label={t("Модель распознавания OpenAI")}
                  disabled={saving}
                  value={form.openAiModel}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, openAiModel: event.target.value }))
                  }
                >
                  <option value="gpt-4o-transcribe">{t("gpt-4o-transcribe — точнее")}</option>
                  <option value="gpt-4o-mini-transcribe">
                    {t("gpt-4o-mini-transcribe — дешевле")}
                  </option>
                </select>
              </label>
              <label className="theme-setting">
                <span>OpenAI API key</span>
                <span className="codex-proxy-input">
                  <input
                    aria-label="OpenAI API key"
                    autoComplete="off"
                    disabled={!secure || saving}
                    placeholder={
                      config.openAiApiKeyConfigured && !removeApiKey
                        ? t("Ключ сохранён; оставьте пустым без изменений")
                        : "sk-…"
                    }
                    spellCheck={false}
                    type={showApiKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(event) => {
                      setApiKey(event.target.value);
                      if (event.target.value) setRemoveApiKey(false);
                    }}
                  />
                  <button
                    disabled={!apiKey}
                    type="button"
                    onClick={() => setShowApiKey((current) => !current)}
                  >
                    {showApiKey ? t("Скрыть") : t("Показать")}
                  </button>
                </span>
              </label>
              {config.openAiApiKeyConfigured && (
                <div className="settings-actions codex-actions transcription-key-actions">
                  <span>{removeApiKey ? t("Ключ будет удалён") : t("API key настроен")}</span>
                  <button
                    disabled={saving}
                    type="button"
                    onClick={() => {
                      setRemoveApiKey((current) => !current);
                      setApiKey("");
                    }}
                  >
                    {removeApiKey ? t("Не удалять") : t("Удалить ключ")}
                  </button>
                </div>
              )}
              {!secure && (
                <div className="settings-notice danger" role="alert">
                  {t("Ввод API key доступен только через HTTPS или локальное подключение.")}
                </div>
              )}
              <div className="settings-notice warning" role="status">
                {t(
                  "Аудио отправляется в OpenAI API и оплачивается отдельно от подписки ChatGPT или Codex.",
                )}
              </div>
            </div>
          )}

          <label className="theme-setting">
            <span>{t("Язык")}</span>
            <input
              aria-label={t("Язык распознавания")}
              disabled={saving}
              maxLength={32}
              placeholder="ru"
              spellCheck={false}
              value={form.language ?? ""}
              onChange={(event) =>
                setForm((current) => ({ ...current, language: event.target.value || null }))
              }
            />
          </label>

          {config.providers.length === 0 && (
            <div className="settings-notice warning" role="status">
              {t("Настройте URL локального STT или OpenAI API key, чтобы включить микрофон.")}
            </div>
          )}
          {config.provider && !config.providers.includes(config.provider) && (
            <div className="settings-notice danger" role="alert">
              {t(
                "Выбранный провайдер настроен не полностью. Исправьте параметры и сохраните форму.",
              )}
            </div>
          )}
          {error && (
            <div className="settings-notice danger" role="alert">
              {error}
            </div>
          )}
          {notice && !error && (
            <div className="settings-notice success" role="status">
              {notice}
            </div>
          )}
          <div className="settings-actions">
            <button className="primary" disabled={saving || !form.provider} type="submit">
              {saving ? t("Сохраняем…") : t("Сохранить распознавание")}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function transcriptionForm(config: TranscriptionConfigResponse | null): TranscriptionForm {
  return {
    provider: config?.provider ?? null,
    localUrl: config?.localUrl ?? null,
    openAiModel: config?.openAiModel ?? "gpt-4o-transcribe",
    language: config?.language ?? "ru",
    refineLocal: config?.refineLocal ?? true,
    refinementModel: config?.refinementModel ?? "gpt-5.6-luna",
  };
}

function secureServerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" ||
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "::1"
    );
  } catch {
    return false;
  }
}
