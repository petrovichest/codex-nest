import { Capacitor } from "@capacitor/core";
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router";

import type {
  AppUpdateStatus,
  CodexManagementStatus,
  ModelOption,
  GlobalPermissionSettings,
  PermissionPreset,
  TaskDefaults,
  TranscriptionConfigResponse,
  TranscriptionProvider,
  UiLanguage,
  UpdateTaskDefaultsRequest,
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
import {
  BellIcon,
  MicrophoneIcon,
  RefreshIcon,
  ServerIcon,
  ShieldIcon,
  SkillsIcon,
  SlidersIcon,
  TerminalIcon,
} from "./Icons";
import { ApplicationSettingsCard } from "./ApplicationSettingsCard";
import { CodexSettingsCard, CodexSettingsProvider, ProxySettingsCard } from "./CodexSettingsCard";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { RecoverySettingsCard } from "./RecoverySettingsCard";
import { SettingsGroup, SettingsRow } from "./SettingsPresentation";
import { SkillsSettingsCard } from "./SkillsSettingsCard";

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

const SETTINGS_SECTIONS = [
  { id: "application", label: "Приложение", Icon: SlidersIcon },
  { id: "codex", label: "Codex", Icon: TerminalIcon },
  { id: "skills", label: "Скиллы", Icon: SkillsIcon },
  { id: "connection", label: "Подключение", Icon: ServerIcon },
  { id: "maintenance", label: "Обслуживание", Icon: RefreshIcon },
] as const;

type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];
type EditableTaskDefaults = Omit<TaskDefaults, "serviceTier">;
const EMPTY_MODELS: ModelOption[] = [];

