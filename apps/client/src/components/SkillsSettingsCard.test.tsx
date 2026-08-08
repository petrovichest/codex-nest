import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Project, SkillsCatalogResponse } from "@codexnest/protocol";

import { SkillsSettingsCard } from "./SkillsSettingsCard";

const connection = vi.hoisted(() => vi.fn());

vi.mock("../connection", () => ({ useConnection: connection }));

const projects: Project[] = [
  {
    id: "one",
    displayName: "Первый",
    path: "/work/one",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  },
];

const catalog: SkillsCatalogResponse = {
  cwd: "/work/one",
  skills: [
    {
      name: "review",
      displayName: "Review",
      description: "Review current changes",
      shortDescription: null,
      path: "/skills/review/SKILL.md",
      scope: "user",
      enabled: true,
    },
    {
      name: "docs",
      displayName: "Docs",
      description: "Write documentation",
      shortDescription: null,
      path: "/skills/docs/SKILL.md",
      scope: "repo",
      enabled: false,
    },
  ],
  errors: [],
};

beforeEach(() => connection.mockReset());

describe("SkillsSettingsCard", () => {
  it("lists, searches, refreshes, and toggles installed skills", async () => {
    const listSkills = vi.fn().mockResolvedValue(catalog);
    const updateSkillConfig = vi.fn().mockResolvedValue({
      path: "/skills/docs/SKILL.md",
      enabled: true,
    });
    connection.mockReturnValue({ api: { listSkills, updateSkillConfig } });

    render(<SkillsSettingsCard projects={projects} skillsEpoch={0} />);

    await waitFor(() => expect(listSkills).toHaveBeenCalledWith("/work/one", false));
    expect(screen.getByText("$review")).toBeInTheDocument();
    expect(screen.getByText("$docs")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Поиск скиллов" }), {
      target: { value: "documentation" },
    });
    expect(screen.queryByText("$review")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Включить скилл Docs" }));
    await waitFor(() =>
      expect(updateSkillConfig).toHaveBeenCalledWith({
        cwd: "/work/one",
        path: "/skills/docs/SKILL.md",
        enabled: true,
      }),
    );
    expect(await screen.findByRole("switch", { name: "Выключить скилл Docs" })).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Обновить список скиллов" }));
    await waitFor(() => expect(listSkills).toHaveBeenLastCalledWith("/work/one", true));
  });
});
