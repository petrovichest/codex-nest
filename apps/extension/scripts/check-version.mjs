import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const extensionRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(extensionRoot, "../..");
const [rootPackage, extensionPackage, chromeManifest, firefoxManifest] = await Promise.all([
  readJson(resolve(repositoryRoot, "package.json")),
  readJson(resolve(extensionRoot, "package.json")),
  readJson(resolve(extensionRoot, "public/chrome/manifest.json")),
  readJson(resolve(extensionRoot, "public/firefox/manifest.json")),
]);

const versions = [
  rootPackage.version,
  extensionPackage.version,
  chromeManifest.version,
  firefoxManifest.version,
];
if (versions.some((version) => typeof version !== "string") || new Set(versions).size !== 1) {
  throw new Error(
    `CodexNest and extension versions must match: root=${rootPackage.version}, package=${extensionPackage.version}, chrome=${chromeManifest.version}, firefox=${firefoxManifest.version}`,
  );
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
