import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CLAUDE_MODELS, resolveClaudeModels } from "./models";

describe("resolveClaudeModels", () => {
  it("exposes the curated aliases with Sonnet as default and a shared effort ladder", () => {
    const models = resolveClaudeModels(undefined);
    expect(models.map((model) => model.id)).toEqual(["fable", "opus", "sonnet", "haiku"]);
    expect(models.filter((model) => model.isDefault).map((model) => model.id)).toEqual(["sonnet"]);
    for (const model of models) {
      expect(model.reasoningEfforts.map((effort) => effort.value)).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
      expect(
        model.reasoningEfforts.filter((effort) => effort.isDefault).map((e) => e.value),
      ).toEqual(["medium"]);
      expect(model.serviceTiers).toEqual([]);
      expect(model.supportsPersonality).toBe(false);
    }
    // Concrete dated ids stay discoverable in the description for forward-compat.
    expect(models.find((model) => model.id === "haiku")?.description).toContain(
      "claude-haiku-4-5-20251001",
    );
  });

  it("replaces the list from a valid JSON override", () => {
    const override = JSON.stringify([
      {
        id: "sonnet",
        displayName: "Only Sonnet",
        description: "custom",
        isDefault: true,
        reasoningEfforts: [{ value: "medium", description: null, isDefault: true }],
        serviceTiers: [],
        supportsPersonality: false,
      },
    ]);
    const models = resolveClaudeModels(override);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: "sonnet", displayName: "Only Sonnet" });
  });

  it("falls back to the default list and warns on invalid JSON", () => {
    const log = { warn: vi.fn() };
    expect(resolveClaudeModels("{not json", log)).toEqual(DEFAULT_CLAUDE_MODELS);
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it("falls back to the default list and warns on an invalid shape", () => {
    const log = { warn: vi.fn() };
    expect(resolveClaudeModels(JSON.stringify([{ id: 5 }]), log)).toEqual(DEFAULT_CLAUDE_MODELS);
    expect(resolveClaudeModels(JSON.stringify([]), log)).toEqual(DEFAULT_CLAUDE_MODELS);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});
