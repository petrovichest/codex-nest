import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CodexManagementStatus } from "@codexnest/protocol";

import { CodexSettingsCard } from "./CodexSettingsCard";

const connection = vi.hoisted(() => vi.fn());

vi.mock("../connection", () => ({ useConnection: connection }));

beforeEach(() => {
  connection.mockReset();
  vi.restoreAllMocks();
});

describe("CodexSettingsCard", () => {
  it("loads local versions and checks latest only after clicking the button", async () => {
    const initial = managementStatus();
    const checked = managementStatus({
      latestVersion: "0.145.0",
      updateAvailable: true,
      networkStatus: "ok",
    });
    const api = mockApi(initial, checked);
    connection.mockReturnValue({ api, state: { snapshot: { threads: [] } } });

    render(<CodexSettingsCard />);

    expect(await screen.findByText("Не проверялась")).toBeInTheDocument();
    expect(api.checkCodex).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Проверить версию" }));

    expect(await screen.findByText("0.145.0")).toBeInTheDocument();
    expect(screen.getByText(/WebSocket ChatGPT\/OpenAI доступен/)).toBeInTheDocument();
    expect(api.checkCodex).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Обновить Codex" })).toBeEnabled();
  });

  it("sends a masked proxy once and clears the secret after applying it", async () => {
    const api = mockApi(managementStatus());
    connection.mockReturnValue({ api, state: { snapshot: { threads: [] } } });
    render(<CodexSettingsCard />);

    const input = await screen.findByLabelText("Новый HTTP/HTTPS-прокси");
    expect(input).toHaveAttribute("type", "password");
    fireEvent.change(input, { target: { value: "proxy.example:8000:user:secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить и применить" }));

    await waitFor(() =>
      expect(api.updateCodexProxy).toHaveBeenCalledWith({
        proxy: "proxy.example:8000:user:secret",
      }),
    );
    expect(input).toHaveValue("");
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
    expect(screen.getByText(/Прокси проверен и применён/)).toBeInTheDocument();
  });

  it("blocks disruptive actions while a turn is active but still allows a version check", async () => {
    const api = mockApi(managementStatus({ activeTurnCount: 1 }));
    connection.mockReturnValue({
      api,
      state: { snapshot: { threads: [{ currentTurnId: "turn" }] } },
    });
    render(<CodexSettingsCard />);

    expect(await screen.findByText(/активных ответов: 1/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Обновить Codex" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Перезапустить" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Проверить версию" })).toBeEnabled();
  });

  it("requires confirmation before update and restart", async () => {
    const api = mockApi(managementStatus({ latestVersion: "0.145.0", updateAvailable: true }));
    connection.mockReturnValue({ api, state: { snapshot: { threads: [] } } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<CodexSettingsCard />);

    await screen.findByText("0.145.0");
    fireEvent.click(screen.getByRole("button", { name: "Обновить Codex" }));
    await waitFor(() => expect(api.updateCodex).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Перезапустить" }));
    await waitFor(() => expect(api.restartCodex).toHaveBeenCalledOnce());
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("does not send proxy credentials over non-local HTTP", async () => {
    const api = mockApi(managementStatus(), undefined, "http://codexnest.example");
    connection.mockReturnValue({ api, state: { snapshot: { threads: [] } } });
    render(<CodexSettingsCard />);

    expect(await screen.findByText(/только через HTTPS/)).toBeInTheDocument();
    expect(screen.getByLabelText("Новый HTTP/HTTPS-прокси")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Проверить и применить" })).toBeDisabled();
  });
});

function mockApi(
  initial: CodexManagementStatus,
  checked = initial,
  baseUrl = "https://codexnest.example",
) {
  return {
    settings: { baseUrl, token: "token" },
    readCodexSettings: vi.fn(async () => initial),
    checkCodex: vi.fn(async () => checked),
    updateCodexProxy: vi.fn(async () => initial),
    updateCodex: vi.fn(async () => initial),
    restartCodex: vi.fn(async () => initial),
  };
}

function managementStatus(overrides: Partial<CodexManagementStatus> = {}): CodexManagementStatus {
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
      configured: true,
      protocol: "http",
      host: "proxy.example",
      port: 8000,
      username: "user",
      hasPassword: true,
      error: null,
    },
    ...overrides,
  };
}
