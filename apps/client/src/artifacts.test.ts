import { describe, expect, it } from "vitest";

import { artifactDescriptor, formatArtifactSize, safeArtifactHtml } from "./artifacts";

describe("artifactDescriptor", () => {
  it("classifies supported artifact files without treating Office files as previewable", () => {
    expect(artifactDescriptor("/work/report.PDF")).toMatchObject({ kind: "pdf", format: "PDF" });
    expect(artifactDescriptor("/work/notes.md")).toMatchObject({
      kind: "markdown",
      format: "Markdown",
    });
    expect(artifactDescriptor("/work/dashboard.html")).toMatchObject({
      kind: "html",
      format: "HTML",
    });
    expect(artifactDescriptor("/work/image.webp")).toMatchObject({
      kind: "image",
      format: "WEBP",
    });
    expect(artifactDescriptor("/work/deck.pptx")).toBeNull();
  });

  it("formats compact file sizes", () => {
    expect(formatArtifactSize(12)).toBe("12 B");
    expect(formatArtifactSize(1_025)).toBe("2 KB");
    expect(formatArtifactSize(2 * 1024 * 1024)).toBe("2.0 MB");
  });
});

describe("safeArtifactHtml", () => {
  it("keeps document styling while removing active and remote content", () => {
    const html = safeArtifactHtml(`
      <html><head><style>h1 { color: red }</style></head><body>
        <h1 onclick="alert(1)">Report</h1>
        <script>alert(1)</script>
        <img src="https://tracker.example/pixel.png">
        <img src="data:image/png;base64,AA==">
        <a href="https://tracker.example/report">Open</a>
        <form action="https://example.com"><input></form>
      </body></html>
    `);

    expect(html).toContain("h1 { color: red }");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("tracker.example");
    expect(html).toContain("data:image/png;base64,AA==");
    expect(html).not.toContain("<form");
    expect(html).toContain("Content-Security-Policy");
  });
});
