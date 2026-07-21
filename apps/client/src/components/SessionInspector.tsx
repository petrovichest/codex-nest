import type { Project, ThreadSummary } from "@codexnest/protocol";

import { ArchiveIcon, ClockIcon, FolderIcon, PinIcon, ServerIcon, XIcon } from "./Icons";

export function SessionInspector({
  open,
  summary,
  project,
  connection,
  onClose,
  onPin,
  onArchive,
}: {
  open: boolean;
  summary: ThreadSummary;
  project: Project | null;
  connection: string;
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
        <InspectorRow icon={<ServerIcon />} label="Среда">
          {connection}
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
  connection,
  onClose,
}: {
  open: boolean;
  project: Project | null;
  connection: string;
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
        <InspectorRow icon={<ServerIcon />} label="Среда">
          {connection}
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
