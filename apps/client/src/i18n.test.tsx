import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { I18nProvider, readInitialLanguage, translate, useI18n } from "./i18n";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.lang = "";
});

describe("interface localization", () => {
  it("defaults fresh clients to English and preserves Russian for legacy clients", () => {
    expect(readInitialLanguage()).toBe("en");

    localStorage.setItem("codexnest.theme", "dark");
    expect(readInitialLanguage()).toBe("ru");

    localStorage.setItem("codexnest.uiLanguage", "en");
    expect(readInitialLanguage()).toBe("en");
  });

  it("translates variables and changes the document language", () => {
    expect(translate("en", "Показать ещё {{count}}", { count: 3 })).toBe("Show 3 more");

    render(
      <I18nProvider>
        <LanguageProbe />
      </I18nProvider>,
    );
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Настройки")).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("ru");
    expect(localStorage.getItem("codexnest.uiLanguage")).toBe("ru");
  });
});

function LanguageProbe() {
  const { language, setLanguage, t } = useI18n();
  return (
    <button type="button" onClick={() => setLanguage(language === "en" ? "ru" : "en")}>
      {t("Настройки")}
    </button>
  );
}
