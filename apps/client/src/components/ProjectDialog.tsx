import { type FormEvent, useState } from "react";

import { useConnection } from "../connection";
import { FolderIcon, XIcon } from "./Icons";

export function ProjectDialog({ onClose }: { onClose(): void }) {
  const { api } = useConnection();
  const [displayName, setDisplayName] = useState("");
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createProject({ displayName, path });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось добавить проект");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form
        className="modal compact"
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="row-between">
          <div>
            <span className="dialog-eyebrow">Рабочая папка</span>
            <h2>Добавить проект</h2>
          </div>
          <button type="button" className="icon-button" aria-label="Закрыть" onClick={onClose}>
            <XIcon />
          </button>
        </div>
        <label>
          Название
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            required
          />
        </label>
        <label>
          Абсолютный путь на Pi
          <input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/home/pi/git/project"
            required
          />
        </label>
        {error && <div className="error-banner">{error}</div>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Отмена
          </button>
          <button className="primary" disabled={busy}>
            <FolderIcon /> {busy ? "Проверяем…" : "Добавить"}
          </button>
        </div>
      </form>
    </div>
  );
}