function isSettingsSection(value: string | null): value is SettingsSection {
  return SETTINGS_SECTIONS.some((section) => section.id === value);
}

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
  const [searchParams, setSearchParams] = useSearchParams();
  const sectionParam = searchParams.get("section");
  const activeSection: SettingsSection = isSettingsSection(sectionParam)
    ? sectionParam
    : "application";
  const settingsScrollRef = useRef<HTMLElement>(null);
  const sectionTabRefs = useRef<Partial<Record<SettingsSection, HTMLButtonElement | null>>>({});
  const localizationRef = useRef({ language, t });
  localizationRef.current = { language, t };
  const [settings, setSettings] = useState<GlobalPermissionSettings | null>(null);
  const [selected, setSelected] = useState<PermissionPreset>("auto");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialTaskDefaults = editableTaskDefaults(state?.snapshot?.taskDefaults ?? {});
  const [taskDefaults, setTaskDefaults] = useState<EditableTaskDefaults>(initialTaskDefaults);
  const [savedTaskDefaults, setSavedTaskDefaults] =
    useState<EditableTaskDefaults>(initialTaskDefaults);
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
  const models = state?.snapshot?.models ?? EMPTY_MODELS;
  const defaultModel = models.find((model) => model.isDefault) ?? models[0];
  const selectedTaskModel = models.find((model) => model.id === taskDefaults.model) ?? defaultModel;

  useEffect(() => {
    if (initialAppUpdateStatus) setAppUpdateStatus(initialAppUpdateStatus);
  }, [initialAppUpdateStatus]);

  useEffect(() => {
    if (sectionParam === activeSection) return;
    const canonicalParams = new URLSearchParams(searchParams);
    canonicalParams.set("section", activeSection);
    setSearchParams(canonicalParams, { replace: true });
  }, [activeSection, searchParams, sectionParam, setSearchParams]);

  useEffect(() => {
    sectionTabRefs.current[activeSection]?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
    });
  }, [activeSection]);

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
    const current = editableTaskDefaults(state?.snapshot?.taskDefaults ?? {});
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
      const updated = await api.updateTaskDefaults(
        taskDefaultsPatch(savedTaskDefaults, taskDefaults),
      );
      const editable = editableTaskDefaults(updated);
      setTaskDefaults(editable);
      setSavedTaskDefaults(editable);
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

  const selectSection = useCallback(
    (section: SettingsSection) => {
      if (section === activeSection) return;
      const nextParams = new URLSearchParams(searchParams);
      nextParams.set("section", section);
      setSearchParams(nextParams, { replace: true });
      settingsScrollRef.current?.scrollTo?.({ top: 0 });
    },
    [activeSection, searchParams, setSearchParams],
  );

  function handleSectionKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null;
    if (event.key === "ArrowLeft") {
      nextIndex = (index - 1 + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length;
    } else if (event.key === "ArrowRight") {
      nextIndex = (index + 1) % SETTINGS_SECTIONS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = SETTINGS_SECTIONS.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    const nextSection = SETTINGS_SECTIONS[nextIndex].id;
    selectSection(nextSection);
    sectionTabRefs.current[nextSection]?.focus();
  }

  return (
    <div className="settings-workspace">
      <WorkspaceHeader
        leadingIcon={<SlidersIcon />}
        title={t("Настройки")}
        subtitle={t("Приложение, Codex и сервер")}
        onOpenNavigation={onOpenNavigation}
      />
      <section aria-label={t("Настройки")} className="settings-scroll" ref={settingsScrollRef}>
        <div className="settings-section-shelf">
          <div aria-label={t("Разделы настроек")} className="settings-section-tabs" role="tablist">
            {SETTINGS_SECTIONS.map(({ id, label, Icon }, index) => (
              <button
                aria-controls={`settings-section-panel-${id}`}
                aria-selected={activeSection === id}
                className="settings-section-tab"
                id={`settings-section-tab-${id}`}
                key={id}
                ref={(element) => {
                  sectionTabRefs.current[id] = element;
                }}
                role="tab"
                tabIndex={activeSection === id ? 0 : -1}
                type="button"
                onClick={() => selectSection(id)}
                onKeyDown={(event) => handleSectionKeyDown(event, index)}
              >
                <Icon />
                <span>{t(label)}</span>
              </button>
            ))}
          </div>
        </div>
        <CodexSettingsProvider onStatusChange={setCodexManagementStatus}>
          <div
            aria-labelledby="settings-section-tab-application"
            className="settings-stack"
            hidden={activeSection !== "application"}
            id="settings-section-panel-application"
            role="tabpanel"
          >
            <SettingsGroup
              description={t(
                "Язык интерфейса синхронизируется через сервер; остальные настройки применяются только на этом устройстве.",
              )}
              icon={<SlidersIcon />}
              title={t("Интерфейс")}
            >
              <SettingsRow
                description={t("Синхронизируется между подключёнными устройствами.")}
                label={t("Язык интерфейса")}
                labelFor="settings-language"
              >
                <select
                  aria-label={t("Язык интерфейса")}
                  disabled={languageSaving}
                  id="settings-language"
                  value={language}
                  onChange={(event) => void changeLanguage(event.target.value as UiLanguage)}
                >
                  <option value="en">English</option>
                  <option value="ru">Русский</option>
                </select>
              </SettingsRow>
              {languageError && (
                <div className="settings-notice danger" role="alert">
                  {languageError}
                </div>
              )}
              <SettingsRow
                description={t("Светлая, тёмная или системная цветовая схема.")}
                label={t("Тема")}
                labelFor="settings-theme"
              >
                <select
                  id="settings-theme"
                  value={theme}
                  onChange={(event) => onThemeChange(event.target.value)}
                >
                  <option value="system">{t("Системная тема")}</option>
                  <option value="light">{t("Светлая тема")}</option>
                  <option value="dark">{t("Тёмная тема")}</option>
                </select>
              </SettingsRow>
              <SettingsRow
                description={t("Расположение списка проектов и задач.")}
                label={t("Боковая панель")}
                labelFor="settings-sidebar-side"
              >
                <select
                  id="settings-sidebar-side"
                  value={sidebarSide}
                  onChange={(event) => onSidebarSideChange(event.target.value as SidebarSide)}
                >
                  <option value="left">{t("Слева")}</option>
                  <option value="right">{t("Справа")}</option>
                </select>
              </SettingsRow>
              <SettingsRow
                description={t("Как проекты расположены в боковой панели.")}
                label={t("Порядок проектов")}
                labelFor="settings-project-order"
              >
                <select
                  id="settings-project-order"
                  value={projectListDirection}
                  onChange={(event) =>
                    onProjectListDirectionChange(event.target.value as ProjectListDirection)
                  }
                >
                  <option value="top-down">{t("Сверху вниз")}</option>
                  <option value="bottom-up">{t("Снизу вверх")}</option>
                </select>
              </SettingsRow>
            </SettingsGroup>

            {!Capacitor.isNativePlatform() && (
              <SettingsGroup
                description={t(
                  "События приходят напрямую с вашего сервера, без Google и внешнего push.",
                )}
                icon={<BellIcon />}
                title={t("Уведомления браузера")}
              >
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
              </SettingsGroup>
            )}

            <TranscriptionSettingsCard
              config={transcriptionConfig}
              configError={transcriptionConfigError}
              onChange={onTranscriptionConfigChange}
            />
          </div>

          <div
            aria-labelledby="settings-section-tab-codex"
            className="settings-stack"
            hidden={activeSection !== "codex"}
            id="settings-section-panel-codex"
            role="tabpanel"
          >
            <SettingsGroup
              as="form"
              description={t(
                "Эти значения применяются к новым сессиям и задачам на всех подключённых устройствах.",
              )}
              icon={<SlidersIcon />}
              title={t("Новые задачи")}
              onSubmit={saveTaskDefaults}
            >
              <SettingsRow
                description={t("Модель, которая будет выбрана для новых сессий.")}
                label="Session model"
                labelFor="settings-session-model"
              >
                <select
                  disabled={!defaultModel || taskDefaultsSaving}
                  id="settings-session-model"
                  value={taskDefaults.model ?? ""}
                  onChange={(event) =>
                    setTaskDefaults((current) =>
                      taskDefaultsForModel(
                        {
                          ...current,
                          model: event.target.value || undefined,
                        },
                        models,
                      ),
                    )
                  }
                >
                  <option value="">{t("По умолчанию")}</option>
                  {taskDefaults.model &&
                    !models.some((model) => model.id === taskDefaults.model) && (
                      <option value={taskDefaults.model}>
                        {taskDefaults.model} — {t("Недоступна")}
                      </option>
                    )}
                  {models.map((model) => (
                    <option value={model.id} key={model.id}>
                      {model.displayName}
                    </option>
                  ))}
                </select>
              </SettingsRow>
              <SettingsRow
                description={t("Модель для автоматических названий сессий.")}
                label="Title model"
                labelFor="settings-title-model"
              >
                <select
                  disabled={!defaultModel || taskDefaultsSaving}
                  id="settings-title-model"
                  value={taskDefaults.titleModel ?? ""}
                  onChange={(event) =>
                    setTaskDefaults((current) => ({
                      ...current,
                      titleModel: event.target.value || undefined,
                    }))
                  }
                >
                  <option value="">{t("По умолчанию")}</option>
                  {taskDefaults.titleModel &&
                    !models.some((model) => model.id === taskDefaults.titleModel) && (
                      <option value={taskDefaults.titleModel}>
                        {taskDefaults.titleModel} — {t("Недоступна")}
                      </option>
                    )}
                  {models.map((model) => (
                    <option value={model.id} key={model.id}>
                      {model.displayName}
                    </option>
                  ))}
                </select>
              </SettingsRow>
              <SettingsRow
                description={t("Стиль ответов для новых задач.")}
                label="Personality"
                labelFor="settings-personality"
              >
                <select
                  disabled={!selectedTaskModel?.supportsPersonality || taskDefaultsSaving}
                  id="settings-personality"
                  value={taskDefaults.personality ?? ""}
                  onChange={(event) =>
                    setTaskDefaults((current) => ({
                      ...current,
                      personality: event.target.value || undefined,
                    }))
                  }
                >
                  <option value="">{t("По умолчанию")}</option>
                  {taskDefaults.personality &&
                    !["friendly", "pragmatic", "none"].includes(taskDefaults.personality) && (
                      <option value={taskDefaults.personality}>
                        {taskDefaults.personality} — {t("Недоступна")}
                      </option>
                    )}
                  <option value="friendly">{t("Дружелюбная")}</option>
                  <option value="pragmatic">{t("Прагматичная")}</option>
                  <option value="none">{t("Без personality")}</option>
                </select>
              </SettingsRow>
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
            </SettingsGroup>

            <SettingsGroup
              as="form"
              description={t("Выбранный режим применяется ко всем задачам со следующего хода.")}
              icon={<ShieldIcon />}
              title={t("Разрешения Codex")}
              onSubmit={save}
            >
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
            </SettingsGroup>
          </div>

          <div
            aria-labelledby="settings-section-tab-skills"
            className="settings-stack"
            hidden={activeSection !== "skills"}
            id="settings-section-panel-skills"
            role="tabpanel"
          >
            <SkillsSettingsCard
              projects={state?.snapshot?.projects ?? []}
              skillsEpoch={state?.skillsEpoch ?? 0}
            />
          </div>

          <div
            aria-labelledby="settings-section-tab-connection"
            className="settings-stack"
            hidden={activeSection !== "connection"}
            id="settings-section-panel-connection"
            role="tabpanel"
          >
            <ProxySettingsCard />

            <SettingsGroup
              description={t("Подключение к CodexNest на этом устройстве.")}
              icon={<ServerIcon />}
              title={t("Сервер")}
            >
              <SettingsRow label={t("Сервер")}>
                <button type="button" onClick={onSwitchServer}>
                  {t("Сменить сервер")}
                </button>
              </SettingsRow>
            </SettingsGroup>
          </div>

          <div
            aria-labelledby="settings-section-tab-maintenance"
            className="settings-stack"
            hidden={activeSection !== "maintenance"}
            id="settings-section-panel-maintenance"
            role="tabpanel"
          >
            <ApplicationSettingsCard
              initialStatus={initialAppUpdateStatus}
              onStatusChange={acceptAppUpdateStatus}
            />
            <CodexSettingsCard />
            <RecoverySettingsCard appStatus={appUpdateStatus} codexStatus={codexManagementStatus} />
          </div>
        </CodexSettingsProvider>
      </section>
    </div>
  );
}

