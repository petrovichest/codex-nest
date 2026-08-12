import { describe, expect, it } from "vitest";

import { base64ByteLength, ScreenshotStore } from "./cdp";

describe("screenshot storage", () => {
  it("measures padded base64 and caps retained image count", () => {
    expect(base64ByteLength("YQ==")).toBe(1);
    expect(base64ByteLength("YWI=")).toBe(2);
    expect(base64ByteLength("YWJj")).toBe(3);
    const images = new ScreenshotStore();
    for (let index = 0; index < 20; index += 1) images.add("YQ==", "image/jpeg");
    expect(images.size).toBe(16);
  });
});
