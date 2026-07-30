import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import type {
  AppServerState,
  CodexManagementOperation,
  CodexManagementStatus,
  CodexProxyStatus,
} from "@codexnest/protocol";

import { childProcessEnvironment } from "./config";

const execFileAsync = promisify(execFile);
const PROXY_VARIABLES = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
] as const;
const NO_PROXY = "localhost,127.0.0.1,::1";

export type ParsedProxy = {
  protocol: "http" | "https";
  host: string;
  port: number;
  username: string;
  password: string;
  url: string;
};

type CommandResult = { stdout: string; stderr: string };
type RunCommand = (
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeout: number },
) => Promise<CommandResult>;

export type CodexManagerOptions = {
  codexBin: string;
  managementBin: string;
  proxyEnvFile: string;
  transport: "stdio" | "daemon";
  activeTurnCount(): number;
  bridgeState(): AppServerState;
  bridgeVersion(): string | undefined;
  runCommand?: RunCommand;
};

type Diagnostics = {
  latestVersion: string | null;
  networkStatus: "ok" | "error";
  networkMessage: string | null;
};

type DaemonVersion = {
  status?: string;
  cliVersion?: string;
  appServerVersion?: string;
};

export class CodexManagementError extends Error {
  constructor(
    public readonly kind: "validation" | "unsupported" | "busy" | "active_turns" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "CodexManagementError";
  }
}

export class CodexManager {
  private operation: CodexManagementOperation = "idle";
  private turnStartsInFlight = 0;
  private forceRestartPromise?: Promise<void>;
  private readonly runCommand: RunCommand;

  constructor(private readonly options: CodexManagerOptions) {
    this.runCommand = options.runCommand ?? defaultRunCommand;
  }

  get maintenanceActive(): boolean {
    return (
      this.operation === "applying_proxy" ||
      this.operation === "updating" ||
      this.operation === "restarting" ||
      this.forceRestartPromise !== undefined
    );
  }

  assertTurnsAllowed(): void {
    if (this.maintenanceActive) {
      throw new CodexManagementError("busy", "Codex maintenance is in progress");
    }
  }

