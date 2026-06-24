import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { RalphWorkerPlugin } from "../ralph-worker.js";

function mockClient(title: string) {
  return {
    session: { get: async () => ({ data: { title } }) },
    tui: { showToast: async () => {} },
  };
}

async function loadHooks(title: string) {
  const worktree = await mkdtemp(path.join(tmpdir(), "ralph-scope-"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hooks = await RalphWorkerPlugin({ client: mockClient(title), worktree } as any);
  return { hooks: hooks as any, worktree };
}

describe("plugin scoping: normal vs worker sessions", () => {
  test("worker system prompt is injected only in worker sessions", async () => {
    const worker = await loadHooks("rlm-worker-attempt-1");
    const normal = await loadHooks("My normal chat");
    try {
      const wOut: { system?: string[] } = {};
      await worker.hooks["experimental.chat.system.transform"]({ sessionID: "w" }, wOut);
      expect(wOut.system?.length).toBe(1);

      const nOut: { system?: string[] } = {};
      await normal.hooks["experimental.chat.system.transform"]({ sessionID: "n" }, nOut);
      expect(nOut.system ?? []).toEqual([]);
    } finally {
      await rm(worker.worktree, { recursive: true, force: true });
      await rm(normal.worktree, { recursive: true, force: true });
    }
  });

  test("normal session: edit/bash are NOT gated", async () => {
    const { hooks, worktree } = await loadHooks("Just a chat");
    try {
      // Must not throw — the gate must not apply to non-worker sessions.
      await hooks["tool.execute.before"]({ sessionID: "n", tool: "edit" });
      await hooks["tool.execute.before"]({ sessionID: "n", tool: "bash" });
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("normal session: Ralph tools are blocked (inert)", async () => {
    const { hooks, worktree } = await loadHooks("Just a chat");
    try {
      await expect(
        hooks["tool.execute.before"]({ sessionID: "n", tool: "ralph_load_context" })
      ).rejects.toThrow(/Ralph/);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("worker session: edit is gated until ralph_load_context", async () => {
    const { hooks, worktree } = await loadHooks("rlm-worker-attempt-2");
    try {
      await expect(
        hooks["tool.execute.before"]({ sessionID: "w", tool: "edit" })
      ).rejects.toThrow();
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("compaction context only added in worker sessions", async () => {
    const worker = await loadHooks("rlm-worker-attempt-1");
    const normal = await loadHooks("chat");
    try {
      const wOut: { context?: string[] } = {};
      await worker.hooks["experimental.session.compacting"]({ sessionID: "w" }, wOut);
      expect(wOut.context?.length).toBe(1);

      const nOut: { context?: string[] } = {};
      await normal.hooks["experimental.session.compacting"]({ sessionID: "n" }, nOut);
      expect(nOut.context ?? []).toEqual([]);
    } finally {
      await rm(worker.worktree, { recursive: true, force: true });
      await rm(normal.worktree, { recursive: true, force: true });
    }
  });
});
