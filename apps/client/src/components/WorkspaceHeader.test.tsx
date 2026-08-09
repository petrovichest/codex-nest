import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../i18n";
import { WorkspaceHeader } from "./WorkspaceHeader";

describe("WorkspaceHeader", () => {
  it("renders a caller-supplied leading icon without imposing folder semantics", () => {
    const { container } = render(
      <I18nProvider>
        <WorkspaceHeader
          leadingIcon={<svg data-testid="session-icon" />}
          title="Session"
          onOpenNavigation={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Session" })).toBeInTheDocument();
    expect(screen.getByTestId("session-icon")).toBeInTheDocument();
    expect(container.querySelector(".workspace-title-icon")).toHaveAttribute("aria-hidden", "true");
  });

  it("omits the leading icon slot when the caller has no appropriate icon", () => {
    const { container } = render(
      <I18nProvider>
        <WorkspaceHeader title="Settings" onOpenNavigation={vi.fn()} />
      </I18nProvider>,
    );

    expect(container.querySelector(".workspace-title-icon")).not.toBeInTheDocument();
  });
});
