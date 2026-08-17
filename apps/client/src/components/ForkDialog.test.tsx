import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ForkEstimateResponse, ForkOperationSummary } from "../forks";
import { translate } from "../i18n";
import { ForkDialog, formatForkBytes, formatForkTime } from "./ForkDialog";

const connection = vi.hoisted(() => vi.fn());
vi.mock("../connection", () => ({ useConnection: connection }));

const estimate: ForkEstimateResponse = {
  sourceBytes: 12_345_678,
  compressed: {
    available: true,
    estimatedBytes: 456_789,
    estimatedSeconds: { minSeconds: 8, maxSeconds: 15 },
    unavailableReason: null,
  },
  exact: {
    available: true,
    estimatedBytes: 12_345_678,
    estimatedSeconds: { minSeconds: 65, maxSeconds: 125 },
    unavailableReason: null,
  },
};

const operation: ForkOperationSummary = {
  id: "operation-id",
  sourceThreadId: "thread",
  lastTurnId: "turn",
  agentMessageId: "answer",
  mode: "compressed",
  status: "preparing",
  title: "",
  createdAt: 1,
  updatedAt: 1,
  targetThreadId: null,
  queuedMessageCount: 0,
  estimate: estimate.compressed,
  error: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "stable-operation-id") });
});

describe("ForkDialog", () => {
  it("paints while estimating, defaults to compressed when available, and creates once", async () => {
    let resolveEstimate!: (value: ForkEstimateResponse) => void;
    const estimateFork = vi.fn(
      () => new Promise<ForkEstimateResponse>((resolve) => (resolveEstimate = resolve)),
    );
    let resolveCreate!: (value: { operation: ForkOperationSummary }) => void;
    const createForkOperation = vi.fn(
      () =>
        new Promise<{ operation: ForkOperationSummary }>((resolve) => (resolveCreate = resolve)),
    );
    connection.mockReturnValue({ api: { estimateFork, createForkOperation } });
    const onCreated = vi.fn();

    renderDialog({ onCreated });
    const dialog = screen.getByRole("dialog", { name: "Создать ветку" });
    expect(dialog).toBeVisible();
    expect(within(dialog).getAllByText("Считаем…").length).toBeGreaterThan(0);
    expect(within(dialog).getByRole("button", { name: "Закрыть" })).toHaveFocus();

    await act(async () => resolveEstimate(estimate));
    const compressed = within(dialog).getByRole("radio", { name: /Компактная/ });
    expect(compressed).toBeChecked();
    const create = within(dialog).getByRole("button", { name: "Создать ветку" });
    fireEvent.click(create);
    fireEvent.click(create);

    expect(createForkOperation).toHaveBeenCalledOnce();
    expect(createForkOperation).toHaveBeenCalledWith("thread", {
      operationId: "stable-operation-id",
      lastTurnId: "turn",
      agentMessageId: "answer",
      mode: "compressed",
    });
    await act(async () => resolveCreate({ operation }));
    expect(onCreated).toHaveBeenCalledWith(operation);
  });

  it("keeps exact selectable with unknown estimates when estimation fails", async () => {
    connection.mockReturnValue({
      api: {
        estimateFork: vi.fn().mockRejectedValue(new Error("offline")),
        createForkOperation: vi.fn(),
      },
    });
    renderDialog();

    const exact = await screen.findByRole("radio", { name: /Полная история/ });
    expect(exact).toBeEnabled();
    await waitFor(() => expect(exact).toBeChecked());
    expect(screen.getByRole("radio", { name: /Компактная/ })).toBeDisabled();
    expect(
      screen.getByText("Сжатый контекст для этой точки недоступен. Выберите полную историю."),
    ).toBeVisible();
    expect(screen.getAllByText("неизвестно").length).toBeGreaterThanOrEqual(2);
  });

  it("selects exact when compressed is explicitly unavailable and closes by keyboard", async () => {
    const onClose = vi.fn();
    connection.mockReturnValue({
      api: {
        estimateFork: vi.fn().mockResolvedValue({
          ...estimate,
          compressed: {
            available: false,
            estimatedBytes: null,
            estimatedSeconds: null,
            unavailableReason: "Недостаточно данных для безопасного сжатия",
          },
        }),
        createForkOperation: vi.fn(),
      },
    });
    renderDialog({ onClose });
    expect(await screen.findByRole("radio", { name: /Полная история/ })).toBeChecked();
    expect(
      screen.getByText("Сжатый контекст для этой точки недоступен. Выберите полную историю."),
    ).toBeVisible();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("formats large estimates without unbounded precision", () => {
    expect(
      formatForkBytes(9_876_543_210, "en", (key, values) => translate("en", key, values)),
    ).toBe("9.2 GB");
    expect(
      formatForkTime({ minSeconds: 65, maxSeconds: 125 }, (key, values) =>
        key.replace("{{count}}", String(values?.count)),
      ),
    ).toBe("≈ 2 мин–3 мин");
  });
});

function renderDialog({
  onClose = vi.fn(),
  onCreated = vi.fn(),
}: {
  onClose?: () => void;
  onCreated?: (operation: ForkOperationSummary) => void;
} = {}) {
  return render(
    <ForkDialog
      sourceThreadId="thread"
      sourceTitle="Очень длинное название исходной задачи"
      lastTurnId="turn"
      agentMessageId="answer"
      onClose={onClose}
      onCreated={onCreated}
    />,
  );
}
