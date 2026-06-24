import path from "node:path";
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { LoopRegistry } from "../loop-registry.js";
import { createMockRuntime, mockSubscribe } from "./mock-runtime.js";
import { ensureMinimalRepoFixture } from "./minimal-repo-fixture.js";

const fixtureRoot = await ensureMinimalRepoFixture(
  path.resolve(import.meta.dirname, "../../../../fixtures/minimal-repo")
);

describe("LoopRegistry", () => {
  test("list returns synchronous snapshots", async () => {
    const worktree = await mkdtemp(path.join(tmpdir(), "ralph-registry-"));
    await cp(fixtureRoot, worktree, { recursive: true });

    const registry = new LoopRegistry();
    const runtime = createMockRuntime();

    try {
      await registry.start(
        { sessionId: "sess-a", worktree, bootstrap: true },
        { runtime, subscribeEvents: (onEvent) => mockSubscribe(runtime, onEvent) }
      );

      const listed = registry.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]?.sessionId).toBe("sess-a");
      expect(listed[0]?.started).toBe(true);
      expect(listed[0]?.attempt).toBe(1);
      expect(listed[0]?.stopped).toBe(false);
    } finally {
      registry.dispose();
      await rm(worktree, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});