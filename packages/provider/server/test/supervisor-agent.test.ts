import path from "node:path";
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { supervisorTurn } from "../lib/supervisor-agent.js";
import { loopRegistry } from "../lib/loop-registry.js";
import { getOpencodeRuntime } from "../lib/runtime.js";
import { createProviderMockRuntime, mockSubscribe } from "./mock-runtime.js";
import { ensureMinimalRepoFixture } from "./minimal-repo-fixture.js";

const fixtureRoot = await ensureMinimalRepoFixture(
  path.resolve(import.meta.dirname, "../../../../fixtures/minimal-repo")
);

describe("supervisorTurn (RALPH_TEST_MODE)", () => {
  let worktree: string;
  const previous = process.env.RALPH_TEST_MODE;

  beforeEach(async () => {
    process.env.RALPH_TEST_MODE = "1";
    loopRegistry.dispose();

    worktree = await mkdtemp(path.join(tmpdir(), "ralph-provider-"));
    await cp(fixtureRoot, worktree, { recursive: true });

    const runtime = createProviderMockRuntime();
    await loopRegistry.getOrCreate(
      { sessionId: "sess-1", worktree },
      { runtime, subscribeEvents: mockSubscribe }
    );
    await loopRegistry.getOrCreate(
      { sessionId: "sess-2", worktree },
      { runtime, subscribeEvents: mockSubscribe }
    );
  });

  afterEach(async () => {
    loopRegistry.dispose();
    if (previous === undefined) delete process.env.RALPH_TEST_MODE;
    else process.env.RALPH_TEST_MODE = previous;
    try {
      await rm(worktree, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // ignore Windows temp lock
    }
  });

  test("starts loop from natural language goal", async () => {
    const turn = await supervisorTurn({
      sessionKey: "sess-1",
      worktree,
      messages: [{ role: "user", content: "Implement marker file; tests must pass" }],
    });

    expect(turn.mode).toBe("test");
    expect(turn.content.toLowerCase()).toContain("attempt 1");

    const engine = loopRegistry.get("sess-1");
    expect(engine?.state.started).toBe(true);
    expect(engine?.state.attempt).toBe(1);
  });

  test("returns status on status request", async () => {
    await supervisorTurn({
      sessionKey: "sess-2",
      worktree,
      messages: [{ role: "user", content: "Implement marker file" }],
    });

    const turn = await supervisorTurn({
      sessionKey: "sess-2",
      worktree,
      messages: [{ role: "user", content: "status?" }],
    });

    expect(turn.content.toLowerCase()).toContain("attempt");
  });

  test("getOpencodeRuntime is cached singleton", () => {
    expect(getOpencodeRuntime()).toBe(getOpencodeRuntime());
  });
});