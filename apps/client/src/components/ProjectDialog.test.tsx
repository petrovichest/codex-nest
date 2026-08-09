import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DirectoryListing } from "@codexnest/protocol";

import { ProjectDialog } from "./ProjectDialog";

const connection = vi.hoisted(() => vi.fn());

vi.mock("../connection", () => ({ useConnection: connection }));

const root: DirectoryListing = {
  rootPath: "/home/pi",
  path: "/home/pi",
  parentPath: null,
  directories: [
    { name: ".config", path: "/home/pi/.config" },
    { name: "projects", path: "/home/pi/projects" },
  ],
};

const projects: DirectoryListing = {
  rootPath: "/home/pi",
  path: "/home/pi/projects",
  parentPath: "/home/pi",
  directories: [],
};

beforeEach(() => {
  connection.mockReset();
});

describe("ProjectDialog", () => {
  it("browses from home, toggles hidden folders, navigates breadcrumbs, and selects a folder", async () => {
    const listDirectories = vi.fn((path?: string) =>
      Promise.resolve(path === "/home/pi/projects" ? projects : root),
    );
    const createProject = vi.fn().mockResolvedValue({});
    const onClose = vi.fn();
    connection.mockReturnValue({
      api: { listDirectories, createDirectory: vi.fn(), createProject },
    });

    render(<ProjectDialog onClose={onClose} />);

    expect(await screen.findByRole("button", { name: "projects" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ".config" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Показывать скрытые"));
    expect(screen.getByRole("button", { name: ".config" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "projects" }));
    await waitFor(() => expect(listDirectories).toHaveBeenCalledWith("/home/pi/projects"));
    expect(await screen.findByRole("button", { name: "Домашняя" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "projects" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Домашняя" }));
    await waitFor(() => expect(listDirectories).toHaveBeenCalledWith("/home/pi"));
    fireEvent.click(await screen.findByRole("button", { name: "projects" }));
    await waitFor(() => expect(screen.getByLabelText("На уровень выше")).toBeEnabled());
    fireEvent.click(screen.getByLabelText("На уровень выше"));
    await waitFor(() => expect(listDirectories).toHaveBeenCalledTimes(5));
    fireEvent.click(await screen.findByRole("button", { name: "projects" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "projects" })).toBeDisabled());

    fireEvent.click(screen.getByRole("button", { name: "Выбрать эту папку" }));
    await waitFor(() => expect(createProject).toHaveBeenCalledWith({ path: "/home/pi/projects" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("creates a folder, enters it without another listing request, and waits for confirmation", async () => {
    const listDirectories = vi.fn().mockResolvedValue(root);
    const created: DirectoryListing = {
      rootPath: "/home/pi",
      path: "/home/pi/new-project",
      parentPath: "/home/pi",
      directories: [],
    };
    const createDirectory = vi.fn().mockResolvedValue(created);
    const createProject = vi.fn().mockResolvedValue({});
    connection.mockReturnValue({ api: { listDirectories, createDirectory, createProject } });

    render(<ProjectDialog onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: /Новая папка/ }));
    fireEvent.change(screen.getByLabelText("Название новой папки"), {
      target: { value: "new-project" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Создать" }));

    await waitFor(() =>
      expect(createDirectory).toHaveBeenCalledWith({
        parentPath: "/home/pi",
        name: "new-project",
      }),
    );
    expect(listDirectories).toHaveBeenCalledOnce();
    expect(createProject).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "new-project" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Выбрать эту папку" }));
    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith({ path: "/home/pi/new-project" }),
    );
  });

  it("shows loading errors and lets the user retry", async () => {
    const listDirectories = vi
      .fn()
      .mockRejectedValueOnce(new Error("Directory is not accessible"))
      .mockResolvedValueOnce(root);
    connection.mockReturnValue({
      api: { listDirectories, createDirectory: vi.fn(), createProject: vi.fn() },
    });

    render(<ProjectDialog onClose={() => undefined} />);

    expect(await screen.findByText("Directory is not accessible")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByRole("button", { name: "projects" })).toBeInTheDocument();
    expect(listDirectories).toHaveBeenCalledTimes(2);
  });

  it("prevents dismissal while busy and allows it after loading", async () => {
    let finishLoading!: (listing: DirectoryListing) => void;
    const listDirectories = vi.fn(
      () =>
        new Promise<DirectoryListing>((resolve) => {
          finishLoading = resolve;
        }),
    );
    const onClose = vi.fn();
    connection.mockReturnValue({
      api: { listDirectories, createDirectory: vi.fn(), createProject: vi.fn() },
    });

    render(<ProjectDialog onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "Добавить проект" });
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(dialog.parentElement!);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => finishLoading(root));
    await screen.findByRole("button", { name: "projects" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
