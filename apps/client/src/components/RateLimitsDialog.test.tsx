import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RateLimitsDialog } from "./RateLimitsDialog";

describe("RateLimitsDialog", () => {
  it("keeps restrictions explicit even with a reset window and distinguishes unknown values", () => {
    render(
      <RateLimitsDialog
        limits={{
          primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1000 },
          secondary: null,
          ordinaryUsageAllowed: false,
          spendControlReached: null,
          rateLimitReachedType: "future_reason",
        }}
        loading={false}
        error
        updatedAt={1000}
        onRefresh={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("последние полученные данные");
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(
      screen.getByText("Обычное использование разрешено").nextElementSibling,
    ).toHaveTextContent("Нет");
    expect(screen.getByText("Порог расходов достигнут").nextElementSibling).toHaveTextContent(
      "Не сообщено",
    );
    expect(screen.getByText("future_reason")).toBeInTheDocument();
    const reset = screen.getAllByText("Сброс окна")[0]!.nextElementSibling;
    expect(reset?.textContent).toContain("1970");
    expect(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Обновить" }),
    ).toBeEnabled();
  });
});
