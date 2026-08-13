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

  it("uses a fixed Gecko id, module background scripts, and no debugger permission", async () => {
    const manifest = await readJson("public/firefox/manifest.json");
    expect(manifest).toMatchObject({
      manifest_version: 3,
      browser_specific_settings: {
        gecko: {
          id: "codexnest-browser@petrovichest",
          strict_min_version: "146.0",
          data_collection_permissions: {
            required: expect.arrayContaining([
              "authenticationInfo",
              "browsingActivity",
              "websiteContent",
              "websiteActivity",
            ]),
          },
        },
      },
      action: { default_popup: "popup.html" },
      sidebar_action: {
        default_panel: "panel.html",
        open_at_install: false,
      },
      background: { scripts: ["background.js"], type: "module" },
    });
    expect(manifest.permissions).not.toContain("debugger");
    expect(manifest.permissions).not.toContain("windows");
    expect(manifest).not.toHaveProperty("key");
    expect(manifest).not.toHaveProperty("minimum_chrome_version");
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

  it("declares separate Chrome ZIP and Firefox XPI package names", async () => {
    const script = await readFile(resolve(extensionRoot, "scripts/package.mjs"), "utf8");
    expect(script).toContain("codexnest-browser-${manifest.version}.zip");
    expect(script).toContain("codexnest-browser-firefox-${manifest.version}.xpi");
  });
});

async function readJson(relativePath: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(resolve(extensionRoot, relativePath), "utf8"));
}
