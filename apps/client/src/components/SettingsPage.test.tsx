import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

import type { TranscriptionConfigResponse } from "@codexnest/protocol";

import { ApiClientError } from "../api";
import { I18nProvider } from "../i18n";
import { SettingsPage } from "./SettingsPage";

const connection = vi.hoisted(() => vi.fn());

vi.mock("../connection", () => ({ useConnection: connection }));
vi.mock("./CodexSettingsCard", () => ({
  CodexSettingsProvider: ({ children }: { children: ReactNode }) => children,
  CodexSettingsCard: () => (
    <section>
      <h2>Codex CLI</h2>
    </section>
  ),
  ProxySettingsCard: () => (
    <section>
      <h2>Прокси</h2>
    </section>
  ),
}));
vi.mock("./ClaudeSettingsCard", () => ({
  ClaudeSettingsCard: () => (
    <section>
      <h2>Claude Code CLI</h2>
    </section>
  ),
}));
vi.mock("./ApplicationSettingsCard", () => ({
  ApplicationSettingsCard: () => (
    <section>
      <h2>Обновление CodexNest</h2>
    </section>
  ),
}));

beforeEach(() => {
  connection.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SettingsPage", () => {
  it("normalizes a custom config into the selected global preset", async () => {
    const readPermissionSettings = vi.fn().mockResolvedValue({
      preset: null,
      version: "version-1",
      overridden: false,
      message: null,
    });
    const updatePermissionSettings = vi.fn().mockResolvedValue({
      preset: "auto",
      version: "version-2",
      overridden: false,
      message: null,
    });
    connection.mockReturnValue({ api: { readPermissionSettings, updatePermissionSettings } });

    renderPage();

    expect(await screen.findAllByRole("radio")).toHaveLength(3);
    expect(screen.getByRole("radio", { name: /Подтверждать автоматически/ })).toBeChecked();
    expect(screen.getByText(/Обнаружена нестандартная конфигурация/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(updatePermissionSettings).toHaveBeenCalledWith({
        preset: "auto",
        expectedVersion: "version-1",
      }),
    );
    expect(screen.queryByText(/Обнаружена нестандартная конфигурация/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Сохранить" })).toBeDisabled();
  });

  it("warns about full access and reloads after a version conflict", async () => {
    const current = {
      preset: "auto" as const,
      version: "version-1",
      overridden: false,
      message: null,
    };
    const readPermissionSettings = vi.fn().mockResolvedValue(current);
    const updatePermissionSettings = vi
      .fn()
      .mockRejectedValue(new ApiClientError("conflict", "Config changed", 409));
    connection.mockReturnValue({ api: { readPermissionSettings, updatePermissionSettings } });

    renderPage();
    const fullAccess = await screen.findByRole("radio", { name: /Полный доступ/ });
    fireEvent.click(fullAccess);

    expect(screen.getByRole("alert")).toHaveTextContent("Полный доступ снимает ограничения");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    expect(
      await screen.findByText(/Конфигурация Codex изменилась.*сохраните ещё раз/),
    ).toBeInTheDocument();
    expect(readPermissionSettings).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("radio", { name: /Подтверждать автоматически/ })).toBeChecked();
  });

  it("shows a managed override returned by Codex", async () => {
    connection.mockReturnValue({
      api: {
        readPermissionSettings: vi.fn().mockResolvedValue({
          preset: "ask",
          version: "version-1",
          overridden: true,
          message: "Managed by policy",
        }),
        updatePermissionSettings: vi.fn(),
      },
    });

    renderPage();

    expect(await screen.findByText("Managed by policy")).toBeInTheDocument();
  });

  it("changes the local appearance theme immediately", () => {
    connection.mockReturnValue({
      api: {
        readPermissionSettings: vi.fn().mockResolvedValue({
          preset: "auto",
          version: "version-1",
          overridden: false,
          message: null,
        }),
        updatePermissionSettings: vi.fn(),
      },
    });
    const onThemeChange = vi.fn();

    renderPage("system", onThemeChange);
    fireEvent.change(screen.getByRole("combobox", { name: "Тема" }), {
      target: { value: "dark" },
    });

    expect(onThemeChange).toHaveBeenCalledWith("dark");
  });

  it("saves the interface language on the server before applying it", async () => {
    localStorage.setItem("codexnest.uiLanguage", "ru");
    const readPermissionSettings = vi.fn().mockResolvedValue({
      preset: "auto",
      version: "version-1",
      overridden: false,
      message: null,
    });
    const updateUiLanguage = vi.fn().mockResolvedValue({ language: "en" });
    connection.mockReturnValue({
      api: {
        readPermissionSettings,
        updatePermissionSettings: vi.fn(),
        updateUiLanguage,
      },
    });

    renderLocalizedPage();
    fireEvent.change(await screen.findByRole("combobox", { name: "Язык интерфейса" }), {
      target: { value: "en" },
    });

    await waitFor(() => expect(updateUiLanguage).toHaveBeenCalledWith({ language: "en" }));
    expect(await screen.findByRole("combobox", { name: "Interface language" })).toHaveValue("en");
    expect(localStorage.getItem("codexnest.uiLanguage")).toBe("en");
    expect(readPermissionSettings).toHaveBeenCalledOnce();
  });

  it("orders settings by usage frequency in one column", () => {
    connection.mockReturnValue({
      api: {
        readPermissionSettings: vi.fn().mockResolvedValue({
          preset: "auto",
          version: "version-1",
          overridden: false,
          message: null,
        }),
        updatePermissionSettings: vi.fn(),
      },
    });

    const view = renderPage();
    const stack = view.container.querySelector(".settings-stack");

    expect(stack).not.toBeNull();
    expect(
      within(stack as HTMLElement)
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual([
      "Обновление CodexNest",
      "Codex CLI",
      "Claude Code CLI",
      "Новые задачи",
      "Разрешения Codex",
      "Распознавание речи",
      "Уведомления браузера",
      "Интерфейс",
      "Прокси",
      "Сервер",
    ]);
    expect(screen.queryByRole("navigation", { name: "Разделы настроек" })).not.toBeInTheDocument();
  });

  it("changes the local sidebar side immediately", () => {
    connection.mockReturnValue({
      api: {
        readPermissionSettings: vi.fn().mockResolvedValue({
          preset: "auto",
          version: "version-1",
          overridden: false,
          message: null,
        }),
        updatePermissionSettings: vi.fn(),
      },
    });
    const onSidebarSideChange = vi.fn();

    renderPage("system", vi.fn(), vi.fn(), "left", onSidebarSideChange);
    fireEvent.change(screen.getByRole("combobox", { name: "Боковая панель" }), {
      target: { value: "right" },
    });

    expect(onSidebarSideChange).toHaveBeenCalledWith("right");
  });

  it("changes the local project list direction immediately", () => {
    connection.mockReturnValue({
      api: {
        readPermissionSettings: vi.fn().mockResolvedValue({
          preset: "auto",
          version: "version-1",
          overridden: false,
          message: null,
        }),
        updatePermissionSettings: vi.fn(),
      },
    });
    const onProjectListDirectionChange = vi.fn();

    renderPage(
      "system",
      vi.fn(),
      vi.fn(),
      "left",
      vi.fn(),
      "bottom-up",
      onProjectListDirectionChange,
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Порядок проектов" }), {
      target: { value: "top-down" },
    });

    expect(onProjectListDirectionChange).toHaveBeenCalledWith("top-down");
  });

  it("saves the speech transcription provider globally on the server", async () => {
    const updateTranscriptionSettings = vi.fn().mockResolvedValue({
      ...transcriptionConfig,
      provider: "openai",
    });
    connection.mockReturnValue({
      api: {
        settings: { baseUrl: "https://codex.example" },
        readPermissionSettings: vi.fn().mockResolvedValue({
          preset: "auto",
          version: "version-1",
          overridden: false,
          message: null,
        }),
        updatePermissionSettings: vi.fn(),
        updateTranscriptionSettings,
      },
    });
    const onTranscriptionConfigChange = vi.fn();

    renderPage("system", vi.fn(), vi.fn(), "left", vi.fn(), "bottom-up", vi.fn(), {
      config: transcriptionConfig,
      onChange: onTranscriptionConfigChange,
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Провайдер распознавания речи" }), {
      target: { value: "openai" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить распознавание" }));

    await waitFor(() =>
      expect(updateTranscriptionSettings).toHaveBeenCalledWith({
        provider: "openai",
        localUrl: "http://127.0.0.1:8178/inference",
        openAiModel: "gpt-4o-transcribe",
        language: "ru",
        refineLocal: true,
        refinementModel: "gpt-5.6-luna",
      }),
    );
    expect(onTranscriptionConfigChange).toHaveBeenCalledWith({
      ...transcriptionConfig,
      provider: "openai",
    });
  });

  it("masks and removes the OpenAI key without allowing key input over remote HTTP", async () => {
    const openAiConfig: TranscriptionConfigResponse = {
      ...transcriptionConfig,
      provider: "openai",
    };
    const updateTranscriptionSettings = vi.fn().mockResolvedValue({
      ...openAiConfig,
      providers: ["local"],
      provider: "local",
      openAiApiKeyConfigured: false,
    });
    connection.mockReturnValue({
      api: {
        settings: { baseUrl: "http://192.168.2.228:4310" },
        readPermissionSettings: vi.fn().mockResolvedValue({
          preset: "auto",
          version: "version-1",
          overridden: false,
          message: null,
        }),
        updatePermissionSettings: vi.fn(),
        updateTranscriptionSettings,
      },
    });

    renderPage("system", vi.fn(), vi.fn(), "left", vi.fn(), "bottom-up", vi.fn(), {
      config: openAiConfig,
      onChange: vi.fn(),
    });

    expect(screen.getByText("API key настроен")).toBeInTheDocument();
    expect(screen.getByLabelText("OpenAI API key")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Удалить ключ" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Провайдер распознавания речи" }), {
      target: { value: "local" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить распознавание" }));

    await waitFor(() =>
      expect(updateTranscriptionSettings).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "local", openAiApiKey: null }),
      ),
    );
  });

  it("requests browser notification permission from an explicit action", async () => {
    const requestPermission = vi.fn().mockResolvedValue("granted");
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    connection.mockReturnValue({
      api: {
        readPermissionSettings: vi.fn().mockResolvedValue({
          preset: "auto",
          version: "version-1",
          overridden: false,
          message: null,
        }),
        updatePermissionSettings: vi.fn(),
      },
    });

    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Разрешить уведомления" }));

    await waitFor(() => expect(requestPermission).toHaveBeenCalledOnce());
    expect(await screen.findByText(/Уведомления включены/)).toBeInTheDocument();
  });

  it("exposes the server switch action in settings", () => {
    connection.mockReturnValue({
      api: {
        readPermissionSettings: vi.fn().mockResolvedValue({
          preset: "auto",
          version: "version-1",
          overridden: false,
          message: null,
        }),
        updatePermissionSettings: vi.fn(),
      },
    });
    const onSwitchServer = vi.fn();

    renderPage("system", vi.fn(), onSwitchServer);
    fireEvent.click(screen.getByRole("button", { name: "Сменить сервер" }));

    expect(onSwitchServer).toHaveBeenCalledOnce();
  });

  it("stores Service tier and Personality as server defaults for new tasks", async () => {
    const updateTaskDefaults = vi.fn().mockResolvedValue({
      serviceTier: "fast",
      personality: "friendly",
    });
    connection.mockReturnValue({
      api: {
        readPermissionSettings: vi.fn().mockResolvedValue({
          preset: "auto",
          version: "version-1",
          overridden: false,
          message: null,
        }),
        updatePermissionSettings: vi.fn(),
        updateTaskDefaults,
      },
      state: {
        snapshot: {
          taskDefaults: {},
          models: [
            {
              id: "gpt",
              displayName: "GPT",
              description: "",
              isDefault: true,
              reasoningEfforts: [],
              serviceTiers: [{ id: "fast", displayName: "Fast" }],
              supportsPersonality: true,
            },
          ],
        },
      },
    });

    renderPage();
    fireEvent.change(screen.getByRole("combobox", { name: "Service tier" }), {
      target: { value: "fast" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Personality" }), {
      target: { value: "friendly" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить настройки новых задач" }));

    await waitFor(() =>
      expect(updateTaskDefaults).toHaveBeenCalledWith({
        serviceTier: "fast",
        personality: "friendly",
      }),
    );
  });
});

function renderPage(
  theme = "system",
  onThemeChange = vi.fn(),
  onSwitchServer = vi.fn(),
  sidebarSide: "left" | "right" = "left",
  onSidebarSideChange = vi.fn(),
  projectListDirection: "bottom-up" | "top-down" = "top-down",
  onProjectListDirectionChange = vi.fn(),
  transcription: {
    config: TranscriptionConfigResponse;
    onChange(config: TranscriptionConfigResponse): void;
  } | null = null,
) {
  return render(
    <MemoryRouter>
      <SettingsPage
        onOpenNavigation={() => undefined}
        onSwitchServer={onSwitchServer}
        theme={theme}
        onThemeChange={onThemeChange}
        sidebarSide={sidebarSide}
        onSidebarSideChange={onSidebarSideChange}
        projectListDirection={projectListDirection}
        onProjectListDirectionChange={onProjectListDirectionChange}
        transcriptionConfig={transcription?.config}
        onTranscriptionConfigChange={transcription?.onChange}
      />
    </MemoryRouter>,
  );
}

function renderLocalizedPage() {
  return render(
    <I18nProvider>
      <MemoryRouter>
        <SettingsPage
          onOpenNavigation={() => undefined}
          onSwitchServer={() => undefined}
          theme="system"
          onThemeChange={() => undefined}
          sidebarSide="left"
          onSidebarSideChange={() => undefined}
          projectListDirection="top-down"
          onProjectListDirectionChange={() => undefined}
        />
      </MemoryRouter>
    </I18nProvider>,
  );
}

const transcriptionConfig: TranscriptionConfigResponse = {
  providers: ["local", "openai"],
  provider: "local",
  localUrl: "http://127.0.0.1:8178/inference",
  openAiApiKeyConfigured: true,
  openAiModel: "gpt-4o-transcribe",
  language: "ru",
  refineLocal: true,
  refinementModel: "gpt-5.6-luna",
  maxRecordingSeconds: 300,
  maxUploadBytes: 24 * 1024 * 1024,
  timingEstimate: { sampleCount: 0, estimatedProcessingMsPerAudioSecond: null },
};
