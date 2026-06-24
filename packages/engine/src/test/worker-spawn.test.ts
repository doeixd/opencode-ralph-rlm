import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { loadWorkerSpawnConfig, RALPH_WORKER_AGENT } from "../worker-spawn.js";
import { DEFAULT_TEMPLATES } from "../templates.js";

async function tempWorktree(providerJson?: unknown): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ralph-worker-"));
  if (providerJson) {
    await mkdir(path.join(root, ".opencode"), { recursive: true });
    await writeFile(
      path.join(root, ".opencode", "ralph-provider.json"),
      JSON.stringify(providerJson)
    );
  }
  return root;
}

describe("loadWorkerSpawnConfig worker-model guard", () => {
  test("rejects the ralph-rlm provider (the supervisor)", async () => {
    const root = await tempWorktree({
      worker: { providerID: "ralph-rlm", modelID: "supervisor" },
    });
    try {
      await expect(loadWorkerSpawnConfig(root, DEFAULT_TEMPLATES)).rejects.toThrow(
        /ralph-rlm/
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts a real coding model", async () => {
    const root = await tempWorktree({
      worker: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
    });
    try {
      const cfg = await loadWorkerSpawnConfig(root, DEFAULT_TEMPLATES);
      expect(cfg.providerID).toBe("opencode");
      expect(cfg.modelID).toBe("deepseek-v4-flash-free");
      expect(cfg.agent).toBe(RALPH_WORKER_AGENT);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("leaves model unset when not configured (no throw)", async () => {
    const root = await tempWorktree();
    try {
      const cfg = await loadWorkerSpawnConfig(root, DEFAULT_TEMPLATES);
      expect(cfg.providerID).toBeUndefined();
      expect(cfg.modelID).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
