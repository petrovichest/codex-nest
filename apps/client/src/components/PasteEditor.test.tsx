import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { MessagePresentation } from "@codexnest/protocol";
import { PasteMessageEditor } from "./PasteEditor";
import { PastedMarkdown } from "./PastedMarkdown";
import { clipboardText } from "../pasted-text";

function Harness({ initial = { input: "" } }: { initial?: MessagePresentation }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <PasteMessageEditor
        identity="test"
        aria-label="Message"
        value={value}
        onValueChange={setValue}
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

describe("paste editor", () => {
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
