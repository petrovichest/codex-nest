import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";

import { Activity } from "./ThreadPage";

it("keeps message image galleries separate and supports keyboard navigation", () => {
  const firstImages = ["data:image/png;base64,Zmlyc3Q=", "data:image/png;base64,c2Vjb25k"];
  const view = render(
    <>
      <Activity
        item={{
          type: "userMessage",
          id: "first-message",
          status: "completed",
          text: "",
          images: firstImages,
          timestamp: null,
          phase: null,
        }}
      />
      <Activity
        item={{
          type: "userMessage",
          id: "second-message",
          status: "completed",
          text: "",
          images: ["data:image/png;base64,dGhpcmQ="],
          timestamp: null,
          phase: null,
        }}
      />
    </>,
  );

  const secondPreview = screen.getByRole("button", { name: "Открыть изображение 2" });
  fireEvent.click(secondPreview);

  let dialog = screen.getByRole("dialog", { name: "Просмотр изображений" });
  expect(within(dialog).getByAltText("Изображение 2")).toHaveAttribute("src", firstImages[1]);
  expect(within(dialog).getByText("Изображение 2 из 2")).toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "Следующее изображение" })).toBeDisabled();

  fireEvent.keyDown(document, { key: "ArrowLeft" });
  dialog = screen.getByRole("dialog", { name: "Просмотр изображений" });
  expect(within(dialog).getByAltText("Изображение 1")).toHaveAttribute("src", firstImages[0]);
  expect(within(dialog).getByRole("button", { name: "Предыдущее изображение" })).toBeDisabled();

  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Просмотр изображений" })).toBeNull();
  expect(secondPreview).toHaveFocus();

  const secondMessage = view.container.querySelector('[data-message-id="second-message"]')!;
  const singlePreview = within(secondMessage as HTMLElement).getByRole("button", {
    name: "Открыть изображение 1",
  });
  fireEvent.click(singlePreview);
  dialog = screen.getByRole("dialog", { name: "Просмотр изображений" });
  expect(within(dialog).queryByRole("button", { name: "Следующее изображение" })).toBeNull();
  expect(within(dialog).queryByText(/ из /)).toBeNull();

  fireEvent.mouseDown(dialog);
  expect(screen.queryByRole("dialog", { name: "Просмотр изображений" })).toBeNull();
  expect(singlePreview).toHaveFocus();
});
