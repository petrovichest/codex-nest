import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ComponentProps, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Capacitor } from "@capacitor/core";
import type { MessagePresentation } from "@codexnest/protocol";
import { PasteMessageEditor } from "./PasteEditor";
import { PastedMarkdown } from "./PastedMarkdown";
import { clipboardText } from "../pasted-text";

function Harness({
  initial = { input: "" },
  ...props
}: { initial?: MessagePresentation } & Pick<
  ComponentProps<typeof PasteMessageEditor>,
  "pasteEnabled" | "readOnly" | "disabled" | "onChange"
>) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <PasteMessageEditor
        identity="test"
        aria-label="Message"
        value={value}
        onValueChange={setValue}
        {...props}
      />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </>
  );
}
function paste(text: string, html = "") {
  fireEvent.paste(screen.getByRole("textbox", { name: "Message" }), {
    clipboardData: { getData: (type: string) => (type === "text/html" ? html : text) },
  });
}
function value(): MessagePresentation {
  return JSON.parse(screen.getByTestId("value").textContent!);
}

function keyboardInput(
  text: string,
  { inputType = "insertText", beforeInput = true, isComposing = false } = {},
) {
  const field = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
  const next =
    field.value.slice(0, field.selectionStart) + text + field.value.slice(field.selectionEnd);
  if (beforeInput)
    fireEvent(
      field,
      new InputEvent("beforeinput", { bubbles: true, inputType, data: text, isComposing }),
    );
  fireEvent.input(field, { target: { value: next }, inputType, data: text, isComposing });
}

afterEach(() => vi.restoreAllMocks());

