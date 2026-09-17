// @vitest-environment node

import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");

// Optical geometry, not surface radii: session marker, document/image edge,
// and inline-link focus.
const opticalRadii = new Map([
  [".thread-link .status", "2px"],
  [".artifact-document, .artifact-html-frame", "2px"],
  [".artifact-image", "2px"],
  [".fork-parent-link:focus-visible", "3px"],
]);

describe("shared surface radii", () => {
  for (const file of globSync(["apps/client/src/**/*.css", "apps/extension/src/**/*.css"], {
    cwd: root,
  }).sort()) {
    it(`${file} uses the shared scale or explicit component geometry`, () => {
      const css = readFileSync(resolve(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      const violations: string[] = [];
      for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = block[1]!.trim().replace(/\s+/g, " ");
        for (const declaration of block[2]!.matchAll(/\bborder(?:-[\w-]+)?-radius:\s*([^;]+);/g)) {
          const value = declaration[1]!.trim();
          if (opticalRadii.get(selector) === value) continue;
          // The floating composer has its own desktop and mobile bubble geometry.
          if (selector === ".composer-box" && ["30px", "24px"].includes(value)) continue;
          const remaining = value
            .replace(/var\(--radius-(?:sm|md|lg)\)/g, "")
            .replace(/var\(--chat-radius(?:-(?:control|card|surface|compact|checkbox))?\)/g, "")
            .replace(/\b(?:0|50%|999px)(?=\s|$)/g, "")
            .trim();
          if (remaining) violations.push(`${selector}: ${value}`);
        }
      }
      expect(violations).toEqual([]);
    });
  }
});
