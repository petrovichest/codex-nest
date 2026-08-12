import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Project, ThreadSummary } from "@codexnest/protocol";

import type { SessionArtifact } from "../artifacts";
import { NewSessionInspector, SessionInspector, type GitChangesView } from "./SessionInspector";

const summary: ThreadSummary = {
  id: "thread",
  relation: { kind: "session", sessionId: "session" },
  projectId: "project",
  title: "Задача",
  preview: "",
  cwd: "/work/project",
  state: "idle",
  unread: false,
  unseen: false,
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  currentTurnId: null,
  queuedMessageCount: 0,
  browserStatus: "disabled",
  settings: { collaborationMode: "default" },
};

const project: Project = {
  id: "project",
  displayName: "Проект",
  path: "/work/project",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};

const artifact: SessionArtifact = {
  id: "artifact",
  label: "Итоговый отчёт",
  path: "/work/project/reports/result.md",
  fileName: "result.md",
  relativePath: "reports/result.md",
  turnId: "turn",
  createdAt: 1,
  format: "Markdown",
  preview: {
    path: "/work/project/reports/result.md",
    fileName: "result.md",
    format: "Markdown",
    kind: "markdown",
    maxBytes: 2 * 1024 * 1024,
  },
};

describe("SessionInspector", () => {
  it.each([
    [null, "Загрузка…"],
    ["error", "Недоступно"],
    [{ state: "clean", filesChanged: 0, additions: 0, deletions: 0 }, "Нет изменений"],
    [{ state: "notRepository", filesChanged: 0, additions: 0, deletions: 0 }, "Не Git-репозиторий"],
  ] satisfies Array<[GitChangesView, string]>)("renders the Git state %#", (gitChanges, label) => {
    renderInspector(gitChanges);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it.each([
    [1, "1 файл"],
    [2, "2 файла"],
    [5, "5 файлов"],
    [11, "11 файлов"],
    [21, "21 файл"],
  ])("uses the correct file label for %i", (filesChanged, label) => {
    renderInspector({ state: "dirty", filesChanged, additions: 12, deletions: 3 });
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText("+12")).toBeInTheDocument();
    expect(screen.getByText("−3")).toBeInTheDocument();
  });

  it("removes environment information from both inspectors", () => {
    const view = renderInspector({ state: "clean", filesChanged: 0, additions: 0, deletions: 0 });
    expect(screen.queryByText("Среда")).not.toBeInTheDocument();
    expect(screen.queryByText("Локальный сервер готов")).not.toBeInTheDocument();

    view.rerender(<NewSessionInspector open project={project} onClose={() => undefined} />);
    expect(screen.queryByText("Среда")).not.toBeInTheDocument();
    expect(screen.queryByText("Локальный сервер готов")).not.toBeInTheDocument();
  });

  it("uses the same completed-result pulse as the session list", () => {
    const unseen = {
      ...summary,
      state: "completed" as const,
      unread: true,
      unseen: true,
    };
    const view = renderInspector(
      { state: "clean", filesChanged: 0, additions: 0, deletions: 0 },
      unseen,
    );

    expect(view.container.querySelector(".status")).toHaveClass(
      "status-completed-unread",
      "status-unseen",
      "status-pulsing",
    );

    view.rerender(
      <SessionInspector
        open
        summary={{ ...unseen, unseen: false }}
        project={project}
        gitChanges={{ state: "clean", filesChanged: 0, additions: 0, deletions: 0 }}
        activeTab="overview"
        artifacts={[]}
        artifactCapability="explicit"
        artifactLoadState="idle"
        onClose={() => undefined}
        onTabChange={vi.fn()}
        onArtifactOpen={vi.fn()}
        onArtifactDownload={vi.fn()}
        onArtifactRetry={vi.fn()}
      />,
    );
    expect(view.container.querySelector(".status")).toHaveClass("status-completed-unread");
    expect(view.container.querySelector(".status")).not.toHaveClass(
      "status-unseen",
      "status-pulsing",
    );
  });

  it("switches to the artifact shelf and exposes the exact count", () => {
    const onTabChange = vi.fn();
    const onArtifactOpen = vi.fn();
    const view = render(
      <SessionInspector
        open
        summary={summary}
        project={project}
        gitChanges={{ state: "clean", filesChanged: 0, additions: 0, deletions: 0 }}
        activeTab="artifacts"
        artifacts={[artifact]}
        artifactCapability="explicit"
        artifactLoadState="idle"
        onClose={vi.fn()}
        onTabChange={onTabChange}
        onArtifactOpen={onArtifactOpen}
        onArtifactDownload={vi.fn()}
        onArtifactRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("Итоговый отчёт")).toBeInTheDocument();

    expect(screen.getByRole("tab", { name: "Артефакты, 1" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      "session-artifacts-tab",
    );
    expect(screen.getByText("reports/result.md")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Открыть result.md" }));
    expect(onArtifactOpen).toHaveBeenCalledWith(artifact, expect.any(HTMLButtonElement));
    expect(view.container.querySelector(".inspector-actions")).not.toBeInTheDocument();
  });

  it("shows progress instead of a false empty state while artifacts load", () => {
    render(
      <SessionInspector
        open
        summary={summary}
        project={project}
        gitChanges={{ state: "clean", filesChanged: 0, additions: 0, deletions: 0 }}
        activeTab="artifacts"
        artifacts={[]}
        artifactCapability={null}
        artifactLoadState="loading"
        onClose={vi.fn()}
        onTabChange={vi.fn()}
        onArtifactOpen={vi.fn()}
        onArtifactDownload={vi.fn()}
        onArtifactRetry={vi.fn()}
      />,
    );

    expect(screen.getByText("Загружаем артефакты…")).toBeInTheDocument();
    expect(screen.queryByText("В этой сессии пока нет артефактов")).not.toBeInTheDocument();
  });

  it("explains why old sessions cannot expose explicit artifacts", () => {
    render(
      <SessionInspector
        open
        summary={summary}
        project={project}
        gitChanges={{ state: "clean", filesChanged: 0, additions: 0, deletions: 0 }}
        activeTab="artifacts"
        artifacts={[]}
        artifactCapability="unavailable"
        artifactLoadState="idle"
        onClose={vi.fn()}
        onTabChange={vi.fn()}
        onArtifactOpen={vi.fn()}
        onArtifactDownload={vi.fn()}
        onArtifactRetry={vi.fn()}
      />,
    );

    expect(screen.getByText("Артефакты недоступны для этой сессии")).toBeInTheDocument();
    expect(screen.getByText("Явные артефакты доступны в новых сессиях.")).toBeInTheDocument();
  });
});

function renderInspector(gitChanges: GitChangesView, thread = summary) {
  return render(
    <SessionInspector
      open
      summary={thread}
      project={project}
      gitChanges={gitChanges}
      activeTab="overview"
      artifacts={[]}
      artifactCapability="explicit"
      artifactLoadState="idle"
      onClose={() => undefined}
      onTabChange={vi.fn()}
      onArtifactOpen={vi.fn()}
      onArtifactDownload={vi.fn()}
      onArtifactRetry={vi.fn()}
    />,
  );
}
