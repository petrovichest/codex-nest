import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

type WebAppManifest = {
  id?: string;
  start_url?: string;
  scope?: string;
  display?: string;
  icons?: Array<{
    src: string;
    sizes: string;
    type: string;
    purpose?: string;
  }>;
};

describe("PWA metadata", () => {
  it("keeps every client route inside the standalone app scope", () => {
    const manifest = readManifest();

    expect(manifest).toMatchObject({
      id: "/",
      start_url: "/",
      scope: "/",
      display: "standalone",
    });
  });

  it("links the manifest and iOS Home Screen metadata from the app shell", () => {
    const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
    const document = new DOMParser().parseFromString(html, "text/html");

    expect(document.querySelector('link[rel="manifest"]')?.getAttribute("href")).toBe(
      "/manifest.webmanifest",
    );
    expect(document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href")).toBe(
      "/apple-touch-icon.png",
    );
    expect(
      document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.getAttribute("content"),
    ).toBe("yes");
    expect(
      document.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute("content"),
    ).toBe("CodexNest");
  });

  it("ships valid PNG icons at every declared size", () => {
    const manifest = readManifest();
    expect(manifest.icons).toHaveLength(2);

    for (const icon of manifest.icons ?? []) {
      expect(icon.type).toBe("image/png");
      expect(icon.purpose?.split(/\s+/)).toEqual(expect.arrayContaining(["any", "maskable"]));
      const size = Number(icon.sizes.split("x")[0]);
      expect(readPngSize(icon.src)).toEqual({ width: size, height: size });
    }

    expect(readPngSize("/apple-touch-icon.png")).toEqual({ width: 180, height: 180 });
  });
});

function readManifest(): WebAppManifest {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), "public/manifest.webmanifest"), "utf8"),
  ) as WebAppManifest;
}

function readPngSize(src: string): { width: number; height: number } {
  const file = readFileSync(resolve(process.cwd(), "public", src.replace(/^\//, "")));
  expect(Array.from(file.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return { width: file.readUInt32BE(16), height: file.readUInt32BE(20) };
}
