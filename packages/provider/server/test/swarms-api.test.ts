import path from "node:path";
import { mkdtemp, cp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { executeSupervisorTool } from "../lib/supervisor-tools.js";
import { swarmRegistry } from "../lib/swarm-registry.js";
import { requireSwarm } from "../lib/swarms-api.js";
import { createProviderMockRuntime, mockSubscribe } from "./mock-runtime.js";

const fixtureRoot = path.resolve(import.meta.dirname, "../../../../fixtures/minimal-repo");

describe("swarms API and spawn_swarm tool", () => {
  let worktree: string;

  beforeEach(async () => {
    swarmRegistry.dispose();
    worktree = await mkdtemp(path.join(tmpdir(), "ralph-swarms-api-"));
    await cp(fixtureRoot, worktree, { recursive: true });
    await writeFile(
      path.join(worktree, ".opencode", "ralph.json"),
      JSON.stringify({
        subAgentEnabled: true,
        swarm: { enabled: true, maxConcurrent: 2, maxTasksPerRun: 8 },
      }),
      "utf8"
    );
  });

  afterEach(async () => {
    swarmRegistry.dispose();
    try {
      await rm(worktree, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // ignore Windows temp lock
    }
  });

  test("spawn_swarm tool starts a swarm and prunes registry when done", async () => {
    const runtime = createProviderMockRuntime();
    const ctx = {
      sessionKey: "sess-swarm",
      worktree,
      runtime,
      subscribeEvents: (onEvent: (event: unknown) => void | Promise<void>) =>
        mockSubscribe(runtime, onEvent),
    };

    const raw = await executeSupervisorTool(
      "spawn_swarm",
      {
        label: "api-test",
        tasks: [
          { name: "alpha", goal: "Do alpha" },
          { name: "beta", goal: "Do beta" },
        ],
        concurrency: 2,
      },
      ctx
    );

    const parsed = JSON.parse(raw) as {
      ok: boolean;
      swarmId?: string;
      status?: { status: string; tasks: Array<{ name: string }> };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.swarmId).toBeTruthy();
    expect(parsed.status?.tasks).toHaveLength(2);
    expect(swarmRegistry.get(parsed.swarmId!)).toBeDefined();

    await new Promise((r) => setTimeout(r, 40));
    for (const sessionId of runtime.spawnedWorkers) {
      await runtime.emitIdle(sessionId);
    }
    await new Promise((r) => setTimeout(r, 40));

    expect(swarmRegistry.listForSession("sess-swarm")).toHaveLength(0);
    expect(requireSwarm(parsed.swarmId!).status).toBeNull();
  });

  test("swarm_status lists session swarms", async () => {
    const runtime = createProviderMockRuntime();
    const ctx = {
      sessionKey: "sess-list",
      worktree,
      runtime,
      subscribeEvents: (onEvent: (event: unknown) => void | Promise<void>) =>
        mockSubscribe(runtime, onEvent),
    };
    await executeSupervisorTool(
      "spawn_swarm",
      {
        tasks: [{ name: "only", goal: "Work" }],
      },
      ctx
    );

    const raw = await executeSupervisorTool("swarm_status", {}, ctx);
    const parsed = JSON.parse(raw) as { ok: boolean; swarms?: Array<{ swarmId: string }> };
    expect(parsed.ok).toBe(true);
    expect(parsed.swarms?.length).toBe(1);
  });

  test("swarm_cancel removes swarm from registry", async () => {
    const runtime = createProviderMockRuntime();
    const ctx = {
      sessionKey: "sess-cancel",
      worktree,
      runtime,
      subscribeEvents: (onEvent: (event: unknown) => void | Promise<void>) =>
        mockSubscribe(runtime, onEvent),
    };
    const spawnRaw = await executeSupervisorTool(
      "spawn_swarm",
      {
        tasks: [{ name: "only", goal: "Work" }],
      },
      ctx
    );
    const spawnParsed = JSON.parse(spawnRaw) as { swarmId: string };
    await new Promise((r) => setTimeout(r, 30));

    const cancelRaw = await executeSupervisorTool(
      "swarm_cancel",
      { swarmId: spawnParsed.swarmId, reason: "test" },
      ctx
    );
    const cancelParsed = JSON.parse(cancelRaw) as { ok: boolean; cancelled: boolean };
    expect(cancelParsed.ok).toBe(true);
    expect(cancelParsed.cancelled).toBe(true);
    expect(swarmRegistry.get(spawnParsed.swarmId)).toBeUndefined();
  });
});