import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { chromium } from "@playwright/test";

// Generated assets are checked in: ordinary builds do not need a browser.
const source = await readFile(new URL("../../client/public/favicon.svg", import.meta.url), "utf8");
const output = resolve(import.meta.dirname, "../public/chrome/icons");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  for (const size of [16, 32, 48, 128]) {
    const png = await page.evaluate(
      async ({ source, size }) => {
        const image = new Image();
        image.src = `data:image/svg+xml,${encodeURIComponent(source)}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        canvas.getContext("2d").drawImage(image, 0, 0, size, size);
        return canvas.toDataURL("image/png").split(",")[1];
      },
      { source, size },
    );
    await writeFile(resolve(output, `codexnest-${size}.png`), Buffer.from(png, "base64"));
  }
} finally {
  await browser.close();
}
