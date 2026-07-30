import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CodexManagementError,
  CodexManager,
  parseProxy,
  renderProxyEnvironment,
} from "./codex-management";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("parseProxy", () => {
  it.each([
    ["proxy.example:8000", "http://proxy.example:8000"],
    ["proxy.example:8000:user:pass", "http://user:pass@proxy.example:8000"],
    ["user:pass@proxy.example:8000", "http://user:pass@proxy.example:8000"],
    ["https://user:pass@proxy.example:8443", "https://user:pass@proxy.example:8443"],
    ["http://proxy.example", "http://proxy.example:80"],
    ["https://proxy.example", "https://proxy.example:443"],
    ["[2001:db8::1]:3128", "http://[2001:db8::1]:3128"],
  ])("normalizes %s", (input, expected) => {
    expect(parseProxy(input).url).toBe(expected);
  });

  it("encodes raw credentials and keeps colons inside a four-part password", () => {
    expect(parseProxy("proxy.example:8000:u@ser:p:a/ss'").url).toBe(
      "http://u%40ser:p%3Aa%2Fss'@proxy.example:8000",
    );
    expect(renderProxyEnvironment(parseProxy("proxy.example:8000:u@ser:p:a/ss'").url)).toContain(
      "'\\''",
    );
  });

  it.each([
    "",
    "proxy.example",
    "proxy.example:0",
    "proxy.example:65536",
    "socks5://proxy.example:1080",
    "2001:db8::1:3128",
    "http://proxy.example:8000/path",
    "proxy.example:8000 user pass",
  ])("rejects unsupported or ambiguous input %s", (input) => {
    expect(() => parseProxy(input)).toThrow(CodexManagementError);
  });
});

