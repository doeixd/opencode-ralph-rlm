import path from "node:path";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { DEFAULT_TEMPLATES } from "../templates.js";
import { PROTOCOL_FILES } from "../protocol-files.js";
import { rolloverState } from "../rollover.js";
import { resolvePlanContext, resolvePlansConfig } from "../plan-paths.js";
import { writeTextFile } from "../fs.js";

const legacyCtx = (root: string) =>
  resolvePlanContext(root, resolvePlansConfig({ dir: "" }));

describe("rolloverState", () => {
  test("snapshots CURRENT_STATE and resets scratch files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ralph-rollover-"));
    try {
      await mkdir(path.join(root, ".opencode"), { recursive: true });
      await writeTextFile(
        path.join(root, PROTOCOL_FILES.CURR),
        "# Current State\n\n- worked on auth\n"
      );
      await writeTextFile(
        path.join(root, PROTOCOL_FILES.NEXT_RALPH),
        "# Next Ralph Context\n\n- initial\n"
      );

      await rolloverState(await legacyCtx(root), DEFAULT_TEMPLATES, 1, "fail", "tests failed");

      const prev = await readFile(path.join(root, PROTOCOL_FILES.PREV), "utf8");
      const curr = await readFile(path.join(root, PROTOCOL_FILES.CURR), "utf8");
      const next = await readFile(path.join(root, PROTOCOL_FILES.NEXT_RALPH), "utf8");

      expect(prev).toContain("worked on auth");
      expect(curr).toBe(DEFAULT_TEMPLATES.bootstrapCurrentState);
      expect(next).toContain("Verdict: fail");
      expect(next).toContain("Previous attempt 1 ended with verdict: fail.");
      expect(next).toContain("ralph_load_context() FIRST");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});