  beginTurn(): () => void {
    this.assertTurnsAllowed();
    this.turnStartsInFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.turnStartsInFlight -= 1;
    };
  }

  async status(diagnostics?: Diagnostics): Promise<CodexManagementStatus> {
    const supported = this.options.transport === "daemon";
    const [proxy, daemon] = await Promise.all([
      readProxyStatus(this.options.proxyEnvFile),
      supported ? this.readDaemonVersion() : Promise.resolve(null),
    ]);
    const unavailableReason = !supported
      ? "Управление доступно только при daemon-режиме Codex"
      : daemon
        ? null
        : "Codex CLI или daemon недоступны. Установите Codex, выполните вход и запустите codexnest repair.";
    const latestVersion = diagnostics?.latestVersion ?? null;
    const cliVersion = daemon?.cliVersion ?? null;
    return {
      supported,
      unavailableReason,
      operation: this.forceRestartPromise ? "restarting" : this.operation,
      activeTurnCount: this.options.activeTurnCount(),
      daemonStatus: daemon?.status ?? (supported ? "unavailable" : "unsupported"),
      cliVersion,
      appServerVersion: daemon?.appServerVersion ?? null,
      latestVersion,
      updateAvailable:
        latestVersion && cliVersion ? compareVersions(latestVersion, cliVersion) > 0 : null,
      networkStatus: diagnostics?.networkStatus ?? "unknown",
      networkMessage: diagnostics?.networkMessage ?? null,
      proxy,
    };
  }

  async check(): Promise<CodexManagementStatus> {
    this.assertSupported();
    const diagnostics = await this.runExclusive("checking", async () =>
      this.runDoctor(this.options.proxyEnvFile),
    );
    return this.status(diagnostics);
  }

  async applyProxy(input: string): Promise<CodexManagementStatus> {
    this.assertSupported();
    const proxy = parseProxy(input);
    const diagnostics = await this.runMaintenance("applying_proxy", async () => {
      const candidate = await this.writeCandidate(renderProxyEnvironment(proxy.url));
      let checked: Diagnostics;
      try {
        checked = await this.runDoctor(candidate);
      } finally {
        await rm(candidate, { force: true });
      }

      const nextContent = renderProxyEnvironment(proxy.url);
      const previousContent = await readOptionalFile(this.options.proxyEnvFile);
      if (previousContent === nextContent) {
        await writeAtomicPrivateFile(this.options.proxyEnvFile, nextContent);
        return checked;
      }

      await writeAtomicPrivateFile(this.options.proxyEnvFile, nextContent);
      try {
        await this.restartDaemonAndWait();
      } catch (error) {
        if (previousContent === null) {
          await rm(this.options.proxyEnvFile, { force: true });
        } else {
          await writeAtomicPrivateFile(this.options.proxyEnvFile, previousContent);
        }
        await this.restartDaemonAndWait().catch(() => undefined);
        throw error;
      }
      return checked;
    });
    return this.status(diagnostics);
  }

  async update(): Promise<CodexManagementStatus> {
    this.assertSupported();
    const diagnostics = await this.runMaintenance("updating", async () => {
      await this.runManaged(["update"], 300_000);
      const checked = await this.runDoctor(this.options.proxyEnvFile);
      await this.restartDaemonAndWait();
      return checked;
    });
    return this.status(diagnostics);
  }

  async restart(): Promise<CodexManagementStatus> {
    this.assertSupported();
    await this.runMaintenance("restarting", async () => this.restartDaemonAndWait());
    return this.status();
  }

  async forceRestart(): Promise<CodexManagementStatus> {
    this.assertSupported();
    if (!this.forceRestartPromise) {
      const tracked = this.restartDaemonAndWait().finally(() => {
        if (this.forceRestartPromise === tracked) this.forceRestartPromise = undefined;
      });
      this.forceRestartPromise = tracked;
    }
    await this.forceRestartPromise;
    return this.status();
  }

  private assertSupported(): void {
    if (this.options.transport !== "daemon") {
      throw new CodexManagementError(
        "unsupported",
        "Codex management is available only in daemon mode",
      );
    }
  }

  private async runExclusive<T>(operation: CodexManagementOperation, task: () => Promise<T>) {
    if (this.operation !== "idle" || this.forceRestartPromise) {
      throw new CodexManagementError("busy", "Another Codex management operation is in progress");
    }
    this.operation = operation;
    try {
      return await task();
    } finally {
      this.operation = "idle";
    }
  }

  private runMaintenance<T>(operation: CodexManagementOperation, task: () => Promise<T>) {
    if (this.options.activeTurnCount() + this.turnStartsInFlight > 0) {
      throw new CodexManagementError(
        "active_turns",
        "Wait for active Codex turns to finish before maintenance",
      );
    }
    return this.runExclusive(operation, task);
  }

  private async readDaemonVersion(): Promise<DaemonVersion | null> {
    try {
      const { stdout } = await this.runCommand(
        this.options.codexBin,
        ["app-server", "daemon", "version"],
        { timeout: 10_000 },
      );
      const value = JSON.parse(stdout) as DaemonVersion;
      return typeof value === "object" && value !== null ? value : null;
    } catch {
      return null;
    }
  }

  private async runDoctor(proxyEnvFile: string): Promise<Diagnostics> {
    const { stdout } = await this.runManaged(
      ["--strict-config", "doctor", "--json"],
      60_000,
      proxyEnvFile,
    );
    let report: DoctorReport;
    try {
      report = JSON.parse(stdout) as DoctorReport;
    } catch {
      throw new CodexManagementError("failed", "Codex doctor returned invalid JSON");
    }
    const websocket = report.checks?.["network.websocket_reachability"];
    const handshake = websocket?.details?.["handshake result"];
    if (websocket?.status !== "ok" || !handshake?.includes("101")) {
      throw new CodexManagementError(
        "failed",
        websocket?.summary || "Codex WebSocket check through the proxy failed",
      );
    }
    const latest = report.checks?.["updates.status"]?.details?.["latest version"];
    return {
      latestVersion: typeof latest === "string" ? latest : null,
      networkStatus: "ok",
      networkMessage: websocket.summary ?? "Responses WebSocket handshake succeeded",
    };
  }

  private async runManaged(args: string[], timeout: number, proxyEnvFile?: string) {
    try {
      return await this.runCommand(this.options.managementBin, args, {
        timeout,
        env: cleanProxyEnvironment(proxyEnvFile ?? this.options.proxyEnvFile),
      });
    } catch (error) {
      if (error instanceof CodexManagementError) throw error;
      throw new CodexManagementError("failed", "Codex command failed");
    }
  }

  private async restartDaemonAndWait(): Promise<void> {
    await this.runManaged(["app-server", "daemon", "restart"], 60_000);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const version = await this.readDaemonVersion();
      if (
        version?.status === "running" &&
        version.cliVersion &&
        version.cliVersion === version.appServerVersion &&
        this.options.bridgeState() === "ready" &&
        this.options.bridgeVersion() === version.appServerVersion
      ) {
        return;
      }
      await delay(250);
    }
    throw new CodexManagementError("failed", "Codex daemon did not become ready after restart");
  }

  private async writeCandidate(content: string): Promise<string> {
    const directory = dirname(this.options.proxyEnvFile);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(
      directory,
      `.${basename(this.options.proxyEnvFile)}.${randomUUID()}.candidate`,
    );
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return path;
  }
}

