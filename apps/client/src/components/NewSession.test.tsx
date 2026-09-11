import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router";

import type { ModelOption, Project, ThreadDraft, ThreadSummary } from "@codexnest/protocol";

import { ApiClientError } from "../api";
import type { LocalDraft, LocalNewSessionDraft } from "../offline-store";
import { NewSession } from "./NewSession";

const connection = vi.hoisted(() => vi.fn());
const drafts = vi.hoisted(() => ({
  delete: vi.fn().mockResolvedValue(undefined),
  deleteLocal: vi.fn().mockResolvedValue(undefined),
  load: vi.fn().mockResolvedValue(null),
  loadLocal: vi.fn().mockResolvedValue(null),
  save: vi.fn().mockResolvedValue(true),
  saveLocal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../connection", () => ({ useConnection: connection }));
vi.mock("../offline-store", () => ({
  deleteLocalDraft: drafts.deleteLocal,
  deleteNewSessionDraft: drafts.delete,
  loadNewSessionDraft: drafts.load,
  loadLocalDraft: drafts.loadLocal,
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
  serviceTiers: [],
  supportsPersonality: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  drafts.delete.mockResolvedValue(undefined);
  drafts.deleteLocal.mockResolvedValue(undefined);
  drafts.load.mockResolvedValue(null);
  drafts.loadLocal.mockResolvedValue(null);
  drafts.save.mockResolvedValue(true);
  drafts.saveLocal.mockResolvedValue(undefined);
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NewSession", () => {
  it("persists a fast Enter and moves it into the timeline before creation completes", async () => {
    const hydration = deferred<null>();
    const creation = deferred<{ thread: ThreadSummary }>();
    const delivery = deferred<"delivered">();
    drafts.load.mockReturnValue(hydration.promise);
    const createProjectThread = vi.fn().mockReturnValue(creation.promise);
    let commit: (() => void) | undefined;
    const sendReliable = vi.fn((_id, _body, onCommitted) => {
      commit = onCommitted;
      return delivery.promise;
    });
    connection.mockReturnValue(mockConnection({ createProjectThread, sendReliable }));
    renderNewSession();
    const textbox = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    fireEvent.change(textbox, { target: { value: "Быстрое первое сообщение" } });
    fireEvent.keyDown(textbox, { key: "Enter" });
    fireEvent.keyDown(textbox, { key: "Enter" });
    await waitFor(() =>
      expect(drafts.save).toHaveBeenCalledWith(
        connectionSettings,
        project.id,
        expect.anything(),
        expect.objectContaining({
          submission: expect.objectContaining({
            id: expect.any(String),
            input: "Быстрое первое сообщение",
          }),
        }),
      ),
    );
    expect(createProjectThread).not.toHaveBeenCalled();
    hydration.resolve(null);
    await waitFor(() => expect(createProjectThread).toHaveBeenCalledOnce());
    expect(textbox).toHaveValue("");
    expect(screen.getByText("Быстрое первое сообщение")).toBeInTheDocument();
    expect(screen.getByText("Отправляется…")).toBeInTheDocument();
    creation.resolve({ thread });
    await waitFor(() => expect(sendReliable).toHaveBeenCalledOnce());
    expect(textbox).toHaveValue("");
    expect(screen.queryByText("Созданная сессия")).not.toBeInTheDocument();
    act(() => commit!());
    expect(textbox).toHaveValue("");
    expect(screen.getByText("Созданная сессия")).toBeInTheDocument();
    delivery.resolve("delivered");
    await waitFor(() => expect(drafts.delete).toHaveBeenCalled());
  });

  it("continues a persisted first submission with its original id after reopening", async () => {
    const draft = { input: "Сохранённая отправка", images: [], goalMode: false, annotations: [] };
    drafts.load.mockResolvedValue({
      projectId: project.id,
      value: draft,
      threadId: thread.id,
      thread,
      phase: "transferring",
      revision: 1,
      submission: { id: "persisted-id", intent: "queue", input: draft.input, draft },
    });
    const createProjectThread = vi.fn();
    const sendReliable = vi.fn().mockResolvedValue("delivered");
    connection.mockReturnValue(mockConnection({ createProjectThread, sendReliable }));
    renderNewSession();
    await waitFor(() =>
      expect(sendReliable).toHaveBeenCalledWith(
        thread.id,
        expect.objectContaining({ clientMessageId: "persisted-id", input: draft.input }),
        expect.any(Function),
        expect.objectContaining({ projectId: project.id }),
      ),
    );
    expect(createProjectThread).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toHaveValue("");
  });

  it("automatically retries creation without losing the first submission identity", async () => {
    const createProjectThread = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiClientError("app_server_unavailable", "Временно недоступно", 503),
      )
      .mockResolvedValue({ thread });
    const sendReliable = vi.fn().mockResolvedValue("delivered");
    connection.mockReturnValue(mockConnection({ createProjectThread, sendReliable }));
    renderNewSession();
    const textbox = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    fireEvent.change(textbox, { target: { value: "Повтори после сбоя" } });
    fireEvent.keyDown(textbox, { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByText("Нет связи — повторим отправку")).toBeInTheDocument(),
    );
    const firstSubmission = drafts.save.mock.calls.find((call) => call[3]?.submission)?.[3]
      .submission;
    expect(firstSubmission?.id).toEqual(expect.any(String));
    expect(textbox).toHaveValue("");
    expect(screen.getByText("Повтори после сбоя")).toBeInTheDocument();
    await waitFor(() => expect(sendReliable).toHaveBeenCalledOnce(), { timeout: 2500 });
    expect(sendReliable.mock.calls[0]?.[1].clientMessageId).toBe(firstSubmission.id);
    expect(createProjectThread).toHaveBeenCalledTimes(2);
  });

  it("recovers an Enter across a page reload while session creation is still pending", async () => {
    let stored: LocalNewSessionDraft | null = null;
    drafts.load.mockImplementation(async () => stored);
    drafts.save.mockImplementation(async (_settings, projectId, value, preparation) => {
      stored = structuredClone({
        key: "new",
        connectionKey: "test",
        projectId,
        value,
        ...preparation,
        updatedAt: 1,
      });
      return true;
    });
    const firstCreation = deferred<{ thread: ThreadSummary }>();
    const createProjectThread = vi
      .fn()
      .mockReturnValueOnce(firstCreation.promise)
      .mockResolvedValue({ thread });
    const sendReliable = vi.fn().mockResolvedValue("delivered");
    connection.mockReturnValue(mockConnection({ createProjectThread, sendReliable }));
    const view = renderNewSession();
    const textbox = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    fireEvent.change(textbox, { target: { value: "Пережить перезагрузку" } });
    fireEvent.keyDown(textbox, { key: "Enter" });
    await waitFor(() => expect(createProjectThread).toHaveBeenCalledOnce());
    const messageId = stored!.submission!.id;
    view.unmount();
    renderNewSession();
    await waitFor(() => expect(sendReliable).toHaveBeenCalledOnce());
    expect(sendReliable.mock.calls[0]?.[1]).toMatchObject({
      input: "Пережить перезагрузку",
      clientMessageId: messageId,
    });
    await act(async () => firstCreation.resolve({ thread }));
    expect(sendReliable).toHaveBeenCalledOnce();
  });

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

  it("keeps the first message in the editor if local persistence fails until server acceptance", async () => {
    drafts.save.mockResolvedValue(false);
    const creation = deferred<{ thread: ThreadSummary }>();
    const delivery = deferred<"delivered">();
    const sendReliable = vi.fn().mockReturnValue(delivery.promise);
    connection.mockReturnValue(
      mockConnection({
        createProjectThread: vi.fn().mockReturnValue(creation.promise),
        sendReliable,
      }),
    );
    renderNewSession();
    const textbox = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    fireEvent.change(textbox, { target: { value: "Не очищать без копии" } });
    fireEvent.keyDown(textbox, { key: "Enter" });
    await waitFor(() => expect(drafts.save).toHaveBeenCalled());
    expect(textbox).toHaveValue("Не очищать без копии");
    creation.resolve({ thread });
    await waitFor(() => expect(sendReliable).toHaveBeenCalledOnce());
    expect(textbox).toHaveValue("Не очищать без копии");
    await act(async () => delivery.resolve("delivered"));
    expect(textbox).toHaveValue("");
  });

  it("keeps the next draft separate while the first message waits for session creation", async () => {
    const creation = deferred<{ thread: ThreadSummary }>();
    const delivery = deferred<"delivered">();
    const sendReliable = vi.fn((_id, _body, commit) => {
      commit();
      return delivery.promise;
    });
    connection.mockReturnValue(
      mockConnection({
        createProjectThread: vi.fn().mockReturnValue(creation.promise),
        sendReliable,
      }),
    );
    renderNewSession();
    const textbox = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    fireEvent.change(textbox, { target: { value: "Первое" } });
    fireEvent.keyDown(textbox, { key: "Enter" });
    await waitFor(() => expect(textbox).toHaveValue(""));
    fireEvent.change(textbox, { target: { value: "Следующее" } });
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(sendReliable).not.toHaveBeenCalled();
    expect(screen.getByText("Первое")).toBeInTheDocument();
    creation.resolve({ thread });
    await waitFor(() => expect(sendReliable).toHaveBeenCalledOnce());
    expect(sendReliable.mock.calls[0]?.[1].input).toBe("Первое");
    expect(textbox).toHaveValue("Следующее");
    expect(drafts.save).toHaveBeenCalledWith(
      connectionSettings,
      project.id,
      expect.objectContaining({ input: "Следующее" }),
      expect.objectContaining({
        submission: expect.objectContaining({ input: "Первое", staged: true }),
      }),
    );
    await act(async () => delivery.resolve("delivered"));
    expect(textbox).toHaveValue("Следующее");
  });

  it("retains a permanently rejected first submission for explicit retry", async () => {
    const creation = deferred<{ thread: ThreadSummary }>();
    const createProjectThread = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError("invalid", "Cannot create", 400))
      .mockReturnValue(creation.promise);
    const sendReliable = vi.fn().mockResolvedValue("delivered");
    connection.mockReturnValue(mockConnection({ createProjectThread, sendReliable }));
    renderNewSession();
    const textbox = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    fireEvent.change(textbox, { target: { value: "Повторить вручную" } });
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(await screen.findByText("Не отправлено")).toBeInTheDocument();
    expect(screen.getByText("Повторить вручную")).toBeInTheDocument();
    expect(textbox).toHaveValue("");
    const id = drafts.save.mock.calls.find((call) => call[3]?.submission)?.[3].submission.id;
    expect(createProjectThread).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Повторить отправку" }));
    await waitFor(() => expect(createProjectThread).toHaveBeenCalledTimes(2));
    creation.resolve({ thread });
    await waitFor(() => expect(sendReliable).toHaveBeenCalledOnce());
    expect(sendReliable.mock.calls[0]?.[1].clientMessageId).toBe(id);
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

  it.each([
    { localInput: null, updatedAt: 0, expected: "Серверный черновик", writes: 0 },
    { localInput: "Устаревшая копия", updatedAt: 10, expected: "Серверный черновик", writes: 0 },
    {
      localInput: "Последние изменения",
      updatedAt: 30,
      expected: "Последние изменения",
      writes: 1,
    },
    { localInput: "", updatedAt: 30, expected: "", writes: 1 },
  ])(
    "restores the latest reused-thread draft: $expected ($updatedAt)",
    async ({ localInput, updatedAt, expected, writes }) => {
      const serverDraft: ThreadDraft = {
        input: "Серверный черновик",
        images: [],
        goalMode: false,
        annotations: [],
        updatedAt: 20,
      };
      if (localInput !== null) {
        drafts.loadLocal.mockResolvedValue({
          value: { input: localInput, images: [], goalMode: false, annotations: [] },
          updatedAt,
        });
      }
      const updateThreadDraft = vi
        .fn()
        .mockImplementation(async (_id, value) =>
          value.input ? { ...value, updatedAt: 40 } : null,
        );
      const readThread = vi.fn();
      connection.mockReturnValue(
        mockConnection({
          createProjectThread: vi.fn().mockResolvedValue({ thread, draft: serverDraft }),
          updateThreadDraft,
          readThread,
        }),
      );

      renderNewSession();

      expect(await screen.findByText("Созданная сессия")).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toHaveValue(expected);
      expect(drafts.loadLocal).toHaveBeenCalledWith(connectionSettings, thread.id);
      expect(updateThreadDraft).toHaveBeenCalledTimes(writes);
      if (writes) {
        expect(updateThreadDraft).toHaveBeenCalledWith(
          thread.id,
          {
            input: expected,
            images: [],
            goalMode: false,
            annotations: [],
          },
          { retry: true },
        );
      }
      expect(readThread).not.toHaveBeenCalled();
    },
  );

  it("restores attachments and goal mode without resaving the server draft", async () => {
    const draft: ThreadDraft = {
      input: "  Текст с пробелами\nи новой строкой  ",
      images: [{ id: "image", name: "image.png", url: "data:image/png;base64,AA==" }],
      files: [
        {
          id: "file",
          name: "notes.txt",
          path: "/work/notes.txt",
          size: 5,
          mediaType: "text/plain",
        },
      ],
      goalMode: true,
      annotations: [],
      updatedAt: 20,
    };
    const updateThreadDraft = vi.fn();
    connection.mockReturnValue(
      mockConnection({
        createProjectThread: vi.fn().mockResolvedValue({ thread, draft }),
        updateThreadDraft,
      }),
    );

    renderNewSession();

    expect(await screen.findByText("Созданная сессия")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toHaveValue(draft.input);
    expect(
      screen.getByRole("button", { name: "Удалить изображение image.png" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Удалить файл notes.txt" })).toBeInTheDocument();
    expect(drafts.save).toHaveBeenLastCalledWith(
      connectionSettings,
      project.id,
      {
        input: draft.input,
        images: draft.images,
        files: draft.files,
        goalMode: true,
        annotations: [],
      },
      expect.anything(),
    );
    expect(updateThreadDraft).not.toHaveBeenCalled();
  });

  it.each(["Новый текст", ""])(
    "preserves edits made while a reused draft is loading: %s",
    async (input) => {
      const loading = deferred<LocalDraft | null>();
      drafts.loadLocal.mockReturnValueOnce(loading.promise);
      const updateThreadDraft = vi.fn().mockResolvedValue(null);
      connection.mockReturnValue(
        mockConnection({
          createProjectThread: vi.fn().mockResolvedValue({
            thread,
            draft: {
              input: "Старый текст",
              images: [],
              goalMode: false,
              annotations: [],
              updatedAt: 20,
            },
          }),
          updateThreadDraft,
        }),
      );

      renderNewSession();
      await waitFor(() => expect(drafts.loadLocal).toHaveBeenCalledOnce());
      const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });
      fireEvent.change(textarea, { target: { value: "Начал писать" } });
      fireEvent.change(textarea, { target: { value: input } });
      loading.resolve(null);

      expect(await screen.findByText("Созданная сессия")).toBeInTheDocument();
      expect(textarea).toHaveValue(input);
      expect(updateThreadDraft).toHaveBeenCalledWith(
        thread.id,
        {
          input,
          images: [],
          goalMode: false,
          annotations: [],
        },
        { retry: true },
      );
    },
  );

  it("keeps a saved preparation ahead of a reused thread's older draft", async () => {
    drafts.load.mockResolvedValue({
      value: { input: "Черновик подготовки", images: [], goalMode: false, annotations: [] },
      phase: "creating",
      threadId: null,
      thread: null,
      revision: 1,
    });
    const updateThreadDraft = vi.fn().mockResolvedValue(null);
    connection.mockReturnValue(
      mockConnection({
        createProjectThread: vi.fn().mockResolvedValue({
          thread,
          draft: {
            input: "Старый текст",
            images: [],
            goalMode: false,
            annotations: [],
            updatedAt: 20,
          },
        }),
        updateThreadDraft,
      }),
    );

    renderNewSession();

    expect(await screen.findByText("Созданная сессия")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toHaveValue(
      "Черновик подготовки",
    );
    expect(updateThreadDraft).toHaveBeenCalledWith(
      thread.id,
      expect.objectContaining({ input: "Черновик подготовки" }),
      { retry: true },
    );
  });

  it("clears a reused thread when its saved preparation was deliberately emptied", async () => {
    drafts.load.mockResolvedValue({
      value: { input: "", images: [], goalMode: false, annotations: [] },
      phase: "transferring",
      threadId: thread.id,
      thread,
      revision: 2,
    });
    const updateThreadDraft = vi.fn().mockResolvedValue(null);
    const createProjectThread = vi.fn();
    connection.mockReturnValue(mockConnection({ createProjectThread, updateThreadDraft }));

    renderNewSession();

    expect(await screen.findByText("Созданная сессия")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toHaveValue("");
    expect(updateThreadDraft).toHaveBeenCalledWith(
      thread.id,
      {
        input: "",
        images: [],
        goalMode: false,
        annotations: [],
      },
      { retry: true },
    );
    expect(createProjectThread).not.toHaveBeenCalled();
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

  it("restores an abandoned early submission without carrying a legacy service tier", async () => {
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
    expect(textbox).toHaveValue("Сохрани после ухода");

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

    expect(await screen.findByText("Сохрани после ухода")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toHaveValue("");
    expect(view.container.querySelector('img[src^="data:image/png"]')).not.toBeNull();
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
  taskDefaults?: {
    model?: string;
    titleModel?: string;
    serviceTier?: string;
    personality?: string;
  };
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
