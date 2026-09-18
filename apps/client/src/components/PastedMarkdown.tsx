import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Root, RootContent, Text, Emphasis } from "mdast";
import type { InlinePaste } from "@codexnest/protocol";
import { useI18n } from "../i18n";

/** Highlight source ranges after Markdown parsing, so formatting and links stay intact. */
export function pastedRangesPlugin(ranges: InlinePaste[], source: string, title: string) {
  return () => (tree: Root) => {
    function visit(parent: { children: RootContent[] }) {
      parent.children = parent.children.flatMap((node): RootContent[] => {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start === undefined || end === undefined) return [node];
        const overlaps = ranges.filter((range) => range.start < end && range.end > start);
        if (!overlaps.length) return [node];
        if (node.type === "inlineCode" || node.type === "code") {
          const raw = source.slice(start, end);
          const offsets: number[] = [];
          if (node.type === "inlineCode") {
            const fence = raw.match(/^`+/)?.[0].length ?? 1;
            let content = raw.slice(fence, -fence).replace(/\r\n|[\r\n]/g, " ");
            const padding =
              content.startsWith(" ") && content.endsWith(" ") && /[^ ]/.test(content) ? 1 : 0;
            content = padding ? content.slice(1, -1) : content;
            if (content !== node.value) return [node];
            for (let i = fence + padding; offsets.length < node.value.length; i++) {
              offsets.push(start + i);
              if (raw[i] === "\r" && raw[i + 1] === "\n") i++;
            }
          } else {
            let cursor = /^ {0,3}(?:`{3,}|~{3,})/.test(raw) ? raw.indexOf("\n") + 1 : 0;
            for (const line of node.value.split("\n")) {
              const found = raw.indexOf(line, cursor);
              if (found < 0) return [node];
              for (let i = 0; i < line.length; i++) offsets.push(start + found + i);
              offsets.push(start + found + line.length);
              cursor = raw.indexOf("\n", found + line.length) + 1;
            }
          }
          const code: Emphasis = {
            type: "emphasis",
            children: highlightedText(node.value, offsets, overlaps, title),
            data: {
              hName: "code",
              ...(node.type === "code" && node.lang
                ? { hProperties: { className: [`language-${node.lang}`] } }
                : {}),
            },
          };
          if (node.type === "inlineCode") return [code];
          code.children.push({ type: "text", value: "\n" });
          return [{ type: "paragraph", children: [code], data: { hName: "pre" } }];
        } else if (node.type === "text") {
          const offsets = textOffsets(source.slice(start, end), node.value, start);
          return offsets ? highlightedText(node.value, offsets, overlaps, title) : [node];
        } else if ("children" in node) visit(node as { children: RootContent[] });
        return [node];
      });
    }
    visit(tree);
  };
}

function highlightedText(
  value: string,
  offsets: number[],
  ranges: InlinePaste[],
  title: string,
): Array<Text | Emphasis> {
  const result: Array<Text | Emphasis> = [];
  let cursor = 0;
  while (cursor < value.length) {
    const range = ranges.find(
      (range) => offsets[cursor]! >= range.start && offsets[cursor]! < range.end,
    );
    let next = cursor + 1;
    while (
      next < value.length &&
      ranges.find(
        (candidate) => offsets[next]! >= candidate.start && offsets[next]! < candidate.end,
      ) === range
    )
      next++;
    const text: Text = { type: "text", value: value.slice(cursor, next) };
    result.push(
      range
        ? {
            type: "emphasis",
            children: [text],
            data: {
              hName: "mark",
              hProperties: { className: ["paste-inline"], title, "data-paste-id": range.id },
            },
          }
        : text,
    );
    cursor = next;
  }
  return result;
}

function textOffsets(source: string, value: string, start: number): number[] | null {
  const offsets: number[] = [];
  let decoded = "";
  for (let i = 0; i < source.length;) {
    let part = source[i]!;
    let length = 1;
    if (part === "\\" && source[i + 1] && /[!-/:-@[-`{-~]/.test(source[i + 1]!)) {
      part = source[i + 1]!;
      length = 2;
    } else if (part === "&") {
      const entity = source.slice(i).match(/^&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][a-zA-Z\d]+);/);
      if (entity && typeof document !== "undefined") {
        const field = document.createElement("textarea");
        field.innerHTML = entity[0];
        part = field.value;
        length = entity[0].length;
      }
    }
    decoded += part;
    for (let index = 0; index < part.length; index++) offsets.push(start + i);
    i += length;
  }
  return decoded === value ? offsets : null;
}

const previewComponents: Components = {
  table: ({ children }) => (
    <div className="markdown-table-scroll">
      <table>{children}</table>
    </div>
  ),
  // Clipboard content never initiates remote image requests.
  img: ({ alt }) => <span>{alt}</span>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
};

export const PastedMarkdown = memo(function PastedMarkdown({
  text,
  inlinePastes,
  components,
}: {
  text: string;
  inlinePastes?: InlinePaste[];
  components?: Components;
}) {
  const { t } = useI18n();
  const plugins = useMemo(
    () => [remarkGfm, pastedRangesPlugin(inlinePastes ?? [], text, t("Вставленный текст"))],
    [inlinePastes, text, t],
  );
  return (
    <ReactMarkdown remarkPlugins={plugins} components={components ?? previewComponents}>
      {text}
    </ReactMarkdown>
  );
});
