import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AttentionPanel } from "./AttentionPanel";

const connection = vi.hoisted(() => vi.fn());

vi.mock("../connection", () => ({ useConnection: connection }));

describe("AttentionPanel", () => {
  it("responds to approvals through the existing API", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    connection.mockReturnValue({ api: { respond }, state: { snapshot: null } });
    render(
      <AttentionPanel
        requests={[
          {
            id: "attention",
            threadId: "thread",
            turnId: "turn",
            itemId: "item",
            createdAt: 1,
            kind: "commandApproval",
            command: "npm test",
            cwd: "/work",
            reason: "Нужно проверить изменения",
            networkHost: null,
            canAcceptForSession: true,
            proposedPolicyChanges: [],
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Разрешить один раз" }));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("attention", {
        kind: "approval",
        decision: "accept",
      }),
    );
  });

  it("shows user-input questions one at a time and submits all answers at the end", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    connection.mockReturnValue({ api: { respond }, state: { snapshot: null } });
    render(
      <AttentionPanel
        requests={[
          {
            id: "questions",
            threadId: "thread",
            turnId: "turn",
            itemId: "item",
            createdAt: 1,
            kind: "userInput",
            autoResolutionMs: null,
            questions: [
              {
                id: "storage",
                header: "Хранение",
                question: "Где хранить вложения?",
                isOther: true,
                isSecret: false,
                options: [
                  { label: "На сервере", description: "Единое хранилище." },
                  { label: "В проекте", description: "Только локальные файлы." },
                ],
              },
              {
                id: "source",
                header: "Источники",
                question: "Как выбирать изображение?",
                isOther: false,
                isSecret: false,
                options: [
                  { label: "Камера", description: "Сделать новый снимок." },
                  { label: "Галерея", description: "Выбрать готовый файл." },
                ],
              },
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText("Вопрос 1 из 2")).toBeInTheDocument();
    expect(screen.getByText("Где хранить вложения?")).toBeInTheDocument();
    expect(screen.queryByText("Как выбирать изображение?")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Далее" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Далее" }).parentElement).toHaveClass(
      "user-input-actions",
    );

    fireEvent.click(screen.getByRole("radio", { name: /На сервере/ }));
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));

    expect(screen.getByText("Вопрос 2 из 2")).toBeInTheDocument();
    expect(screen.queryByText("Где хранить вложения?")).not.toBeInTheDocument();
    expect(screen.getByText("Как выбирать изображение?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Отправить ответы" })).toBeDisabled();
    expect(respond).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("radio", { name: /Галерея/ }));
    fireEvent.click(screen.getByRole("button", { name: "Отправить ответы" }));

    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("questions", {
        kind: "userInput",
        answers: { storage: ["На сервере"], source: ["Галерея"] },
      }),
    );
  });

  it("names the acting agent in the user-input title for a Claude thread", () => {
    connection.mockReturnValue({
      api: { respond: vi.fn() },
      state: { snapshot: { threads: [{ id: "thread", agent: "claude" }] } },
    });
    render(
      <AttentionPanel
        requests={[
          {
            id: "questions",
            threadId: "thread",
            turnId: "turn",
            itemId: "item",
            createdAt: 1,
            kind: "userInput",
            autoResolutionMs: null,
            questions: [
              {
                id: "q",
                header: "H",
                question: "Q?",
                isOther: false,
                isSecret: false,
                options: [{ label: "A", description: "" }],
              },
            ],
          },
        ]}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Claude Code просит уточнение" }),
    ).toBeInTheDocument();
  });
});
