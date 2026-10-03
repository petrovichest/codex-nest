import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router";

import type { ModelOption, Project, ThreadDraft, ThreadSummary } from "@codexnest/protocol";

import { ApiClientError } from "../api";
import type { LocalNewSessionDraft } from "../offline-store";
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
      expect(
        screen.getByText("Сервер временно недоступен — повторим отправку"),
      ).toBeInTheDocument(),
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

  it("retains the first draft and does not create a session when local persistence fails", async () => {
    drafts.save.mockResolvedValue(false);
    const createProjectThread = vi.fn();
    const sendReliable = vi.fn();
    connection.mockReturnValue(mockConnection({ createProjectThread, sendReliable }));
    renderNewSession();
    const textbox = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    fireEvent.change(textbox, { target: { value: "Не очищать без копии" } });
    fireEvent.keyDown(textbox, { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByText("Не удалось сохранить черновик на устройстве")).toBeInTheDocument(),
    );
    expect(textbox).toHaveValue("Не очищать без копии");
    expect(createProjectThread).not.toHaveBeenCalled();
    expect(sendReliable).not.toHaveBeenCalled();
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

  it("keeps a project draft without creating a Codex session until Enter", async () => {
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
    drafts.delete.mockImplementation(async () => {
      stored = null;
    });
    const createProjectThread = vi.fn().mockResolvedValue({ thread });
    const sendReliable = vi.fn().mockResolvedValue("delivered");
    const updateThreadDraft = vi.fn();
    connection.mockReturnValue(
      mockConnection({ createProjectThread, sendReliable, updateThreadDraft }),
    );
    let view = renderNewSession();
    const textbox = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    fireEvent.change(textbox, { target: { value: "Не потерять черновик" } });
    view.unmount();
    await waitFor(() => expect(stored?.value.input).toBe("Не потерять черновик"));
    expect((stored as LocalNewSessionDraft | null)?.threadId).toBeNull();
    expect(createProjectThread).not.toHaveBeenCalled();
    expect(updateThreadDraft).not.toHaveBeenCalled();
    view = renderNewSession();
    expect(await screen.findByDisplayValue("Не потерять черновик")).toBeInTheDocument();
    expect(createProjectThread).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Сообщение для Codex" }), {
      key: "Enter",
    });
    await waitFor(() => expect(sendReliable).toHaveBeenCalledOnce());
    expect(createProjectThread).toHaveBeenCalledExactlyOnceWith(project.id, expect.any(String));
    await waitFor(() => expect(drafts.delete).toHaveBeenCalled());
    view.unmount();
    renderNewSession();
    await waitFor(() => expect(drafts.load).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toHaveValue("");
    expect(createProjectThread).toHaveBeenCalledOnce();
  });

  it("retains file bytes across reopening and uploads only on the first send", async () => {
    let stored: LocalNewSessionDraft | null = null;
    drafts.load.mockImplementation(async () => stored);
    drafts.save.mockImplementation(async (_settings, projectId, value, preparation) => {
      stored = {
        key: "new",
        connectionKey: "test",
        projectId,
        value,
        ...preparation,
        updatedAt: 1,
      };
      return true;
    });
    const createProjectThread = vi.fn().mockResolvedValue({ thread });
    const uploadAttachment = vi.fn().mockResolvedValue({
      id: "uploaded",
      name: "notes.txt",
      path: "/attachments/notes.txt",
      size: 5,
      mediaType: "text/plain",
    });
    const sendReliable = vi.fn().mockResolvedValue("delivered");
    connection.mockReturnValue(
      mockConnection({ createProjectThread, sendReliable, uploadAttachment }),
    );
    const view = renderNewSession();
    fireEvent.change(view.container.querySelector('input[type="file"]')!, {
      target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
    });
    expect(
      await screen.findByRole("button", { name: "Удалить файл notes.txt" }),
    ).toBeInTheDocument();
    view.unmount();
    await waitFor(() => expect(stored?.attachments?.[0]?.file.size).toBe(5));
    expect(createProjectThread).not.toHaveBeenCalled();
    expect(uploadAttachment).not.toHaveBeenCalled();
    renderNewSession();
    expect(
      await screen.findByRole("button", { name: "Удалить файл notes.txt" }),
    ).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Сообщение для Codex" }), {
      key: "Enter",
    });
    await waitFor(() => expect(sendReliable).toHaveBeenCalledOnce());
    expect(uploadAttachment).toHaveBeenCalledWith(
      thread.id,
      expect.objectContaining({ name: "notes.txt", size: 5 }),
    );
    const fileContents = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(uploadAttachment.mock.calls[0]?.[1]);
    });
    expect(fileContents).toBe("hello");
    expect(sendReliable.mock.calls[0]?.[1].files).toEqual([
      {
        id: "uploaded",
        name: "notes.txt",
        path: "/attachments/notes.txt",
        size: 5,
        mediaType: "text/plain",
      },
    ]);
  });

  it("ignores a legacy created-thread binding when only an unsent draft is restored", async () => {
    drafts.load.mockResolvedValue({
      projectId: project.id,
      clientCreationId: "obsolete-id",
      threadId: "missing",
      thread: { ...thread, id: "missing" },
      value: { input: "Старый черновик", images: [], annotations: [], goalMode: false },
      revision: 1,
    });
    const createProjectThread = vi.fn().mockResolvedValue({ thread });
    const readThread = vi.fn();
    const sendReliable = vi.fn().mockResolvedValue("delivered");
    connection.mockReturnValue(mockConnection({ createProjectThread, readThread, sendReliable }));
    renderNewSession();
    expect(await screen.findByDisplayValue("Старый черновик")).toBeInTheDocument();
    expect(createProjectThread).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Сообщение для Codex" }), {
      key: "Enter",
    });
    await waitFor(() => expect(sendReliable).toHaveBeenCalledOnce());
    expect(createProjectThread.mock.calls[0]?.[1]).not.toBe("obsolete-id");
    expect(readThread).not.toHaveBeenCalled();
  });

  it("keeps user edits made while the project draft is being restored", async () => {
    const loading = deferred<LocalNewSessionDraft | null>();
    drafts.load.mockReturnValue(loading.promise);
    const createProjectThread = vi.fn().mockResolvedValue({ thread });
    const uploadAttachment = vi
      .fn()
      .mockResolvedValue({
        id: "uploaded",
        name: "fresh.txt",
        path: "/attachments/fresh.txt",
        size: 5,
        mediaType: "text/plain",
      });
    const sendReliable = vi.fn().mockResolvedValue("delivered");
    connection.mockReturnValue(
      mockConnection({ createProjectThread, uploadAttachment, sendReliable }),
    );
    const view = renderNewSession();
    fireEvent.change(screen.getByRole("textbox", { name: "Сообщение для Codex" }), {
      target: { value: "Свежий текст" },
    });
    fireEvent.change(view.container.querySelector('input[type="file"]')!, {
      target: { files: [new File(["fresh"], "fresh.txt", { type: "text/plain" })] },
    });
    expect(
      await screen.findByRole("button", { name: "Удалить файл fresh.txt" }),
    ).toBeInTheDocument();
    await act(async () =>
      loading.resolve({
        key: "new",
        connectionKey: "test",
        projectId: project.id,
        updatedAt: 1,
        attachments: [],
        value: { input: "Старый текст", images: [], annotations: [], goalMode: false },
      } as LocalNewSessionDraft),
    );
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toHaveValue(
      "Свежий текст",
    );
    expect(createProjectThread).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Сообщение для Codex" }), {
      key: "Enter",
    });
    await waitFor(() => expect(sendReliable).toHaveBeenCalledOnce());
    expect(uploadAttachment).toHaveBeenCalledOnce();
    expect(sendReliable.mock.calls[0]?.[1].files?.[0]?.path).toBe("/attachments/fresh.txt");
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
    await waitFor(() => expect(createProjectThread).toHaveBeenCalledOnce());
    expect(sendReliable).not.toHaveBeenCalled();
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
        "Локальное сохранение недоступно. Не закрывайте страницу до отправки сообщения.",
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
  uploadAttachment = vi.fn(),
  models = [],
  readThread = vi.fn(),
  sendQueuedNow = vi.fn(),
  sendReliable = vi.fn(),
  taskDefaults,
  updateThreadDraft = vi.fn(),
  dispatch = vi.fn(),
}: {
  createProjectThread?: ReturnType<typeof vi.fn>;
  uploadAttachment?: ReturnType<typeof vi.fn>;
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
      uploadAttachment,
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
