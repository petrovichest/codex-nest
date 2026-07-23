import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

import type { CodexManagementStatus } from "@codexnest/protocol";

import { useConnection } from "../connection";
import { ToolIcon } from "./Icons";

type Action = "checking" | "proxy" | "updating" | "restarting" | null;
type Feedback = { kind: "error" | "success"; message: string } | null;

type CodexSettingsContextValue = {
  status: CodexManagementStatus | null;
  loading: boolean;
  action: Action;
  proxy: string;
  showProxy: boolean;
  loadError: string | null;
  codexFeedback: Feedback;
  proxyFeedback: Feedback;
  activeTurnCount: number;
  secure: boolean;
  supported: boolean;
  busy: boolean;
  maintenanceDisabled: boolean;
  setProxy(value: string): void;
  setShowProxy(value: boolean | ((current: boolean) => boolean)): void;
  applyProxy(event: FormEvent): Promise<void>;
  check(): Promise<void>;
  update(): Promise<void>;
  restart(): Promise<void>;
};

const CodexSettingsContext = createContext<CodexSettingsContextValue | null>(null);

export function CodexSettingsProvider({ children }: { children: ReactNode }) {
  const { api, state } = useConnection();
  const [status, setStatus] = useState<CodexManagementStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<Action>(null);
  const [proxy, setProxy] = useState("");
  const [showProxy, setShowProxy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [codexFeedback, setCodexFeedback] = useState<Feedback>(null);
  const [proxyFeedback, setProxyFeedback] = useState<Feedback>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setStatus(await api.readCodexSettings());
    } catch (caught) {
      setLoadError(errorMessage(caught, "Не удалось загрузить состояние Codex"));
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
    await perform("proxy", "proxy", async () => {
      const updated = await api.updateCodexProxy({ proxy });
      setStatus(updated);
      setProxy("");
      setShowProxy(false);
      setProxyFeedback({
        kind: "success",
        message: "Прокси проверен и применён. Codex daemon готов к работе.",
      });
    });
  }

  async function check() {
    await perform("checking", "codex", async () => {
      const updated = await api.checkCodex();
      setStatus(updated);
      setCodexFeedback({
        kind: "success",
        message: "Проверка Codex и соединения через прокси завершена.",
      });
    });
  }

  async function update() {
    if (!window.confirm("Обновить Codex и перезапустить daemon?")) return;
    await perform("updating", "codex", async () => {
      const updated = await api.updateCodex();
      setStatus(updated);
      setCodexFeedback({
        kind: "success",
        message: "Codex обновлён, проверен через прокси и перезапущен.",
      });
    });
  }

  async function restart() {
    if (!window.confirm("Перезапустить Codex daemon?")) return;
    await perform("restarting", "codex", async () => {
      const updated = await api.restartCodex();
      setStatus(updated);
      setCodexFeedback({ kind: "success", message: "Codex daemon перезапущен." });
    });
  }

  async function perform(
    nextAction: Exclude<Action, null>,
    target: "codex" | "proxy",
    task: () => Promise<void>,
  ) {
    setAction(nextAction);
    if (target === "codex") setCodexFeedback(null);
    else setProxyFeedback(null);
    try {
      await task();
    } catch (caught) {
      const feedback: Feedback = {
        kind: "error",
        message: errorMessage(caught, "Операция Codex завершилась ошибкой"),
      };
      if (target === "codex") setCodexFeedback(feedback);
      else setProxyFeedback(feedback);
      try {
        setStatus(await api.readCodexSettings());
      } catch {
        // Keep the operation error visible when refreshing status also fails.
      }
    } finally {
      setAction(null);
    }
  }

  return (
    <CodexSettingsContext.Provider
      value={{
        status,
        loading,
        action,
        proxy,
        showProxy,
        loadError,
        codexFeedback,
        proxyFeedback,
        activeTurnCount,
        secure,
        supported,
        busy,
        maintenanceDisabled,
        setProxy,
        setShowProxy,
        applyProxy,
        check,
        update,
        restart,
      }}
    >
      {children}
    </CodexSettingsContext.Provider>
  );
}

export function CodexSettingsCard() {
  const {
    status,
    loading,
    action,
    loadError,
    codexFeedback,
    activeTurnCount,
    supported,
    busy,
    maintenanceDisabled,
    check,
    update,
    restart,
  } = useCodexSettings();

  return (
    <section className="settings-card codex-settings-card">
      <div className="settings-card-heading">
        <span className="settings-card-icon">
          <ToolIcon />
        </span>
        <div>
          <h2>Codex CLI</h2>
          <p>Версия и состояние Codex daemon на сервере.</p>
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
              <dt>Установленная версия Codex CLI</dt>
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
              <dt>Актуальная версия Codex CLI</dt>
              <dd>{status?.latestVersion ?? "Не проверялась"}</dd>
            </div>
          </dl>

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
          {loadError && (
            <div className="settings-notice danger" role="alert">
              {loadError}
            </div>
          )}
          <SettingsFeedback feedback={codexFeedback} />

          <div className="settings-actions codex-actions">
            <button disabled={!supported || busy} type="button" onClick={() => void check()}>
              {action === "checking" ? "Проверяем…" : "Проверить Codex CLI"}
            </button>
            <button
              disabled={maintenanceDisabled || status?.updateAvailable !== true}
              type="button"
              onClick={() => void update()}
            >
              {action === "updating" ? "Обновляем…" : "Обновить Codex CLI"}
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

export function ProxySettingsCard() {
  const {
    status,
    loading,
    action,
    proxy,
    showProxy,
    loadError,
    proxyFeedback,
    secure,
    supported,
    busy,
    maintenanceDisabled,
    setProxy,
    setShowProxy,
    applyProxy,
  } = useCodexSettings();

  return (
    <section className="settings-card codex-settings-card">
      <div className="settings-card-heading">
        <span className="settings-card-icon">
          <ToolIcon />
        </span>
        <div>
          <h2>Прокси</h2>
          <p>Внутренние запросы Codex идут через fail-closed прокси; команды агента — напрямую.</p>
        </div>
      </div>

      {loading ? (
        <div className="settings-loading compact">
          <span className="spinner small" /> Получаем состояние прокси…
        </div>
      ) : (
        <>
          <div className="codex-proxy-summary">
            <strong>Текущий прокси</strong>
            <span>{proxySummary(status)}</span>
          </div>

          {status?.networkStatus === "ok" && (
            <div className="settings-notice success" role="status">
              WebSocket ChatGPT/OpenAI доступен через прокси.
            </div>
          )}
          {!secure && (
            <div className="settings-notice danger" role="alert">
              Ввод прокси с паролем доступен только через HTTPS или локальное подключение.
            </div>
          )}
          {loadError && (
            <div className="settings-notice danger" role="alert">
              {loadError}
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

          <SettingsFeedback feedback={proxyFeedback} />
        </>
      )}
    </section>
  );
}

function useCodexSettings(): CodexSettingsContextValue {
  const value = useContext(CodexSettingsContext);
  if (!value) throw new Error("Codex settings cards must be inside CodexSettingsProvider");
  return value;
}

function SettingsFeedback({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  return (
    <div
      className={`settings-notice ${feedback.kind === "error" ? "danger" : "success"}`}
      role={feedback.kind === "error" ? "alert" : "status"}
    >
      {feedback.message}
    </div>
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