function editableTaskDefaults(value: TaskDefaults): EditableTaskDefaults {
  const next = { ...value };
  delete next.serviceTier;
  return next;
}

function taskDefaultsForModel(
  value: EditableTaskDefaults,
  models: ModelOption[],
): EditableTaskDefaults {
  const defaultModel = models.find((model) => model.isDefault) ?? models[0];
  const selectedModel = value.model ? models.find((model) => model.id === value.model) : undefined;
  const effectiveModel = selectedModel ?? defaultModel;
  if (!effectiveModel) return value;
  const next = { ...value };
  if (next.personality && !effectiveModel.supportsPersonality) delete next.personality;
  return next;
}

function taskDefaultsPatch(
  saved: EditableTaskDefaults,
  current: EditableTaskDefaults,
): UpdateTaskDefaultsRequest {
  return {
    ...(saved.model !== current.model ? { model: current.model ?? null } : {}),
    ...(saved.titleModel !== current.titleModel ? { titleModel: current.titleModel ?? null } : {}),
    ...(saved.personality !== current.personality
      ? { personality: current.personality ?? null }
      : {}),
  };
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
    <SettingsGroup
      description={t("Эти настройки общие для всех клиентов и сохраняются на сервере.")}
      icon={<MicrophoneIcon />}
      title={t("Распознавание речи")}
    >
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
          <SettingsRow
            description={t("Где обрабатывается записанное аудио.")}
            label={t("Провайдер")}
            labelFor="settings-transcription-provider"
          >
            <select
              aria-label={t("Провайдер распознавания речи")}
              disabled={saving}
              id="settings-transcription-provider"
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
          </SettingsRow>

          {form.provider === "local" && (
            <div className="transcription-provider-settings">
              <SettingsRow
                description={t("HTTP-адрес сервиса распознавания на вашем сервере.")}
                label={t("URL локального STT")}
                labelFor="settings-local-stt-url"
              >
                <input
                  aria-label={t("URL локального STT")}
                  disabled={saving}
                  id="settings-local-stt-url"
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
              </SettingsRow>
              <SettingsRow
                label={t("Расставлять пунктуацию и исправлять очевидные ошибки через Codex")}
              >
                <label className="check settings-check-control">
                  <input
                    checked={form.refineLocal}
                    disabled={saving}
                    type="checkbox"
                    onChange={(event) =>
                      setForm((current) => ({ ...current, refineLocal: event.target.checked }))
                    }
                  />
                  <span className="sr-only">
                    {t("Расставлять пунктуацию и исправлять очевидные ошибки через Codex")}
                  </span>
                </label>
              </SettingsRow>
              {form.refineLocal && (
                <SettingsRow label={t("Модель улучшения")} labelFor="settings-refinement-model">
                  <select
                    aria-label={t("Модель улучшения расшифровки")}
                    disabled={saving}
                    id="settings-refinement-model"
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
                </SettingsRow>
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
              <SettingsRow label={t("Модель OpenAI")} labelFor="settings-openai-stt-model">
                <select
                  aria-label={t("Модель распознавания OpenAI")}
                  disabled={saving}
                  id="settings-openai-stt-model"
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
              </SettingsRow>
              <SettingsRow
                description={t("Хранится на сервере и не возвращается в интерфейс.")}
                label="OpenAI API key"
                labelFor="settings-openai-api-key"
              >
                <span className="codex-proxy-input">
                  <input
                    aria-label="OpenAI API key"
                    autoComplete="off"
                    disabled={!secure || saving}
                    id="settings-openai-api-key"
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
              </SettingsRow>
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

          <SettingsRow
            description={t("Код языка аудио, например ru или en.")}
            label={t("Язык")}
            labelFor="settings-transcription-language"
          >
            <input
              aria-label={t("Язык распознавания")}
              disabled={saving}
              id="settings-transcription-language"
              maxLength={32}
              placeholder="ru"
              spellCheck={false}
              value={form.language ?? ""}
              onChange={(event) =>
                setForm((current) => ({ ...current, language: event.target.value || null }))
              }
            />
          </SettingsRow>

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
    </SettingsGroup>
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
