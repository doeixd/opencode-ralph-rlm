import { describe, expect, test } from "bun:test";
import { createAsyncEventQueue } from "../async-event-queue.js";

describe("createAsyncEventQueue", () => {
  test("serializes concurrent push callers", async () => {
    const order: number[] = [];
    const queue = createAsyncEventQueue(async (event) => {
      order.push(event as number);
      await new Promise((r) => setTimeout(r, 5));
    });

    await Promise.all([queue.push(1), queue.push(2), queue.push(3)]);
    expect(order).toEqual([1, 2, 3]);
  });

  test("rejects when max queue size exceeded", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const queue = createAsyncEventQueue(async () => {
      await gate;
    }, 2);

    const first = queue.push("a");
    const second = queue.push("b");
    await expect(queue.push("c")).rejects.toThrow(/overflow/);

    release();
    await first;
    await second;
  });
});