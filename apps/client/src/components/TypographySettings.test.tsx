import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import { initializeTypography, resetTypography, TYPOGRAPHY_KEY } from "../typography";
import { TypographySettings } from "./TypographySettings";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("codexnest.uiLanguage", "ru");
  act(() => initializeTypography());
});

it("shows all nine roles and applies only valid values while preserving editable input", () => {
  render(
    <I18nProvider>
      <TypographySettings />
    </I18nProvider>,
  );
  expect(screen.getAllByRole("spinbutton")).toHaveLength(9);
  const field = screen.getByRole("spinbutton", { name: "Основной интерфейс" });
  fireEvent.change(field, { target: { value: "24" } });
  expect(document.documentElement.style.getPropertyValue("--text-ui")).toBe("24px");
  expect(screen.getByRole("spinbutton", { name: "Сообщения и поля ввода" })).toHaveValue(16);
  fireEvent.change(field, { target: { value: "33" } });
  expect(field).toHaveValue(33);
  expect(document.documentElement.style.getPropertyValue("--text-ui")).toBe("24px");
  fireEvent.blur(field);
  expect(field).toHaveValue(24);
  fireEvent.change(field, { target: { value: "" } });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(field).toHaveValue(24);
  fireEvent.click(screen.getByRole("button", { name: "Сбросить размер: Основной интерфейс" }));
  expect(field).toHaveValue(16);
  expect(JSON.parse(localStorage.getItem(TYPOGRAPHY_KEY)!).ui).toBe(16);
});

it("restores defaults including an invalid draft whose saved size is already default", () => {
  render(
    <I18nProvider>
      <TypographySettings />
    </I18nProvider>,
  );
  const field = screen.getByRole("spinbutton", { name: "Основной интерфейс" });
  fireEvent.change(field, { target: { value: "99" } });
  fireEvent.click(screen.getByRole("button", { name: "Вернуть стандартные размеры" }));
  expect(field).toHaveValue(16);
  act(() => resetTypography());
});
