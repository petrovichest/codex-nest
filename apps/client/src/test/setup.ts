import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);

// jsdom hides [popover] elements but does not implement the top-layer API yet.
if (!HTMLElement.prototype.showPopover) {
  HTMLElement.prototype.showPopover = function () {
    this.style.display = "block";
  };
  HTMLElement.prototype.hidePopover = function () {
    this.style.display = "none";
  };
}
