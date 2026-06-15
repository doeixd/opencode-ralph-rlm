import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { writeLoopAttemptMarker } from "@ralph-rlm/engine";
import { parseAttemptFromTitle } from "../session-state.js";

describe("worker attempt sync helpers", () => {
  test("parseAttemptFromTitle reads loop worker titles", () => {
    expect(parseAttemptFromTitle("rlm-worker-attempt-4")).toBe(4);
    expect(parseAttemptFromTitle("other")).toBe(0);
  });

  test("loop attempt marker is readable by worker plugin imports", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ralph-worker-attempt-"));
    try {
      await writeLoopAttemptMarker(root, {
        attempt: 2,
        sessionId: "supervisor-1",
      });
      const { readLoopAttemptMarker } = await import("@ralph-rlm/engine");
      expect(await readLoopAttemptMarker(root)).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});