import { describe, expect, test, afterEach } from "bun:test";
import {
  disposeAllWorktreeEventBridges,
  getWorktreeEventBridge,
  subscribeWorktreeEvents,
} from "../worktree-event-bridge.js";
import { createMockRuntime, mockSubscribe } from "./mock-runtime.js";

describe("WorktreeEventBridge", () => {
  afterEach(() => {
    disposeAllWorktreeEventBridges();
  });

  test("fans out events to multiple consumers", async () => {
    const runtime = createMockRuntime();
    const bridge = getWorktreeEventBridge("/tmp/worktree", runtime);
    const seenA: string[] = [];
    const seenB: string[] = [];

    const subA = await bridge.subscribe(async (event) => {
      if (
        typeof event === "object" &&
        event !== null &&
        (event as Record<string, unknown>).type === "session.idle"
      ) {
        seenA.push("a");
      }
    });
    const subB = await bridge.subscribe(async (event) => {
      if (
        typeof event === "object" &&
        event !== null &&
        (event as Record<string, unknown>).type === "session.idle"
      ) {
        seenB.push("b");
      }
    });

    expect(bridge.consumerCount).toBe(2);

    await runtime.emitIdle("worker-1");
    await new Promise((r) => setTimeout(r, 30));

    expect(seenA).toEqual(["a"]);
    expect(seenB).toEqual(["b"]);

    subA.stop();
    subB.stop();
    expect(bridge.consumerCount).toBe(0);
  });

  test("drops bridge registry entry when last consumer unsubscribes", async () => {
    const runtime = createMockRuntime();
    const worktree = `/tmp/bridge-cleanup-${Date.now()}`;

    const sub = await subscribeWorktreeEvents(worktree, runtime, async () => {});
    sub.stop();

    const again = getWorktreeEventBridge(worktree, runtime);
    expect(again.consumerCount).toBe(0);
  });

  test("mockSubscribe override still works for engine tests", async () => {
    const runtime = createMockRuntime();
    const seen: string[] = [];
    await mockSubscribe(runtime, async () => {
      seen.push("ok");
    });
    await runtime.emitIdle("worker-1");
    expect(seen).toEqual(["ok"]);
  });
});