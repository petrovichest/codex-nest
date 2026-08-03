import type { ThreadSummary } from "@codexnest/protocol";

export function hasAlwaysVisibleThreadStatus(
  thread: Pick<ThreadSummary, "state" | "unread">,
): boolean {
  return (
    thread.state === "running" ||
    thread.state === "queued" ||
    thread.state === "needsAttention" ||
    thread.state === "failed" ||
    ((thread.state === "completed" || thread.state === "interrupted") && thread.unread)
  );
}

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
