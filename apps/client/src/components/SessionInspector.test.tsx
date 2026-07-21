import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Project, ThreadSummary } from "@codexnest/protocol";

import { NewSessionInspector, SessionInspector, type GitChangesView } from "./SessionInspector";

const summary: ThreadSummary = {
  id: "thread",
  projectId: "project",
  title: "Задача",
  preview: "",
  cwd: "/work/project",
  state: "idle",
  unread: false,
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  currentTurnId: null,
  queuedMessageCount: 0,
  settings: { collaborationMode: "default" },
};

const project: Project = {
  id: "project",
  displayName: "Проект",
  path: "/work/project",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
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
});

function renderInspector(gitChanges: GitChangesView) {
  return render(
    <SessionInspector
      open
      summary={summary}
      project={project}
      gitChanges={gitChanges}
      onClose={() => undefined}
      onPin={vi.fn()}
      onArchive={vi.fn()}
    />,
  );
}
