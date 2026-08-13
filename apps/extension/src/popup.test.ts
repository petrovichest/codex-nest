/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  BindingSummary,
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
  activeBinding: BindingSummary | null;
  bindings: BindingSummary[];
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
  document.body.removeAttribute("data-surface");
});

describe("popup and panel surfaces", () => {
  it("opens the Chrome side panel for the popup's current window", async () => {
    const { getCurrent, sendMessage, sidePanelOpen, sidebarActionOpen } = await loadPopup(
      snapshot(),
      { surface: "popup", windowId: 23 },
    );

    const openPanel = requireOpenPanelButton("Open side panel");
    expect(openPanel.textContent).toBe("Open side panel");
    expect(getCurrent).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith({ type: "popup.state", windowId: 23 });

    openPanel.click();

    expect(sidePanelOpen).toHaveBeenCalledWith({ windowId: 23 });
    expect(sidebarActionOpen).not.toHaveBeenCalled();
  });

  it("opens the Firefox sidebar directly from the localized popup action", async () => {
    vi.stubGlobal("navigator", { language: "ru", userAgent: "Firefox/146.0" });
    const { sidePanelOpen, sidebarActionOpen } = await loadPopup(snapshot({ locale: "ru" }), {
      surface: "popup",
    });

    const openPanel = requireOpenPanelButton("Открыть сбоку");
    expect(openPanel.textContent).toBe("Открыть сбоку");
    openPanel.click();

    expect(sidebarActionOpen).toHaveBeenCalledOnce();
    expect(sidePanelOpen).not.toHaveBeenCalled();
  });

  it("omits the persistent-panel action from the panel surface", async () => {
    await loadPopup(snapshot(), { surface: "panel" });

    expect(document.querySelector(".open-panel-button")).toBeNull();
    expect(document.querySelector('[aria-label="Open side panel"]')).toBeNull();
  });
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
    const { publishInvalidation, sendMessage } = await loadPopup(initial);
    const select = requireSelect();
    const queued = select.querySelector<HTMLOptionElement>('option[value="thread-queued"]');
    expect(queued?.disabled).toBe(true);
    expect(queued?.textContent).toBe("Queued session — Busy");

    select.value = "thread-selected";
    select.dispatchEvent(new Event("change"));
    expect(requireAttachButton().disabled).toBe(false);
    select.focus();

    publishInvalidation({
      ...initial,
      threads: [thread("thread-selected", "project-1", "Selected session", "running")],
    });
    await vi.waitFor(() => {
      expect(
        sendMessage.mock.calls.filter(([message]) => message.type === "popup.state"),
      ).toHaveLength(2);
      expect(requireAttachButton().disabled).toBe(true);
    });
    expect(document.querySelector("select")).toBe(select);

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
        windowId: 1,
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

  it("includes the current window in configure, open, and detach requests", async () => {
    const attached = binding("thread-bound");
    const { sendMessage } = await loadPopup(
      snapshot({ activeBinding: attached, bindings: [attached] }),
      { windowId: 37 },
    );

    requireButton("Open in CodexNest").click();
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: "popup.open",
        threadId: "thread-bound",
        windowId: 37,
      }),
    );
    await vi.waitFor(() => expect(requireButton("Detach").disabled).toBe(false));
    requireButton("Detach").click();
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: "popup.detach",
        threadId: "thread-bound",
        windowId: 37,
      }),
    );

    vi.resetModules();
    document.body.replaceChildren();
    const setup = await loadPopup(snapshot({ configured: false }), { windowId: 37 });
    const baseUrl = document.querySelector<HTMLInputElement>("#base-url");
    const token = document.querySelector<HTMLInputElement>("#owner-token");
    if (!baseUrl || !token) throw new Error("Setup inputs are missing");
    baseUrl.value = "http://127.0.0.1:4310";
    token.value = "owner-token";
    requireButton("Connect").click();
    await vi.waitFor(() =>
      expect(setup.sendMessage).toHaveBeenCalledWith({
        type: "popup.configure",
        baseUrl: "http://127.0.0.1:4310",
        token: "owner-token",
        windowId: 37,
      }),
    );
  });
});

async function loadPopup(
  initial: TestSnapshot,
  options: { surface?: "popup" | "panel"; windowId?: number } = {},
): Promise<{
  publishInvalidation: (state: TestSnapshot) => void;
  sendMessage: ReturnType<typeof vi.fn>;
  getCurrent: ReturnType<typeof vi.fn>;
  sidePanelOpen: ReturnType<typeof vi.fn>;
  sidebarActionOpen: ReturnType<typeof vi.fn>;
}> {
  document.body.dataset.surface = options.surface ?? "popup";
  document.body.innerHTML = '<main id="app" aria-live="polite"></main>';
  let current = initial;
  let listener: ((message: unknown) => void) | undefined;
  const sendMessage = vi.fn(async () => ({ ok: true, result: current }));
  const getCurrent = vi.fn(async () => ({ id: options.windowId ?? 1 }));
  const sidePanelOpen = vi.fn(async () => undefined);
  const sidebarActionOpen = vi.fn(async () => undefined);
  vi.stubGlobal("chrome", {
    runtime: {
      onMessage: {
        addListener: vi.fn((next: (message: unknown) => void) => {
          listener = next;
        }),
      },
      sendMessage,
    },
    windows: { getCurrent },
    sidePanel: { open: sidePanelOpen },
    sidebarAction: { open: sidebarActionOpen },
  });

  await import("./popup");
  await vi.waitFor(() => expect(document.querySelector("h1")).not.toBeNull());
  return {
    publishInvalidation: (state) => {
      current = state;
      listener?.({ type: "background.stateChanged" });
    },
    sendMessage,
    getCurrent,
    sidePanelOpen,
    sidebarActionOpen,
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

function binding(threadId: string): BindingSummary {
  return {
    threadId,
    projectId: "project-1",
    title: "Bound session",
    groupId: 4,
    tabIds: [7],
    createdAt: 1,
    updatedAt: 1,
  };
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

function requireButton(name: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent === name,
  );
  if (!button) throw new Error(`${name} button is missing`);
  return button;
}

function requireOpenPanelButton(name: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    `.open-panel-button[aria-label="${name}"]`,
  );
  if (!button) throw new Error(`${name} button is missing`);
  return button;
}
