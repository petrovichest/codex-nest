type ContentAction =
  | "read_page"
  | "get_page_text"
  | "find"
  | "form_input"
  | "element_rect"
  | "scroll_to"
  | "invalidate_refs";

interface ContentRequest {
  type: "codexnest.content";
  action: ContentAction;
  arguments?: Record<string, unknown>;
}

interface UploadStart {
  type: "start";
  name: string;
  mediaType: string;
  size: number;
  ref: string;
  drop: boolean;
}

interface UploadChunk {
  type: "chunk";
  data: string;
}

const refs = new Map<string, Element>();
const refPrefix = Math.random().toString(36).slice(2, 8);
let nextRef = 1;
let refGeneration = 1;

const contentApi =
  (globalThis as typeof globalThis & { browser?: ChromeApi; chrome?: ChromeApi }).browser ?? chrome;

if (window.top === window) {
  contentApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isContentRequest(message)) return;
    try {
      sendResponse({ ok: true, result: dispatch(message) });
    } catch (error) {
      sendResponse({ ok: false, error: errorMessage(error) });
    }
  });

  contentApi.runtime.onConnect.addListener((port) => {
    if (port.name !== "codexnest.upload") return;
    let start: UploadStart | null = null;
    const chunks: Uint8Array[] = [];
    let received = 0;
    port.onMessage.addListener((message) => {
      if (!isRecord(message) || typeof message.type !== "string") return;
      try {
        if (message.type === "start") {
          start = message as unknown as UploadStart;
          chunks.length = 0;
          received = 0;
          return;
        }
        if (message.type === "chunk") {
          if (!start) throw new Error("Upload did not start");
          const bytes = decodeBase64((message as unknown as UploadChunk).data);
          received += bytes.byteLength;
          if (received > start.size) throw new Error("Upload is larger than declared");
          chunks.push(bytes);
          return;
        }
        if (message.type === "end") {
          if (!start || received !== start.size) throw new Error("Upload is incomplete");
          applyUpload(start, chunks);
          port.postMessage({ ok: true });
        }
      } catch (error) {
        port.postMessage({ ok: false, error: errorMessage(error) });
      }
    });
  });
}

function dispatch(request: ContentRequest): unknown {
  const args = request.arguments ?? {};
  switch (request.action) {
    case "read_page":
      return readPage(numberArg(args, "maxChars", 30_000, 1_000, 100_000));
    case "get_page_text":
      return getPageText(numberArg(args, "maxChars", 100_000, 1_000, 500_000));
    case "find":
      return findElements(args);
    case "form_input":
      return formInput(stringArg(args, "ref"), args.value);
    case "element_rect":
      return elementRect(stringArg(args, "ref"));
    case "scroll_to":
      return scrollToElement(stringArg(args, "ref"));
    case "invalidate_refs":
      invalidateRefs();
      return { invalidated: true };
  }
}

function readPage(maxChars: number): {
  title: string;
  url: string;
  tree: string;
  truncated: boolean;
} {
  invalidateRefs();
  const lines: string[] = [];
  let length = 0;
  let truncated = false;
  const root = document.body ?? document.documentElement;

  const visit = (element: Element, depth: number) => {
    if (truncated || !isVisible(element)) return;
    const role = elementRole(element);
    const name = elementName(element);
    const interactive = isInteractive(element, role);
    const structural = role !== "generic" || depth < 2;
    if (interactive || structural || name) {
      const ref = interactive ? remember(element) : null;
      const state = elementState(element);
      const line = `${"  ".repeat(Math.min(depth, 12))}${ref ? `[${ref}] ` : ""}${role}${name ? ` "${singleLine(name, 180)}"` : ""}${state}`;
      if (length + line.length + 1 > maxChars) {
        truncated = true;
        return;
      }
      lines.push(line);
      length += line.length + 1;
    }
    for (const child of element.children) visit(child, depth + 1);
  };
  visit(root, 0);
  return { title: document.title, url: location.href, tree: lines.join("\n"), truncated };
}

