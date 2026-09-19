import { render, screen } from "@testing-library/react";
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
