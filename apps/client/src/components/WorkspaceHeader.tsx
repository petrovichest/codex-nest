import type { ReactNode } from "react";

import { useI18n } from "../i18n";
import { FolderIcon, InfoIcon, PanelLeftIcon } from "./Icons";

export function WorkspaceHeader({
  title,
  subtitle,
  onOpenNavigation,
  onToggleInspector,
  actions,
}: {
  title: string;
  subtitle?: string;
  onOpenNavigation(): void;
  onToggleInspector?(): void;
  actions?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <header className="workspace-header">
      <div className="workspace-title">
        <button
          className="icon-button mobile-nav-toggle"
          aria-label={t("Открыть список задач")}
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
      </div>
      <div className="workspace-actions">
        {actions}
        {onToggleInspector && (
          <button
            className="icon-button"
            aria-label={t("Показать сведения")}
            onClick={onToggleInspector}
          >
            <InfoIcon />
          </button>
        )}
      </div>
    </header>
  );
}
