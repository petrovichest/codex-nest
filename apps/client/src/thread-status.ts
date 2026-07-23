import type { ThreadSummary } from "@codexnest/protocol";

export function threadStatusClasses(
  thread: Pick<ThreadSummary, "state" | "unread" | "unseen">,
): string {
  const stateClass =
    thread.state === "completed" && thread.unread
      ? "status-completed-unread"
      : thread.state === "interrupted" && !thread.unread
        ? "status-interrupted-read"
        : `status-${thread.state}`;
  return `status ${stateClass}${thread.unseen ? " status-unseen" : ""}`;
}
