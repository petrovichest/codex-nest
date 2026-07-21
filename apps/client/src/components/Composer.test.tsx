import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import type { SessionSettings } from "@codexnest/protocol";

import { Composer, type ComposerImage } from "./Composer";

const models = [
  {
    id: "gpt",
    displayName: "GPT",
    description: "",
    isDefault: true,
    reasoningEfforts: [{ value: "high", description: null, isDefault: true }],
    serviceTiers: [],
    supportsPersonality: true,
  },
];

describe("Composer", () => {
  it("starts at two rows, grows to its cap, and then enables internal scrolling", () => {
    render(<Harness />);
    const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    expect(textarea).toHaveAttribute("rows", "2");

    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 240 });
    fireEvent.change(textarea, { target: { value: "Длинное\n".repeat(30) } });
    expect(textarea).toHaveStyle({ height: "190px", overflowY: "auto" });

    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 52 });
    fireEvent.change(textarea, { target: { value: "Короткое" } });
    expect(textarea).toHaveStyle({ height: "52px", overflowY: "hidden" });
  });

  it("adds multiple images and removes a preview only after selecting it", async () => {
    const view = render(<Harness />);
    const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        files: [
          new File(["one"], "one.png", { type: "image/png" }),
          new File(["two"], "two.jpg", { type: "image/jpeg" }),
        ],
      },
    });

    const first = await screen.findByRole("button", { name: "Выбрать изображение one.png" });
    expect(screen.getByRole("button", { name: "Выбрать изображение two.jpg" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Удалить изображение one.png" })).toBeNull();

    fireEvent.click(first);
    fireEvent.click(screen.getByRole("button", { name: "Удалить изображение one.png" }));

    await waitFor(() => expect(screen.queryByAltText("one.png")).toBeNull());
    expect(screen.getByAltText("two.jpg")).toBeInTheDocument();
  });
});

function Harness() {
  const [input, setInput] = useState("");
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [settings, setSettings] = useState<SessionSettings>({ collaborationMode: "default" });
  return (
    <Composer
      input={input}
      onInput={setInput}
      images={images}
      onImagesChange={setImages}
      onSubmit={(event) => event.preventDefault()}
      busy={false}
      settings={settings}
      onSettingsChange={(patch) =>
        setSettings((current) => {
          const next = { ...current };
          for (const [key, value] of Object.entries(patch)) {
            if (value === null) delete next[key as keyof SessionSettings];
            else if (value !== undefined) Object.assign(next, { [key]: value });
          }
          return next;
        })
      }
      models={models}
      error={null}
    />
  );
}
