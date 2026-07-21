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
});

function renderPage() {
  return render(
    <MemoryRouter>
      <SettingsPage onOpenNavigation={() => undefined} />
    </MemoryRouter>,
  );
}
