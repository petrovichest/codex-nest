/** Clipboard HTML is parsed in an inert template, never attached to the document. */
export function clipboardText(clipboard: Pick<DataTransfer, "getData">): {
  text: string;
  plain: string;
} {
  const plain = clipboard.getData?.("text/plain") ?? "";
  const html = clipboard.getData?.("text/html") ?? "";
  if (!html) return { text: plain, plain };
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const node of template.content.querySelectorAll("script,style,meta,link,iframe,object,svg"))
    node.remove();
  const formatted =
    template.content.querySelector(
      "h1,h2,h3,h4,h5,h6,strong,b,em,i,s,del,a,ul,ol,table,pre,code,blockquote",
    ) ||
    Array.from(template.content.querySelectorAll<HTMLElement>("[style]")).some(
      (node) =>
        /^(bold|[6-9]00)$/.test(node.style.fontWeight) ||
        node.style.fontStyle === "italic" ||
        node.style.whiteSpace === "pre",
    );
  if (plain && !formatted) return { text: plain, plain };
  const text = htmlToMarkdown(template.content).trim();
  return { text: text || plain, plain: plain || template.content.textContent || text };
}

function escapeText(text: string): string {
  return text.replace(/([\\`*_[\]<>])/g, "\\$1");
}

function htmlToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE)
    return escapeText((node.textContent ?? "").replace(/\s+/g, " "));
  if (!(node instanceof Element)) return Array.from(node.childNodes).map(htmlToMarkdown).join("");
  const tag = node.tagName.toLowerCase();
  const inner = () => Array.from(node.childNodes).map(htmlToMarkdown).join("");
  if (tag === "br") return "\n";
  if (tag === "img") return node.getAttribute("alt") ?? "";
  if (tag === "pre" || (node as HTMLElement).style?.whiteSpace === "pre") {
    const text = node.textContent ?? "";
    const fence = "`".repeat(
      (text.match(/`+/g) ?? []).reduce((length, run) => Math.max(length, run.length + 1), 3),
    );
    return `\n\n${fence}\n${text}\n${fence}\n\n`;
  }
  if (tag === "code") {
    const text = node.textContent ?? "";
    const fence = "`".repeat(
      (text.match(/`+/g) ?? []).reduce((length, run) => Math.max(length, run.length + 1), 1),
    );
    return `${fence} ${text} ${fence}`;
  }
  if (tag === "table") {
    const rows = Array.from(node.querySelectorAll("tr")).map((row) =>
      Array.from(row.children)
        .filter((cell) => /^(TD|TH)$/.test(cell.tagName))
        .map((cell) => htmlToMarkdown(cell).trim().replace(/\|/g, "\\|").replace(/\n+/g, " ")),
    );
    const width = Math.max(0, ...rows.map((row) => row.length));
    if (!width) return inner();
    const lines = rows.map(
      (row) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`,
    );
    lines.splice(1, 0, `| ${Array(width).fill("---").join(" | ")} |`);
    return `\n\n${lines.join("\n")}\n\n`;
  }
  if (tag === "ul" || tag === "ol") {
    let number = Number(node.getAttribute("start")) || 1;
    const rows = Array.from(node.children)
      .filter((child) => child.tagName === "LI")
      .map((child) => {
        number = Number(child.getAttribute("value")) || number;
        const prefix = tag === "ol" ? `${number++}. ` : "- ";
        return (
          prefix +
          htmlToMarkdown(child)
            .trim()
            .replace(/\n/g, `\n${" ".repeat(prefix.length)}`)
        );
      });
    return `\n\n${rows.join("\n")}\n\n`;
  }
  let text = inner();
  if (/^h[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${text.trim()}\n\n`;
  if (tag === "blockquote") return `\n\n${text.trim().replace(/^/gm, "> ")}\n\n`;
  if (tag === "a") {
    const href = node.getAttribute("href") ?? "";
    if (/^(https?:|mailto:)/i.test(href)) return `[${text}](<${href.replace(/>/g, "%3E")}>)`;
  }
  const style = (node as HTMLElement).style;
  if (tag === "strong" || tag === "b" || /^(bold|[6-9]00)$/.test(style?.fontWeight ?? ""))
    text = `**${text.trim()}**`;
  if (tag === "em" || tag === "i" || style?.fontStyle === "italic") text = `*${text.trim()}*`;
  if (tag === "del" || tag === "s") text = `~~${text}~~`;
  if (/^(p|div|section|article)$/.test(tag)) return `\n\n${text.trim()}\n\n`;
  return text;
}
