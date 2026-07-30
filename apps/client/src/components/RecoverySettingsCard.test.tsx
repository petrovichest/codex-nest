import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppUpdateStatus, CodexManagementStatus } from "@codexnest/protocol";

import { ApiClientError } from "../api";
import { RecoverySettingsCard } from "./RecoverySettingsCard";

const connection = vi.hoisted(() => vi.fn());

vi.mock("../connection", () => ({ useConnection: connection }));

beforeEach(() => {
  connection.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("RecoverySettingsCard", () => {
  it("force restarts CodexNest during active work and reloads after reconnect", async () => {
    const api = recoveryApi();
    api.forceRestartApp.mockRejectedValueOnce(
      new ApiClientError("connection_failed", "Connection lost"),
    );
    let network = "connected";
    connection.mockImplementation(() => ({
      api,
      state: {
        network,
        snapshot: { threads: [{ currentTurnId: "turn-1" }] },
      },
    }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const reload = vi.fn();
    const view = render(
      <RecoverySettingsCard
        appStatus={appStatus({ operation: "building" })}
        codexStatus={codexStatus({ operation: "updating" })}
        onReload={reload}
      />,
    );

    expect(screen.getByText(/Активных ответов: 1/)).toBeInTheDocument();
    const restart = screen.getByRole("button", { name: "Жёстко перезапустить CodexNest" });
    expect(restart).toBeEnabled();
    fireEvent.click(restart);
    await waitFor(() => expect(api.forceRestartApp).toHaveBeenCalledOnce());
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Текущее обновление"));

    network = "offline";
    view.rerender(
      <RecoverySettingsCard
        appStatus={appStatus({ operation: "building" })}
        codexStatus={codexStatus({ operation: "updating" })}
        onReload={reload}
      />,
    );
    network = "connected";
    view.rerender(
      <RecoverySettingsCard
        appStatus={appStatus({ operation: "building" })}
        codexStatus={codexStatus({ operation: "updating" })}
        onReload={reload}
      />,
    );

    expect(reload).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("force restarts only the Codex daemon and reports success", async () => {
    const api = recoveryApi();
    connection.mockReturnValue({
      api,
      state: {
        network: "connected",
        snapshot: { threads: [{ currentTurnId: "turn-1" }] },
      },
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const reload = vi.fn();
    render(
      <RecoverySettingsCard
        appStatus={appStatus()}
        codexStatus={codexStatus({ operation: "updating" })}
        onReload={reload}
      />,
    );

    const restart = screen.getByRole("button", { name: "Жёстко перезапустить Codex" });
    expect(restart).toBeEnabled();
    fireEvent.click(restart);

    await waitFor(() => expect(api.forceRestartCodex).toHaveBeenCalledOnce());
    expect(await screen.findByText("Codex daemon аварийно перезапущен.")).toBeInTheDocument();
    expect(api.forceRestartApp).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("disables unavailable recovery targets", () => {
    connection.mockReturnValue({
      api: recoveryApi(),
      state: { network: "connected", snapshot: { threads: [] } },
    });
    render(
      <RecoverySettingsCard
        appStatus={appStatus({ supported: false })}
        codexStatus={codexStatus({ supported: false })}
      />,
    );

    expect(screen.getByRole("button", { name: "Жёстко перезапустить CodexNest" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Жёстко перезапустить Codex" })).toBeDisabled();
  });

  it("reports when CodexNest never reconnects", async () => {
    vi.useFakeTimers();
    const api = recoveryApi();
    connection.mockReturnValue({
      api,
      state: { network: "connected", snapshot: { threads: [] } },
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <RecoverySettingsCard
        appStatus={appStatus()}
        codexStatus={codexStatus()}
        onReload={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Жёстко перезапустить CodexNest" }));
    await act(async () => Promise.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(90_000));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "CodexNest не восстановил соединение после перезапуска.",
    );
    expect(screen.getByRole("button", { name: "Жёстко перезапустить CodexNest" })).toBeEnabled();
  });
});

function recoveryApi() {
  return {
    forceRestartApp: vi.fn(async () => ({ accepted: true as const })),
    forceRestartCodex: vi.fn(async () => codexStatus()),
  };
}

function appStatus(overrides: Partial<AppUpdateStatus> = {}): AppUpdateStatus {
  return {
    supported: true,
    canUpdateWithActiveTurns: true,
    currentVersion: "0.1.0",
    latestVersion: "0.2.0",
    updateAvailable: true,
    operation: "idle",
    result: "none",
    message: null,
    checkedAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function codexStatus(overrides: Partial<CodexManagementStatus> = {}): CodexManagementStatus {
  return {
    supported: true,
    unavailableReason: null,
    operation: "idle",
    activeTurnCount: 0,
    daemonStatus: "running",
    cliVersion: "0.144.6",
    appServerVersion: "0.144.6",
    latestVersion: null,
    updateAvailable: null,
    networkStatus: "unknown",
    networkMessage: null,
    proxy: {
      configured: false,
      protocol: null,
      host: null,
      port: null,
      username: null,
      hasPassword: false,
      error: null,
    },
    ...overrides,
  };
}