function getPageText(maxChars: number): {
  title: string;
  url: string;
  text: string;
  truncated: boolean;
} {
  const source =
    document.querySelector("article, main, [role='main']") ??
    document.body ??
    document.documentElement;
  const text = singleLineBlocks(source.textContent ?? "");
  return {
    title: document.title,
    url: location.href,
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars,
  };
}

function findElements(args: Record<string, unknown>): {
  matches: Array<Record<string, unknown>>;
  truncated: boolean;
} {
  const query = stringArg(args, "query").toLocaleLowerCase();
  const selector = typeof args.selector === "string" ? args.selector : "*";
  const maxResults = numberArg(args, "maxResults", 50, 1, 200);
  let elements: Element[];
  try {
    elements = [...document.querySelectorAll(selector)];
  } catch {
    throw new Error("Invalid CSS selector");
  }
  const matches: Array<Record<string, unknown>> = [];
  for (const element of elements) {
    if (!isVisible(element)) continue;
    const haystack =
      `${elementName(element)} ${element.getAttribute("placeholder") ?? ""} ${element.getAttribute("aria-label") ?? ""}`.toLocaleLowerCase();
    if (query && !haystack.includes(query)) continue;
    matches.push({
      ref: remember(element),
      role: elementRole(element),
      name: singleLine(elementName(element), 180),
      ...rectRecord(element.getBoundingClientRect()),
    });
    if (matches.length >= maxResults) break;
  }
  return { matches, truncated: matches.length === maxResults };
}

function formInput(ref: string, value: unknown): { ref: string; value: unknown } {
  const element = requireRef(ref);
  if (element instanceof HTMLInputElement) {
    if (element.type === "checkbox" || element.type === "radio") {
      element.checked = Boolean(value);
      emitInput(element);
      return { ref, value: element.checked };
    }
    element.focus();
    setNativeValue(element, String(value ?? ""));
    emitInput(element);
    return { ref, value: element.value };
  }
  if (element instanceof HTMLTextAreaElement) {
    element.focus();
    setNativeValue(element, String(value ?? ""));
    emitInput(element);
    return { ref, value: element.value };
  }
  if (element instanceof HTMLSelectElement) {
    const requested = Array.isArray(value) ? value.map(String) : [String(value ?? "")];
    for (const option of element.options) {
      option.selected = requested.includes(option.value) || requested.includes(option.text);
    }
    emitInput(element);
    return {
      ref,
      value: element.multiple
        ? [...element.selectedOptions].map((option) => option.value)
        : element.value,
    };
  }
  if (element instanceof HTMLElement && element.isContentEditable) {
    element.focus();
    element.textContent = String(value ?? "");
    emitInput(element);
    return { ref, value: element.textContent };
  }
  throw new Error(`Element ${ref} is not an editable field`);
}

function elementRect(ref: string): Record<string, number> {
  const element = requireRef(ref);
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  return rectRecord(element.getBoundingClientRect());
}

function scrollToElement(ref: string): { ref: string; rect: Record<string, number> } {
  const element = requireRef(ref);
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  return { ref, rect: rectRecord(element.getBoundingClientRect()) };
}

function applyUpload(start: UploadStart, chunks: Uint8Array[]): void {
  const target = requireRef(start.ref);
  const file = new File(chunks as BlobPart[], start.name, { type: start.mediaType });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  if (!start.drop && target instanceof HTMLInputElement && target.type === "file") {
    target.files = transfer.files;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  target.dispatchEvent(
    new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }),
  );
  target.dispatchEvent(
    new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }),
  );
  target.dispatchEvent(
    new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
  );
}

function remember(element: Element): string {
  for (const [ref, candidate] of refs) if (candidate === element) return ref;
  const ref = `e_${refPrefix}_${refGeneration}_${nextRef++}`;
  refs.set(ref, element);
  return ref;
}

