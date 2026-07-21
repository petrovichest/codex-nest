import type { GitChangesSummary, Project, ThreadSummary } from "@codexnest/protocol";

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
  if (!open) return null;
  return (
    <aside className="session-inspector open" aria-label="Сведения о задаче">
      <div className="inspector-heading">
        <span>Сведения</span>
        <button className="icon-button" aria-label="Закрыть сведения" onClick={onClose}>
          <XIcon />
        </button>
      </div>
      <dl className="inspector-list">
        <InspectorRow icon={<ServerIcon />} label="Статус">
          <span className={`status-label status-label-${summary.state}`}>
            <span className={`status status-${summary.state}`} />
            {stateLabel(summary.state)}
          </span>
        </InspectorRow>
        <InspectorRow icon={<FolderIcon />} label="Проект">
          {project?.displayName ?? "Без проекта"}
        </InspectorRow>
        <InspectorRow icon={<GitBranchIcon />} label="Git changes">
          <GitChangesValue value={gitChanges} />
        </InspectorRow>
        <InspectorRow icon={<ClockIcon />} label="Создана">
          {formatDate(summary.createdAt)}
        </InspectorRow>
        <InspectorRow icon={<ClockIcon />} label="Обновлена">
          {formatDate(summary.updatedAt)}
        </InspectorRow>
      </dl>
      <div className="inspector-path">
        <span>Рабочая папка</span>
        <code>{summary.cwd}</code>
      </div>
      <div className="inspector-actions">
        <button onClick={onPin}>
          <PinIcon /> {summary.pinned ? "Открепить" : "Закрепить"}
        </button>
        <button onClick={onArchive}>
          <ArchiveIcon /> {summary.archived ? "Вернуть из архива" : "Архивировать"}
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
  if (!open) return null;
  return (
    <aside className="session-inspector open" aria-label="Сведения о новой задаче">
      <div className="inspector-heading">
        <span>Новая задача</span>
        <button className="icon-button" aria-label="Закрыть сведения" onClick={onClose}>
          <XIcon />
        </button>
      </div>
      <dl className="inspector-list">
        <InspectorRow icon={<FolderIcon />} label="Проект">
          {project?.displayName ?? "Не выбран"}
        </InspectorRow>
      </dl>
      {project && (
        <div className="inspector-path">
          <span>Рабочая папка</span>
          <code>{project.path}</code>
        </div>
      )}
      <p className="inspector-note">Задача будет создана после отправки первого сообщения.</p>
    </aside>
  );
}

function GitChangesValue({ value }: { value: GitChangesView }) {
  if (value === null) return <>Загрузка…</>;
  if (value === "error") return <>Недоступно</>;
  if (value.state === "notRepository") return <>Не Git-репозиторий</>;
  if (value.state === "clean") return <>Нет изменений</>;
  return (
    <span className="git-changes-summary">
      <span>{formatFileCount(value.filesChanged)}</span>
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

function formatDate(value: number): string {
  return new Date(value).toLocaleString("ru", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatFileCount(count: number): string {
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
  return `${count} ${suffix}`;
}

function stateLabel(state: string): string {
  return (
    (
      {
        needsAttention: "Нужно решение",
        running: "Выполняется",
        completed: "Завершена",
        failed: "Ошибка",
        interrupted: "Прервана",
        idle: "Готова",
        unavailable: "Недоступна",
      } as Record<string, string>
    )[state] ?? state
  );
}
