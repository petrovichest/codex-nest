import { useCallback, useEffect, useState } from "react";

import type { ClaudeManagementStatus } from "@codexnest/protocol";

import { ApiClientError } from "../api";
import { useConnection } from "../connection";
import { ToolIcon } from "./Icons";

type Feedback = { kind: "error" | "success"; message: string } | null;

/**
 * Read-only status card for the Claude Code CLI, mirroring the Codex card's shape but with
 * Claude's smaller surface (supported / unavailableReason / cliVersion / path). CodexNest
 * neither installs nor updates Claude Code, so the only action is a re-probe («Проверить»).
 */
export function ClaudeSettingsCard() {
  const { api } = useConnection();
  const [status, setStatus] = useState<ClaudeManagementStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [serverUnsupported, setServerUnsupported] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setServerUnsupported(false);
    try {
      setStatus(await api.readClaudeSettings());
    } catch (caught) {
      // An older server predates the /settings/claude route and 404s. That is not a failure to
      // flag in red — show a neutral "unsupported on this server version" note instead.
      if (caught instanceof ApiClientError && caught.status === 404) {
        setServerUnsupported(true);
      } else {
        setLoadError(
          caught instanceof Error ? caught.message : "Не удалось загрузить состояние Claude Code",
        );
      }
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function check() {
    setChecking(true);
    setFeedback(null);
    try {
      const updated = await api.checkClaude();
      setStatus(updated);
      setFeedback(
        updated.supported
          ? { kind: "success", message: "Claude Code найден и готов к работе." }
          : { kind: "error", message: updated.unavailableReason ?? "Claude Code недоступен." },
      );
    } catch (caught) {
      setFeedback({
        kind: "error",
        message:
          caught instanceof Error ? caught.message : "Проверка Claude Code завершилась ошибкой",
      });
    } finally {
      setChecking(false);
    }
  }

  const supported = status?.supported ?? false;

  return (
    <section className="settings-card codex-settings-card">
      <div className="settings-card-heading">
        <span className="settings-card-icon">
          <ToolIcon />
        </span>
        <div>
          <h2>Claude Code CLI</h2>
          <p>Версия и состояние Claude Code на сервере.</p>
        </div>
      </div>

      {loading ? (
        <div className="settings-loading compact">
          <span className="spinner small" /> Получаем состояние Claude Code…
        </div>
      ) : serverUnsupported ? (
        <div className="settings-notice" role="status">
          Управление Claude Code недоступно на этой версии сервера.
        </div>
      ) : (
        <>
          <dl className="codex-status-grid">
            <div>
              <dt>Установленная версия Claude Code</dt>
              <dd>{status?.cliVersion ?? "—"}</dd>
            </div>
            <div>
              <dt>Путь к CLI</dt>
              <dd>{status?.path ?? "—"}</dd>
            </div>
          </dl>

          {!supported && (
            <div className="settings-notice warning" role="status">
              {status?.unavailableReason ?? "Claude Code не найден на сервере."} Установите Claude
              Code и выполните вход командой <code>claude login</code> на сервере.
            </div>
          )}
          {loadError && (
            <div className="settings-notice danger" role="alert">
              {loadError}
            </div>
          )}
          {feedback && (
            <div
              className={`settings-notice ${feedback.kind === "error" ? "danger" : "success"}`}
              role={feedback.kind === "error" ? "alert" : "status"}
            >
              {feedback.message}
            </div>
          )}

          <div className="settings-actions codex-actions">
            <button type="button" disabled={checking} onClick={() => void check()}>
              {checking ? "Проверяем…" : "Проверить"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
