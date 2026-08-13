import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const extensionRoot = resolve(import.meta.dirname, "..");

describe("browser packaging", () => {
  it("keeps the fixed Chrome identity and debugger service worker manifest", async () => {
    const manifest = await readJson("public/chrome/manifest.json");
    expect(manifest).toMatchObject({
      manifest_version: 3,
      minimum_chrome_version: "116",
      action: { default_popup: "popup.html" },
      side_panel: { default_path: "panel.html" },
      background: { service_worker: "background.js", type: "module" },
      permissions: expect.arrayContaining(["debugger", "sidePanel"]),
    });
    expect(manifest.key).toMatch(/^MIGf/);
  });

  it("ships popup and panel surfaces from the shared popup entrypoint", async () => {
    const [popup, panel] = await Promise.all([
      readFile(resolve(extensionRoot, "popup.html"), "utf8"),
      readFile(resolve(extensionRoot, "panel.html"), "utf8"),
    ]);

    expect(popup).toContain('<body data-surface="popup">');
    expect(panel).toContain('<body data-surface="panel">');
    expect(popup).toContain('<script type="module" src="/src/popup.ts"></script>');
    expect(panel).toContain('<script type="module" src="/src/popup.ts"></script>');
  });

  it("declares the Chrome ZIP package name", async () => {
    const script = await readFile(resolve(extensionRoot, "scripts/package.mjs"), "utf8");
    expect(script).toContain("codexnest-browser-${manifest.version}.zip");
  });
});

async function readJson(relativePath: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(resolve(extensionRoot, relativePath), "utf8"));
}
