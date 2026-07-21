import { type FormEvent, useCallback, useEffect, useState } from "react";

import type { CodexManagementStatus } from "@codexnest/protocol";

import { useConnection } from "../connection";
import { ToolIcon } from "./Icons";

type Action = "checking" | "proxy" | "updating" | "restarting" | null;

export function CodexSettingsCard() {
  const { api, state } = useConnection();
  const [status, setStatus] = useState<CodexManagementStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<Action>(null);
  const [proxy, setProxy] = useState("");
  const [showProxy, setShowProxy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await api.readCodexSettings());
    } catch (caught) {
      setError(errorMessage(caught, "Не удалось загрузить состояние Codex"));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!status || status.operation === "idle") return;
    const timer = window.setTimeout(() => {
      void api
        .readCodexSettings()
        .then(setStatus)
        .catch(() => undefined);
    }, 1_000);
    return () => window.clearTimeout(timer);
  }, [api, status]);

  const liveThreads = state?.snapshot?.threads;
  const activeTurnCount = liveThreads
    ? liveThreads.filter((thread) => thread.currentTurnId !== null).length
    : (status?.activeTurnCount ?? 0);
  const secure = secureServerUrl(api.settings.baseUrl);
  const supported = status?.supported ?? false;
  const busy = action !== null || (status !== null && status.operation !== "idle");
  const maintenanceDisabled = !supported || busy || activeTurnCount > 0;

  async function applyProxy(event: FormEvent) {
    event.preventDefault();
    if (!secure || !proxy.trim()) return;
    await perform("proxy", async () => {
      const updated = await api.updateCodexProxy({ proxy });
      setStatus(updated);
      setProxy("");
      setShowProxy(false);
      setNotice("Прокси проверен и применён. Codex daemon готов к работе.");
    });
  }

  async function check() {
    await perform("checking", async () => {
      const updated = await api.checkCodex();
      setStatus(updated);
      setNotice("Проверка Codex и соединения через прокси завершена.");
    });
  }

  async function update() {
    if (!window.confirm("Обновить Codex и перезапустить daemon?")) return;
    await perform("updating", async () => {
      const updated = await api.updateCodex();
      setStatus(updated);
      setNotice("Codex обновлён, проверен через прокси и перезапущен.");
    });
  }

  async function restart() {
    if (!window.confirm("Перезапустить Codex daemon?")) return;
    await perform("restarting", async () => {
      const updated = await api.restartCodex();
      setStatus(updated);
      setNotice("Codex daemon перезапущен.");
    });
  }

  async function perform(nextAction: Exclude<Action, null>, task: () => Promise<void>) {
    setAction(nextAction);
    setError(null);
    setNotice(null);
    try {
      await task();
    } catch (caught) {
      setError(errorMessage(caught, "Операция Codex завершилась ошибкой"));
      await load().catch(() => undefined);
    } finally {
      setAction(null);
    }
  }

  return (
    <section className="settings-card codex-settings-card">
      <div className="settings-card-heading">
        <span className="settings-card-icon">
          <ToolIcon />
        </span>
        <div>
          <h2>Codex и прокси</h2>
          <p>Внутренние запросы Codex идут через fail-closed прокси; команды агента — напрямую.</p>
        </div>
      </div>

      {loading ? (
        <div className="settings-loading compact">
          <span className="spinner small" /> Получаем состояние Codex…
        </div>
      ) : (
        <>
          <dl className="codex-status-grid">
            <div>
              <dt>CLI</dt>
              <dd>{status?.cliVersion ?? "—"}</dd>
            </div>
            <div>
              <dt>Daemon</dt>
              <dd>{status?.appServerVersion ?? "—"}</dd>
            </div>
            <div>
              <dt>Состояние</dt>
              <dd>{daemonLabel(status?.daemonStatus)}</dd>
            </div>
            <div>
              <dt>Последняя версия</dt>
              <dd>{status?.latestVersion ?? "Не проверялась"}</dd>
            </div>
          </dl>

          <div className="codex-proxy-summary">
            <strong>Текущий прокси</strong>
            <span>{proxySummary(status)}</span>
          </div>

          {status?.networkStatus === "ok" && (
            <div className="settings-notice success" role="status">
              WebSocket ChatGPT/OpenAI доступен через прокси.
            </div>
          )}
          {status?.unavailableReason && (
            <div className="settings-notice warning" role="status">
              {status.unavailableReason}
            </div>
          )}
          {activeTurnCount > 0 && (
            <div className="settings-notice warning" role="status">
              Дождитесь завершения активных ответов: {activeTurnCount}.
            </div>
          )}
          {!secure && (
            <div className="settings-notice danger" role="alert">
              Ввод прокси с паролем доступен только через HTTPS или локальное подключение.
            </div>
          )}

          <form className="codex-proxy-form" onSubmit={applyProxy}>
            <label>
              <span>Новый HTTP/HTTPS-прокси</span>
              <span className="codex-proxy-input">
                <input
                  autoComplete="off"
                  disabled={!supported || busy || !secure}
                  placeholder="host:port:user:password"
                  spellCheck={false}
                  type={showProxy ? "text" : "password"}
                  value={proxy}
                  onChange={(event) => setProxy(event.target.value)}
                />
                <button
                  disabled={!proxy}
                  type="button"
                  onClick={() => setShowProxy((current) => !current)}
                >
                  {showProxy ? "Скрыть" : "Показать"}
                </button>
              </span>
            </label>
            <small>
              Форматы: host:port, host:port:user:password, user:password@host:port или полный URL.
            </small>
            <div className="settings-actions codex-actions">
              <button
                className="primary"
                disabled={maintenanceDisabled || !secure || !proxy.trim()}
                type="submit"
              >
                {action === "proxy" ? "Проверяем и применяем…" : "Проверить и применить"}
              </button>
            </div>
          </form>

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

          <div className="settings-actions codex-actions">
            <button disabled={!supported || busy} type="button" onClick={() => void check()}>
              {action === "checking" ? "Проверяем…" : "Проверить версию"}
            </button>
            <button
              disabled={maintenanceDisabled || status?.updateAvailable !== true}
              type="button"
              onClick={() => void update()}
            >
              {action === "updating" ? "Обновляем…" : "Обновить Codex"}
            </button>
            <button disabled={maintenanceDisabled} type="button" onClick={() => void restart()}>
              {action === "restarting" ? "Перезапускаем…" : "Перезапустить"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function proxySummary(status: CodexManagementStatus | null): string {
  const proxy = status?.proxy;
  if (!proxy) return "—";
  if (proxy.error) return proxy.error;
  if (!proxy.configured) return "Не настроен";
  const user = proxy.username ? ` · ${proxy.username}` : "";
  const password = proxy.hasPassword ? " · пароль сохранён" : "";
  return `${proxy.protocol}://${proxy.host}:${proxy.port}${user}${password}`;
}

function daemonLabel(value: string | undefined): string {
  if (value === "running") return "Работает";
  if (value === "unsupported") return "Не поддерживается";
  if (!value || value === "unavailable") return "Недоступен";
  return value;
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

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
