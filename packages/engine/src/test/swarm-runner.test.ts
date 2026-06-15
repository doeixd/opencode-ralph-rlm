import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { writeTextFile } from "../fs.js";
import { SwarmRegistry } from "../swarm-registry.js";
import { createMockRuntime, mockSubscribe } from "./mock-runtime.js";

async function makeWorktree(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ralph-swarm-"));
  await writeTextFile(
    path.join(root, ".opencode", "ralph.json"),
    JSON.stringify({
      subAgentEnabled: true,
      swarm: { enabled: true, maxConcurrent: 2, maxTasksPerRun: 8 },
    })
  );
  return root;
}

describe("SwarmRunner", () => {
  test("spawns tasks with concurrency and tracks idle", async () => {
    const worktree = await makeWorktree();
    const runtime = createMockRuntime();
    const registry = new SwarmRegistry();

    try {
      const runner = await registry.spawn(
        "session-1",
        worktree,
        {
          label: "refactor",
          tasks: [
            { name: "auth", goal: "Fix auth module" },
            { name: "api", goal: "Fix api routes" },
            { name: "tests", goal: "Fix tests" },
          ],
          concurrency: 2,
        },
        {
          runtime,
          subscribeEvents: (onEvent) => mockSubscribe(runtime, onEvent),
        }
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(runtime.spawnedWorkers.length).toBe(3);

      for (const sessionId of runtime.spawnedWorkers) {
        await runtime.emitIdle(sessionId);
      }

      await new Promise((r) => setTimeout(r, 50));
      const status = runner.status();
      expect(status.status).toBe("done");
      expect(status.tasks.every((task) => task.status === "idle")).toBe(true);
    } finally {
      registry.dispose();
      await rm(worktree, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  test("rejects duplicate task names at spawn", async () => {
    const worktree = await makeWorktree();
    const runtime = createMockRuntime();
    const registry = new SwarmRegistry();

    try {
      await expect(
        registry.spawn(
          "session-1",
          worktree,
          {
            tasks: [
              { name: "dup", goal: "First" },
              { name: "dup", goal: "Second" },
            ],
          },
          {
            runtime,
            subscribeEvents: (onEvent) => mockSubscribe(runtime, onEvent),
          }
        )
      ).rejects.toThrow("duplicate task name: dup");
    } finally {
      registry.dispose();
      await rm(worktree, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  test("prunes finished swarms from registry", async () => {
    const worktree = await makeWorktree();
    const runtime = createMockRuntime();
    const registry = new SwarmRegistry();

    try {
      const runner = await registry.spawn(
        "session-1",
        worktree,
        {
          tasks: [{ name: "only", goal: "Do work" }],
        },
        {
          runtime,
          subscribeEvents: (onEvent) => mockSubscribe(runtime, onEvent),
        }
      );

      await new Promise((r) => setTimeout(r, 30));
      await runtime.emitIdle("worker-1");
      await new Promise((r) => setTimeout(r, 30));

      expect(runner.status().status).toBe("done");
      expect(registry.get(runner.state.swarmId)).toBeUndefined();
    } finally {
      registry.dispose();
      await rm(worktree, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  test("cancel aborts active swarm", async () => {
    const worktree = await makeWorktree();
    const runtime = createMockRuntime();
    const registry = new SwarmRegistry();

    try {
      const runner = await registry.spawn(
        "session-1",
        worktree,
        {
          tasks: [{ name: "only", goal: "Do work" }],
        },
        {
          runtime,
          subscribeEvents: (onEvent) => mockSubscribe(runtime, onEvent),
        }
      );

      await new Promise((r) => setTimeout(r, 30));
      await registry.cancel(runner.state.swarmId, "test cancel");
      const status = runner.status();
      expect(status.status).toBe("cancelled");
    } finally {
      registry.dispose();
      await rm(worktree, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});