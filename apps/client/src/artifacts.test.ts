import { describe, expect, it } from "vitest";

import type { ActivityItem, TurnView } from "@codexnest/protocol";

import {
  artifactDescriptor,
  collectSessionArtifacts,
  formatArtifactSize,
  localDownloadPath,
  safeArtifactHtml,
} from "./artifacts";

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

describe("localDownloadPath", () => {
  it("decodes confined absolute paths and rejects other hrefs", () => {
    expect(localDownloadPath("/work/report%20final.pdf", "/work/")).toBe("/work/report final.pdf");
    expect(localDownloadPath("/work", "/work/")).toBe("/work");
    expect(localDownloadPath("report.pdf", "/work")).toBeNull();
    expect(localDownloadPath("/workspace/report.pdf", "/work")).toBeNull();
    expect(localDownloadPath("/work/../outside/report.pdf", "/work")).toBeNull();
    expect(localDownloadPath("/work/%2E%2E/outside/report.pdf", "/work")).toBeNull();
    expect(localDownloadPath("/work/%E0%A4%A", "/work")).toBeNull();
  });
});

describe("collectSessionArtifacts", () => {
  it("collects supported links from agent messages, reasoning, and plans", () => {
    const artifacts = collectSessionArtifacts(
      [
        turn([
          message("agentMessage", "[Report](/work/reports/report.pdf)", 10),
          message("reasoning", "[Notes](/work/notes.md)", 20),
          message("plan", "| File |\n| --- |\n| [Data](/work/data.csv) |", 30),
        ]),
      ],
      "/work",
    );

    expect(artifacts.map(({ path }) => path)).toEqual([
      "/work/data.csv",
      "/work/notes.md",
      "/work/reports/report.pdf",
    ]);
    expect(artifacts[0]).toMatchObject({
      fileName: "data.csv",
      relativePath: "data.csv",
      format: "CSV",
      preview: { kind: "text", path: "/work/data.csv" },
    });
    expect(artifacts[2]).toMatchObject({
      fileName: "report.pdf",
      relativePath: "reports/report.pdf",
      format: "PDF",
      preview: { kind: "pdf" },
    });
  });

  it("keeps unsupported links as download-only artifacts", () => {
    const artifacts = collectSessionArtifacts(
      [turn([message("agentMessage", "[Deck](/work/deck.Pptx) [Bundle](/work/bundle)", 10)])],
      "/work",
    );

    expect(artifacts).toEqual([
      {
        path: "/work/bundle",
        fileName: "bundle",
        relativePath: "bundle",
        format: "FILE",
        linkedAt: 10,
        preview: null,
      },
      {
        path: "/work/deck.Pptx",
        fileName: "deck.Pptx",
        relativePath: "deck.Pptx",
        format: "PPTX",
        linkedAt: 10,
        preview: null,
      },
    ]);
  });

  it("uses decoded paths for identity and metadata", () => {
    expect(
      collectSessionArtifacts(
        [turn([message("agentMessage", "[Report](/work/final%20report.PDF)", 10)])],
        "/work",
      )[0],
    ).toMatchObject({
      path: "/work/final report.PDF",
      fileName: "final report.PDF",
      relativePath: "final report.PDF",
      format: "PDF",
    });
  });

  it("deduplicates exact paths at their newest occurrence and sorts deterministically", () => {
    const artifacts = collectSessionArtifacts(
      [
        turn([message("agentMessage", "[Old](/work/a.pdf)", 10)]),
        turn([
          message("reasoning", "[B](/work/b.pdf)", 30),
          message("plan", "[A](/work/a.pdf)", 30),
          message("agentMessage", "[C](/work/c.pdf)", 20),
        ]),
      ],
      "/work",
    );

    expect(artifacts.map(({ path, linkedAt }) => ({ path, linkedAt }))).toEqual([
      { path: "/work/a.pdf", linkedAt: 30 },
      { path: "/work/b.pdf", linkedAt: 30 },
      { path: "/work/c.pdf", linkedAt: 20 },
    ]);
  });

  it("excludes user, technical, outside, relative, malformed, and non-link content", () => {
    const artifacts = collectSessionArtifacts(
      [
        turn([
          message("userMessage", "[User file](/work/user.pdf)", 10),
          {
            type: "command",
            id: "command",
            status: "completed",
            kind: "command",
            command: "printf output",
            cwd: "/work",
            output: "[Technical file](/work/technical.pdf)",
            exitCode: 0,
          },
          message(
            "agentMessage",
            [
              "[Outside](/other/outside.pdf)",
              "[Relative](relative.pdf)",
              "[Malformed](/work/%E0%A4%A)",
              '<a href="/work/raw.pdf">Raw HTML</a>',
              "Plain text /work/plain.pdf",
              "[Included](/work/included.pdf)",
            ].join("\n"),
            20,
          ),
        ]),
      ],
      "/work",
    );

    expect(artifacts.map(({ path }) => path)).toEqual(["/work/included.pdf"]);
  });

  it("falls back from item timestamps to completed, started, then zero", () => {
    const artifacts = collectSessionArtifacts(
      [
        turn([message("agentMessage", "[Completed](/work/completed.pdf)")], {
          completedAt: 30,
          startedAt: 20,
        }),
        turn([message("reasoning", "[Started](/work/started.pdf)")], { startedAt: 20 }),
        turn([message("plan", "[Zero](/work/zero.pdf)")]),
      ],
      "/work",
    );

    expect(artifacts.map(({ fileName, linkedAt }) => ({ fileName, linkedAt }))).toEqual([
      { fileName: "completed.pdf", linkedAt: 30 },
      { fileName: "started.pdf", linkedAt: 20 },
      { fileName: "zero.pdf", linkedAt: 0 },
    ]);
  });
});

function message(
  type: "userMessage" | "agentMessage" | "reasoning" | "plan",
  text: string,
  timestamp: number | null = null,
): ActivityItem {
  return {
    type,
    id: `${type}-${text}`,
    status: "completed",
    text,
    images: [],
    timestamp,
    phase: type === "agentMessage" ? "final_answer" : null,
  };
}

function turn(
  items: ActivityItem[],
  timestamps: { startedAt?: number | null; completedAt?: number | null } = {},
): TurnView {
  const startedAt = timestamps.startedAt ?? null;
  const completedAt = timestamps.completedAt ?? null;
  return {
    id: `turn-${items[0]?.id ?? "empty"}`,
    status: "completed",
    startedAt,
    completedAt,
    durationMs: null,
    progress: {
      startedAt,
      explanation: null,
      steps: [],
      filesChanged: 0,
      additions: 0,
      deletions: 0,
    },
    items,
  };
}