describe("CodexManager", () => {
  it("checks a candidate, writes a private env file, restarts, and never exposes the password", async () => {
    const directory = await temporaryDirectory();
    const proxyEnvFile = join(directory, "app-server.env");
    const runCommand = vi.fn(async (_command, args, options) => {
      if (args.includes("doctor")) {
        const candidate = options.env?.CODEXNEST_CODEX_PROXY_ENV_FILE;
        expect(candidate).not.toBe(proxyEnvFile);
        expect(candidate && (await readFile(candidate, "utf8"))).toContain(
          "http://user:secret@proxy.example:8000",
        );
        expect(options.env?.HTTPS_PROXY).toBeUndefined();
        return { stdout: doctorReport("0.145.0"), stderr: "" };
      }
      if (args.join(" ") === "app-server daemon restart") return { stdout: "", stderr: "" };
      if (args.join(" ") === "app-server daemon version") {
        return { stdout: daemonVersion("0.144.6"), stderr: "" };
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });
    const manager = createManager(proxyEnvFile, runCommand);

    const status = await manager.applyProxy("proxy.example:8000:user:secret");

    expect((await stat(proxyEnvFile)).mode & 0o777).toBe(0o600);
    expect(status.proxy).toEqual({
      configured: true,
      protocol: "http",
      host: "proxy.example",
      port: 8000,
      username: "user",
      hasPassword: true,
      error: null,
    });
    expect(JSON.stringify(status)).not.toContain("secret");
    expect(status.latestVersion).toBe("0.145.0");
    expect(status.updateAvailable).toBe(true);
  });

  it("restores the previous proxy if the daemon cannot restart", async () => {
    const directory = await temporaryDirectory();
    const proxyEnvFile = join(directory, "app-server.env");
    const previous = renderProxyEnvironment("http://old:password@old.example:7000");
    await writeFile(proxyEnvFile, previous, { mode: 0o600 });
    let restarts = 0;
    const runCommand = vi.fn(async (_command, args) => {
      if (args.includes("doctor")) return { stdout: doctorReport("0.144.6"), stderr: "" };
      if (args.join(" ") === "app-server daemon restart") {
        restarts += 1;
        if (restarts === 1) throw new Error("restart failed");
        return { stdout: "", stderr: "" };
      }
      if (args.join(" ") === "app-server daemon version") {
        return { stdout: daemonVersion("0.144.6"), stderr: "" };
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });
    const manager = createManager(proxyEnvFile, runCommand);

    await expect(manager.applyProxy("new.example:8000:new:newpass")).rejects.toThrow(
      "Codex command failed",
    );

    expect(await readFile(proxyEnvFile, "utf8")).toBe(previous);
    expect(restarts).toBe(2);
  });

  it("does not replace the current proxy when candidate diagnostics fail", async () => {
    const directory = await temporaryDirectory();
    const proxyEnvFile = join(directory, "app-server.env");
    const previous = renderProxyEnvironment("http://old:password@old.example:7000");
    await writeFile(proxyEnvFile, previous, { mode: 0o600 });
    const runCommand = vi.fn(async (_command, args) => {
      if (args.includes("doctor")) throw new Error("proxy refused connection");
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });
    const manager = createManager(proxyEnvFile, runCommand);

    await expect(manager.applyProxy("new.example:8000:new:newpass")).rejects.toThrow(
      "Codex command failed",
    );

    expect(await readFile(proxyEnvFile, "utf8")).toBe(previous);
    expect(runCommand.mock.calls.some(([, args]) => args.join(" ").includes("restart"))).toBe(
      false,
    );
  });

  it("updates through the wrapper, validates the new binary, and only then restarts", async () => {
    const directory = await temporaryDirectory();
    const proxyEnvFile = join(directory, "app-server.env");
    await writeFile(proxyEnvFile, renderProxyEnvironment("http://proxy.example:8000"), {
      mode: 0o600,
    });
    const commands: string[] = [];
    const runCommand = vi.fn(async (_command, args) => {
      const command = args.join(" ");
      commands.push(command);
      if (command === "update" || command === "app-server daemon restart") {
        return { stdout: "", stderr: "" };
      }
      if (args.includes("doctor")) return { stdout: doctorReport("0.145.0"), stderr: "" };
      if (command === "app-server daemon version") {
        return { stdout: daemonVersion("0.145.0"), stderr: "" };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const manager = createManager(
      proxyEnvFile,
      runCommand,
      () => 0,
      () => "0.145.0",
    );

    const status = await manager.update();

    expect(commands.indexOf("update")).toBeLessThan(
      commands.indexOf("--strict-config doctor --json"),
    );
    expect(commands.indexOf("--strict-config doctor --json")).toBeLessThan(
      commands.indexOf("app-server daemon restart"),
    );
    expect(status.cliVersion).toBe("0.145.0");
    expect(status.appServerVersion).toBe("0.145.0");
    expect(status.updateAvailable).toBe(false);
  });

  it("blocks disruptive maintenance while turns are active and serializes checks", async () => {
    const directory = await temporaryDirectory();
    const proxyEnvFile = join(directory, "app-server.env");
    await writeFile(proxyEnvFile, renderProxyEnvironment("http://proxy.example:8000"), {
      mode: 0o600,
    });
    let activeTurns = 1;
    let releaseDoctor: (() => void) | undefined;
    const doctorWaiting = new Promise<void>((resolve) => {
      releaseDoctor = resolve;
    });
    const runCommand = vi.fn(async (_command, args) => {
      if (args.includes("doctor")) {
        await doctorWaiting;
        return { stdout: doctorReport("0.144.6"), stderr: "" };
      }
      if (args.join(" ") === "app-server daemon version") {
        return { stdout: daemonVersion("0.144.6"), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const manager = createManager(proxyEnvFile, runCommand, () => activeTurns);

    await expect(manager.restart()).rejects.toMatchObject({ kind: "active_turns" });
    activeTurns = 0;
    const finishStartingTurn = manager.beginTurn();
    await expect(manager.restart()).rejects.toMatchObject({ kind: "active_turns" });
    finishStartingTurn();
    const check = manager.check();
    await expect(manager.restart()).rejects.toMatchObject({ kind: "busy" });
    releaseDoctor!();
    await check;
  });

  it("coalesces force restarts while active turns and regular management are running", async () => {
    const directory = await temporaryDirectory();
    const proxyEnvFile = join(directory, "app-server.env");
    await writeFile(proxyEnvFile, renderProxyEnvironment("http://proxy.example:8000"), {
      mode: 0o600,
    });
    let releaseDoctor: (() => void) | undefined;
    const doctorWaiting = new Promise<void>((resolve) => {
      releaseDoctor = resolve;
    });
    let releaseRestart: (() => void) | undefined;
    const restartWaiting = new Promise<void>((resolve) => {
      releaseRestart = resolve;
    });
    let restartCount = 0;
    const runCommand = vi.fn(async (_command, args) => {
      const command = args.join(" ");
      if (args.includes("doctor")) {
        await doctorWaiting;
        return { stdout: doctorReport("0.144.6"), stderr: "" };
      }
      if (command === "app-server daemon restart") {
        restartCount += 1;
        await restartWaiting;
        return { stdout: "", stderr: "" };
      }
      if (command === "app-server daemon version") {
        return { stdout: daemonVersion("0.144.6"), stderr: "" };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const manager = createManager(proxyEnvFile, runCommand, () => 2);

    const check = manager.check();
    await vi.waitFor(() => expect(manager.maintenanceActive).toBe(false));
    const first = manager.forceRestart();
    const second = manager.forceRestart();
    expect(manager.maintenanceActive).toBe(true);
    await expect(manager.status()).resolves.toMatchObject({ operation: "restarting" });
    releaseRestart!();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(restartCount).toBe(1);
    releaseDoctor!();
    await check;
  });
});

function createManager(
  proxyEnvFile: string,
  runCommand: NonNullable<ConstructorParameters<typeof CodexManager>[0]["runCommand"]>,
  activeTurnCount = () => 0,
  bridgeVersion = () => "0.144.6",
) {
  return new CodexManager({
    codexBin: "/fake/codex",
    managementBin: "/fake/codex-proxied",
    proxyEnvFile,
    transport: "daemon",
    activeTurnCount,
    bridgeState: () => "ready",
    bridgeVersion,
    runCommand,
  });
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-management-test-"));
  directories.push(directory);
  return directory;
}

function doctorReport(latestVersion: string): string {
  return JSON.stringify({
    checks: {
      "network.websocket_reachability": {
        status: "ok",
        summary: "Responses WebSocket handshake succeeded",
        details: { "handshake result": "HTTP 101 Switching Protocols" },
      },
      "updates.status": {
        status: "ok",
        details: { "latest version": latestVersion },
      },
    },
  });
}

function daemonVersion(version: string): string {
  return JSON.stringify({ status: "running", cliVersion: version, appServerVersion: version });
}
