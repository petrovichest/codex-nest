import { useState } from "react";

import type { GitChangesSummary, Project, ThreadSummary } from "@codexnest/protocol";

import type { SessionArtifact } from "../artifacts";
import { useI18n, type Translate } from "../i18n";
import { threadStatusClasses } from "../thread-status";
import {
  ArrowDownIcon,
  ClockIcon,
  FileIcon,
  FolderIcon,
  GitBranchIcon,
  ServerIcon,
  XIcon,
} from "./Icons";

export type GitChangesView = GitChangesSummary | "error" | null;
export type InspectorTab = "overview" | "artifacts";
export type ArtifactLoadState = "idle" | "loading" | "error";

export function SessionInspector({
  open,
  summary,
  project,
  gitChanges,
  activeTab,
  artifacts,
  artifactCapability,
  artifactLoadState,
  onClose,
  onTabChange,
  onArtifactOpen,
  onArtifactDownload,
  onArtifactRetry,
}: {
  open: boolean;
  summary: ThreadSummary;
  project: Project | null;
  gitChanges: GitChangesView;
  activeTab: InspectorTab;
  artifacts: SessionArtifact[];
  artifactCapability: "explicit" | "unavailable" | null;
  artifactLoadState: ArtifactLoadState;
  onClose(): void;
  onTabChange(tab: InspectorTab): void;
  onArtifactOpen(artifact: SessionArtifact, opener: HTMLButtonElement): void;
  onArtifactDownload(path: string): Promise<void>;
  onArtifactRetry(): void;
}) {
  const { language, t } = useI18n();
  if (!open) return null;
  const artifactsTabLabel = artifactCapability
    ? t("Артефакты, {{count}}", { count: artifacts.length })
    : t("Артефакты");
  return (
    <aside className="session-inspector open" aria-label={t("Сведения о задаче")}>
      <div className="inspector-heading">
        <strong>{t("Сессия")}</strong>
        <button className="icon-button" aria-label={t("Закрыть сведения")} onClick={onClose}>
          <XIcon />
        </button>
      </div>
      <div className="inspector-tabs" role="tablist" aria-label={t("Разделы сведений")}>
        <button
          type="button"
          id="session-overview-tab"
          role="tab"
          aria-controls="session-overview-panel"
          aria-selected={activeTab === "overview"}
          className={activeTab === "overview" ? "active" : undefined}
          onClick={() => onTabChange("overview")}
        >
          {t("Обзор")}
        </button>
        <button
          type="button"
          id="session-artifacts-tab"
          role="tab"
          aria-controls="session-artifacts-panel"
          aria-label={artifactsTabLabel}
          aria-selected={activeTab === "artifacts"}
          className={activeTab === "artifacts" ? "active" : undefined}
          onClick={() => onTabChange("artifacts")}
        >
          <span>{t("Артефакты")}</span>
          <span className="inspector-tab-count" aria-hidden="true">
            {artifactCapability ? artifacts.length : "…"}
          </span>
        </button>
      </div>

      {activeTab === "overview" ? (
        <div
          id="session-overview-panel"
          className="inspector-panel inspector-overview"
          role="tabpanel"
          aria-labelledby="session-overview-tab"
        >
          <dl className="inspector-list">
            <InspectorRow icon={<ServerIcon />} label={t("Статус")}>
              <span className={`status-label status-label-${summary.state}`}>
                <span className={threadStatusClasses(summary)} />
                {stateLabel(summary.state, t)}
              </span>
            </InspectorRow>
            <InspectorRow icon={<FolderIcon />} label={t("Проект")}>
              {project?.displayName ?? t("Без проекта")}
            </InspectorRow>
            <InspectorRow technical icon={<GitBranchIcon />} label="Git changes">
              <GitChangesValue value={gitChanges} />
            </InspectorRow>
            <InspectorRow technical icon={<ClockIcon />} label={t("Создана")}>
              {formatDate(summary.createdAt, language)}
            </InspectorRow>
            <InspectorRow technical icon={<ClockIcon />} label={t("Обновлена")}>
              {formatDate(summary.updatedAt, language)}
            </InspectorRow>
          </dl>
          <div className="inspector-path">
            <span>{t("Рабочая папка")}</span>
            <code>{summary.cwd}</code>
          </div>
        </div>
      ) : (
        <div
          id="session-artifacts-panel"
          className="inspector-panel inspector-artifacts"
          role="tabpanel"
          aria-labelledby="session-artifacts-tab"
        >
          {artifacts.length > 0 && (
            <div className="inspector-artifact-list">
              {artifacts.map((artifact) => (
                <InspectorArtifact
                  artifact={artifact}
                  key={artifact.id}
                  onDownload={onArtifactDownload}
                  onOpen={onArtifactOpen}
                />
              ))}
            </div>
          )}
          {artifactLoadState === "loading" && (
            <div className="inspector-artifact-progress" role="status">
              <span className="spinner small" />
              <span>{t("Загружаем артефакты…")}</span>
            </div>
          )}
          {artifactLoadState === "error" && (
            <div className="inspector-artifact-error" role="alert">
              <span>{t("Не удалось загрузить артефакты.")}</span>
              <button type="button" onClick={onArtifactRetry}>
                {t("Повторить")}
              </button>
            </div>
          )}
          {artifactCapability === "explicit" && artifacts.length === 0 && (
            <div className="inspector-artifact-empty">
              <span className="inspector-artifact-empty-icon">
                <FileIcon />
              </span>
              <strong>{t("В этой сессии пока нет артефактов")}</strong>
              <span>{t("Файлы появятся здесь, когда Codex приложит их к ответу.")}</span>
            </div>
          )}
          {artifactCapability === "unavailable" && (
            <div className="inspector-artifact-empty">
              <span className="inspector-artifact-empty-icon">
                <FileIcon />
              </span>
              <strong>{t("Артефакты недоступны для этой сессии")}</strong>
              <span>{t("Явные артефакты доступны в новых сессиях.")}</span>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

export function NewSessionInspector({
  open,
  project,
  onClose,
}: {
  open: boolean;
  project: Project | null;
  onClose(): void;
}) {
  const { t } = useI18n();
  if (!open) return null;
  return (
    <aside className="session-inspector open" aria-label={t("Сведения о новой задаче")}>
      <div className="inspector-heading">
        <strong>{t("Новая задача")}</strong>
        <button className="icon-button" aria-label={t("Закрыть сведения")} onClick={onClose}>
          <XIcon />
        </button>
      </div>
      <div className="inspector-panel inspector-overview new-session-inspector-panel">
        <dl className="inspector-list">
          <InspectorRow icon={<FolderIcon />} label={t("Проект")}>
            {project?.displayName ?? t("Не выбран")}
          </InspectorRow>
        </dl>
        {project && (
          <div className="inspector-path">
            <span>{t("Рабочая папка")}</span>
            <code>{project.path}</code>
          </div>
        )}
        <p className="inspector-note">
          {t("Задача будет создана после отправки первого сообщения.")}
        </p>
      </div>
    </aside>
  );
}

function InspectorArtifact({
  artifact,
  onOpen,
  onDownload,
}: {
  artifact: SessionArtifact;
  onOpen(artifact: SessionArtifact, opener: HTMLButtonElement): void;
  onDownload(path: string): Promise<void>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function download() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await onDownload(artifact.path);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const actionLabel = artifact.preview
    ? t("Открыть {{name}}", { name: artifact.fileName })
    : t("Скачать {{name}}", { name: artifact.fileName });

  return (
    <div className="inspector-artifact-item">
      <div className="inspector-artifact-row">
        <button
          type="button"
          className="inspector-artifact-open"
          data-artifact-path={artifact.path}
          aria-label={actionLabel}
          onClick={(event) => {
            if (artifact.preview) onOpen(artifact, event.currentTarget);
            else void download();
          }}
        >
          <span className="inspector-artifact-stamp">{artifactStamp(artifact)}</span>
          <span className="inspector-artifact-copy">
            <strong>{artifact.label}</strong>
            <span>{artifact.relativePath}</span>
          </span>
        </button>
        <button
          type="button"
          className="inspector-artifact-download"
          aria-label={t("Скачать {{name}}", { name: artifact.fileName })}
          disabled={busy}
          onClick={() => void download()}
        >
          {busy ? <span className="spinner small" /> : <ArrowDownIcon />}
        </button>
      </div>
      {failed && (
        <span className="download-link-error" role="alert">
          {t("Не удалось скачать файл. Нажмите ещё раз.")}
        </span>
      )}
    </div>
  );
}

function artifactStamp(artifact: SessionArtifact): string {
  const extension = artifact.fileName.split(".").at(-1)?.toUpperCase();
  if (extension === "MARKDOWN") return "MD";
  if (extension === "JPEG") return "JPG";
  return extension?.slice(0, 4) || "FILE";
}

function GitChangesValue({ value }: { value: GitChangesView }) {
  const { language, t } = useI18n();
  if (value === null) return <>{t("Загрузка…")}</>;
  if (value === "error") return <>{t("Недоступно")}</>;
  if (value.state === "notRepository") return <>{t("Не Git-репозиторий")}</>;
  if (value.state === "clean") return <>{t("Нет изменений")}</>;
  return (
    <span className="git-changes-summary">
      <span>{formatFileCount(value.filesChanged, language, t)}</span>
      <b className="diff-add">+{value.additions}</b>
      <b className="diff-delete">−{value.deletions}</b>
    </span>
  );
}

function InspectorRow({
  icon,
  label,
  technical = false,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  technical?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt>
        {icon}
        {label}
      </dt>
      <dd className={technical ? "inspector-value-technical" : undefined}>{children}</dd>
    </div>
  );
}

function formatDate(value: number, language: "en" | "ru"): string {
  return new Date(value).toLocaleString(language, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatFileCount(count: number, language: "en" | "ru", t: Translate): string {
  if (language === "en") return t(count === 1 ? "{{count}} file" : "{{count}} files", { count });
  const modulo100 = count % 100;
  const modulo10 = count % 10;
  const suffix =
    modulo100 >= 11 && modulo100 <= 14
      ? "файлов"
      : modulo10 === 1
        ? "файл"
        : modulo10 >= 2 && modulo10 <= 4
          ? "файла"
          : "файлов";
  return t(`{{count}} ${suffix}`, { count });
}

function stateLabel(state: string, t: Translate): string {
  const labels: Record<string, string> = {
    needsAttention: "Нужно решение",
    running: "Выполняется",
    completed: "Завершена",
    failed: "Ошибка",
    interrupted: "Прервана",
    idle: "Готова",
    unavailable: "Недоступна",
  };
  return labels[state] ? t(labels[state]) : state;
}
