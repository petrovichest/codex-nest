import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SetupScreen } from "./SetupScreen";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("SetupScreen", () => {
  it("shows the permanent LAN interception warning for HTTP", () => {
    render(<SetupScreen onConnected={() => undefined} />);
    expect(screen.getByText(/HTTP не шифрует token/)).toBeInTheDocument();
  });

  it("checks health and bearer authentication before saving", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ threadCount: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const connected = vi.fn();
    render(<SetupScreen onConnected={connected} />);
    fireEvent.change(screen.getByLabelText("Адрес сервера"), {
      target: { value: "https://pi.local:4310" },
    });
    fireEvent.change(screen.getByLabelText("Bearer token"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Подключиться" }));
    await waitFor(() =>
      expect(connected).toHaveBeenCalledWith({ baseUrl: "https://pi.local:4310", token: "secret" }),
    );
    const secondHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Headers;
    expect(secondHeaders.get("Authorization")).toBe("Bearer secret");
  });
});
