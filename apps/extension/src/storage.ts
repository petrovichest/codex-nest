import type { BindingSummary, UiLanguage } from "./protocol";

const STORAGE_KEY = "codexnest.browser.state.v1";

export interface ExtensionSettings {
  baseUrl: string;
  token: string;
}

export interface PersistedState {
  schemaVersion: 1;
  instanceId: string;
  settings: ExtensionSettings | null;
  locale: UiLanguage;
  bindings: Record<string, BindingSummary>;
}

export interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export class ExtensionStore {
  private state: PersistedState | null = null;
  private write = Promise.resolve();
  private mutation = Promise.resolve();

  constructor(
    private readonly area: StorageArea,
    private readonly createId: () => string = () => crypto.randomUUID(),
    private readonly initialLocale: () => UiLanguage = browserLocale,
  ) {}

  async load(): Promise<PersistedState> {
    if (this.state) return structuredClone(this.state);
    const values = await this.area.get(STORAGE_KEY);
    const stored = values[STORAGE_KEY];
    this.state = normaliseState(stored, this.createId, this.initialLocale);
    await this.persist();
    return structuredClone(this.state);
  }

  update(mutator: (draft: PersistedState) => void): Promise<PersistedState> {
    const operation = this.mutation.then(async () => {
      const current = await this.load();
      const immutableId = current.instanceId;
      mutator(current);
      current.instanceId = immutableId;
      this.state = current;
      await this.persist();
      return structuredClone(current);
    });
    this.mutation = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async persist(): Promise<void> {
    const snapshot = structuredClone(this.state);
    this.write = this.write.then(() => this.area.set({ [STORAGE_KEY]: snapshot }));
    await this.write;
  }
}

function normaliseState(
  value: unknown,
  createId: () => string,
  initialLocale: () => UiLanguage,
): PersistedState {
  const fallback: PersistedState = {
    schemaVersion: 1,
    instanceId: createId(),
    settings: null,
    locale: initialLocale(),
    bindings: {},
  };
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as Partial<PersistedState>;
  return {
    schemaVersion: 1,
    instanceId:
      typeof candidate.instanceId === "string" && candidate.instanceId.length > 0
        ? candidate.instanceId
        : fallback.instanceId,
    settings:
      candidate.settings &&
      typeof candidate.settings.baseUrl === "string" &&
      typeof candidate.settings.token === "string"
        ? { baseUrl: candidate.settings.baseUrl, token: candidate.settings.token }
        : null,
    locale:
      candidate.locale === "ru" || candidate.locale === "en" ? candidate.locale : fallback.locale,
    bindings:
      candidate.bindings && typeof candidate.bindings === "object" ? candidate.bindings : {},
  };
}

export function browserLocale(): UiLanguage {
  const language = globalThis.navigator?.language?.toLowerCase() ?? "en";
  return language.startsWith("ru") ? "ru" : "en";
}
