import type { Definition, Nodes } from "mdast";
import { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { artifactDescriptor, localDownloadPath } from "./artifacts";

export type MessageImage = { key: string; src: string; localPath: string | null; label: string };

const parser = unified().use(remarkParse).use(remarkGfm);

export function messageImage(
  src: string | undefined,
  cwd?: string,
  explicit = false,
): MessageImage | null {
  if (!src || !defaultUrlTransform(src)) return null;
  const localPath = cwd ? localDownloadPath(src, cwd) : null;
  let fileName = localPath ?? src;
  if (/^https?:\/\//i.test(src)) {
    try {
      fileName = decodeURI(new URL(src).pathname);
    } catch {
      return null;
    }
  }
  const descriptor = artifactDescriptor(fileName);
  if (!explicit && (descriptor?.kind !== "image" || (!localPath && !/^https?:\/\//i.test(src))))
    return null;
  return {
    key: localPath ?? src,
    src,
    localPath: descriptor?.kind === "image" ? localPath : null,
    label: src.startsWith("data:") ? "" : (fileName.split("/").at(-1) ?? ""),
  };
}

function nodeText(node: Nodes): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
  return "children" in node ? node.children.map(nodeText).join("") : "";
}

export function collectMessageImages(
  text: string,
  attachments: readonly string[],
  cwd?: string,
): MessageImage[] {
  const tree = parser.parse(text);
  const definitions = new Map<string, Definition>();
  const images = new Map<string, MessageImage>();
  const walk = (node: Nodes, visit: (node: Nodes) => void) => {
    visit(node);
    if ("children" in node) node.children.forEach((child) => walk(child, visit));
  };
  walk(tree, (node) => {
    if (node.type === "definition" && !definitions.has(node.identifier))
      definitions.set(node.identifier, node);
  });
  walk(tree, (node) => {
    const explicit = node.type === "image" || node.type === "imageReference";
    const src =
      node.type === "image" || node.type === "link"
        ? node.url
        : node.type === "imageReference" || node.type === "linkReference"
          ? definitions.get(node.identifier)?.url
          : undefined;
    const image = messageImage(src, cwd, explicit);
    if (image && !images.has(image.key))
      images.set(image.key, { ...image, label: nodeText(node) || image.label });
  });
  for (const src of attachments) {
    // Attachments already passed the upload pipeline and may use data/blob URLs.
    const image = /^(data:image\/|blob:)/i.test(src)
      ? { key: src, src, localPath: null, label: "" }
      : messageImage(src, cwd, true);
    if (image && !images.has(image.key)) images.set(image.key, image);
  }
  return [...images.values()];
}
