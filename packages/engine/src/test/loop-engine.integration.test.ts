import path from "node:path";
import { mkdtemp, cp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { createLoopEngine } from "../loop-engine.js";
import { PROTOCOL_FILES } from "../protocol-files.js";
import { writePendingInput } from "../pending-input.js";
import { loadPlanContext } from "../protocol-files.js";
import { stateFilePath } from "../plan-paths.js";
import { fileExists } from "../fs.js";
import { createMockRuntime, mockSubscribe } from "./mock-runtime.js";
import { ensureMinimalRepoFixture } from "./minimal-repo-fixture.js";

const fixtureRoot = await ensureMinimalRepoFixture(
  path.resolve(import.meta.dirname, "../../../../fixtures/minimal-repo")
);

async function makeFixtureCopy(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ralph-loop-"));
  await cp(fixtureRoot, root, { recursive: true });
  return root;
}

/** Fixture copy configured for the named-plan layout (.ralph-rlm/plans/<name>/). */
async function makeNamedFixtureCopy(): Promise<string> {
  const root = await makeFixtureCopy();
  // A fresh named install has no root protocol files — remove the fixture's.
  await Promise.all(
    Object.values(PROTOCOL_FILES).map((file) =>
      rm(path.join(root, file), { force: true })
    )
  );
  await writeFile(
    path.join(root, ".opencode", "ralph.json"),
    JSON.stringify(
      {
        enabled: true,
        maxAttempts: 5,
        verify: { command: ["node", "scripts/verify.mjs"], cwd: "." },
        plans: { dir: ".ralph-rlm/plans", active: "default" },
      },
      null,
      2
    ),
    "utf8"
  );
  return root;
}

describe("LoopEngine integration", () => {
  test("runs two attempts: fail then pass", async () => {
    const worktree = await makeFixtureCopy();
    const runtime = createMockRuntime();

    const events: string[] = [];
    const engine = createLoopEngine(
      { sessionId: "test-session", worktree, bootstrap: true },
      {
        runtime,
        subscribeEvents: (onEvent) => mockSubscribe(runtime, onEvent),
      }
    );

    engine.on("worker.spawned", () => events.push("worker.spawned"));
    engine.on("verify.done", () => events.push("verify.done"));
    engine.on("rollover", () => events.push("rollover"));
    engine.on("loop.done", () => events.push("loop.done"));

    try {
      await engine.start();

      expect(runtime.spawnedWorkers).toEqual(["worker-1"]);
      expect(engine.state.attempt).toBe(1);

      await runtime.emitIdle("worker-1");

      expect(events).toContain("verify.done");
      expect(events).toContain("rollover");
      expect(runtime.spawnedWorkers).toEqual(["worker-1", "worker-2"]);
      expect(engine.state.attempt).toBe(2);

      await writeFile(path.join(worktree, ".ralph-pass-marker"), "ok\n", "utf8");
      await runtime.emitIdle("worker-2");

      const status = await engine.status();
      expect(status.done).toBe(true);
      expect(events).toContain("loop.done");

      const doneCtx = await loadPlanContext(worktree);
      const nextRalph = await Bun.file(
        path.join(doneCtx.protocolDir, PROTOCOL_FILES.NEXT_RALPH)
      ).text();
      expect(nextRalph).toContain("DONE");
    } finally {
      engine.dispose();
      try {
        await rm(worktree, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows temp dirs can remain locked briefly after verify subprocesses exit.
      }
    }
  });

  test("resume retries same attempt after spawn failure", async () => {
    const worktree = await makeFixtureCopy();
    const runtime = createMockRuntime();
    runtime.failNextPrompt = true;

    const engine = createLoopEngine(
      { sessionId: "test-session", worktree, bootstrap: true },
      {
        runtime,
        subscribeEvents: (onEvent) => mockSubscribe(runtime, onEvent),
      }
    );

    try {
      await engine.start();
      expect(engine.state.attempt).toBe(1);
      expect(engine.state.paused).toBe(true);

      runtime.failNextPrompt = false;
      await engine.resume();

      expect(engine.state.paused).toBe(false);
      expect(engine.state.attempt).toBe(1);
      expect(runtime.spawnedWorkers).toEqual(["worker-1", "worker-2"]);
    } finally {
      engine.dispose();
      try {
        await rm(worktree, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows temp dirs can remain locked briefly after verify subprocesses exit.
      }
    }
  });

  test("pauses when worker prompt fails", async () => {
    const worktree = await makeFixtureCopy();
    const runtime = createMockRuntime();
    runtime.failNextPrompt = true;

    const engine = createLoopEngine(
      { sessionId: "test-session", worktree, bootstrap: true },
      {
        runtime,
        subscribeEvents: (onEvent) => mockSubscribe(runtime, onEvent),
      }
    );

    try {
      await engine.start();
      expect(engine.state.paused).toBe(true);
      expect(engine.state.pauseReason).toContain("Worker prompt failed");
      expect(runtime.spawnedWorkers).toEqual(["worker-1"]);
    } finally {
      engine.dispose();
      try {
        await rm(worktree, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows temp dirs can remain locked briefly after verify subprocesses exit.
      }
    }
  });

  test("defers verify when error-paused then idle, runs verify on resume", async () => {
    const worktree = await makeFixtureCopy();
    const runtime = createMockRuntime();
    const events: string[] = [];

    const engine = createLoopEngine(
      { sessionId: "test-session", worktree, bootstrap: true },
      {
        runtime,
        subscribeEvents: (onEvent) => mockSubscribe(runtime, onEvent),
      }
    );
    engine.on("verify.done", () => events.push("verify.done"));
    engine.on("rollover", () => events.push("rollover"));

    try {
      await engine.start();
      expect(runtime.spawnedWorkers).toEqual(["worker-1"]);

      await runtime.emitEvent({
        type: "ralph.subscription.error",
        error: "hold verify",
      });
      expect(engine.state.paused).toBe(true);
      await runtime.emitIdle("worker-1");

      expect(engine.state.workerIdlePendingVerify).toBe(true);
      expect(engine.state.currentWorkerSessionId).toBeUndefined();
      expect(events).not.toContain("verify.done");
      expect(runtime.spawnedWorkers).toEqual(["worker-1"]);

      await engine.resume();

      expect(engine.state.workerIdlePendingVerify).toBeUndefined();
      expect(events).toContain("verify.done");
      expect(events).toContain("rollover");
      expect(runtime.spawnedWorkers).toEqual(["worker-1", "worker-2"]);
      expect(engine.state.attempt).toBe(2);
    } finally {
      engine.dispose();
      try {
        await rm(worktree, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows temp dirs can remain locked briefly after verify subprocesses exit.
      }
    }
  });

  test("stop clears worker and allows restart on same attempt", async () => {
    const worktree = await makeFixtureCopy();
    const runtime = createMockRuntime();

    const engine = createLoopEngine(
      { sessionId: "test-session", worktree, bootstrap: true },
      {
        runtime,
        subscribeEvents: (onEvent) => mockSubscribe(runtime, onEvent),
      }
    );

    try {
      await engine.start();
      expect(engine.state.attempt).toBe(1);

      await engine.stop("user requested");
      const stoppedStatus = await engine.status();
      expect(stoppedStatus.stopped).toBe(true);
      expect(stoppedStatus.done).toBe(true);
      expect(stoppedStatus.outcome).toBe("stopped");
      expect(stoppedStatus.stopReason).toBe("user requested");
      expect(stoppedStatus.paused).toBe(false);
      expect(engine.state.currentWorkerSessionId).toBeUndefined();

      await engine.start();
      expect(engine.state.stopped).toBe(false);
      expect(engine.state.attempt).toBe(1);
      expect(runtime.spawnedWorkers).toEqual(["worker-1", "worker-2"]);
    } finally {
      engine.dispose();
      try {
        await rm(worktree, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows temp dirs can remain locked briefly after verify subprocesses exit.
      }
    }
  });

  test("pause aborts active worker and resume spawns a replacement", async () => {
    const worktree = await makeFixtureCopy();
    const runtime = createMockRuntime();

    const engine = createLoopEngine(
      { sessionId: "test-session", worktree, bootstrap: true },
      {
        runtime,
        subscribeEvents: (onEvent) => mockSubscribe(runtime, onEvent),
      }
    );

    try {
      await engine.start();
      expect(runtime.spawnedWorkers).toEqual(["worker-1"]);

      await engine.pause("hold");
      expect(engine.state.paused).toBe(true);
      expect(engine.state.currentWorkerSessionId).toBeUndefined();

      await engine.resume();
      expect(engine.state.paused).toBe(false);
      expect(runtime.spawnedWorkers).toEqual(["worker-1", "worker-2"]);
    } finally {
      engine.dispose();
      try {
        await rm(worktree, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows temp dirs can remain locked briefly after verify subprocesses exit.
      }
    }
  });

  test("ignores duplicate concurrent spawns on resume", async () => {
    const worktree = await makeFixtureCopy();
    const runtime = createMockRuntime();

    const engine = createLoopEngine(
      { sessionId: "test-session", worktree, bootstrap: true },
      {
        runtime,
        subscribeEvents: (onEvent) => mockSubscribe(runtime, onEvent),
      }
    );

    try {
      await engine.start();
      await engine.pause();
      await Promise.all([engine.resume(), engine.resume()]);
      expect(runtime.spawnedWorkers).toEqual(["worker-1", "worker-2"]);
    } finally {
      engine.dispose();
      try {
        await rm(worktree, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows temp dirs can remain locked briefly after verify subprocesses exit.
      }
    }
  });

  test("serializes concurrent handleEvent calls", async () => {
    const worktree = await makeFixtureCopy();
    const runtime = createMockRuntime();
    const idleCount: number[] = [];

    const engine = createLoopEngine(
      { sessionId: "test-session", worktree, bootstrap: true },
      {
        runtime,
        subscribeEvents: (onEvent) => mockSubscribe(runtime, onEvent),
      }
    );
    engine.on("worker.idle", () => idleCount.push(engine.state.attempt));

    try {
      await engine.start();
      await Promise.all([
        engine.handleEvent({
          type: "session.idle",
          properties: { sessionID: "worker-1" },
        }),
        engine.handleEvent({
          type: "session.idle",
          properties: { sessionID: "worker-1" },
        }),
      ]);

      expect(idleCount).toEqual([1]);
      expect(engine.state.attempt).toBe(2);
      expect(runtime.spawnedWorkers).toEqual(["worker-1", "worker-2"]);
    } finally {
      engine.dispose();
      try {
        await rm(worktree, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows temp dirs can remain locked briefly after verify subprocesses exit.
      }
    }
  });

  test("notifies pending worker questions on idle", async () => {
    const worktree = await makeFixtureCopy();
    const runtime = createMockRuntime();
    const questions: string[] = [];

    const engine = createLoopEngine(
      { sessionId: "test-session", worktree, bootstrap: true },
      {
        runtime,
        subscribeEvents: (onEvent) => mockSubscribe(runtime, onEvent),
      }
    );
    engine.on("worker.question", (payload) => {
      if (payload.questionId) questions.push(payload.questionId);
    });

    try {
      await engine.start();
      await writePendingInput(await loadPlanContext(worktree), {
        questions: [
          {
            id: "ask-42",
            question: "Keep legacy JWT?",
            askedAt: "2026-06-15T00:00:00.000Z",
            from: "worker",
            attempt: 1,
          },
        ],
      });
      await runtime.emitIdle("worker-1");

      expect(questions).toContain("ask-42");
      const status = await engine.status();
      expect(status.pendingQuestions?.[0]?.id).toBe("ask-42");
    } finally {
      engine.dispose();
      try {
        await rm(worktree, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows temp dirs can remain locked briefly after verify subprocesses exit.
      }
    }
  });

  test("runs a full loop in named-plan mode (files + markers in plans/<name>/)", async () => {
    const worktree = await makeNamedFixtureCopy();
    const runtime = createMockRuntime();
    const engine = createLoopEngine(
      { sessionId: "named-session", worktree, bootstrap: true },
      { runtime, subscribeEvents: (onEvent) => mockSubscribe(runtime, onEvent) }
    );

    try {
      await engine.start();

      const ctx = await loadPlanContext(worktree);
      expect(ctx.mode).toBe("named");
      expect(ctx.protocolRel).toBe(".ralph-rlm/plans/default");

      // Protocol files + the attempt marker land under the plan dir, not root.
      expect(
        await fileExists(path.join(ctx.protocolDir, PROTOCOL_FILES.PLAN))
      ).toBe(true);
      expect(await fileExists(path.join(worktree, PROTOCOL_FILES.PLAN))).toBe(false);
      expect(await fileExists(stateFilePath(ctx, "loop_attempt.json"))).toBe(true);

      // Worker question sync works through the plan's .state dir.
      await writePendingInput(ctx, {
        questions: [
          {
            id: "ask-named",
            question: "named?",
            askedAt: "2026-06-15T00:00:00.000Z",
            from: "worker",
            attempt: 1,
          },
        ],
      });
      const withQuestion = await engine.status();
      expect(withQuestion.pendingQuestions?.[0]?.id).toBe("ask-named");

      // Drive to pass and confirm the done file is written in the plan dir.
      await writeFile(path.join(worktree, ".ralph-pass-marker"), "ok\n", "utf8");
      await runtime.emitIdle("worker-1");

      const done = await engine.status();
      expect(done.done).toBe(true);
      const nextRalph = await Bun.file(
        path.join(ctx.protocolDir, PROTOCOL_FILES.NEXT_RALPH)
      ).text();
      expect(nextRalph).toContain("DONE");
    } finally {
      engine.dispose();
      try {
        await rm(worktree, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows temp dirs can remain locked briefly after verify subprocesses exit.
      }
    }
  });
});