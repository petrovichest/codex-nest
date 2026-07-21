import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AttentionPanel } from "./AttentionPanel";

const connection = vi.hoisted(() => vi.fn());

vi.mock("../connection", () => ({ useConnection: connection }));

describe("AttentionPanel", () => {
  it("responds to approvals through the existing API", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    connection.mockReturnValue({ api: { respond } });
    render(
      <AttentionPanel
        requests={[
          {
            id: "attention",
            threadId: "thread",
            turnId: "turn",
            itemId: "item",
            createdAt: 1,
            kind: "commandApproval",
            command: "npm test",
            cwd: "/work",
            reason: "Нужно проверить изменения",
            networkHost: null,
            canAcceptForSession: true,
            proposedPolicyChanges: [],
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Разрешить один раз" }));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("attention", {
        kind: "approval",
        decision: "accept",
      }),
    );
  });
});
