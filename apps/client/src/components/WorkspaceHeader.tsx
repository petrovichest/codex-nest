import type { ReactNode } from "react";

import { FolderIcon, InfoIcon, PanelLeftIcon } from "./Icons";

export function WorkspaceHeader({
  title,
  subtitle,
  badge,
  onOpenNavigation,
  onToggleInspector,
  actions,
}: {
  title: string;
  subtitle?: string;
  badge?: ReactNode;
  onOpenNavigation(): void;
  onToggleInspector?(): void;
  actions?: ReactNode;
}) {
  return (
    <header className="workspace-header">
      <div className="workspace-title">
        <button
          className="icon-button mobile-nav-toggle"
          aria-label="Открыть список задач"
          onClick={onOpenNavigation}
        >
          <PanelLeftIcon />
        </button>
        <span className="workspace-title-icon">
          <FolderIcon />
        </span>
        <div>
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {badge}
      </div>
      <div className="workspace-actions">
        {actions}
        {onToggleInspector && (
          <button
            className="icon-button"
            aria-label="Показать сведения"
            onClick={onToggleInspector}
          >
            <InfoIcon />
          </button>
        )}
      </div>
    </header>
  );
}