function invalidateRefs(): void {
  refs.clear();
  nextRef = 1;
  refGeneration += 1;
}

function requireRef(ref: string): Element {
  const element = refs.get(ref);
  if (!element || !element.isConnected)
    throw new Error(`Element ref ${ref} is stale; call read_page or find again`);
  return element;
}

function isVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) return true;
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0 || element === document.body;
}

function isInteractive(element: Element, role: string): boolean {
  return (
    [
      "button",
      "link",
      "textbox",
      "checkbox",
      "radio",
      "combobox",
      "listbox",
      "menuitem",
      "option",
      "slider",
      "spinbutton",
      "switch",
      "tab",
    ].includes(role) ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLElement && (element.isContentEditable || element.tabIndex >= 0))
  );
}

function elementRole(element: Element): string {
  const explicit = element.getAttribute("role");
  if (explicit) return explicit;
  const tag = element.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return `heading level=${tag[1]}`;
  const roles: Record<string, string> = {
    a: "link",
    button: "button",
    nav: "navigation",
    main: "main",
    article: "article",
    aside: "complementary",
    header: "banner",
    footer: "contentinfo",
    form: "form",
    img: "img",
    ul: "list",
    ol: "list",
    li: "listitem",
    table: "table",
    select: "combobox",
    textarea: "textbox",
    option: "option",
    dialog: "dialog",
  };
  if (tag === "input") {
    const type = (element as HTMLInputElement).type;
    if (
      type === "checkbox" ||
      type === "radio" ||
      type === "button" ||
      type === "submit" ||
      type === "range"
    ) {
      return type === "range" ? "slider" : type;
    }
    return "textbox";
  }
  return roles[tag] ?? "generic";
}

function elementName(element: Element): string {
  const explicit =
    element.getAttribute("aria-label") ??
    labelledByText(element) ??
    element.getAttribute("alt") ??
    element.getAttribute("title");
  if (explicit?.trim()) return explicit.trim();
  if (element instanceof HTMLInputElement && (element.placeholder || element.value)) {
    return (element.placeholder || element.value).trim();
  }
  return directText(element).trim();
}

function labelledByText(element: Element): string | null {
  const id = element.getAttribute("aria-labelledby");
  if (!id) return null;
  return (
    id
      .split(/\s+/)
      .map((part) => document.getElementById(part)?.textContent ?? "")
      .join(" ")
      .trim() || null
  );
}

function directText(element: Element): string {
  return [...element.childNodes]
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? "")
    .join(" ");
}

function elementState(element: Element): string {
  const states: string[] = [];
  if (element.getAttribute("aria-expanded"))
    states.push(`expanded=${element.getAttribute("aria-expanded")}`);
  if (element.getAttribute("aria-checked"))
    states.push(`checked=${element.getAttribute("aria-checked")}`);
  if (
    element instanceof HTMLInputElement &&
    (element.type === "checkbox" || element.type === "radio")
  )
    states.push(`checked=${element.checked}`);
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    if (element.disabled) states.push("disabled");
    if (element.value) states.push(`value="${singleLine(element.value, 100)}"`);
  }
  return states.length ? ` (${states.join(", ")})` : "";
}

function rectRecord(rect: DOMRect): Record<string, number> {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    centerX: rect.x + rect.width / 2,
    centerY: rect.y + rect.height / 2,
  };
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    element instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(element, value);
}

function emitInput(element: Element): void {
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function singleLine(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function singleLineBlocks(value: string): string {
  return value
    .replace(/[\t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${name} must be a non-empty string`);
  return value;
}

function numberArg(
  args: Record<string, unknown>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = args[name];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${name} must be a number`);
  return Math.max(minimum, Math.min(maximum, value));
}

function isContentRequest(value: unknown): value is ContentRequest {
  return isRecord(value) && value.type === "codexnest.content" && typeof value.action === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export {};
