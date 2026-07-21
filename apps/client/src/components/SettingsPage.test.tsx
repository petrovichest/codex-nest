import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

import { ApiClientError } from "../api";
import { SettingsPage } from "./SettingsPage";

const connection = vi.hoisted(() => vi.fn());

vi.mock("../connection", () => ({ useConnection: connection }));

beforeEach(() => {
  connection.mockReset();
});

describe("SettingsPage", () => {
  it("normalizes a custom config into the selected global preset", async () => {
    const readPermissionSettings = vi.fn().mockResolvedValue({
      preset: null,
      version: "version-1",
      overridden: false,
      message: null,
    });
    const updatePermissionSettings = vi.fn().mockResolvedValue({
      preset: "auto",
      version: "version-2",
      overridden: false,
      message: null,
    });
    connection.mockReturnValue({ api: { readPermissionSettings, updatePermissionSettings } });

    renderPage();

    expect(await screen.findAllByRole("radio")).toHaveLength(3);
    expect(screen.getByRole("radio", { name: /Подтверждать автоматически/ })).toBeChecked();
    expect(screen.getByText(/Обнаружена нестандартная конфигурация/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(updatePermissionSettings).toHaveBeenCalledWith({
        preset: "auto",
        expectedVersion: "version-1",
      }),
    );
    expect(screen.queryByText(/Обнаружена нестандартная конфигурация/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Сохранить" })).toBeDisabled();
  });

  it("warns about full access and reloads after a version conflict", async () => {
    const current = {
      preset: "auto" as const,
      version: "version-1",
      overridden: false,
      message: null,
    };
    const readPermissionSettings = vi.fn().mockResolvedValue(current);
    const updatePermissionSettings = vi
      .fn()
      .mockRejectedValue(new ApiClientError("conflict", "Config changed", 409));
    connection.mockReturnValue({ api: { readPermissionSettings, updatePermissionSettings } });

    renderPage();
    const fullAccess = await screen.findByRole("radio", { name: /Полный доступ/ });
    fireEvent.click(fullAccess);

    expect(screen.getByRole("alert")).toHaveTextContent("Полный доступ снимает ограничения");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    expect(
      await screen.findByText(/Конфигурация Codex изменилась.*сохраните ещё раз/),
    ).toBeInTheDocument();
    expect(readPermissionSettings).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("radio", { name: /Подтверждать автоматически/ })).toBeChecked();
  });

  it("shows a managed override returned by Codex", async () => {
    connection.mockReturnValue({
      api: {
        readPermissionSettings: vi.fn().mockResolvedValue({
          preset: "ask",
          version: "version-1",
          overridden: true,
          message: "Managed by policy",
        }),
        updatePermissionSettings: vi.fn(),
      },
    });

    renderPage();

    expect(await screen.findByText("Managed by policy")).toBeInTheDocument();
  });

  it("changes the local appearance theme immediately", () => {
    connection.mockReturnValue({
      api: {
        readPermissionSettings: vi.fn().mockResolvedValue({
          preset: "auto",
          version: "version-1",
          overridden: false,
          message: null,
        }),
        updatePermissionSettings: vi.fn(),
      },
    });
    const onThemeChange = vi.fn();

    renderPage("system", onThemeChange);
    fireEvent.change(screen.getByRole("combobox", { name: "Тема" }), {
      target: { value: "dark" },
    });

    expect(onThemeChange).toHaveBeenCalledWith("dark");
  });

  it("changes the local sidebar side immediately", () => {
    connection.mockReturnValue({
      api: {
        readPermissionSettings: vi.fn().mockResolvedValue({
          preset: "auto",
          version: "version-1",
          overridden: false,
          message: null,
        }),
        updatePermissionSettings: vi.fn(),
      },
    });
    const onSidebarSideChange = vi.fn();

    renderPage("system", vi.fn(), vi.fn(), "left", onSidebarSideChange);
    fireEvent.change(screen.getByRole("combobox", { name: "Боковая панель" }), {
      target: { value: "right" },
    });

    expect(onSidebarSideChange).toHaveBeenCalledWith("right");
  });

  it("changes the local project list direction immediately", () => {
    connection.mockReturnValue({
      api: {
        readPermissionSettings: vi.fn().mockResolvedValue({
          preset: "auto",
          version: "version-1",
          overridden: false,
          message: null,
        }),
        updatePermissionSettings: vi.fn(),
      },
    });
    const onProjectListDirectionChange = vi.fn();

    renderPage(
      "system",
      vi.fn(),
      vi.fn(),
      "left",
      vi.fn(),
      "bottom-up",
      onProjectListDirectionChange,
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Порядок проектов" }), {
      target: { value: "top-down" },
    });

    expect(onProjectListDirectionChange).toHaveBeenCalledWith("top-down");
  });

  it("exposes the server switch action in settings", () => {
    connection.mockReturnValue({
      api: {
        readPermissionSettings: vi.fn().mockResolvedValue({
          preset: "auto",
          version: "version-1",
          overridden: false,
          message: null,
        }),
        updatePermissionSettings: vi.fn(),
      },
    });
    const onSwitchServer = vi.fn();

    renderPage("system", vi.fn(), onSwitchServer);
    fireEvent.click(screen.getByRole("button", { name: "Сменить сервер" }));

    expect(onSwitchServer).toHaveBeenCalledOnce();
  });
});

function renderPage(
  theme = "system",
  onThemeChange = vi.fn(),
  onSwitchServer = vi.fn(),
  sidebarSide: "left" | "right" = "left",
  onSidebarSideChange = vi.fn(),
  projectListDirection: "bottom-up" | "top-down" = "bottom-up",
  onProjectListDirectionChange = vi.fn(),
) {
  return render(
    <MemoryRouter>
      <SettingsPage
        onOpenNavigation={() => undefined}
        onSwitchServer={onSwitchServer}
        theme={theme}
        onThemeChange={onThemeChange}
        sidebarSide={sidebarSide}
        onSidebarSideChange={onSidebarSideChange}
        projectListDirection={projectListDirection}
        onProjectListDirectionChange={onProjectListDirectionChange}
      />
    </MemoryRouter>,
  );
}
