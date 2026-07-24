import type { ModelOption } from "@codexnest/protocol";

// Model ids are stored as the stable ALIAS ("sonnet", "opus", …) rather than the
// dated concrete id, so a session's saved settings survive model refreshes. The
// SDK resolves aliases at query time; the concrete id is kept in the description.

const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

function reasoningEfforts(): ModelOption["reasoningEfforts"] {
  return CLAUDE_EFFORT_LEVELS.map((value) => ({
    value,
    description: null,
    isDefault: value === "medium",
  }));
}

export const DEFAULT_CLAUDE_MODELS: ModelOption[] = [
  {
    id: "fable",
    displayName: "Claude Fable 5",
    description: "Самая мощная модель Anthropic (claude-fable-5)",
    isDefault: false,
    reasoningEfforts: reasoningEfforts(),
    serviceTiers: [],
    supportsPersonality: false,
  },
  {
    id: "opus",
    displayName: "Claude Opus 4.8",
    description: "Глубокие рассуждения для сложных задач (claude-opus-4-8)",
    isDefault: false,
    reasoningEfforts: reasoningEfforts(),
    serviceTiers: [],
    supportsPersonality: false,
  },
  {
    id: "sonnet",
    displayName: "Claude Sonnet 5",
    description: "Баланс скорости и качества (claude-sonnet-5)",
    isDefault: true,
    reasoningEfforts: reasoningEfforts(),
    serviceTiers: [],
    supportsPersonality: false,
  },
  {
    id: "haiku",
    displayName: "Claude Haiku 4.5",
    description: "Быстрые ответы для простых задач (claude-haiku-4-5-20251001)",
    isDefault: false,
    reasoningEfforts: reasoningEfforts(),
    serviceTiers: [],
    supportsPersonality: false,
  },
];

/**
 * Resolves the curated Claude model list, allowing a full replacement via the
 * `CODEXNEST_CLAUDE_MODELS` JSON env. On any parse or shape error the default list
 * is returned and a warning is logged — a bad override never breaks startup.
 */
export function resolveClaudeModels(
  raw: string | undefined,
  log?: { warn: (payload: Record<string, unknown>, message: string) => void },
): ModelOption[] {
  if (raw === undefined || raw.trim() === "") return structuredClone(DEFAULT_CLAUDE_MODELS);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    log?.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "CODEXNEST_CLAUDE_MODELS is not valid JSON; using the default Claude model list",
    );
    return structuredClone(DEFAULT_CLAUDE_MODELS);
  }
  if (!isModelOptionList(parsed)) {
    log?.warn(
      {},
      "CODEXNEST_CLAUDE_MODELS has an invalid shape; using the default Claude model list",
    );
    return structuredClone(DEFAULT_CLAUDE_MODELS);
  }
  return parsed;
}

function isModelOptionList(value: unknown): value is ModelOption[] {
  return Array.isArray(value) && value.length > 0 && value.every(isModelOption);
}

function isModelOption(value: unknown): value is ModelOption {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.displayName === "string" &&
    typeof value.description === "string" &&
    typeof value.isDefault === "boolean" &&
    typeof value.supportsPersonality === "boolean" &&
    Array.isArray(value.serviceTiers) &&
    value.serviceTiers.every(
      (tier) =>
        isRecord(tier) && typeof tier.id === "string" && typeof tier.displayName === "string",
    ) &&
    Array.isArray(value.reasoningEfforts) &&
    value.reasoningEfforts.every(
      (effort) =>
        isRecord(effort) &&
        typeof effort.value === "string" &&
        (effort.description === null || typeof effort.description === "string") &&
        typeof effort.isDefault === "boolean",
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