describe("paste editor", () => {
  it.each([true, false])(
    "turns Android keyboard input into one undoable block (beforeinput: %s)",
    async (beforeInput) => {
      vi.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
      const initial: MessagePresentation = {
        input: "Check abc now",
        inlinePastes: [{ id: "old", start: 6, end: 9 }],
      };
      const changed = vi.fn();
      render(
        <Harness initial={initial} onChange={(event) => changed(event.currentTarget.value)} />,
      );
      const field = screen.getByRole("textbox") as HTMLTextAreaElement;
      field.setSelectionRange(6, 9);
      keyboardInput("## Context\n" + "🚀".repeat(51), { beforeInput });
      expect(value().input).toBe(initial.input);
      expect(value().inlinePastes).toEqual(initial.inlinePastes);
      expect(value().pasteBlocks).toEqual([
        { id: expect.any(String), text: "## Context\n" + "🚀".repeat(51) },
      ]);
      expect(field).toHaveValue(initial.input);
      expect(changed).toHaveBeenLastCalledWith(initial.input);
      expect([field.selectionStart, field.selectionEnd]).toEqual([6, 6]);
      const pasted = value();
      fireEvent.keyDown(field, { key: "z", ctrlKey: true });
      expect(value()).toEqual(initial);
      await waitFor(() => expect([field.selectionStart, field.selectionEnd]).toEqual([6, 9]));
      fireEvent.keyDown(field, { key: "z", ctrlKey: true, shiftKey: true });
      expect(value()).toEqual(pasted);
      keyboardInput("second\nblock", { beforeInput });
      expect(value().pasteBlocks).toHaveLength(2);
      expect(new Set(value().pasteBlocks!.map((block) => block.id)).size).toBe(2);
    },
  );

  it.each([
    "x".repeat(51),
    "🚀".repeat(51),
    "one\ntwo",
    "one\r\ntwo",
    "one\u2028two",
    "one\u2029two",
  ])("uses the existing block threshold for an Android keyboard fragment: %s", (text) => {
    vi.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
    render(<Harness />);
    keyboardInput(text);
    expect(value().input).toBe("");
    expect(value().pasteBlocks?.map((block) => block.text)).toEqual([text.replace(/\r\n?/g, "\n")]);
  });

  it.each(["x".repeat(50), "🚀".repeat(50), "a", "\n", "\r\n"])(
    "leaves a short keyboard operation unmarked regardless of total draft length: %s",
    (text) => {
      vi.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
      const initial = "Instructions ".repeat(8);
      render(<Harness initial={{ input: initial }} />);
      const field = screen.getByRole("textbox") as HTMLTextAreaElement;
      field.setSelectionRange(initial.length, initial.length);
      keyboardInput(text);
      expect(value()).toEqual({ input: initial + text.replace(/\r\n?/g, "\n") });
    },
  );

  it.each(["insertFromPaste", "insertFromPasteAsQuotation"])(
    "recognizes explicit %s input without a ClipboardEvent on the web",
    (inputType) => {
      vi.spyOn(Capacitor, "getPlatform").mockReturnValue("web");
      render(<Harness />);
      keyboardInput("short", { inputType, beforeInput: false });
      expect(value().inlinePastes).toEqual([{ id: expect.any(String), start: 0, end: 5 }]);
      keyboardInput("long\nblock", { inputType });
      expect(value().input).toBe("short");
      expect(value().pasteBlocks?.map((block) => block.text)).toEqual(["long\nblock"]);
    },
  );

  it("preserves emoji boundaries when recovering a replacement without beforeinput", () => {
    vi.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
    render(<Harness initial={{ input: "🚀 end" }} />);
    (screen.getByRole("textbox") as HTMLTextAreaElement).setSelectionRange(0, 2);
    keyboardInput("🚁" + "a".repeat(51), { beforeInput: false });
    expect(value().input).toBe("🚀 end");
    expect(value().pasteBlocks?.[0]?.text).toBe("🚁" + "a".repeat(51));
  });

  it("does not reinterpret ordinary desktop text input as a paste", () => {
    vi.spyOn(Capacitor, "getPlatform").mockReturnValue("web");
    render(<Harness />);
    keyboardInput("long\nblock");
    expect(value()).toEqual({ input: "long\nblock" });
  });

  it.each(["insertReplacementText", "insertLineBreak", "insertCompositionText"])(
    "does not classify %s as an implicit keyboard paste",
    (inputType) => {
      vi.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
      render(<Harness />);
      keyboardInput("x".repeat(51), { inputType });
      expect(value()).toEqual({ input: "x".repeat(51) });
    },
  );

  it("keeps composing text ordinary even when insertText does not report isComposing", () => {
    vi.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
    render(<Harness />);
    const field = screen.getByRole("textbox");
    fireEvent.compositionStart(field);
    keyboardInput("x".repeat(51));
    fireEvent.compositionEnd(field);
    keyboardInput("y".repeat(51), { isComposing: true });
    expect(value()).toEqual({ input: "x".repeat(51) + "y".repeat(51) });
    keyboardInput("final\nfragment");
    expect(value().pasteBlocks).toHaveLength(1);
  });

  it.each(["pasteEnabled", "readOnly", "disabled"] as const)(
    "respects the %s editor restriction",
    (prop) => {
      vi.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
      render(<Harness {...{ [prop]: prop !== "pasteEnabled" }} />);
      keyboardInput("long\nblock");
      expect(value().pasteBlocks).toBeUndefined();
    },
  );

  it("cancels a normal Android paste and does not reuse its metadata for the next input", () => {
    vi.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
    render(<Harness />);
    const field = screen.getByRole("textbox");
    expect(
      fireEvent.paste(field, {
        clipboardData: { getData: (type: string) => (type === "text/plain" ? "long\nblock" : "") },
      }),
    ).toBe(false);
    expect(value().pasteBlocks).toHaveLength(1);
    keyboardInput("a", { beforeInput: false });
    expect(value().input).toBe("a");
    expect(value().inlinePastes).toBeUndefined();
    expect(value().pasteBlocks).toHaveLength(1);
  });

  it("keeps separate short events inline, with text and origin restored by undo/redo", () => {
    const { container } = render(<Harness />);
    const field = screen.getByRole("textbox") as HTMLTextAreaElement;
    paste("first");
    field.setSelectionRange(5, 5);
    paste("second");
    expect(value().input).toBe("firstsecond");
    expect(new Set(value().inlinePastes!.map((range) => range.id)).size).toBe(2);
    expect(container.querySelectorAll("mark")).toHaveLength(2);
    fireEvent.keyDown(field, { key: "z", ctrlKey: true });
    expect(value().input).toBe("first");
    expect(value().inlinePastes).toHaveLength(1);
    fireEvent.keyDown(field, { key: "z", ctrlKey: true, shiftKey: true });
    expect(value().input).toBe("firstsecond");
    expect(value().inlinePastes).toHaveLength(2);
  });
  it("keeps large events as individual collapsed cards and undoes removal", () => {
    render(<Harness initial={{ input: "My instructions" }} />);
    paste("## Context\n- **bold**\n- value 42");
    paste("x".repeat(51));
    expect(value().input).toBe("My instructions");
    expect(value().pasteBlocks).toHaveLength(2);
    const cards = screen.getAllByRole("button", { expanded: false });
    fireEvent.click(cards[0]!);
    expect(screen.getByRole("heading", { name: "Context" })).toBeInTheDocument();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    fireEvent.click(screen.getAllByRole("button", { name: "Удалить вставленный текст" })[0]!);
    expect(value().pasteBlocks).toHaveLength(1);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), {
      key: "z",
      ctrlKey: true,
    });
    expect(value().pasteBlocks).toHaveLength(2);
  });
  it("leaves new typed text unmarked and preserves source when editing a card", () => {
    render(
      <Harness initial={{ input: "abcdef", inlinePastes: [{ id: "event", start: 0, end: 6 }] }} />,
    );
    const field = screen.getByRole("textbox") as HTMLTextAreaElement;
    field.setSelectionRange(3, 3);
    field.dispatchEvent(
      new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "X" }),
    );
    fireEvent.change(field, { target: { value: "abcXdef" } });
    expect(value().inlinePastes).toEqual([
      { id: "event", start: 0, end: 3 },
      { id: "event", start: 4, end: 7 },
    ]);
    paste("large\nblock");
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    fireEvent.click(screen.getByRole("button", { name: "Редактировать вставленный текст" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Исходный вставленный текст" }), {
      target: { value: "short" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(value().pasteBlocks?.[0]?.text).toBe("short");
    expect(value().input).toBe("abcXdef");
  });
  it("renders inline provenance through Markdown source positions", () => {
    const text = "Typed **bold** and [link](https://example.com) &amp; end";
    const { container } = render(
      <PastedMarkdown
        text={text}
        inlinePastes={[
          { id: "one", start: 6, end: 14 },
          { id: "two", start: 18, end: 44 },
          { id: "three", start: text.indexOf("&amp;"), end: text.indexOf("&amp;") + 5 },
        ]}
      />,
    );
    expect(container.querySelector("strong mark")?.textContent).toBe("bold");
    expect(container.querySelector("a mark")?.textContent).toBe("link");
    expect(
      Array.from(container.querySelectorAll("mark")).map((mark) => mark.textContent),
    ).toContain("&");
    expect(container.textContent).toBe("Typed bold and link & end");
  });
  it("marks only the pasted characters inside inline and fenced code", () => {
    const text = "Typed `prePOST` and\n\n```js\nconst value = POST;\n```";
    const inlinePastes = [text.indexOf("POST"), text.lastIndexOf("POST")].map((start, i) => ({
      id: String(i),
      start,
      end: start + 4,
    }));
    const { container } = render(<PastedMarkdown text={text} inlinePastes={inlinePastes} />);
    expect(
      Array.from(container.querySelectorAll("code mark")).map((mark) => mark.textContent),
    ).toEqual(["POST", "POST"]);
    expect(container.querySelector("pre code")?.textContent).toBe("const value = POST;\n");
  });
  it("converts browser/Word HTML to inert Markdown with tables, code and emphasis", () => {
    const html =
      '<h2>Title</h2><p>Hello <span style="font-weight:700">world</span> &amp; <a href="https://example.com">link</a></p><ol start="3"><li>three</li></ol><table><tr><th>A</th><th>B</th></tr><tr><td>42</td><td>7</td></tr></table><pre>abc\n  def</pre><script>evil()</script><img src="https://bad.invalid" alt="image">';
    const result = clipboardText({
      getData: (type) => (type === "text/html" ? html : "Title\nHello world"),
    });
    expect(result.text).toContain("## Title");
    expect(result.text).toContain("Hello **world** & [link](<https://example.com>)");
    expect(result.text).toContain("3. three");
    expect(result.text).toContain("| 42 | 7 |");
    expect(result.text).toContain("abc\n  def");
    expect(result.text).not.toMatch(/evil|bad.invalid/);
  });

  it("imports email link labels as text while preserving formatting and web links", () => {
    const html =
      '<p><a href="mailto:user@example.com">user@example.com</a> ' +
      '<a href="MAILTO:user@example.com?subject=Hello"><strong>Email</strong></a> ' +
      '<a href="https://example.com">Website</a></p>';
    const plain = "user@example.com Email Website";
    const result = clipboardText({
      getData: (type) => (type === "text/html" ? html : plain),
    });
    expect(result).toEqual({
      text: "user@example.com **Email** [Website](<https://example.com>)",
      plain,
    });
  });
});
