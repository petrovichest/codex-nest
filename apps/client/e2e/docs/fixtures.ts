import type { Page } from "@playwright/test";
import type { AppSnapshot, ThreadDetail } from "@codexnest/protocol";

import { installVisualFixture, snapshot } from "../visual/fixtures";

const NOW = Date.UTC(2026, 7, 3, 12);
const ORIGIN = "https://codexnest.visual";

export const report = `# Project search

Search is ready in Launchpad.

## What changed

- Find projects by name.
- Filter as you type.
- Clear the query in one tap.
- Keep search usable on mobile.

## Verification

| Check | Result |
| --- | --- |
| Search tests | 12 passed |
| Client build | Passed |
| Mobile layout | Checked |
| Keyboard access | Checked |

## Next step

Try searching for a project from your phone. The same search works on desktop.
`;

const titles: Record<string, string> = {
  "session-main": "Add project search",
  "session-active": "Improve keyboard navigation",
  "session-attention": "Choose search behavior",
  "session-queued": "Polish the empty state",
  "session-complete": "Write the getting started guide",
};

const demoSnapshot: AppSnapshot = {
  ...snapshot,
  uiLanguage: "en",
  projects: snapshot.projects.map((project, index) => ({
    ...project,
    displayName: index === 0 ? "Launchpad" : "Field Notes",
    path: index === 0 ? "/work/launchpad" : "/work/field-notes",
  })),
  threads: snapshot.threads
    .filter((thread) => thread.id in titles)
    .map((thread) => ({
      ...thread,
      title: titles[thread.id]!,
      preview: "Build a faster way to find your projects.",
      cwd: thread.projectId === "project-nest" ? "/work/launchpad" : "/work/field-notes",
      settings: { ...thread.settings, collaborationMode: "default" },
      codexSettings: { model: "gpt-5.6-codex", reasoningEffort: "high" },
      canAcceptDirectInput: true,
    })),
  attention: [
    {
      id: "search-choice",
      threadId: "session-attention",
      turnId: "turn-attention",
      itemId: null,
      createdAt: NOW - 120_000,
      kind: "userInput",
      autoResolutionMs: null,
      questions: [
        {
          id: "search-behavior",
          header: "Search",
          question: "When should the project list update?",
          isOther: true,
          isSecret: false,
          options: [
            { label: "As you type", description: "Filter instantly, with no extra tap." },
            { label: "On Enter", description: "Wait until the query is complete." },
          ],
        },
      ],
    },
  ],
  models: snapshot.models.map((model) => ({
    ...model,
    description: "Coding and project work",
    reasoningEfforts: model.reasoningEfforts.map((effort) => ({
      ...effort,
      description: effort.value === "high" ? "Thorough" : "Balanced",
    })),
  })),
};

function summary(id: string) {
  return demoSnapshot.threads.find((thread) => thread.id === id)!;
}

