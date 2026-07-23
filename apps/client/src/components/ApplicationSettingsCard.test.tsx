import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppUpdateStatus } from "@codexnest/protocol";

import { ApplicationSettingsCard } from "./ApplicationSettingsCard";

const connection = vi.hoisted(() => vi.fn());
const openDownloadUrl = vi.hoisted(() => vi.fn());

vi.mock("../connection", () => ({ useConnection: connection }));
vi.mock("../downloads", () => ({ openDownloadUrl }));

beforeEach(() => {
  connection.mockReset();
  openDownloadUrl.mockReset();
  openDownloadUrl.mockResolvedValue(undefined);
  vi.restoreAllMocks();
});

describe("ApplicationSettingsCard", () => {
  it("checks GitHub only after an explicit click", async () => {
    const initial = updateStatus();
    const checked = updateStatus({ latestVersion: "0.1.4-abcdef0", updateAvailable: true });
    const api = {
      readAppSettings: vi.fn(async () => initial),
      checkAppUpdate: vi.fn(async () => checked),
      updateApp: vi.fn(async () => checked),
    };
    connection.mockReturnValue({ api, state: { network: "connected" } });

    render(<ApplicationSettingsCard />);

    expect(await screen.findByText("Не проверялась")).toBeInTheDocument();
    expect(api.checkAppUpdate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Проверить обновления" }));

    expect(await screen.findByText("0.1.4-abcdef0")).toBeInTheDocument();
    expect(api.checkAppUpdate).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Обновить CodexNest" })).toBeEnabled();
    expect(screen.getByText("Последняя rolling-версия")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Сервер и APK обновляются из одной проверенной CI-сборки с автоматическим откатом.",
      ),
    ).toBeInTheDocument();
  });

  it("requires confirmation before handing the update to systemd", async () => {
    const current = updateStatus({ latestVersion: "0.1.4-abcdef0", updateAvailable: true });
    const queued = updateStatus({
      latestVersion: "0.1.4-abcdef0",
      updateAvailable: true,
      operation: "preparing",
    });
    const api = {
      readAppSettings: vi.fn(async () => current),
      checkAppUpdate: vi.fn(async () => current),
      updateApp: vi.fn(async () => queued),
    };
    connection.mockReturnValue({ api, state: { network: "connected" } });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<ApplicationSettingsCard />);
    await screen.findByText("0.1.4-abcdef0");
    fireEvent.click(screen.getByRole("button", { name: "Обновить CodexNest" }));

    await waitFor(() => expect(api.updateApp).toHaveBeenCalledOnce());
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("до версии 0.1.4-abcdef0"));
  });

  it("explains when the current checkout is not managed", async () => {
    const api = {
      readAppSettings: vi.fn(async () =>
        updateStatus({ supported: false, message: "Managed installer is required" }),
      ),
      checkAppUpdate: vi.fn(),
      updateApp: vi.fn(),
    };
    connection.mockReturnValue({ api, state: { network: "connected" } });

    render(<ApplicationSettingsCard />);

    expect(await screen.findByText("Managed installer is required")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Проверить обновления" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Скачать свежий APK" })).toBeEnabled();
  });

  it("opens the rolling APK download without another API request", async () => {
    const api = {
      settings: { baseUrl: "https://codex.home.arpa" },
      readAppSettings: vi.fn(async () => updateStatus({ supported: false })),
      checkAppUpdate: vi.fn(),
      updateApp: vi.fn(),
    };
    connection.mockReturnValue({ api, state: { network: "connected" } });

    render(<ApplicationSettingsCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Скачать свежий APK" }));

    await waitFor(() =>
      expect(openDownloadUrl).toHaveBeenCalledWith(
        "https://codex.home.arpa",
        "https://github.com/petrovichest/codex-nest/releases/download/android-latest/CodexNest-latest.apk",
      ),
    );
    expect(api.checkAppUpdate).not.toHaveBeenCalled();
    expect(api.updateApp).not.toHaveBeenCalled();
  });

  it("shows an error when the APK download cannot be opened", async () => {
    openDownloadUrl.mockRejectedValueOnce(new Error("browser failed"));
    const api = {
      settings: { baseUrl: "https://codex.home.arpa" },
      readAppSettings: vi.fn(async () => updateStatus()),
      checkAppUpdate: vi.fn(),
      updateApp: vi.fn(),
    };
    connection.mockReturnValue({ api, state: { network: "connected" } });

    render(<ApplicationSettingsCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Скачать свежий APK" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось открыть загрузку APK");
  });

  it("keeps polling across a restart and shows the final updater result", async () => {
    vi.useFakeTimers();
    const preparing = updateStatus({
      latestVersion: "0.2.0",
      updateAvailable: true,
      operation: "restarting",
    });
    const updated = updateStatus({
      currentVersion: "0.2.0",
      latestVersion: "0.2.0",
      updateAvailable: false,
      result: "updated",
      message: "CodexNest was updated successfully",
    });
    const api = {
      readAppSettings: vi
        .fn()
        .mockResolvedValueOnce(preparing)
        .mockRejectedValueOnce(new Error("server restarting"))
        .mockResolvedValue(updated),
      checkAppUpdate: vi.fn(),
      updateApp: vi.fn(),
    };
    connection.mockReturnValue({ api, state: { network: "connected" } });

    try {
      render(<ApplicationSettingsCard />);
      await act(async () => Promise.resolve());
      expect(screen.getByText("Перезапуск")).toBeInTheDocument();

      await act(async () => vi.advanceTimersByTimeAsync(1_500));
      await act(async () => vi.advanceTimersByTimeAsync(1_500));

      expect(api.readAppSettings).toHaveBeenCalledTimes(3);
      expect(screen.getByText("CodexNest was updated successfully")).toBeInTheDocument();
      expect(screen.getByText("Обновлено")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reloads the final updater result after the server reconnects", async () => {
    const interrupted = updateStatus({
      latestVersion: "0.2.0",
      updateAvailable: true,
      result: "failed",
      message: "Update interrupted",
    });
    const updated = updateStatus({
      currentVersion: "0.2.0",
      latestVersion: "0.2.0",
      updateAvailable: false,
      result: "updated",
      message: "CodexNest was updated successfully",
    });
    const api = {
      readAppSettings: vi.fn().mockResolvedValueOnce(interrupted).mockResolvedValue(updated),
      checkAppUpdate: vi.fn(),
      updateApp: vi.fn(),
    };
    let network = "connected";
    connection.mockImplementation(() => ({ api, state: { network } }));

    const view = render(<ApplicationSettingsCard />);
    expect(await screen.findByText("Update interrupted")).toBeInTheDocument();

    network = "offline";
    view.rerender(<ApplicationSettingsCard />);
    network = "connected";
    view.rerender(<ApplicationSettingsCard />);

    expect(await screen.findByText("CodexNest was updated successfully")).toBeInTheDocument();
    expect(screen.getByText("Обновлено")).toBeInTheDocument();
  });
});

function updateStatus(overrides: Partial<AppUpdateStatus> = {}): AppUpdateStatus {
  return {
    supported: true,
    currentVersion: "0.1.0",
    latestVersion: null,
    updateAvailable: null,
    operation: "idle",
    result: "none",
    message: null,
    checkedAt: null,
    updatedAt: null,
    ...overrides,
  };
}
