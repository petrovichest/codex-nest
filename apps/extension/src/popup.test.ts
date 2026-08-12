/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  BrowserTabSummary,
  ConnectionStatus,
  ProjectSummary,
  ThreadSummary,
  UiLanguage,
} from "./protocol";

interface TestSnapshot {
  configured: boolean;
  locale: UiLanguage;
  status: ConnectionStatus;
  error: string | null;
  projects: ProjectSummary[];
  threads: ThreadSummary[];
  activeTab: BrowserTabSummary | null;
  activeBinding: null;
  bindings: [];
}

const activeTab: BrowserTabSummary = {
  id: 7,
  windowId: 1,
  groupId: -1,
  active: true,
  title: "Popup target",
  url: "https://example.test/",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.replaceChildren();
});

describe("popup session catalog", () => {
  it("uses Firefox-specific setup wording in the Firefox target", async () => {
    vi.stubGlobal("navigator", { language: "en", userAgent: "Firefox/146.0" });
    await loadPopup(snapshot({ configured: false }));

    expect(document.querySelector("h1")?.textContent).toBe("Connect this Firefox");
  });

  it("starts on the placeholder and groups only enabled sessions under non-empty projects", async () => {
    await loadPopup(
      snapshot({
        projects: [
          { id: "project-1", displayName: "Project One", path: "/one" },
          { id: "project-empty", displayName: "Empty Project", path: "/empty" },
        ],
        threads: [
          thread("thread-idle", "project-1", "Ready session", "idle"),
          thread("thread-orphan", "missing-project", "Orphan session", "idle"),
        ],
      }),
    );

    const select = requireSelect();
    expect(select.value).toBe("");
    expect(select.options).toHaveLength(2);
    expect(select.options[0]?.textContent).toBe("Choose a session");
    expect(select.options[1]?.textContent).toBe("Ready session");
    expect(document.querySelector('optgroup[label="Project One"]')).not.toBeNull();
    expect(document.querySelector('optgroup[label="Empty Project"]')).toBeNull();
    expect(document.body.textContent).not.toContain("New session");
    expect(document.body.textContent).not.toContain("Existing");
    expect(document.body.textContent).not.toContain("Orphan session");
    expect(requireAttachButton().disabled).toBe(true);
  });

  it("shows the Browser opt-in instruction for an empty catalog", async () => {
    await loadPopup(
      snapshot({
        projects: [{ id: "project-1", displayName: "Project One", path: "/one" }],
      }),
    );

    expect(document.querySelectorAll("optgroup")).toHaveLength(0);
    expect(document.body.textContent).toContain(
      "Enable Browser in a CodexNest session to attach this tab.",
    );
    expect(document.body.textContent).not.toContain("No projects");
  });

  it("keeps a selected target across catalog updates and disables it when it becomes busy", async () => {
    const initial = snapshot({
      projects: [{ id: "project-1", displayName: "Project One", path: "/one" }],
      threads: [
        thread("thread-selected", "project-1", "Selected session", "idle"),
        thread("thread-queued", "project-1", "Queued session", "queued"),
      ],
    });
    const { publish } = await loadPopup(initial);
    const select = requireSelect();
    const queued = select.querySelector<HTMLOptionElement>('option[value="thread-queued"]');
    expect(queued?.disabled).toBe(true);
    expect(queued?.textContent).toBe("Queued session — Busy");

    select.value = "thread-selected";
    select.dispatchEvent(new Event("change"));
    expect(requireAttachButton().disabled).toBe(false);
    select.focus();

    publish({
      ...initial,
      threads: [thread("thread-selected", "project-1", "Selected session", "running")],
    });
    expect(document.querySelector("select")).toBe(select);
    expect(requireAttachButton().disabled).toBe(true);

    select.blur();
    await vi.waitFor(() => expect(document.querySelector("select")).not.toBe(select));
    const updated = requireSelect();
    expect(updated.value).toBe("thread-selected");
    expect(updated.selectedOptions[0]?.disabled).toBe(true);
    expect(updated.selectedOptions[0]?.textContent).toBe("Selected session — Busy");
    expect(requireAttachButton().disabled).toBe(true);
  });

  it("sends the exact selected existing-thread target", async () => {
    const { sendMessage } = await loadPopup(
      snapshot({
        projects: [{ id: "project-1", displayName: "Project One", path: "/one" }],
        threads: [thread("thread-exact", "project-1", "Exact session", "idle")],
      }),
    );
    const select = requireSelect();
    select.value = "thread-exact";
    select.dispatchEvent(new Event("change"));
    requireAttachButton().click();

    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: "popup.createAttach",
        target: { kind: "existing", threadId: "thread-exact" },
        tabId: 7,
      }),
    );
    expect(
      sendMessage.mock.calls.some(
        ([message]) =>
          typeof message === "object" &&
          message !== null &&
          "target" in message &&
          message.target?.kind === "new",
      ),
    ).toBe(false);
  });
});

async function loadPopup(initial: TestSnapshot): Promise<{
  publish: (state: TestSnapshot) => void;
  sendMessage: ReturnType<typeof vi.fn>;
}> {
  document.body.innerHTML = '<main id="app" aria-live="polite"></main>';
  let listener: ((message: unknown) => void) | undefined;
  const sendMessage = vi.fn(async () => ({ ok: true, result: initial }));
  vi.stubGlobal("chrome", {
    runtime: {
      onMessage: {
        addListener: vi.fn((next: (message: unknown) => void) => {
          listener = next;
        }),
      },
      sendMessage,
    },
  });

  await import("./popup");
  await vi.waitFor(() => expect(document.querySelector("h1")).not.toBeNull());
  return {
    publish: (state) => listener?.({ type: "background.state", state }),
    sendMessage,
  };
}

function snapshot(overrides: Partial<TestSnapshot> = {}): TestSnapshot {
  return {
    configured: true,
    locale: "en",
    status: "connected",
    error: null,
    projects: [],
    threads: [],
    activeTab,
    activeBinding: null,
    bindings: [],
    ...overrides,
  };
}

function thread(
  id: string,
  projectId: string,
  title: string,
  state: ThreadSummary["state"],
): ThreadSummary {
  return { id, projectId, title, state };
}

function requireSelect(): HTMLSelectElement {
  const select = document.querySelector<HTMLSelectElement>("select");
  if (!select) throw new Error("Session select is missing");
  return select;
}

function requireAttachButton(): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent === "Attach current tab",
  );
  if (!button) throw new Error("Attach button is missing");
  return button;
}
