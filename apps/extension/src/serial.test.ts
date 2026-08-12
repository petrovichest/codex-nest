import { describe, expect, it } from "vitest";

import { KeyedSerialQueue } from "./serial";

describe("KeyedSerialQueue", () => {
  it("serialises work for one tab while allowing other tabs to proceed", async () => {
    const queue = new KeyedSerialQueue();
    const order: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = queue.run(7, async () => {
      order.push("7:first:start");
      await blocked;
      order.push("7:first:end");
    });
    const second = queue.run(7, async () => {
      order.push("7:second");
    });
    const other = queue.run(8, async () => {
      order.push("8:first");
    });
    await other;
    expect(order).toEqual(["7:first:start", "8:first"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["7:first:start", "8:first", "7:first:end", "7:second"]);
  });
});
