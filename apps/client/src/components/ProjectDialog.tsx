import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import type { DirectoryListing } from "@codexnest/protocol";

import { useConnection } from "../connection";
import { ArrowLeftIcon, ChevronRightIcon, FolderIcon, PlusIcon, XIcon } from "./Icons";

type Operation = "loading" | "creating" | "selecting" | null;

export function ProjectDialog({ onClose }: { onClose(): void }) {
  const { api } = useConnection();
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [operation, setOperation] = useState<Operation>("loading");
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [directoryName, setDirectoryName] = useState("");
  const busy = operation !== null;

  const openDirectory = useCallback(
    async (path?: string) => {
      setOperation("loading");
      setError(null);
      try {
        setListing(await api.listDirectories(path));
        setShowCreate(false);
        setDirectoryName("");
      } catch (caught) {
        setError(messageFor(caught, "Не удалось открыть папку"));
      } finally {
        setOperation(null);
      }
    },
    [api],
  );

  useEffect(() => {
    void openDirectory();
  }, [openDirectory]);

  const visibleDirectories = useMemo(
    () => listing?.directories.filter((entry) => showHidden || !entry.name.startsWith(".")) ?? [],
    [listing, showHidden],
  );

  async function createNewDirectory(event: FormEvent) {
    event.preventDefault();
    if (!listing || !directoryName.trim()) return;
    setOperation("creating");
    setError(null);
    try {
      const created = await api.createDirectory({
        parentPath: listing.path,
        name: directoryName,
      });
      setListing(created);
      setShowCreate(false);
      setDirectoryName("");
    } catch (caught) {
      setError(messageFor(caught, "Не удалось создать папку"));
    } finally {
      setOperation(null);
    }
  }

  async function selectDirectory() {
    if (!listing) return;
    setOperation("selecting");
    setError(null);
    try {
      await api.createProject({ path: listing.path });
      onClose();
    } catch (caught) {
      setError(messageFor(caught, "Не удалось добавить проект"));
      setOperation(null);
    }
  }

  return (
    <div
      className="modal-backdrop project-browser-backdrop"
      role="presentation"
      onMouseDown={() => !busy && onClose()}
    >
      <div
        className="modal project-browser-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="row-between">
          <div>
            <span className="dialog-eyebrow">Рабочая папка на сервере</span>
            <h2 id="project-dialog-title">Добавить проект</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Закрыть"
            disabled={busy}
            onClick={onClose}
          >
            <XIcon />
          </button>
        </div>

        <div className="project-browser-navigation">
          <button
            type="button"
            className="icon-button"
            aria-label="На уровень выше"
            disabled={busy || !listing?.parentPath}
            onClick={() => void openDirectory(listing?.parentPath ?? undefined)}
          >
            <ArrowLeftIcon />
          </button>
          <nav className="project-breadcrumbs" aria-label="Путь к папке">
            {listing ? (
              breadcrumbs(listing).map((item, index, items) => (
                <span className="project-breadcrumb" key={item.path}>
                  {index > 0 && <ChevronRightIcon />}
                  <button
                    type="button"
                    disabled={busy || index === items.length - 1}
                    onClick={() => void openDirectory(item.path)}
                  >
                    {item.label}
                  </button>
                </span>
              ))
            ) : (
              <span className="project-breadcrumb-placeholder">Домашняя папка</span>
            )}
          </nav>
          {operation === "loading" && <div className="spinner small" aria-label="Загрузка" />}
        </div>

        <div className="project-browser-controls">
          <button
            type="button"
            disabled={busy || !listing}
            onClick={() => {
              setShowCreate((value) => !value);
              setDirectoryName("");
              setError(null);
            }}
          >
            <PlusIcon /> Новая папка
          </button>
          <label className="project-hidden-toggle">
            <input
              type="checkbox"
              checked={showHidden}
              disabled={busy}
              onChange={(event) => setShowHidden(event.target.checked)}
            />
            Показывать скрытые
          </label>
        </div>

        {showCreate && listing && (
          <form className="project-directory-create" onSubmit={createNewDirectory}>
            <input
              autoFocus
              aria-label="Название новой папки"
              value={directoryName}
              disabled={busy}
              placeholder="Название новой папки"
              onChange={(event) => setDirectoryName(event.target.value)}
            />
            <button type="submit" className="primary" disabled={busy || !directoryName.trim()}>
              {operation === "creating" ? "Создаём…" : "Создать"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setShowCreate(false);
                setDirectoryName("");
              }}
            >
              Отмена
            </button>
          </form>
        )}

        {error && (
          <div className="error-banner project-browser-error">
            <span>{error}</span>
            {!listing && (
              <button type="button" disabled={busy} onClick={() => void openDirectory()}>
                Повторить
              </button>
            )}
          </div>
        )}

        <div className="project-directory-list" aria-label="Папки">
          {!listing && operation === "loading" && (
            <div className="project-directory-empty">
              <div className="spinner" />
              <span>Получаем папки с сервера…</span>
            </div>
          )}
          {listing && visibleDirectories.length === 0 && (
            <div className="project-directory-empty">
              <FolderIcon />
              <span>
                {listing.directories.length > 0
                  ? "Скрытые папки не показаны"
                  : "В этой папке нет других папок"}
              </span>
            </div>
          )}
          {visibleDirectories.map((entry) => (
            <button
              type="button"
              className="project-directory-entry"
              key={entry.path}
              disabled={busy}
              onClick={() => void openDirectory(entry.path)}
            >
              <FolderIcon />
              <span>{entry.name}</span>
              <ChevronRightIcon />
            </button>
          ))}
        </div>

        <div className="dialog-actions project-browser-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Отмена
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || !listing}
            onClick={() => void selectDirectory()}
          >
            <FolderIcon /> {operation === "selecting" ? "Добавляем…" : "Выбрать эту папку"}
          </button>
        </div>
      </div>
    </div>
  );
}

function breadcrumbs(listing: DirectoryListing): Array<{ label: string; path: string }> {
  const result = [{ label: "Домашняя", path: listing.rootPath }];
  const suffix = listing.path.slice(listing.rootPath.length);
  let path = listing.rootPath;
  for (const segment of suffix.split("/").filter(Boolean)) {
    path = path === "/" ? `/${segment}` : `${path}/${segment}`;
    result.push({ label: segment, path });
  }
  return result;
}

function messageFor(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message ? caught.message : fallback;
}
