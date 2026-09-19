import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { PastedMarkdown } from "./PastedMarkdown";

describe("Markdown links", () => {
  it.each([
    [
      "git@github.com:petrovichest/3d_cad_models.git",
      "git@github.com:petrovichest/3d_cad_models.git",
    ],
    ["user@example.com", "user@example.com"],
    ["<user@example.com>", "user@example.com"],
    ["<mailto:user@example.com>", "mailto:user@example.com"],
    ["[Email](mailto:user@example.com)", "Email"],
    ["[Email](MAILTO:user@example.com?subject=Hello)", "Email"],
    ["[Email][contact]\n\n[contact]: mailto:user@example.com", "Email"],
  ])("renders %s without a link", (text, expected) => {
    const { container } = render(<PastedMarkdown text={text} />);
    expect(container.textContent).toBe(expected);
    expect(container.querySelector("a")).toBeNull();
  });

  it("preserves the full pasted SSH address and its provenance", () => {
    const prefix = "Давай склонируем этот репо в git директорию\n";
    const address = "git@github.com:petrovichest/3d_cad_models.git";
    const text = prefix + address;
    const { container } = render(
      <PastedMarkdown
        text={text}
        inlinePastes={[{ id: "repository", start: prefix.length, end: text.length }]}
      />,
    );
    expect(container.textContent).toBe(text);
    expect(container.querySelector("a")).toBeNull();
    expect(
      Array.from(container.querySelectorAll('mark[data-paste-id="repository"]'))
        .map((mark) => mark.textContent)
        .join(""),
    ).toBe(address);
  });

  it("keeps formatting and paste marks inside an explicit email link", () => {
    const text = "[**Email**](mailto:user@example.com)";
    const { container } = render(
      <PastedMarkdown text={text} inlinePastes={[{ id: "email", start: 0, end: text.length }]} />,
    );
    expect(container.querySelector("strong mark")?.textContent).toBe("Email");
    expect(container.querySelector("a")).toBeNull();
  });

  it("passes only web and file links to custom link renderers", () => {
    const link = vi.fn(({ href, children }: ComponentProps<"a">) => <a href={href}>{children}</a>);
    render(
      <PastedMarkdown
        text={
          "user@example.com [Email](mailto:user@example.com) https://example.com " +
          "[Website](http://example.com) [File](/work/report.md)"
        }
        components={{ a: link }}
      />,
    );
    expect(screen.getAllByRole("link").map((element) => element.getAttribute("href"))).toEqual([
      "https://example.com",
      "http://example.com",
      "/work/report.md",
    ]);
    expect(link).toHaveBeenCalledTimes(3);
  });
});
