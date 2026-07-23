import { useCallback, useEffect, useState } from "react";

import type { AppUpdateStatus } from "@codexnest/protocol";

import { useConnection } from "../connection";
import { openDownloadUrl } from "../downloads";
import { ServerIcon } from "./Icons";

type Action = "checking" | "updating" | null;

const LATEST_ANDROID_APK_URL =
  "https://github.com/petrovichest/codex-nest/releases/download/android-latest/CodexNest-latest.apk";

export function ApplicationSettingsCard() {
  const { api, state } = useConnection();
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<Action>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await api.readAppSettings());
      setError(null);
    } catch (caught) {
      setError(message(caught, "Не удалось получить состояние CodexNest"));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (state.network !== "connected") return;
    void load();
  }, [load, state.network]);

  useEffect(() => {
    if (!status || status.operation === "idle") return;
    const timer = window.setInterval(() => {
      void api
        .readAppSettings()
        .then((updated) => {
          setStatus(updated);
          if (updated.operation === "idle") setAction(null);
        })
        .catch(() => undefined);
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [api, status]);

  async function check() {
    setAction("checking");
    setError(null);
    try {
      setStatus(await api.checkAppUpdate());
    } catch (caught) {
      setError(message(caught, "Не удалось проверить обновления CodexNest"));
    } finally {
      setAction(null);
    }
  }

  async function update() {
    const target = status?.latestVersion ? ` до версии ${status.latestVersion}` : "";
    if (!window.confirm(`Обновить CodexNest${target}? Интерфейс ненадолго переподключится.`)) {
      return;
    }
    setAction("updating");
    setError(null);
    try {
      setStatus(await api.updateApp());
    } catch (caught) {
      setAction(null);
      setError(message(caught, "Не удалось запустить обновление CodexNest"));
    }
  }

  async function downloadApk() {
    setError(null);
    try {
      await openDownloadUrl(api.settings.baseUrl, LATEST_ANDROID_APK_URL);
    } catch {
      setError("Не удалось открыть загрузку APK");
    }
  }

  const busy = action !== null || (status !== null && status.operation !== "idle");

  return (
    <section className="settings-card application-settings-card">
      <div className="settings-card-heading">
        <span className="settings-card-icon">
          <ServerIcon />
        </span>
        <div>
          <h2>Обновление CodexNest</h2>
          <p>Сервер и APK обновляются из одной проверенной CI-сборки с автоматическим откатом.</p>
        </div>
      </div>

      {loading ? (
        <div className="settings-loading compact">
          <span className="spinner small" /> Получаем версию CodexNest…
        </div>
      ) : (
        <>
          <dl className="codex-status-grid">
            <div>
              <dt>Текущая версия</dt>
              <dd>{status?.currentVersion ?? "—"}</dd>
            </div>
            <div>
              <dt>Последняя rolling-версия</dt>
              <dd>{status?.latestVersion ?? "Не проверялась"}</dd>
            </div>
            <div>
              <dt>Состояние</dt>
              <dd>{operationLabel(status?.operation)}</dd>
            </div>
            <div>
              <dt>Результат</dt>
              <dd>{resultLabel(status?.result)}</dd>
            </div>
          </dl>

          {!status?.supported && (
            <div className="settings-notice warning" role="status">
              {status?.message ?? "Обновления доступны только для установки через install.sh."}
            </div>
          )}
          {status?.supported && status.message && (
            <div
              className={`settings-notice ${status.result === "failed" ? "danger" : "success"}`}
              role={status.result === "failed" ? "alert" : "status"}
            >
              {status.message}
            </div>
          )}
          {error && (
            <div className="settings-notice danger" role="alert">
              {error}
            </div>
          )}

          <div className="settings-actions codex-actions">
            <button type="button" onClick={() => void downloadApk()}>
              Скачать свежий APK
            </button>
            <button
              disabled={!status?.supported || busy}
              type="button"
              onClick={() => void check()}
            >
              {action === "checking" ? "Проверяем…" : "Проверить обновления"}
            </button>
            <button
              className="primary"
              disabled={!status?.supported || busy || status?.updateAvailable !== true}
              type="button"
              onClick={() => void update()}
            >
              {action === "updating" || (status !== null && status.operation !== "idle")
                ? "Обновляем…"
                : "Обновить CodexNest"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function operationLabel(operation: AppUpdateStatus["operation"] | undefined): string {
  if (!operation || operation === "idle") return "Готово";
  if (operation === "checking") return "Проверка";
  if (operation === "preparing") return "Подготовка";
  if (operation === "building") return "Сборка";
  if (operation === "switching") return "Переключение версии";
  return "Перезапуск";
}

function resultLabel(result: AppUpdateStatus["result"] | undefined): string {
  if (result === "updated") return "Обновлено";
  if (result === "rolled_back") return "Выполнен откат";
  if (result === "failed") return "Ошибка";
  return "—";
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
