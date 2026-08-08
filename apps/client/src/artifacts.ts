import type { TurnView } from "@codexnest/protocol";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

export type ArtifactPreviewKind = "html" | "image" | "markdown" | "pdf" | "text";

export type ArtifactDescriptor = {
  fileName: string;
  format: string;
  kind: ArtifactPreviewKind;
  maxBytes: number;
  path: string;
};

export type SessionArtifact = {
  path: string;
  fileName: string;
  relativePath: string;
  format: string;
  linkedAt: number;
  preview: ArtifactDescriptor | null;
};

const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;
const IMAGE_PREVIEW_LIMIT = 25 * 1024 * 1024;
const PDF_PREVIEW_LIMIT = 50 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set(["avif", "gif", "jpeg", "jpg", "png", "webp"]);
const TEXT_EXTENSIONS = new Set(["csv", "json", "log", "text", "txt", "yaml", "yml"]);
const markdownParser = unified().use(remarkParse).use(remarkGfm);

export function artifactDescriptor(path: string): ArtifactDescriptor | null {
  const fileName = path.split("/").at(-1) || path;
  const extension = fileName.includes(".") ? fileName.split(".").at(-1)?.toLowerCase() : undefined;
  if (!extension) return null;

  if (IMAGE_EXTENSIONS.has(extension)) {
    return {
      fileName,
      format: extensionLabel(extension),
      kind: "image",
      maxBytes: IMAGE_PREVIEW_LIMIT,
      path,
    };
  }
  if (extension === "pdf") {
    return { fileName, format: "PDF", kind: "pdf", maxBytes: PDF_PREVIEW_LIMIT, path };
  }
  if (extension === "md" || extension === "markdown") {
    return { fileName, format: "Markdown", kind: "markdown", maxBytes: TEXT_PREVIEW_LIMIT, path };
  }
  if (extension === "html" || extension === "htm") {
    return { fileName, format: "HTML", kind: "html", maxBytes: TEXT_PREVIEW_LIMIT, path };
  }
  if (TEXT_EXTENSIONS.has(extension)) {
    return {
      fileName,
      format: extension.toUpperCase(),
      kind: "text",
      maxBytes: TEXT_PREVIEW_LIMIT,
      path,
    };
  }
  return null;
}

export function localDownloadPath(href: string | undefined, cwd: string): string | null {
  if (!href?.startsWith("/")) return null;
  let path: string;
  try {
    path = decodeURI(href);
  } catch {
    return null;
  }
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return null;
  const root = cwd.replace(/\/+$/, "") || "/";
  if (root === "/" || path === root || path.startsWith(`${root}/`)) return path;
  return null;
}

export function collectSessionArtifacts(turns: TurnView[], cwd: string): SessionArtifact[] {
  const artifacts = new Map<string, SessionArtifact>();
  const root = cwd.replace(/\/+$/, "") || "/";

  for (const turn of turns) {
    for (const item of turn.items) {
      if (!isAgentMarkdown(item)) continue;
      const linkedAt = item.timestamp ?? turn.completedAt ?? turn.startedAt ?? 0;

      for (const href of markdownLinks(item.text)) {
        const path = localDownloadPath(href, cwd);
        if (!path) continue;
        const existing = artifacts.get(path);
        if (existing && existing.linkedAt >= linkedAt) continue;

        const fileName = path.split("/").at(-1) ?? "";
        const preview = artifactDescriptor(path);
        artifacts.set(path, {
          path,
          fileName,
          relativePath:
            root === "/" ? path.slice(1) : path === root ? "" : path.slice(root.length + 1),
          format: preview?.format ?? downloadFormat(fileName),
          linkedAt,
          preview,
        });
      }
    }
  }

  return [...artifacts.values()].sort((left, right) => {
    if (left.linkedAt !== right.linkedAt) return right.linkedAt - left.linkedAt;
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });
}

function isAgentMarkdown(item: TurnView["items"][number]): item is TurnView["items"][number] & {
  type: "agentMessage" | "reasoning" | "plan";
  text: string;
  timestamp: number | null;
} {
  return item.type === "agentMessage" || item.type === "reasoning" || item.type === "plan";
}

function markdownLinks(markdown: string): string[] {
  const links: string[] = [];

  function walk(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const markdownNode = node as { type?: unknown; url?: unknown; children?: unknown };
    if (markdownNode.type === "link" && typeof markdownNode.url === "string") {
      links.push(markdownNode.url);
    }
    if (Array.isArray(markdownNode.children)) {
      for (const child of markdownNode.children) walk(child);
    }
  }

  walk(markdownParser.parse(markdown));
  return links;
}

function downloadFormat(fileName: string): string {
  const extensionAt = fileName.lastIndexOf(".");
  return extensionAt >= 0 && extensionAt < fileName.length - 1
    ? fileName.slice(extensionAt + 1).toUpperCase()
    : "FILE";
}

function extensionLabel(extension: string): string {
  if (extension === "jpg" || extension === "jpeg") return "JPEG";
  return extension.toUpperCase();
}

export function formatArtifactSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function safeArtifactHtml(source: string): string {
  const document = new DOMParser().parseFromString(source, "text/html");
  document
    .querySelectorAll("script, iframe, frame, object, embed, form, base, meta[http-equiv]")
    .forEach((element) => element.remove());

  for (const element of document.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (
        ["action", "formaction", "href", "poster", "src", "srcset", "xlink:href"].includes(name) &&
        !safeEmbeddedUrl(value)
      ) {
        element.removeAttribute(attribute.name);
      }
    }
    if (element instanceof HTMLAnchorElement) {
      element.target = "_blank";
      element.rel = "noopener noreferrer";
    }
  }

  const policy = document.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content =
    "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; media-src data: blob:; frame-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'";
  document.head.prepend(policy);
  return `<!doctype html>\n${document.documentElement.outerHTML}`;
}

function safeEmbeddedUrl(value: string): boolean {
  if (!value || value.startsWith("#")) return true;
  return /^(?:data|blob):/i.test(value);
}
