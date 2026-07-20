import { type FormEvent, useState } from "react";

import { ApiClient } from "../api";
import { normalizeBaseUrl, saveConnectionSettings, type ConnectionSettings } from "../storage";

export function SetupScreen({ onConnected }: { onConnected(settings: ConnectionSettings): void }) {
  const [baseUrl, setBaseUrl] = useState("http://");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const settings = { baseUrl: normalizeBaseUrl(baseUrl), token: token.trim() };
      if (!settings.token) throw new Error("Введите bearer token");
      const api = new ApiClient(settings);
      await api.health();
      await api.summary();
      await saveConnectionSettings(settings);
      onConnected(settings);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось сохранить подключение");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="setup-page">
      <form className="setup-card" onSubmit={submit}>
        <div className="brand-mark">CN</div>
        <h1>Подключение к CodexNest</h1>
        <p className="muted">Укажите адрес Raspberry Pi в локальной сети и общий token.</p>
        <label>
          Адрес сервера
          <input
            type="url"
            inputMode="url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="http://192.168.1.42:4310"
            autoCapitalize="none"
            required
          />
        </label>
        <label>
          Bearer token
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {baseUrl.trim().startsWith("http://") && (
          <div className="warning">
            HTTP не шифрует token и содержимое сессий. Используйте только доверенную LAN.
          </div>
        )}
        {error && <div className="error-banner">{error}</div>}
        <button className="primary" disabled={busy} type="submit">
          {busy ? "Проверяем…" : "Подключиться"}
        </button>
      </form>
    </main>
  );
}
