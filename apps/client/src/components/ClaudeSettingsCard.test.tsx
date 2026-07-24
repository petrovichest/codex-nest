import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ApiClientError } from "../api";
import { ClaudeSettingsCard } from "./ClaudeSettingsCard";

const connection = vi.hoisted(() => vi.fn());

vi.mock("../connection", () => ({ useConnection: connection }));

describe("ClaudeSettingsCard", () => {
  it("shows the version and path when Claude Code is supported", async () => {
    const readClaudeSettings = vi.fn().mockResolvedValue({
      supported: true,
      unavailableReason: null,
      cliVersion: "2.1.0",
      path: "/usr/local/bin/claude",
    });
    connection.mockReturnValue({ api: { readClaudeSettings, checkClaude: vi.fn() } });

    render(<ClaudeSettingsCard />);

    expect(await screen.findByText("2.1.0")).toBeInTheDocument();
    expect(screen.getByText("/usr/local/bin/claude")).toBeInTheDocument();
    expect(screen.queryByText(/claude login/)).toBeNull();
  });

  it("shows an install/login hint when management is offered but the CLI is missing", async () => {
    // Mixed state: the server offers Claude management (supported) yet the CLI probe failed
    // (cliVersion null, unavailableReason set). The card must warn — not report readiness.
    const readClaudeSettings = vi.fn().mockResolvedValue({
      supported: true,
      unavailableReason: "Claude Code CLI не найден",
      cliVersion: null,
      path: "/usr/local/bin/claude",
    });
    connection.mockReturnValue({ api: { readClaudeSettings, checkClaude: vi.fn() } });

    render(<ClaudeSettingsCard />);

    expect(await screen.findByText(/claude login/)).toBeInTheDocument();
    expect(screen.getByText(/Claude Code CLI не найден/)).toBeInTheDocument();
  });

  it("suggests enabling the flag when the Claude agent is disabled", async () => {
    const readClaudeSettings = vi.fn().mockResolvedValue({
      supported: false,
      unavailableReason: "Агент Claude отключён",
      cliVersion: null,
      path: null,
    });
    connection.mockReturnValue({ api: { readClaudeSettings, checkClaude: vi.fn() } });

    render(<ClaudeSettingsCard />);

    expect(await screen.findByText(/CODEXNEST_CLAUDE_ENABLED=true/)).toBeInTheDocument();
    expect(screen.getByText(/Агент Claude отключён/)).toBeInTheDocument();
    // Disabled is not the same as "install the CLI" — that advice must not appear here.
    expect(screen.queryByText(/claude login/)).toBeNull();
  });

  it("shows a neutral note instead of a red error when the server lacks the route", async () => {
    const readClaudeSettings = vi
      .fn()
      .mockRejectedValue(new ApiClientError("not_found", "Route not found", 404));
    connection.mockReturnValue({ api: { readClaudeSettings, checkClaude: vi.fn() } });

    render(<ClaudeSettingsCard />);

    expect(
      await screen.findByText("Управление Claude Code недоступно на этой версии сервера."),
    ).toBeInTheDocument();
    // Neutral, not an error, and nothing to probe on an older server.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Проверить" })).toBeNull();
  });

  it("keeps the red error notice for a non-404 load failure", async () => {
    const readClaudeSettings = vi
      .fn()
      .mockRejectedValue(new ApiClientError("internal_error", "Внутренняя ошибка", 500));
    connection.mockReturnValue({ api: { readClaudeSettings, checkClaude: vi.fn() } });

    render(<ClaudeSettingsCard />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Внутренняя ошибка");
    expect(
      screen.queryByText("Управление Claude Code недоступно на этой версии сервера."),
    ).toBeNull();
  });

  it("re-probes Claude Code through the check button", async () => {
    const readClaudeSettings = vi.fn().mockResolvedValue({
      supported: true,
      unavailableReason: "Claude Code CLI не найден",
      cliVersion: null,
      path: "/bin/claude",
    });
    const checkClaude = vi.fn().mockResolvedValue({
      supported: true,
      unavailableReason: null,
      cliVersion: "2.2.0",
      path: "/bin/claude",
    });
    connection.mockReturnValue({ api: { readClaudeSettings, checkClaude } });

    render(<ClaudeSettingsCard />);
    await screen.findByText(/claude login/);

    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));

    await waitFor(() => expect(checkClaude).toHaveBeenCalled());
    expect(await screen.findByText("2.2.0")).toBeInTheDocument();
    expect(screen.getByText("Claude Code найден и готов к работе.")).toBeInTheDocument();
  });

  it("reports the probe error from check when management is offered but the CLI is missing", async () => {
    const readClaudeSettings = vi.fn().mockResolvedValue({
      supported: true,
      unavailableReason: "Claude Code CLI не найден",
      cliVersion: null,
      path: "/bin/claude",
    });
    // supported stays true (server offers management) but the CLI is still missing — check()
    // must surface the failure, not the unconditional "готов к работе" success.
    const checkClaude = vi.fn().mockResolvedValue({
      supported: true,
      unavailableReason: "Claude Code CLI не найден",
      cliVersion: null,
      path: "/bin/claude",
    });
    connection.mockReturnValue({ api: { readClaudeSettings, checkClaude } });

    render(<ClaudeSettingsCard />);
    await screen.findByText(/claude login/);

    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));

    await waitFor(() => expect(checkClaude).toHaveBeenCalled());
    expect(await screen.findByRole("alert")).toHaveTextContent("Claude Code CLI не найден");
    expect(screen.queryByText("Claude Code найден и готов к работе.")).toBeNull();
  });
});
