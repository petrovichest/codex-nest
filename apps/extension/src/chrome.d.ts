interface ChromeEvent<Arguments extends unknown[]> {
  addListener(callback: (...arguments_: Arguments) => void): void;
  removeListener(callback: (...arguments_: Arguments) => void): void;
}

interface ChromeTab {
  id?: number;
  windowId: number;
  groupId: number;
  index: number;
  active: boolean;
  title?: string;
  url?: string;
  pendingUrl?: string;
  status?: string;
}

interface ChromeWindow {
  id?: number;
  width?: number;
  height?: number;
  left?: number;
  top?: number;
}

interface ChromePort {
  name: string;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: ChromeEvent<[unknown]>;
  onDisconnect: ChromeEvent<[]>;
}

interface ChromeMessageSender {
  tab?: ChromeTab;
  frameId?: number;
}

interface ChromeDebuggerTarget {
  tabId?: number;
}

interface ChromeApi {
  runtime: {
    getManifest(): {
      version: string;
      browser_specific_settings?: { gecko?: { id?: string; strict_min_version?: string } };
    };
    getURL(path: string): string;
    onInstalled: ChromeEvent<[]>;
    onStartup: ChromeEvent<[]>;
    onMessage: ChromeEvent<[unknown, ChromeMessageSender, (response?: unknown) => void]>;
    onConnect: ChromeEvent<[ChromePort]>;
    sendMessage(message: unknown): Promise<unknown>;
  };
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
  tabs: {
    query(query: Record<string, unknown>): Promise<ChromeTab[]>;
    get(tabId: number): Promise<ChromeTab>;
    create(properties: Record<string, unknown>): Promise<ChromeTab>;
    update(tabId: number, properties: Record<string, unknown>): Promise<ChromeTab>;
    remove(tabIds: number | number[]): Promise<void>;
    group(options: {
      tabIds: number | number[];
      groupId?: number;
      createProperties?: { windowId?: number };
    }): Promise<number>;
    ungroup(tabIds: number | number[]): Promise<void>;
    goBack(tabId: number): Promise<void>;
    goForward(tabId: number): Promise<void>;
    reload(tabId: number, properties?: { bypassCache?: boolean }): Promise<void>;
    setZoom(tabId: number, zoomFactor: number): Promise<void>;
    sendMessage(tabId: number, message: unknown, options?: { frameId?: number }): Promise<unknown>;
    connect(tabId: number, options: { name: string; frameId?: number }): ChromePort;
    onActivated: ChromeEvent<[{ tabId: number; windowId: number }]>;
    onRemoved: ChromeEvent<[number, { windowId: number; isWindowClosing: boolean }]>;
    onUpdated: ChromeEvent<[number, Record<string, unknown>, ChromeTab]>;
  };
  tabGroups: {
    update(groupId: number, properties: Record<string, unknown>): Promise<unknown>;
  };
  windows: {
    getCurrent(): Promise<ChromeWindow>;
    get(windowId: number): Promise<ChromeWindow>;
    update(windowId: number, properties: Record<string, unknown>): Promise<ChromeWindow>;
  };
  debugger: {
    attach(target: ChromeDebuggerTarget, version: string): Promise<void>;
    detach(target: ChromeDebuggerTarget): Promise<void>;
    sendCommand(
      target: ChromeDebuggerTarget,
      method: string,
      parameters?: Record<string, unknown>,
    ): Promise<unknown>;
    onEvent: ChromeEvent<[ChromeDebuggerTarget, string, unknown]>;
    onDetach: ChromeEvent<[ChromeDebuggerTarget, string]>;
  };
  scripting: {
    executeScript(options: Record<string, unknown>): Promise<Array<{ result?: unknown }>>;
  };
  action: {
    setBadgeText(details: { text: string }): Promise<void>;
    setBadgeBackgroundColor(details: { color: string }): Promise<void>;
    setTitle(details: { title: string }): Promise<void>;
  };
  sidePanel?: {
    open(options: { windowId: number }): Promise<void>;
  };
  sidebarAction?: {
    open(): Promise<void>;
  };
  alarms: {
    create(name: string, information: Record<string, unknown>): Promise<void>;
    clear(name: string): Promise<boolean>;
    onAlarm: ChromeEvent<[{ name: string }]>;
  };
}

declare const chrome: ChromeApi;
