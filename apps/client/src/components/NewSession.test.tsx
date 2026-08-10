import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router";

import type { ModelOption, Project, ThreadDraft, ThreadSummary } from "@codexnest/protocol";

import { ApiClientError } from "../api";
import { NewSession } from "./NewSession";

const connection = vi.hoisted(() => vi.fn());
const drafts = vi.hoisted(() => ({
  delete: vi.fn().mockResolvedValue(undefined),
  deleteLocal: vi.fn().mockResolvedValue(undefined),
  load: vi.fn().mockResolvedValue(null),
  save: vi.fn().mockResolvedValue(true),
  saveLocal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../connection", () => ({ useConnection: connection }));
vi.mock("../offline-store", () => ({
  deleteLocalDraft: drafts.deleteLocal,
  deleteNewSessionDraft: drafts.delete,
  loadNewSessionDraft: drafts.load,
  saveLocalDraft: drafts.saveLocal,
  saveNewSessionDraft: drafts.save,
}));

const project: Project = {
  id: "project",
  displayName: "CodexNest",
  path: "/work/codex-nest",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};

const thread = {
  id: "created",
  projectId: project.id,
  relation: { kind: "root" },
  settings: { collaborationMode: "plan" },
} as unknown as ThreadSummary;

const connectionSettings = { baseUrl: "https://pi.local", token: "token" };
const model: ModelOption = {
  id: "gpt",
  displayName: "GPT",
  description: "",
  isDefault: true,
  reasoningEfforts: [{ value: "high", description: null, isDefault: true }],
  serviceTiers: [{ id: "fast", displayName: "Fast" }],
  supportsPersonality: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  drafts.delete.mockResolvedValue(undefined);
  drafts.deleteLocal.mockResolvedValue(undefined);
  drafts.load.mockResolvedValue(null);
  drafts.save.mockResolvedValue(true);
  drafts.saveLocal.mockResolvedValue(undefined);
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NewSession", () => {
  it("carries immediate submission through session creation", async () => {
    const sendReliable = vi.fn().mockResolvedValue("delivered");
    const sendQueuedNow = vi.fn().mockResolvedValue({ turnId: "turn" });
    connection.mockReturnValue(
      mockConnection({
        createProjectThread: vi.fn().mockResolvedValue({ thread }),
        sendQueuedNow,
        sendReliable,
      }),
    );
    renderNewSession();
    const textbox = screen.getByRole("textbox", { name: "Сообщение для Codex" });

    fireEvent.change(textbox, { target: { value: "Отправь сразу" } });
    fireEvent.keyDown(textbox, { key: "Enter", metaKey: true });

    await waitFor(() => expect(sendReliable).toHaveBeenCalledOnce());
    const clientMessageId = sendReliable.mock.calls[0]?.[1].clientMessageId;
    expect(clientMessageId).toEqual(expect.any(String));
    expect(sendQueuedNow).toHaveBeenCalledWith(thread.id, clientMessageId);
  });

  it("opens immediately for the selected project and transfers the draft to the created thread", async () => {
    const creation = deferred<{ thread: ThreadSummary }>();
    const dispatch = vi.fn();
    const createProjectThread = vi.fn().mockReturnValue(creation.promise);
    const updateThreadDraft = vi
      .fn()
      .mockImplementation(async (_threadId: string, value: ThreadDraft): Promise<ThreadDraft> => ({
        ...value,
        updatedAt: 20,
      }));
    connection.mockReturnValue(
      mockConnection({ createProjectThread, updateThreadDraft, dispatch }),
    );

    renderNewSession();

    const textbox = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    expect(textbox).toHaveFocus();
    expect(screen.queryByRole("combobox", { name: "Проект" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Отправить" })).toBeDisabled();
    await waitFor(() => expect(createProjectThread).toHaveBeenCalledWith(project.id));

    fireEvent.change(textbox, { target: { value: "Не потерять этот текст" } });
    creation.resolve({ thread });

    await waitFor(() =>
      expect(updateThreadDraft).toHaveBeenCalledWith(
        thread.id,
        {
          input: "Не потерять этот текст",
          images: [],
          goalMode: false,
          annotations: [],
        },
        { retry: true },
      ),
    );
    expect(await screen.findByText("Созданная сессия")).toBeInTheDocument();
    expect(dispatch).toHaveBeenCalledWith({ type: "thread", thread });
    expect(drafts.delete).toHaveBeenCalledWith(connectionSettings, project.id);
  });

  it("opens an untouched thread without an extra draft request", async () => {
    const updateThreadDraft = vi.fn();
    connection.mockReturnValue(
      mockConnection({
        createProjectThread: vi.fn().mockResolvedValue({ thread }),
        updateThreadDraft,
      }),
    );

    renderNewSession();

    expect(await screen.findByText("Созданная сессия")).toBeInTheDocument();
    expect(updateThreadDraft).not.toHaveBeenCalled();
  });

  it("does not create a session when /new is opened directly", async () => {
    const createProjectThread = vi.fn();
    connection.mockReturnValue(mockConnection({ createProjectThread }));

    render(
      <MemoryRouter initialEntries={["/new?projectId=project"]}>
        <Routes>
          <Route
            path="/new"
            element={<NewSession projects={[project]} onOpenNavigation={() => undefined} />}
          />
          <Route path="/" element={<div>Главная</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Главная")).toBeInTheDocument();
    expect(createProjectThread).not.toHaveBeenCalled();
  });

  it("resumes draft transfer without creating a second thread", async () => {
    const transfer = deferred<ThreadDraft>();
    drafts.load.mockResolvedValue({
      key: "draft",
      connectionKey: "connection",
      projectId: project.id,
      value: {
        input: "Восстановленный черновик",
        images: [],
        goalMode: false,
        annotations: [],
      },
      phase: "transferring",
      threadId: thread.id,
      thread,
      revision: 4,
      updatedAt: 10,
    });
    const createProjectThread = vi.fn();
    const updateThreadDraft = vi.fn().mockReturnValue(transfer.promise);
    connection.mockReturnValue(mockConnection({ createProjectThread, updateThreadDraft }));

    render(
      <MemoryRouter initialEntries={["/new?projectId=project"]}>
        <Routes>
          <Route
            path="/new"
            element={<NewSession projects={[project]} onOpenNavigation={() => undefined} />}
          />
          <Route path="/threads/:threadId" element={<div>Созданная сессия</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByDisplayValue("Восстановленный черновик")).toBeInTheDocument();
    await waitFor(() => expect(updateThreadDraft).toHaveBeenCalled());
    expect(createProjectThread).not.toHaveBeenCalled();
    transfer.resolve({
      input: "Восстановленный черновик",
      images: [],
      goalMode: false,
      annotations: [],
      updatedAt: 20,
    });
    expect(await screen.findByText("Созданная сессия")).toBeInTheDocument();
  });

  it("retries a failed resumed thread read with a fresh promise", async () => {
    drafts.load.mockResolvedValue({
      key: "draft",
      connectionKey: "connection",
      projectId: project.id,
      value: {
        input: "Восстановленный черновик",
        images: [],
        goalMode: false,
        annotations: [],
      },
      phase: "transferring",
      threadId: thread.id,
      thread: null,
      revision: 4,
      updatedAt: 10,
    });
    const readThread = vi
      .fn()
      .mockRejectedValueOnce(new Error("Чтение недоступно"))
      .mockResolvedValueOnce({ summary: thread });
    const createProjectThread = vi.fn();
    connection.mockReturnValue(
      mockConnection({
        createProjectThread,
        readThread,
        updateThreadDraft: vi.fn().mockResolvedValue(null),
      }),
    );

    render(
      <MemoryRouter initialEntries={["/new?projectId=project"]}>
        <Routes>
          <Route
            path="/new"
            element={<NewSession projects={[project]} onOpenNavigation={() => undefined} />}
          />
          <Route path="/threads/:threadId" element={<div>Созданная сессия</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Чтение недоступно")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));

    expect(await screen.findByText("Созданная сессия")).toBeInTheDocument();
    expect(readThread).toHaveBeenCalledTimes(2);
    expect(createProjectThread).not.toHaveBeenCalled();
  });

  it("recovers a missing resumed thread by creating a replacement on retry", async () => {
    drafts.load.mockResolvedValue({
      key: "draft",
      connectionKey: "connection",
      projectId: project.id,
      value: {
        input: "Восстановленный черновик",
        images: [],
        goalMode: false,
        annotations: [],
      },
      phase: "transferring",
      threadId: "missing",
      thread: null,
      revision: 4,
      updatedAt: 10,
    });
    const readThread = vi
      .fn()
      .mockRejectedValue(new ApiClientError("not_found", "Сессия не найдена", 404));
    const createProjectThread = vi.fn().mockResolvedValue({ thread });
    connection.mockReturnValue(
      mockConnection({
        createProjectThread,
        readThread,
        updateThreadDraft: vi.fn().mockResolvedValue(null),
      }),
    );

    render(
      <MemoryRouter initialEntries={["/new?projectId=project"]}>
        <Routes>
          <Route
            path="/new"
            element={<NewSession projects={[project]} onOpenNavigation={() => undefined} />}
          />
          <Route path="/threads/:threadId" element={<div>Созданная сессия</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Сессия не найдена")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));

    expect(await screen.findByText("Созданная сессия")).toBeInTheDocument();
    expect(readThread).toHaveBeenCalledOnce();
    expect(createProjectThread).toHaveBeenCalledOnce();
  });

  it("restores an abandoned early submission with its images and settings without sending it", async () => {
    let stored: {
      projectId: string;
      value: ThreadDraft;
      settings?: ThreadSummary["settings"];
      phase: "creating" | "transferring";
      threadId: string | null;
      thread: ThreadSummary | null;
      revision: number;
    } | null = null;
    drafts.load.mockImplementation(async () => stored);
    drafts.save.mockImplementation(
      async (
        _settings,
        projectId,
        value,
        preparation: Omit<NonNullable<typeof stored>, "projectId" | "value">,
      ) => {
        stored = {
          projectId,
          value: structuredClone(value),
          ...structuredClone(preparation),
        };
        return true;
      },
    );
    const abandonedCreation = deferred<{ thread: ThreadSummary }>();
    const createProjectThread = vi
      .fn()
      .mockReturnValueOnce(abandonedCreation.promise)
      .mockReturnValue(new Promise(() => undefined));
    const sendReliable = vi.fn();
    connection.mockReturnValue(
      mockConnection({
        createProjectThread,
        models: [model],
        sendReliable,
        taskDefaults: { serviceTier: "fast", personality: "friendly" },
      }),
    );

    const view = render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: "/new",
            search: "?projectId=project",
            state: { newSessionProjectId: project.id, newSessionWorkspaceId: "first" },
          },
        ]}
      >
        <Routes>
          <Route
            path="/new"
            element={
              <>
                <NewSession projects={[project]} onOpenNavigation={() => undefined} />
                <Link to="/away">Покинуть подготовку</Link>
              </>
            }
          />
          <Route
            path="/away"
            element={<Link to="/new?projectId=project">Открыть проект снова</Link>}
          />
        </Routes>
      </MemoryRouter>,
    );

    const textbox = await screen.findByRole("textbox", { name: "Сообщение для Codex" });
    fireEvent.change(textbox, { target: { value: "Сохрани после ухода" } });
    fireEvent.change(view.container.querySelector('input[type="file"]')!, {
      target: { files: [new File(["image"], "saved.png", { type: "image/png" })] },
    });
    expect(await screen.findByAltText("saved.png")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Выключить режим планирования" }));
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    expect(textbox).toHaveValue("");

    fireEvent.click(screen.getByRole("link", { name: "Покинуть подготовку" }));
    expect(await screen.findByRole("link", { name: "Открыть проект снова" })).toBeInTheDocument();
    await waitFor(() => {
      expect(stored?.value.input).toBe("Сохрани после ухода");
      expect(stored?.value.images).toEqual([
        expect.objectContaining({
          name: "saved.png",
          url: expect.stringMatching(/^data:image\/png/),
        }),
      ]);
      expect(stored?.settings).toEqual({
        collaborationMode: "default",
        serviceTier: "fast",
        personality: "friendly",
      });
    });
    await act(async () => {
      abandonedCreation.resolve({
        thread: { ...thread, id: "abandoned", title: "Оставленная задача" },
      });
      await Promise.resolve();
    });
    expect(sendReliable).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("link", { name: "Открыть проект снова" }));

    expect(await screen.findByDisplayValue("Сохрани после ухода")).toBeInTheDocument();
    expect(screen.getByAltText("saved.png")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Включить режим планирования" })).toBeInTheDocument();
    expect(createProjectThread).toHaveBeenCalledTimes(2);
    expect(sendReliable).not.toHaveBeenCalled();
  });

  it("clears a claimed automatic transfer after it settles behind accepted sending", async () => {
    const transfer = deferred<ThreadDraft | null>();
    const order: string[] = [];
    const updateThreadDraft = vi
      .fn()
      .mockImplementationOnce(async () => {
        order.push("transfer-started");
        const saved = await transfer.promise;
        order.push("transfer-settled");
        return saved;
      })
      .mockImplementationOnce(async (_threadId, value) => {
        order.push("server-cleared");
        expect(value).toEqual({
          input: "",
          images: [],
          goalMode: false,
          annotations: [],
        });
        return null;
      });
    const sendReliable = vi.fn().mockImplementation(async () => {
      order.push("send-accepted");
      return "delivered";
    });
    drafts.deleteLocal.mockImplementation(async () => {
      order.push("local-cleared");
    });
    connection.mockReturnValue(
      mockConnection({
        createProjectThread: vi.fn().mockResolvedValue({ thread }),
        sendReliable,
        updateThreadDraft,
      }),
    );

    renderNewSession();
    const textbox = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    fireEvent.change(textbox, { target: { value: "Отправь только один раз" } });
    await waitFor(() => expect(updateThreadDraft).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() => expect(sendReliable).toHaveBeenCalledOnce());
    expect(updateThreadDraft).toHaveBeenCalledOnce();

    transfer.resolve({
      input: "Отправь только один раз",
      images: [],
      goalMode: false,
      annotations: [],
      updatedAt: 20,
    });

    await waitFor(() =>
      expect(drafts.deleteLocal).toHaveBeenCalledWith(connectionSettings, thread.id),
    );
    expect(updateThreadDraft).toHaveBeenCalledTimes(2);
    expect(updateThreadDraft).toHaveBeenLastCalledWith(
      thread.id,
      { input: "", images: [], goalMode: false, annotations: [] },
      { retry: true },
    );
    expect(sendReliable).toHaveBeenCalledOnce();
    expect(order).toEqual([
      "transfer-started",
      "send-accepted",
      "transfer-settled",
      "server-cleared",
      "local-cleared",
    ]);
  });

  it("repeats transfer when the user types while the previous draft is being saved", async () => {
    const creation = deferred<{ thread: ThreadSummary }>();
    const firstTransfer = deferred<ThreadDraft | null>();
    const updateThreadDraft = vi
      .fn()
      .mockReturnValueOnce(firstTransfer.promise)
      .mockImplementation(async (_threadId: string, value: ThreadDraft): Promise<ThreadDraft> => ({
        ...value,
        updatedAt: 30,
      }));
    connection.mockReturnValue(
      mockConnection({
        createProjectThread: vi.fn().mockReturnValue(creation.promise),
        updateThreadDraft,
      }),
    );

    renderNewSession();
    fireEvent.change(screen.getByRole("textbox", { name: "Сообщение для Codex" }), {
      target: { value: "Первая версия" },
    });
    creation.resolve({ thread });
    await waitFor(() => expect(updateThreadDraft).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole("textbox", { name: "Сообщение для Codex" }), {
      target: { value: "Самая новая версия" },
    });
    firstTransfer.resolve(null);

    await waitFor(() => expect(updateThreadDraft).toHaveBeenCalledTimes(2));
    expect(updateThreadDraft.mock.calls[1]?.[1]).toEqual({
      input: "Самая новая версия",
      images: [],
      goalMode: false,
      annotations: [],
    });
    expect(await screen.findByText("Созданная сессия")).toBeInTheDocument();
  });

  it("does not lose input typed while the transferred preparation is being removed", async () => {
    const creation = deferred<{ thread: ThreadSummary }>();
    const deletion = deferred<void>();
    drafts.delete.mockReturnValueOnce(deletion.promise).mockResolvedValueOnce(undefined);
    const updateThreadDraft = vi
      .fn()
      .mockImplementation(async (_threadId: string, value: ThreadDraft): Promise<ThreadDraft> => ({
        ...value,
        updatedAt: Date.now(),
      }));
    connection.mockReturnValue(
      mockConnection({
        createProjectThread: vi.fn().mockReturnValue(creation.promise),
        updateThreadDraft,
      }),
    );

    renderNewSession();
    fireEvent.change(screen.getByRole("textbox", { name: "Сообщение для Codex" }), {
      target: { value: "Первая версия" },
    });
    creation.resolve({ thread });
    await waitFor(() => expect(drafts.delete).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole("textbox", { name: "Сообщение для Codex" }), {
      target: { value: "Версия во время удаления" },
    });
    deletion.resolve();

    await waitFor(() => expect(updateThreadDraft).toHaveBeenCalledTimes(2));
    expect(updateThreadDraft.mock.calls[1]?.[1]).toEqual({
      input: "Версия во время удаления",
      images: [],
      goalMode: false,
      annotations: [],
    });
    expect(await screen.findByText("Созданная сессия")).toBeInTheDocument();
  });

  it("waits for a selected image before opening the created thread", async () => {
    const creation = deferred<{ thread: ThreadSummary }>();
    const imageRead = deferred<string>();
    class PendingFileReader {
      result: string | ArrayBuffer | null = null;
      error: DOMException | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      readAsDataURL(): void {
        void imageRead.promise.then(
          (result) => {
            this.result = result;
            this.onload?.();
          },
          () => this.onerror?.(),
        );
      }
    }
    vi.stubGlobal("FileReader", PendingFileReader);
    const updateThreadDraft = vi
      .fn()
      .mockImplementation(async (_threadId: string, value: ThreadDraft): Promise<ThreadDraft> => ({
        ...value,
        updatedAt: Date.now(),
      }));
    connection.mockReturnValue(
      mockConnection({
        createProjectThread: vi.fn().mockReturnValue(creation.promise),
        updateThreadDraft,
      }),
    );

    const view = renderNewSession();
    const fileInput = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [new File(["image"], "screenshot.png", { type: "image/png" })] },
    });
    creation.resolve({ thread });

    await waitFor(() =>
      expect(drafts.save).toHaveBeenCalledWith(
        connectionSettings,
        project.id,
        expect.anything(),
        expect.objectContaining({ phase: "transferring", threadId: thread.id }),
      ),
    );
    expect(screen.queryByText("Созданная сессия")).not.toBeInTheDocument();
    expect(updateThreadDraft).not.toHaveBeenCalled();

    imageRead.resolve("data:image/png;base64,aW1hZ2U=");

    await waitFor(() =>
      expect(updateThreadDraft).toHaveBeenCalledWith(
        thread.id,
        {
          input: "",
          images: [
            expect.objectContaining({
              name: "screenshot.png",
              url: "data:image/png;base64,aW1hZ2U=",
            }),
          ],
          goalMode: false,
          annotations: [],
        },
        { retry: true },
      ),
    );
    expect(await screen.findByText("Созданная сессия")).toBeInTheDocument();
  });

  it("keeps the draft and retries the same preparation after a creation error", async () => {
    const createProjectThread = vi
      .fn()
      .mockRejectedValueOnce(new Error("Codex недоступен"))
      .mockResolvedValueOnce({ thread });
    connection.mockReturnValue(
      mockConnection({
        createProjectThread,
        updateThreadDraft: vi.fn().mockResolvedValue(null),
      }),
    );

    renderNewSession();
    fireEvent.change(screen.getByRole("textbox", { name: "Сообщение для Codex" }), {
      target: { value: "Черновик для повторной попытки" },
    });
    expect(await screen.findByText("Codex недоступен")).toBeInTheDocument();
    await waitFor(() =>
      expect(drafts.save).toHaveBeenCalledWith(
        connectionSettings,
        project.id,
        expect.objectContaining({ input: "Черновик для повторной попытки" }),
        expect.objectContaining({ phase: "creating", threadId: null }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByText("Созданная сессия")).toBeInTheDocument();
    expect(createProjectThread).toHaveBeenCalledTimes(2);
  });

  it("retries only draft transfer after the thread has already been created", async () => {
    const creation = deferred<{ thread: ThreadSummary }>();
    const createProjectThread = vi.fn().mockReturnValue(creation.promise);
    const updateThreadDraft = vi
      .fn()
      .mockRejectedValueOnce(new Error("Черновик не сохранён"))
      .mockResolvedValueOnce({
        input: "Сохранить в существующую сессию",
        images: [],
        goalMode: false,
        annotations: [],
        updatedAt: 40,
      });
    connection.mockReturnValue(mockConnection({ createProjectThread, updateThreadDraft }));

    renderNewSession();
    fireEvent.change(screen.getByRole("textbox", { name: "Сообщение для Codex" }), {
      target: { value: "Сохранить в существующую сессию" },
    });
    creation.resolve({ thread });

    expect(await screen.findByText("Черновик не сохранён")).toBeInTheDocument();
    await waitFor(() =>
      expect(drafts.save).toHaveBeenCalledWith(
        connectionSettings,
        project.id,
        expect.objectContaining({ input: "Сохранить в существующую сессию" }),
        expect.objectContaining({ phase: "transferring", threadId: thread.id }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));

    expect(await screen.findByText("Созданная сессия")).toBeInTheDocument();
    expect(createProjectThread).toHaveBeenCalledOnce();
    expect(updateThreadDraft).toHaveBeenCalledTimes(2);
  });

  it("warns when the preparation cannot be stored locally", async () => {
    drafts.save.mockResolvedValue(false);
    connection.mockReturnValue(
      mockConnection({
        createProjectThread: vi.fn().mockReturnValue(new Promise(() => undefined)),
      }),
    );

    renderNewSession();

    expect(
      await screen.findByText(
        "Локальное сохранение недоступно. Не закрывайте страницу, пока сессия не откроется.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps the inspector closed until the user opens it", async () => {
    connection.mockReturnValue(
      mockConnection({
        createProjectThread: vi.fn().mockReturnValue(new Promise(() => undefined)),
      }),
    );
    renderNewSession();

    expect(screen.queryByLabelText("Сведения о новой задаче")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Показать сведения" }));
    expect(await screen.findByLabelText("Сведения о новой задаче")).toBeInTheDocument();
  });
});

function renderNewSession() {
  return render(
    <MemoryRouter
      initialEntries={[
        {
          pathname: "/new",
          search: "?projectId=project",
          state: { newSessionProjectId: project.id },
        },
      ]}
    >
      <Routes>
        <Route path="*" element={<PersistentNewSessionRoute />} />
      </Routes>
    </MemoryRouter>,
  );
}

function PersistentNewSessionRoute() {
  const location = useLocation();
  return (
    <>
      <NewSession projects={[project]} onOpenNavigation={() => undefined} />
      {location.pathname.startsWith("/threads/") && <div>Созданная сессия</div>}
    </>
  );
}

function mockConnection({
  createProjectThread = vi.fn(),
  models = [],
  readThread = vi.fn(),
  sendQueuedNow = vi.fn(),
  sendReliable = vi.fn(),
  taskDefaults,
  updateThreadDraft = vi.fn(),
  dispatch = vi.fn(),
}: {
  createProjectThread?: ReturnType<typeof vi.fn>;
  models?: ModelOption[];
  readThread?: ReturnType<typeof vi.fn>;
  sendQueuedNow?: ReturnType<typeof vi.fn>;
  sendReliable?: ReturnType<typeof vi.fn>;
  taskDefaults?: { serviceTier?: string; personality?: string };
  updateThreadDraft?: ReturnType<typeof vi.fn>;
  dispatch?: ReturnType<typeof vi.fn>;
}) {
  return {
    api: {
      createProjectThread,
      readThread,
      sendQueuedNow,
      settings: connectionSettings,
      transcribe: vi.fn(),
      updateThreadDraft,
    },
    dispatch,
    sendReliable,
    state: {
      details: {},
      snapshot: { connection: { state: "ready" }, models, taskDefaults, threads: [] },
      network: "connected",
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
