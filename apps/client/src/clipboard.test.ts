import { afterEach, describe, expect, it, vi } from "vitest";
import { copyMarkdown } from "./clipboard";
import { renderMarkdownHtml } from "./markdown-clipboard";

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
});

describe("rich Markdown clipboard", () => {
  it("renders safe GFM from source without controls, raw HTML, or remote image loads", () => {
    const html = renderMarkdownHtml(
      "# Title\n\n**bold** and [link](https://example.com)\n\n- one\n- two\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst a = 1;\n```\n\n![alt](https://example.com/private.png)\n\n<script>alert(1)</script>\n\n[bad](javascript:alert%281%29)",
    );
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<table>");
    expect(html).toContain("<ul>");
    expect(html).toContain("language-ts");
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toMatch(/<img|<script|javascript:|private.png|<button|download-ticket/);
  });

  it("writes HTML and the original Markdown in one user-gesture clipboard operation", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn();
    let entries: Record<string, Blob | Promise<Blob>> = {};
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(value: typeof entries) {
          entries = value;
        }
      },
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write, writeText },
    });
    const copying = copyMarkdown("**bold**");
    expect(write).toHaveBeenCalledOnce();
    await copying;
    expect(await blobText(await entries["text/plain"]!)).toBe("**bold**");
    expect(await blobText(await entries["text/html"]!)).toContain("<strong>bold</strong>");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("falls back to plain Markdown when rich clipboard is unavailable or denied", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await copyMarkdown("**one**");
    expect(writeText).toHaveBeenLastCalledWith("**one**");
    vi.stubGlobal("ClipboardItem", class {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write: vi.fn().mockRejectedValue(new Error("Denied")), writeText },
    });
    await copyMarkdown("**two**");
    expect(writeText).toHaveBeenLastCalledWith("**two**");
  });
});

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(blob);
  });
}
