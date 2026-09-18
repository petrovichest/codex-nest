import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initializeTypography,
  parseTypography,
  resetTypography,
  setTypographySize,
  TYPOGRAPHY_DEFAULTS,
  TYPOGRAPHY_KEY,
  TYPOGRAPHY_ROLES,
  type TypographyRole,
} from "./typography";

beforeEach(() => {
  localStorage.clear();
  initializeTypography();
});
afterEach(() => {
  vi.restoreAllMocks();
  resetTypography();
  localStorage.clear();
});

describe("local typography preferences", () => {
  it("recovers valid roles independently from malformed or outdated preferences", () => {
    for (const value of [null, "broken", "null", "[]", "17"])
      expect(parseTypography(value)).toEqual(TYPOGRAPHY_DEFAULTS);
    expect(
      parseTypography(
        JSON.stringify({
          ui: 32,
          message: 10,
          description: 33,
          technical: 9,
          caption: 12.5,
          micro: "20",
          unknown: 18,
        }),
      ),
    ).toEqual({ ...TYPOGRAPHY_DEFAULTS, ui: 32, message: 10 });
  });

  it("applies saved sizes before mounting, independently, and persists changes", () => {
    localStorage.setItem(TYPOGRAPHY_KEY, JSON.stringify({ ui: 24, message: 20 }));
    initializeTypography();
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--text-ui")).toBe("24px");
    expect(root.style.getPropertyValue("--text-input")).toBe("20px");
    setTypographySize("technical", 32);
    const stored = JSON.parse(localStorage.getItem(TYPOGRAPHY_KEY)!);
    expect(stored).toEqual({ ...TYPOGRAPHY_DEFAULTS, ui: 24, message: 20, technical: 32 });
    expect(root.style.getPropertyValue("--text-small")).toBe("14px");
    expect(root).toHaveAttribute("data-custom-typography");
    initializeTypography();
    expect(root.style.getPropertyValue("--text-code")).toBe("32px");
  });

  it("rejects invalid changes and resets only font preferences", () => {
    localStorage.setItem("codexnest.theme", "dark");
    setTypographySize("caption", 22);
    for (const invalid of [NaN, Infinity, 9, 33, 14.5]) setTypographySize("caption", invalid);
    expect(document.documentElement.style.getPropertyValue("--text-caption")).toBe("22px");
    resetTypography();
    expect(document.documentElement).not.toHaveAttribute("data-custom-typography");
    expect(localStorage.getItem("codexnest.theme")).toBe("dark");
    for (const role of Object.keys(TYPOGRAPHY_ROLES) as TypographyRole[]) {
      expect(document.documentElement.style.getPropertyValue(TYPOGRAPHY_ROLES[role].token)).toBe(
        `${TYPOGRAPHY_DEFAULTS[role]}px`,
      );
    }
  });

  it("keeps working when browser storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => {
      initializeTypography();
      setTypographySize("message", 24);
      resetTypography();
    }).not.toThrow();
  });
});