type DoctorReport = {
  checks?: Record<
    string,
    {
      status?: string;
      summary?: string;
      details?: Record<string, string>;
    }
  >;
};

export function parseProxy(input: string): ParsedProxy {
  const value = input.trim();
  if (!value || /[\s\0]/.test(value)) {
    throw new CodexManagementError("validation", "Proxy must not be empty or contain whitespace");
  }
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) return parseProxyUrl(value);

  const colonParts = value.split(":");
  if (!value.startsWith("[") && colonParts.length >= 4 && /^\d+$/.test(colonParts[1]!)) {
    const [host, portValue, username, ...password] = colonParts;
    return normalizedProxy("http", host!, parsePort(portValue!), username!, password.join(":"));
  }

  const at = value.lastIndexOf("@");
  if (at >= 0) {
    const credentials = value.slice(0, at);
    const separator = credentials.indexOf(":");
    if (separator <= 0) {
      throw new CodexManagementError("validation", "Proxy credentials must be user:password");
    }
    const endpoint = parseHostPort(value.slice(at + 1));
    return normalizedProxy(
      "http",
      endpoint.host,
      endpoint.port,
      credentials.slice(0, separator),
      credentials.slice(separator + 1),
    );
  }

  const endpoint = parseHostPort(value);
  return normalizedProxy("http", endpoint.host, endpoint.port, "", "");
}

function parseProxyUrl(value: string): ParsedProxy {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CodexManagementError("validation", "Proxy URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CodexManagementError("validation", "Only HTTP and HTTPS proxies are supported");
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new CodexManagementError("validation", "Proxy URL must not contain a path or query");
  }
  const protocol = url.protocol.slice(0, -1) as "http" | "https";
  return normalizedProxy(
    protocol,
    url.hostname,
    url.port ? parsePort(url.port) : protocol === "https" ? 443 : 80,
    decodeUrlPart(url.username),
    decodeUrlPart(url.password),
  );
}

function normalizedProxy(
  protocol: "http" | "https",
  host: string,
  port: number,
  username: string,
  password: string,
): ParsedProxy {
  const normalizedHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!normalizedHost || /[\s/@]/.test(normalizedHost)) {
    throw new CodexManagementError("validation", "Proxy host is invalid");
  }
  if (!username && password) {
    throw new CodexManagementError("validation", "Proxy password requires a username");
  }
  const authorityHost = normalizedHost.includes(":") ? `[${normalizedHost}]` : normalizedHost;
  const credentials = username
    ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
    : "";
  return {
    protocol,
    host: normalizedHost,
    port,
    username,
    password,
    url: `${protocol}://${credentials}${authorityHost}:${port}`,
  };
}

function parseHostPort(value: string): { host: string; port: number } {
  const bracketed = /^\[([^\]]+)]:(\d+)$/.exec(value);
  if (bracketed) return { host: bracketed[1]!, port: parsePort(bracketed[2]!) };
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || value.slice(0, separator).includes(":")) {
    throw new CodexManagementError(
      "validation",
      "Proxy must contain host and port; wrap IPv6 hosts in brackets",
    );
  }
  return { host: value.slice(0, separator), port: parsePort(value.slice(separator + 1)) };
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new CodexManagementError("validation", "Proxy port must be a number");
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new CodexManagementError("validation", "Proxy port must be from 1 to 65535");
  }
  return port;
}

function decodeUrlPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new CodexManagementError("validation", "Proxy credentials contain invalid escaping");
  }
}

export function renderProxyEnvironment(proxyUrl: string): string {
  const lines = [
    ...PROXY_VARIABLES.map((name) => `${name}=${shellQuote(proxyUrl)}`),
    `NO_PROXY=${shellQuote(NO_PROXY)}`,
    `no_proxy=${shellQuote(NO_PROXY)}`,
  ];
  return `${lines.join("\n")}\n`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function readProxyStatus(path: string): Promise<CodexProxyStatus> {
  const empty: CodexProxyStatus = {
    configured: false,
    protocol: null,
    host: null,
    port: null,
    username: null,
    hasPassword: false,
    error: null,
  };
  try {
    const proxy = await readProxyFile(path);
    if (!proxy) return empty;
    return {
      configured: true,
      protocol: proxy.protocol,
      host: proxy.host,
      port: proxy.port,
      username: proxy.username || null,
      hasPassword: Boolean(proxy.password),
      error: null,
    };
  } catch (error) {
    if (error instanceof ProxyFileError && error.kind === "permissions") {
      return { ...empty, error: "Файл прокси доступен группе или другим пользователям" };
    }
    if (error instanceof ProxyFileError && error.kind === "read") {
      return { ...empty, error: "Не удалось прочитать конфигурацию прокси" };
    }
    return { ...empty, error: "Конфигурация прокси повреждена или противоречива" };
  }
}

export async function readProxyUrl(path: string): Promise<string | null> {
  return (await readProxyFile(path))?.url ?? null;
}

class ProxyFileError extends Error {
  constructor(public readonly kind: "permissions" | "read" | "invalid") {
    super(`Proxy configuration ${kind}`);
    this.name = "ProxyFileError";
  }
}

async function readProxyFile(path: string): Promise<ParsedProxy | null> {
  let content: string;
  try {
    const metadata = await stat(path);
    if ((metadata.mode & 0o077) !== 0) throw new ProxyFileError("permissions");
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    if (error instanceof ProxyFileError) throw error;
    throw new ProxyFileError("read");
  }
  try {
    const values = parseEnvironmentFile(content);
    const proxyUrl = values.get("HTTPS_PROXY");
    if (!proxyUrl) throw new Error("missing proxy");
    for (const name of PROXY_VARIABLES) {
      if (values.get(name) !== proxyUrl) throw new Error("inconsistent proxy");
    }
    if (values.get("NO_PROXY") !== values.get("no_proxy")) throw new Error("inconsistent bypass");
    return parseProxyUrl(proxyUrl);
  } catch {
    throw new ProxyFileError("invalid");
  }
}

function parseEnvironmentFile(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z\d_]*)=(.*)$/.exec(line);
    if (!match) throw new Error("invalid environment line");
    values.set(match[1]!, unquoteShellValue(match[2]!));
  }
  return values;
}

function unquoteShellValue(value: string): string {
  if (!value.startsWith("'")) return value;
  if (!value.endsWith("'")) throw new Error("invalid shell quoting");
  return value.slice(1, -1).replaceAll(`'\\''`, "'");
}

function cleanProxyEnvironment(proxyEnvFile: string): NodeJS.ProcessEnv {
  const env = childProcessEnvironment({
    CODEXNEST_CODEX_PROXY_ENV_FILE: proxyEnvFile,
  });
  for (const name of [...PROXY_VARIABLES, "NO_PROXY", "no_proxy"]) delete env[name];
  return env;
}

async function writeAtomicPrivateFile(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
    const target = await open(path, "r+");
    try {
      await target.chmod(0o600);
      await target.sync();
    } finally {
      await target.close();
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
}

async function defaultRunCommand(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeout: number },
): Promise<CommandResult> {
  const result = await execFileAsync(command, args, {
    env: options.env,
    timeout: options.timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.split(/[.-]/).map((part) => Number(part) || 0);
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
