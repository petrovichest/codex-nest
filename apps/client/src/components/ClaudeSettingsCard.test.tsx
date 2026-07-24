import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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

  it("shows an install/login hint when Claude Code is unavailable", async () => {
    const readClaudeSettings = vi.fn().mockResolvedValue({
      supported: false,
      unavailableReason: "Claude Code CLI не найден",
      cliVersion: null,
      path: null,
    });
    connection.mockReturnValue({ api: { readClaudeSettings, checkClaude: vi.fn() } });

    render(<ClaudeSettingsCard />);

    expect(await screen.findByText(/claude login/)).toBeInTheDocument();
  });

  it("re-probes Claude Code through the check button", async () => {
    const readClaudeSettings = vi.fn().mockResolvedValue({
      supported: false,
      unavailableReason: "Claude Code CLI не найден",
      cliVersion: null,
      path: null,
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
});
