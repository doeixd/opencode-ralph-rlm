import path from "node:path";
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { injectSupervisorMessage } from "../lib/supervisor-message.js";
import { loopRegistry } from "../lib/loop-registry.js";
import {
  PROTOCOL_FILES,
  loadPlanContext,
  protocolFilePath,
  readTextFile,
} from "@doeixd/opencode-ralph-rlm-engine";
import { createProviderMockRuntime, mockSubscribe } from "./mock-runtime.js";
import { ensureMinimalRepoFixture } from "./minimal-repo-fixture.js";

const fixtureRoot = await ensureMinimalRepoFixture(
  path.resolve(import.meta.dirname, "../../../../fixtures/minimal-repo")
);

describe("injectSupervisorMessage (RALPH_TEST_MODE)", () => {
  let worktree: string;
  const previous = process.env.RALPH_TEST_MODE;

  beforeEach(async () => {
    process.env.RALPH_TEST_MODE = "1";
    loopRegistry.dispose();
    worktree = await mkdtemp(path.join(tmpdir(), "ralph-msg-"));
    await cp(fixtureRoot, worktree, { recursive: true });
    await loopRegistry.getOrCreate(
      { sessionId: "sess-msg", worktree },
      { runtime: createProviderMockRuntime(), subscribeEvents: mockSubscribe }
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

  test("records the message and runs a supervisor turn", async () => {
    const result = await injectSupervisorMessage({
      sessionKey: "sess-msg",
      worktree,
      message: "status check from CI watcher",
      source: "ci-watcher",
      toast: false,
    });

    expect(result.recorded).toBe(true);
    expect(result.ran).toBe(true);
    expect(result.response).toBeTruthy();

    const pctx = await loadPlanContext(worktree);
    const conversation = await readTextFile(
      protocolFilePath(pctx, PROTOCOL_FILES.CONVERSATION)
    );
    expect(conversation).toContain("external:ci-watcher");
  });

  test("runTurn:false records without running a turn", async () => {
    const result = await injectSupervisorMessage({
      sessionKey: "sess-msg",
      worktree,
      message: "heads up",
      toast: false,
      runTurn: false,
    });

    expect(result.recorded).toBe(true);
    expect(result.ran).toBe(false);
    expect(result.response).toBeUndefined();
  });
});
