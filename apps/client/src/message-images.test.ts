import { describe, expect, it } from "vitest";
import { collectMessageImages } from "./message-images";

describe("message image collection", () => {
  it("loads tool paths outside the workspace without changing Markdown path handling", () => {
    const path = "/tmp/shot %20.png";
    const image = { key: path, src: path, localPath: path, label: "shot %20.png" };
    expect(collectMessageImages("", [path], "/work", true)).toEqual([image]);
    expect(
      collectMessageImages(`[Outside](${path.replaceAll(" ", "%20")})`, [], "/work", true),
    ).toEqual([]);
    expect(collectMessageImages("", [path], "/work")[0]?.localPath).toBeNull();
  });
  it("merges Markdown images, file links and attachments in first-appearance order", () => {
    const result = collectMessageImages(
      "![Схема](/work/a.png)\n\n[Фото](/work/b.jpg) и [ещё раз](/work/a.png)",
      ["/work/b.jpg", "https://example.test/c.webp"],
      "/work",
    );
    expect(result.map(({ key, label }) => [key, label])).toEqual([
      ["/work/a.png", "Схема"],
      ["/work/b.jpg", "Фото"],
      ["https://example.test/c.webp", "c.webp"],
    ]);
  });
  it("handles references, formatted labels and parentheses using the Markdown parser", () => {
    const result = collectMessageImages(
      "[**Вид** сбоку][photo]\n\n![План][plan]\n\n[photo]: /work/view(2).png\n[plan]: /work/plan.png",
      [],
      "/work",
    );
    expect(result.map(({ label }) => label)).toEqual(["Вид сбоку", "План"]);
  });
  it("ignores code, document links, web pages and unsupported local paths", () => {
    expect(
      collectMessageImages(
        "`![код](/work/a.png)`\n\n```md\n[код](/work/b.png)\n```\n\n[PDF](/work/file.pdf) [Сайт](https://example.test) [вне проекта](/else/image.png) [обход](/work/../secret.png)",
        [],
        "/work",
      ),
    ).toEqual([]);
  });
  it("recognizes remote image links with query parameters and explicit extensionless images", () => {
    expect(
      collectMessageImages(
        "[Фото](https://example.test/a.PNG?size=2) ![Кадр](https://example.test/render?id=1)",
        [],
      ).map(({ src }) => src),
    ).toEqual(["https://example.test/a.PNG?size=2", "https://example.test/render?id=1"]);
  });
  it("keeps URL security rules and accepts data attachments without displaying their address", () => {
    const src = "data:image/png;base64,abc";
    expect(
      collectMessageImages("![bad](javascript:alert) ![bad](data:text/html,test)", [src, src]),
    ).toEqual([{ key: src, src, localPath: null, label: "" }]);
  });
  it("deduplicates encoded local paths and handles an incomplete streamed reference", () => {
    expect(
      collectMessageImages(
        "![Первое](/work/a%20b.png)\n\n[Следующее](",
        ["/work/a b.png"],
        "/work",
      ),
    ).toHaveLength(1);
    expect(
      collectMessageImages(
        "![Первое](/work/a%20b.png)\n\n[Следующее](/work/next.png)",
        ["/work/a b.png"],
        "/work",
      ),
    ).toHaveLength(2);
  });
});
