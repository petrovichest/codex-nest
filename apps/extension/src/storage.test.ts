import { describe, expect, it } from "vitest";

import { ExtensionStore, type StorageArea } from "./storage";

class MemoryStorage implements StorageArea {
  values: Record<string, unknown> = {};

  async get(): Promise<Record<string, unknown>> {
    return structuredClone(this.values);
  }

  async set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.values, structuredClone(items));
  }
}

describe("ExtensionStore", () => {
  it("creates and preserves an immutable instance ID", async () => {
    const area = new MemoryStorage();
    const store = new ExtensionStore(
      area,
      () => "instance-one",
      () => "en",
    );
    expect((await store.load()).instanceId).toBe("instance-one");

    const updated = await store.update((draft) => {
      draft.instanceId = "attempted-replacement";
      draft.settings = { baseUrl: "http://127.0.0.1:4310", token: "secret" };
    });
    expect(updated.instanceId).toBe("instance-one");
    expect(
      (
        await new ExtensionStore(
          area,
          () => "instance-two",
          () => "ru",
        ).load()
      ).instanceId,
    ).toBe("instance-one");
  });

  it("preserves a server-selected English locale on a Russian browser", async () => {
    const area = new MemoryStorage();
    const first = new ExtensionStore(
      area,
      () => "instance",
      () => "ru",
    );
    await first.update((draft) => {
      draft.locale = "en";
    });
    const restarted = new ExtensionStore(
      area,
      () => "other",
      () => "ru",
    );
    expect((await restarted.load()).locale).toBe("en");
  });

  it("serializes concurrent binding updates without losing either change", async () => {
    const area = new MemoryStorage();
    const store = new ExtensionStore(
      area,
      () => "instance",
      () => "en",
    );
    const binding = (threadId: string) => ({
      threadId,
      projectId: "project",
      title: threadId,
      groupId: 1,
      tabIds: [1],
      createdAt: 1,
      updatedAt: 1,
    });

    await Promise.all([
      store.update((draft) => {
        draft.bindings.one = binding("one");
      }),
      store.update((draft) => {
        draft.bindings.two = binding("two");
      }),
    ]);

    expect(Object.keys((await store.load()).bindings).sort()).toEqual(["one", "two"]);
  });
});
