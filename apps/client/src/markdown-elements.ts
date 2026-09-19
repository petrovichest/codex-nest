import type { AllowElement } from "react-markdown";

/** Pair with unwrapDisallowed so email links keep their text and formatting. */
export const allowMarkdownElement: AllowElement = (element) =>
  element.tagName !== "a" || !/^mailto:/i.test(String(element.properties.href ?? ""));
