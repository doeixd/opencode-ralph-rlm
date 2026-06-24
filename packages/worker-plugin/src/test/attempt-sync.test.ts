import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  resolvePlanContext,
  resolvePlansConfig,
  writeLoopAttemptMarker,
} from "@doeixd/opencode-ralph-rlm-engine";
import { parseAttemptFromTitle } from "../session-state.js";

const legacyCtx = (root: string) =>
  resolvePlanContext(root, resolvePlansConfig({ dir: "" }));

describe("worker attempt sync helpers", () => {
  test("parseAttemptFromTitle reads loop worker titles", () => {
    expect(parseAttemptFromTitle("rlm-worker-attempt-4")).toBe(4);
    expect(parseAttemptFromTitle("other")).toBe(0);
  });

  test("loop attempt marker is readable by worker plugin imports", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ralph-worker-attempt-"));
    try {
      const ctx = await legacyCtx(root);
      await writeLoopAttemptMarker(ctx, {
        attempt: 2,
        sessionId: "supervisor-1",
      });
      const { readLoopAttemptMarker } = await import("@doeixd/opencode-ralph-rlm-engine");
      expect(await readLoopAttemptMarker(ctx)).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});