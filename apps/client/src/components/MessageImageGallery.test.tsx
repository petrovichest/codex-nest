import type * as CapacitorCore from "@capacitor/core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Activity } from "./ThreadPage";

const native = vi.hoisted(() => ({ isNativePlatform: vi.fn(() => false), open: vi.fn() }));
vi.mock("@capacitor/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CapacitorCore>();
  return {
    ...actual,
    Capacitor: { ...actual.Capacitor, isNativePlatform: native.isNativePlatform },
  };
});
vi.mock("@capacitor/browser", () => ({ Browser: { open: native.open } }));

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  native.isNativePlatform.mockReturnValue(false);
  native.open.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
});

it("opens remote image downloads in the system browser on native platforms", async () => {
  native.isNativePlatform.mockReturnValue(true);
  render(
    <Activity
      item={{
        type: "agentMessage",
        id: "remote-message",
        text: "[Фото](https://example.test/photo.png)",
        images: [],
        timestamp: null,
        phase: null,
        status: "completed",
      }}
    />,
  );
  const gallery = screen.getByRole("group", { name: "Изображения" });
  fireEvent.load(within(gallery).getByAltText("Фото"));
  fireEvent.click(within(gallery).getByRole("button", { name: "Открыть изображение Фото" }));
  fireEvent.click(screen.getByRole("button", { name: "Скачать Фото" }));
  await waitFor(() =>
    expect(native.open).toHaveBeenCalledWith({ url: "https://example.test/photo.png" }),
  );
});

it("reuses loaded images through streaming and opens links and thumbnails in the same gallery", async () => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const load = vi.fn(async () => new Blob(["image"], { type: "image/png" }));
  const download = vi.fn(async () => {});
  const item = {
    type: "agentMessage" as const,
    id: "message",
    text: "[Первое](/work/a.png)",
    images: [],
    timestamp: null,
    phase: null,
    status: "inProgress" as const,
  };
  const view = render(
    <Activity item={item} cwd="/work" onLoadImage={load} onDownload={download} />,
  );
  const gallery = screen.getByRole("group", { name: "Изображения" });
  await waitFor(() =>
    expect(within(gallery).getByAltText("Первое")).toHaveAttribute("src", "blob:preview"),
  );
  fireEvent.load(within(gallery).getByAltText("Первое"));
  const original = within(gallery).getByAltText("Первое");
  view.rerender(
    <Activity
      item={{
        ...item,
        text: "[Первое](/work/a.png)\n\n![Второе](/work/b.png)\n\n[Повтор](/work/a.png)",
      }}
      cwd="/work"
      onLoadImage={load}
      onDownload={download}
    />,
  );
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect(within(gallery).getByAltText("Первое")).toBe(original);
  const link = view.container.querySelectorAll<HTMLButtonElement>(".gallery-image-link")[1]!;
  fireEvent.click(link);
  let viewer = screen.getByRole("dialog", { name: "Просмотр изображений" });
  expect(within(viewer).getByText("Изображение 2 из 2")).toBeInTheDocument();
  fireEvent.load(within(gallery).getByAltText("Второе"));
  expect(view.container.querySelectorAll(".gallery-image-link")[1]).toBe(link);
  fireEvent.click(within(viewer).getByRole("button", { name: "Скачать Второе" }));
  await waitFor(() => expect(download).toHaveBeenCalledWith("/work/b.png"));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(link).toHaveFocus();
  const thumbnail = within(gallery).getByRole("button", { name: "Открыть изображение Первое" });
  fireEvent.click(thumbnail);
  viewer = screen.getByRole("dialog", { name: "Просмотр изображений" });
  expect(within(viewer).getByText("Изображение 1 из 2")).toBeInTheDocument();
  expect(load).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(thumbnail).toHaveFocus();
  view.unmount();
  expect(revoke).toHaveBeenCalledTimes(2);
});

it("retries a failed local image from the viewer and closes safely when streaming removes it", async () => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:retry");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const load = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(new Blob(["image"]));
  const item = {
    type: "plan" as const,
    id: "plan",
    text: "![План](/work/a.png)",
    images: [],
    timestamp: null,
    phase: null,
    status: "inProgress" as const,
  };
  const view = render(<Activity item={item} cwd="/work" onLoadImage={load} />);
  await screen.findByRole("button", { name: /План: Не удалось/ });
  fireEvent.click(view.container.querySelector(".gallery-image-link")!);
  const viewer = screen.getByRole("dialog", { name: "Просмотр изображений" });
  fireEvent.click(
    within(viewer).getByRole("button", { name: "Не удалось загрузить изображение. Повторить" }),
  );
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  const gallery = screen.getByRole("group", { name: "Изображения" });
  await waitFor(() =>
    expect(within(gallery).getByAltText("План")).toHaveAttribute("src", "blob:retry"),
  );
  fireEvent.load(within(gallery).getByAltText("План"));
  expect(within(viewer).getByAltText("План")).toHaveAttribute("src", "blob:retry");
  view.rerender(
    <Activity item={{ ...item, text: "План обновлён." }} cwd="/work" onLoadImage={load} />,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});
