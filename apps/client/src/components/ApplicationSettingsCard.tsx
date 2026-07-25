import { useCallback, useEffect, useRef, useState } from "react";

import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import type { AppUpdateStatus } from "@codexnest/protocol";

import { useConnection } from "../connection";
import { localizeKnownServerText, useI18n, type Translate } from "../i18n";
import { openDownloadUrl } from "../downloads";
import { ServerIcon } from "./Icons";

type Action = "checking" | "updating" | null;

const LATEST_ANDROID_APK_URL =
  "https://github.com/petrovichest/codex-nest/releases/download/android-latest/CodexNest-latest.apk";

export function ApplicationSettingsCard({
  onStatusChange,
}: {
  onStatusChange?(status: AppUpdateStatus): void;
}) {
  const { api, state } = useConnection();
  const { language, t } = useI18n();
  const localizationRef = useRef({ language, t });
  localizationRef.current = { language, t };
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<Action>(null);
  const [error, setError] = useState<string | null>(null);
  const [apkVersion, setApkVersion] = useState<string | null>(null);
  const [apkVersionFailed, setApkVersionFailed] = useState(false);
  const nativePlatform = Capacitor.isNativePlatform();
  const apkVersionLabel = nativePlatform
    ? (apkVersion ?? (apkVersionFailed ? t("Не удалось определить") : t("Определяем…")))
    : t("Только в Android");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.readAppSettings();
      setStatus(next);
      onStatusChange?.(next);
      setError(null);
    } catch (caught) {
      const localization = localizationRef.current;
      setError(
        message(
          caught,
          localization.t("Не удалось получить состояние CodexNest"),
          localization.language,
        ),
      );
    } finally {
      setLoading(false);
    }
  }, [api, onStatusChange]);

  useEffect(() => {
    if (state.network !== "connected") return;
    void load();
  }, [load, state.network]);

  useEffect(() => {
    if (!nativePlatform) return;
    let active = true;
    void CapacitorApp.getInfo()
      .then((info) => {
        if (active) setApkVersion(`${info.version} (${info.build})`);
      })
      .catch(() => {
        if (active) setApkVersionFailed(true);
      });
    return () => {
      active = false;
    };
  }, [nativePlatform]);

  useEffect(() => {
    if (!status || status.operation === "idle") return;
    const timer = window.setInterval(() => {
      void api
        .readAppSettings()
        .then((updated) => {
          setStatus(updated);
          onStatusChange?.(updated);
          if (updated.operation === "idle") setAction(null);
        })
        .catch(() => undefined);
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [api, onStatusChange, status]);

  async function check() {
    setAction("checking");
    setError(null);
    try {
      const next = await api.checkAppUpdate();
      setStatus(next);
      onStatusChange?.(next);
    } catch (caught) {
      setError(message(caught, t("Не удалось проверить обновления CodexNest"), language));
    } finally {
      setAction(null);
    }
  }

  async function update() {
    const target = status?.latestVersion
      ? t(" до версии {{version}}", { version: status.latestVersion })
      : "";
    if (
      !window.confirm(
        t("Обновить CodexNest{{target}}? Интерфейс ненадолго переподключится.", { target }),
      )
    ) {
      return;
    }
    setAction("updating");
    setError(null);
    try {
      const next = await api.updateApp();
      setStatus(next);
      onStatusChange?.(next);
    } catch (caught) {
      setAction(null);
      setError(message(caught, t("Не удалось запустить обновление CodexNest"), language));
    }
  }

  async function downloadApk() {
    setError(null);
    try {
      await openDownloadUrl(api.settings.baseUrl, LATEST_ANDROID_APK_URL);
    } catch {
      setError(t("Не удалось открыть загрузку APK"));
    }
  }

  const activeTurnCount =
    state.snapshot?.threads.filter((thread) => thread.currentTurnId !== null).length ?? 0;
  const busy = action !== null || (status !== null && status.operation !== "idle");

  return (
    <section className="settings-card application-settings-card">
      <div className="settings-card-heading">
        <span className="settings-card-icon">
          <ServerIcon />
        </span>
        <div>
          <h2>{t("Обновление CodexNest")}</h2>
          <p>
            {t("Сервер и APK обновляются из одной проверенной CI-сборки с автоматическим откатом.")}
          </p>
        </div>
      </div>

      {loading ? (
        <div className="settings-loading compact">
          <span className="spinner small" /> {t("Получаем версию CodexNest…")}
        </div>
      ) : (
        <>
          <dl className="codex-status-grid">
            <div>
              <dt>{t("Установлено на сервере")}</dt>
              <dd>{status?.currentVersion ?? "—"}</dd>
            </div>
            <div>
              <dt>{t("Актуальная версия в GitHub")}</dt>
              <dd>{status?.latestVersion ?? t("Не проверялась")}</dd>
            </div>
            <div>
              <dt>{t("APK на этом устройстве")}</dt>
              <dd>{apkVersionLabel}</dd>
            </div>
            <div>
              <dt>{t("Состояние")}</dt>
              <dd>{operationLabel(status?.operation, t)}</dd>
            </div>
            <div>
              <dt>{t("Результат")}</dt>
              <dd>{resultLabel(status?.result, t)}</dd>
            </div>
          </dl>

          {!status?.supported && (
            <div className="settings-notice warning" role="status">
              {status?.message
                ? (localizeKnownServerText(language, status.message) ?? status.message)
                : t("Обновления доступны только для установки через install.sh.")}
            </div>
          )}
          {status?.supported && status.message && (
            <div
              className={`settings-notice ${status.result === "failed" ? "danger" : "success"}`}
              role={status.result === "failed" ? "alert" : "status"}
            >
              {localizeKnownServerText(language, status.message) ?? status.message}
            </div>
          )}
          {activeTurnCount > 0 && (
            <div className="settings-notice warning" role="status">
              {t("Дождитесь завершения активных ответов: {{count}}.", {
                count: activeTurnCount,
              })}
            </div>
          )}
          {error && (
            <div className="settings-notice danger" role="alert">
              {error}
            </div>
          )}

          <div className="settings-actions codex-actions">
            <button type="button" onClick={() => void downloadApk()}>
              {t("Скачать свежий APK")}
            </button>
            <button
              disabled={!status?.supported || busy}
              type="button"
              onClick={() => void check()}
            >
              {action === "checking" ? t("Проверяем…") : t("Проверить обновления")}
            </button>
            <button
              className="primary"
              disabled={
                !status?.supported ||
                busy ||
                activeTurnCount > 0 ||
                status?.updateAvailable !== true
              }
              type="button"
              onClick={() => void update()}
            >
              {action === "updating" || (status !== null && status.operation !== "idle")
                ? t("Обновляем…")
                : t("Обновить CodexNest")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function operationLabel(operation: AppUpdateStatus["operation"] | undefined, t: Translate): string {
  if (!operation || operation === "idle") return t("Готово");
  if (operation === "checking") return t("Проверка");
  if (operation === "preparing") return t("Подготовка");
  if (operation === "building") return t("Сборка");
  if (operation === "switching") return t("Переключение версии");
  return t("Перезапуск");
}

function resultLabel(result: AppUpdateStatus["result"] | undefined, t: Translate): string {
  if (result === "updated") return t("Обновлено");
  if (result === "rolled_back") return t("Выполнен откат");
  if (result === "failed") return t("Ошибка");
  return "—";
}

function message(error: unknown, fallback: string, language: "en" | "ru"): string {
  return error instanceof Error
    ? (localizeKnownServerText(language, error.message) ?? error.message)
    : fallback;
}
