import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  LOOP_ATTEMPT_REL_PATH,
  readLoopAttemptMarker,
  writeLoopAttemptMarker,
} from "../loop-attempt.js";
import { resolvePlanContext, resolvePlansConfig } from "../plan-paths.js";
import { fileExists } from "../fs.js";

const legacyCtx = (root: string) =>
  resolvePlanContext(root, resolvePlansConfig({ dir: "" }));

describe("loop-attempt marker", () => {
  test("writes and reads attempt number", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ralph-attempt-"));
    try {
      const ctx = await legacyCtx(root);
      await writeLoopAttemptMarker(ctx, {
        attempt: 3,
        sessionId: "sess-1",
        workerSessionId: "worker-3",
      });

      expect(await fileExists(path.join(root, LOOP_ATTEMPT_REL_PATH))).toBe(true);
      expect(await readLoopAttemptMarker(ctx)).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});