import type { Turn } from "./codex/generated/v2/Turn";

export const CAPACITY_RETRY_INTERVAL_MS = 5 * 60_000;
export const CAPACITY_RETRY_MESSAGE_PREFIX = "codexnest-capacity-retry:";
export const CAPACITY_RETRY_MESSAGE =
  "Continue the user's unfinished task from where model capacity interrupted it. Review the existing results and changes before acting, and preserve the current mode and settings.";

export function isCapacityFailure(turn: Pick<Turn, "status" | "error">): boolean {
  return turn.status === "failed" && turn.error?.codexErrorInfo === "serverOverloaded";
}

export function capacityRetryMessageId(turnId: string): string {
  return `${CAPACITY_RETRY_MESSAGE_PREFIX}${turnId}`;
}
