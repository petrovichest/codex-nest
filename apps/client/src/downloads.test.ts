import { beforeEach, describe, expect, it, vi } from "vitest";

import { openDownloadUrl } from "./downloads";

const native = vi.hoisted(() => ({
  isNativePlatform: vi.fn(() => false),
  open: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: native.isNativePlatform },
}));
vi.mock("@capacitor/browser", () => ({
  Browser: { open: native.open },
}));

beforeEach(() => {
  vi.clearAllMocks();
  native.isNativePlatform.mockReturnValue(false);
  native.open.mockResolvedValue(undefined);
});

describe("openDownloadUrl", () => {
  it("uses a temporary browser link on web", async () => {
    let clickedUrl = "";
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clickedUrl = this.href;
    });
    try {
      await openDownloadUrl("https://codex.home.arpa", "/downloads/ticket/app-debug.apk");
    } finally {
      click.mockRestore();
    }

    expect(clickedUrl).toBe("https://codex.home.arpa/downloads/ticket/app-debug.apk");
    expect(native.open).not.toHaveBeenCalled();
    expect(document.querySelector('a[href*="/downloads/ticket/"]')).toBeNull();
  });

  it("opens the system browser on native platforms", async () => {
    native.isNativePlatform.mockReturnValue(true);

    await openDownloadUrl("https://codex.home.arpa", "/downloads/ticket/app-debug.apk");

    expect(native.open).toHaveBeenCalledWith({
      url: "https://codex.home.arpa/downloads/ticket/app-debug.apk",
    });
  });
});
