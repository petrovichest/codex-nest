import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { artifactDescriptor } from "../artifacts";
import { ArtifactViewer } from "./ArtifactViewer";

it("previews Markdown with web links but without email links", async () => {
  const data = new TextEncoder().encode(
    "git@github.com:petrovichest/3d_cad_models.git\n\n" +
      "[**Email**](mailto:user@example.com) [Website](https://example.com)",
  );
  render(
    <ArtifactViewer
      artifact={artifactDescriptor("/work/report.md")!}
      opener={null}
      onClose={vi.fn()}
      onDownload={vi.fn()}
      onLoad={vi.fn().mockResolvedValue({
        state: "ready",
        data: data.buffer,
        fileName: "report.md",
        size: data.byteLength,
      })}
    />,
  );
  expect(await screen.findByRole("link", { name: "Website" })).toHaveAttribute(
    "href",
    "https://example.com",
  );
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getByText("git@github.com:petrovichest/3d_cad_models.git")).toBeVisible();
  expect(screen.getByText("Email").tagName).toBe("STRONG");
});

it("keeps an accessible GFM table mounted while downloading, including after a failure", async () => {
  const data = new TextEncoder().encode(
    "| File | Result |\n| --- | ---: |\n| [Report](https://example.com) | **12** |",
  );
  let rejectDownload!: (error: Error) => void;
  const onDownload = vi.fn(() => new Promise<void>((_, reject) => (rejectDownload = reject)));
  const onLoad = vi.fn().mockResolvedValue({
    state: "ready",
    data: data.buffer,
    fileName: "long-report-name.md",
    size: data.byteLength,
  });
  render(
    <ArtifactViewer
      artifact={artifactDescriptor("/work/report.md")!}
      opener={null}
      onClose={vi.fn()}
      onDownload={onDownload}
      onLoad={onLoad}
    />,
  );
  const table = await screen.findByRole("group", { name: "Таблица" });
  expect(table).toHaveAttribute("tabindex", "0");
  expect(within(table).getAllByRole("columnheader")[1]).toHaveStyle({ textAlign: "right" });
  expect(within(table).getByRole("link", { name: "Report" })).toHaveAttribute(
    "href",
    "https://example.com",
  );
  expect(within(table).getByText("12").tagName).toBe("STRONG");
  expect(screen.getByTitle("long-report-name.md")).toBeVisible();

  table.focus();
  table.scrollLeft = 40;
  const download = screen.getByRole("button", { name: "Скачать report.md" });
  fireEvent.click(download);
  expect(download).toBeDisabled();
  expect(screen.getByRole("group", { name: "Таблица" })).toBe(table);
  expect(table).toHaveFocus();
  rejectDownload(new Error("offline"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось скачать файл");
  await waitFor(() => expect(download).toBeEnabled());
  expect(screen.getByRole("group", { name: "Таблица" })).toBe(table);
  expect(table.scrollLeft).toBe(40);
  expect(table).toHaveFocus();
  expect(onLoad).toHaveBeenCalledTimes(1);
});
