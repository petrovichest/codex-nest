import { beforeEach, describe, expect, it } from "vitest";

import {
  annotationStorageKey,
  formatAnnotatedMessage,
  loadPendingAnnotations,
  type PendingAnnotation,
  rangeOffsets,
  resolveAnnotationRange,
  savePendingAnnotations,
} from "./annotations";

const annotation: PendingAnnotation = {
  id: "annotation-1",
  messageId: "agent-1",
  source: "agentMessage",
  quote: "точная\nцитата",
  startOffset: 4,
  endOffset: 17,
  comment: "Нужно уточнить",
  createdAt: 10,
};

beforeEach(() => localStorage.clear());

describe("pending annotations", () => {
  it("stores valid drafts per thread and removes an empty draft", () => {
    savePendingAnnotations("thread", [annotation]);
    savePendingAnnotations("other", [{ ...annotation, id: "other" }]);

    expect(loadPendingAnnotations("thread")).toEqual([annotation]);
    expect(loadPendingAnnotations("other")[0]?.id).toBe("other");

    savePendingAnnotations("thread", []);
    expect(localStorage.getItem(annotationStorageKey("thread"))).toBeNull();
  });

  it("ignores malformed local data", () => {
    localStorage.setItem(annotationStorageKey("thread"), "not json");
    expect(loadPendingAnnotations("thread")).toEqual([]);

    localStorage.setItem(
      annotationStorageKey("thread"),
      JSON.stringify([{ ...annotation, comment: " " }, annotation]),
    );
    expect(loadPendingAnnotations("thread")).toEqual([annotation]);
  });

  it("formats typed text and exact multiline quotes as one Markdown message", () => {
    expect(formatAnnotatedMessage("Продолжай", [annotation])).toBe(
      [
        "Продолжай",
        "## Аннотации к предыдущему ответу агента",
        "### Аннотация 1",
        "Выделенный текст:",
        "> точная\n> цитата",
        "Комментарий:",
        "Нужно уточнить",
      ].join("\n\n"),
    );
    expect(formatAnnotatedMessage("", [annotation])).toContain("### Аннотация 1");
    expect(formatAnnotatedMessage("  ", [])).toBe("");
    expect(formatAnnotatedMessage("Continue", [annotation], "en")).toContain(
      "## Annotations for the agent's previous response\n\n### Annotation 1",
    );
  });

  it("restores a DOM range and falls back to the closest matching quote", () => {
    const container = document.createElement("div");
    container.innerHTML = "Первый повтор и <strong>второй повтор</strong>";
    const text = container.querySelector("strong")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 7);
    range.setEnd(text, 13);

    const offsets = rangeOffsets(container, range);
    expect(offsets).toEqual({ startOffset: 23, endOffset: 29 });
    expect(
      resolveAnnotationRange(container, {
        quote: "повтор",
        startOffset: 21,
        endOffset: 27,
      })?.toString(),
    ).toBe("повтор");
  });
});
