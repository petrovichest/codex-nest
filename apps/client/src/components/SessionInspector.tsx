import type { GitChangesSummary, Project, ThreadSummary } from "@codexnest/protocol";

import { useI18n, type Translate } from "../i18n";
import { threadStatusClasses } from "../thread-status";
import {
  ArchiveIcon,
  ClockIcon,
  FolderIcon,
  GitBranchIcon,
  PinIcon,
  ServerIcon,
  XIcon,
} from "./Icons";

export type GitChangesView = GitChangesSummary | "error" | null;

export function SessionInspector({
  open,
  summary,
  project,
  gitChanges,
  onClose,
  onPin,
  onArchive,
}: {
  open: boolean;
  summary: ThreadSummary;
  project: Project | null;
  gitChanges: GitChangesView;
  onClose(): void;
  onPin(): void;
  onArchive(): void;
}) {
  const { language, t } = useI18n();
  if (!open) return null;
  return (
    <aside className="session-inspector open" aria-label={t("Сведения о задаче")}>
      <div className="inspector-heading">
        <span>{t("Сведения")}</span>
        <button className="icon-button" aria-label={t("Закрыть сведения")} onClick={onClose}>
          <XIcon />
        </button>
      </div>
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
        <InspectorRow icon={<GitBranchIcon />} label="Git changes">
          <GitChangesValue value={gitChanges} />
        </InspectorRow>
        <InspectorRow icon={<ClockIcon />} label={t("Создана")}>
          {formatDate(summary.createdAt, language)}
        </InspectorRow>
        <InspectorRow icon={<ClockIcon />} label={t("Обновлена")}>
          {formatDate(summary.updatedAt, language)}
        </InspectorRow>
      </dl>
      <div className="inspector-path">
        <span>{t("Рабочая папка")}</span>
        <code>{summary.cwd}</code>
      </div>
      <div className="inspector-actions">
        <button onClick={onPin}>
          <PinIcon /> {summary.pinned ? t("Открепить") : t("Закрепить")}
        </button>
        <button onClick={onArchive}>
          <ArchiveIcon /> {summary.archived ? t("Вернуть из архива") : t("Архивировать")}
        </button>
      </div>
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
        <span>{t("Новая задача")}</span>
        <button className="icon-button" aria-label={t("Закрыть сведения")} onClick={onClose}>
          <XIcon />
        </button>
      </div>
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
    </aside>
  );
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
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt>
        {icon}
        {label}
      </dt>
      <dd>{children}</dd>
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
