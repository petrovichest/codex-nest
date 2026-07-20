import { readFile, rm, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const serverDirectory = resolve(scriptDirectory, "..");
const versionPath = resolve(serverDirectory, "src/codex/PROTOCOL_VERSION");
const outputDirectory = resolve(serverDirectory, "src/codex/generated");
const expected = (await readFile(versionPath, "utf8")).trim();

const run = (args) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(process.env.CODEXNEST_CODEX_BIN ?? "codex", args, {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise(stdout.trim());
      else reject(new Error(`codex exited with code ${code}`));
    });
  });

const versionOutput = await run(["--version"]);
const installed = versionOutput.match(/([0-9]+\.[0-9]+\.[0-9]+)/)?.[1];
if (installed !== expected) {
  throw new Error(`Expected Codex CLI ${expected}, found ${installed ?? versionOutput}`);
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await run(["app-server", "generate-ts", "--experimental", "--out", outputDirectory]);
process.stdout.write(`Generated app-server protocol ${expected} in ${outputDirectory}\n`);
