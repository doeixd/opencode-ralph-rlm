import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { writeTextFile } from "../fs.js";
import { runSwarmScript } from "../swarm-script-runner.js";

describe("swarm-script-runner", () => {
  test("refuses unsafe eval when disabled", async () => {
    const worktree = await mkdtemp(path.join(tmpdir(), "ralph-swarm-script-"));
    try {
      await writeTextFile(
        path.join(worktree, ".opencode", "ralph.json"),
        JSON.stringify({ swarm: { unsafeEvalEnabled: false } })
      );

      const result = await runSwarmScript({
        worktree,
        swarmId: "swarm-test",
        code: "await report({ ok: true });",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("disabled");
      expect(result.scriptPath).toBe("");
    } finally {
      await rm(worktree, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  test("wraps unsafe scripts with spawn cap prelude", async () => {
    const worktree = await mkdtemp(path.join(tmpdir(), "ralph-swarm-script-"));
    try {
      await writeTextFile(
        path.join(worktree, ".opencode", "ralph.json"),
        JSON.stringify({
          swarm: { unsafeEvalEnabled: true, maxUnsafeScriptSpawns: 3 },
        })
      );

      const result = await runSwarmScript({
        worktree,
        swarmId: "swarm-cap-test",
        code: "await report({ ok: true });",
        timeoutMinutes: 1,
      });

      expect(result.scriptPath).not.toBe("");
      const source = await Bun.file(result.scriptPath).text();
      expect(source).toContain("__ralph_maxSpawns = 3");
      expect(source).toContain("spawn cap exceeded");
    } finally {
      await rm(worktree, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});