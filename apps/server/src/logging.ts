const REDACT_KEYS = /authorization|token|prompt|input|output|environment|raw|secret|credential/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[redacted-depth]";
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      REDACT_KEYS.test(key) ? "[redacted]" : redact(child, depth + 1),
    ]),
  );
}

export function safeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}