const mainDetail: ThreadDetail = {
  summary: summary("session-main"),
  olderTurnsCursor: null,
  queuedMessages: [],
  draft: {
    input: "Add a keyboard shortcut to focus search.",
    images: [],
    annotations: [],
    goalMode: false,
    updatedAt: NOW - 60_000,
  },
  turns: [
    {
      id: "turn-main",
      status: "completed",
      startedAt: NOW - 780_000,
      completedAt: NOW - 600_000,
      durationMs: 180_000,
      progress: {
        startedAt: NOW - 780_000,
        explanation: "Project search is ready.",
        steps: [
          { step: "Add project filtering", status: "completed" },
          { step: "Check desktop and mobile", status: "completed" },
          { step: "Run tests and write the report", status: "completed" },
        ],
        filesChanged: 3,
        additions: 48,
        deletions: 7,
      },
      items: [
        {
          type: "userMessage",
          id: "search-request",
          status: "completed",
          text: "Add project search for desktop and mobile.",
          images: [],
          timestamp: NOW - 780_000,
          phase: null,
        },
        {
          type: "plan",
          id: "search-plan",
          status: "completed",
          text: "1. Filter projects as you type.\n2. Add clear and empty states.\n3. Check mobile and run tests.",
          images: [],
          timestamp: NOW - 740_000,
          phase: "commentary",
        },
        {
          type: "planChecklist",
          id: "search-progress",
          status: "completed",
          explanation: null,
          steps: [
            { step: "Search, clear button and empty state", status: "completed" },
            { step: "Mobile layout and keyboard access", status: "completed" },
          ],
          timestamp: NOW - 680_000,
          afterItemId: "search-plan",
        },
        {
          type: "command",
          id: "search-test",
          status: "completed",
          kind: "command",
          command: "npm test -- project-search",
          cwd: "/work/launchpad",
          output: "PASS  src/project-search.test.ts\nTests: 12 passed, 12 total\nDuration: 0.84s",
          exitCode: 0,
        },
        {
          type: "fileChange",
          id: "search-change",
          status: "completed",
          path: "src/project-search.ts",
          patch:
            "@@ -1,1 +1,5 @@\n-export const visibleProjects = projects;\n+export function filterProjects(projects, query) {\n+  const term = query.trim().toLowerCase();\n+  return projects.filter((project) =>\n+    project.name.toLowerCase().includes(term));\n+}",
        },
        {
          type: "agentMessage",
          id: "search-result",
          status: "completed",
          text: "Project search is ready on desktop and mobile. **All 12 tests pass.** See `project-search.md` for the report.",
          images: [],
          timestamp: NOW - 600_000,
          phase: "final_answer",
        },
      ],
    },
  ],
};

const attentionDetail: ThreadDetail = {
  summary: summary("session-attention"),
  olderTurnsCursor: null,
  draft: null,
  queuedMessages: [
    {
      id: "search-followup",
      threadId: "session-attention",
      text: "Also check the empty state on a narrow screen.",
      createdAt: NOW - 100_000,
      status: "queued",
    },
  ],
  turns: [
    {
      id: "turn-attention",
      status: "inProgress",
      startedAt: NOW - 240_000,
      completedAt: null,
      durationMs: null,
      progress: {
        startedAt: NOW - 240_000,
        explanation: "Waiting for your choice.",
        steps: [],
        filesChanged: 0,
        additions: 0,
        deletions: 0,
      },
      items: [
        {
          type: "userMessage",
          id: "choice-request",
          status: "completed",
          text: "Help me choose how project search should work.",
          images: [],
          timestamp: NOW - 240_000,
          phase: null,
        },
        {
          type: "agentMessage",
          id: "choice-response",
          status: "completed",
          text: "Both options work on desktop and mobile. I recommend filtering as you type for this short project list.",
          images: [],
          timestamp: NOW - 180_000,
          phase: "commentary",
        },
      ],
    },
  ],
};

export async function installDocsFixture(page: Page, theme: "light" | "dark") {
  await installVisualFixture(page, { theme, snapshot: demoSnapshot });
  // Keep documentation content separate from the visual regression fixtures.
  await page.route(`${ORIGIN}/api/v1/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(body),
      });
    if (route.request().method() === "OPTIONS") return route.fallback();
    if (path === "/api/v1/threads/session-main") return json(mainDetail);
    if (path === "/api/v1/threads/session-attention") return json(attentionDetail);
    if (path.endsWith("/git-changes")) {
      return json({ state: "dirty", filesChanged: 3, additions: 48, deletions: 7 });
    }
    if (path.endsWith("/artifacts")) {
      return json({
        capability: "explicit",
        artifacts: [
          {
            id: "search-report",
            label: "Project search report",
            path: "/work/launchpad/reports/project-search.md",
            relativePath: "reports/project-search.md",
            fileName: "project-search.md",
            turnId: "turn-main",
            createdAt: NOW - 590_000,
          },
        ],
      });
    }
    if (path.endsWith("/downloads")) {
      return json({
        downloadUrl: "/downloads/project-search.md",
        expiresAt: NOW + 60_000,
        fileName: "project-search.md",
        size: new TextEncoder().encode(report).byteLength,
      });
    }
    return route.fallback();
  });
  await page.route(`${ORIGIN}/downloads/**`, (route) =>
    route.fulfill({ status: 200, contentType: "text/markdown; charset=utf-8", body: report }),
  );
}
