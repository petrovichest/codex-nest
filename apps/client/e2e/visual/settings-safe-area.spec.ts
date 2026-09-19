import { expect, test } from "@playwright/test";

import { installVisualFixture, waitForVisualReady } from "./fixtures";

const layouts = [
  { width: 390, height: 844, top: 64, bottom: 24, left: 0, right: 0, size: 14 },
  { width: 320, height: 844, top: 34, bottom: 24, left: 0, right: 0, size: 14 },
  { width: 320, height: 844, top: 34, bottom: 24, left: 0, right: 0, size: 32 },
  { width: 390, height: 844, top: 0, bottom: 0, left: 0, right: 0, size: 14 },
  { width: 390, height: 844, top: 64, bottom: 48, left: 0, right: 0, size: 32 },
  { width: 390, height: 500, top: 34, bottom: 0, left: 0, right: 0, size: 14 },
  { width: 780, height: 390, top: 24, bottom: 24, left: 48, right: 24, size: 14 },
  { width: 820, height: 844, top: 34, bottom: 24, left: 0, right: 0, size: 14 },
];

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: mobile settings preserve spacing around system bars, text and sticky tabs`, async ({
    page,
  }) => {
    await installVisualFixture(page, { theme });
    await page.goto("/settings?section=application");
    await waitForVisualReady(page);
    for (const layout of layouts) {
      await page.setViewportSize({ width: layout.width, height: layout.height });
      await page.evaluate((layout) => {
        const root = document.documentElement;
        for (const edge of ["top", "bottom", "left", "right"] as const) {
          root.style.setProperty(`--safe-area-inset-${edge}`, `${layout[edge]}px`);
        }
        root.toggleAttribute("data-custom-typography", layout.size !== 14);
        for (const role of ["--text-section", "--text-small", "--text-ui"]) {
          root.style.setProperty(role, `${layout.size}px`);
        }
        document.querySelector(".settings-scroll")!.scrollTop = 0;
      }, layout);
      // Wait for viewport changes and the WebView inset variables to reach layout.
      await expect(async () => {
        const geometry = await page.evaluate(() => {
          const rect = (selector: string) =>
            document.querySelector(selector)!.getBoundingClientRect().toJSON();
          return {
            header: rect(".settings-workspace .workspace-header"),
            title: rect(".workspace-title"),
            tab: rect(".settings-section-tab"),
            card: rect(".settings-stack:not([hidden]) .settings-group"),
            field: rect("#settings-project-order"),
            scroll: rect(".settings-scroll"),
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
        const { header, title, tab, card, field, scroll } = geometry;
        expect(header.top).toBeCloseTo(layout.top, 0);
        expect(title.top - header.top).toBeGreaterThanOrEqual(7.9);
        expect(header.bottom - title.bottom).toBeGreaterThanOrEqual(7.9);
        expect(header.left).toBeCloseTo(16 + layout.left, 0);
        expect(header.right).toBeCloseTo(layout.width - 16 - layout.right, 0);
        expect(card.left).toBeCloseTo(header.left, 0);
        expect(card.right).toBeCloseTo(header.right, 0);
        expect(tab.top - header.bottom).toBeCloseTo(16, 0);
        expect(card.top - tab.bottom).toBeCloseTo(20, 0);
        expect(card.bottom - field.bottom).toBeCloseTo(24, 0);
        expect(scroll.bottom).toBeCloseTo(layout.height - layout.bottom, 0);
        expect(geometry.overflow).toBe(false);
      }).toPass();
      if (layout === layouts[0]) {
        await expect(page).toHaveScreenshot(`settings-safe-area-${theme}.png`);
      }
      for (const position of [100, 500, null]) {
        await page.locator(".settings-scroll").evaluate((el, top) => {
          el.scrollTop = top ?? el.scrollHeight;
        }, position);
        await expect(async () => {
          const header = (await page.locator(".workspace-header").boundingBox())!;
          const tab = (await page.locator(".settings-section-tab").first().boundingBox())!;
          expect(tab.y - (header.y + header.height)).toBeCloseTo(16, 0);
        }).toPass();
      }
      const lastCard = (await page.locator(".settings-group:visible").last().boundingBox())!;
      // scrollHeight rounds to an integer, while card geometry can retain subpixels.
      expect(
        Math.abs(layout.height - layout.bottom - lastCard.y - lastCard.height - 24),
      ).toBeLessThan(1);
    }
  });
}
