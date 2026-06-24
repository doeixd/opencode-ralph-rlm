import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { loadPlanningPlaybook } from "../lib/planning.js";
import { executeSupervisorTool } from "../lib/supervisor-tools.js";
import {
  isPlanAuthored,
  loadPlanContext,
  protocolFilePath,
  readTextFile,
  writeTextFile,
} from "@doeixd/opencode-ralph-rlm-engine";

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "ralph-planning-"));
}

describe("loadPlanningPlaybook", () => {
  test("returns the baked-in default when no skill file is present", async () => {
    const root = await tempRoot();
    try {
      const playbook = await loadPlanningPlaybook(root);
      expect(playbook).toContain("Planning phase");
      expect(playbook).toContain("write_plan");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("prefers a worktree-local skill copy, stripping frontmatter", async () => {
    const root = await tempRoot();
    try {
      const skillDir = path.join(root, "skills", "interview-and-create-plan");
      await mkdir(skillDir, { recursive: true });
      await writeTextFile(
        path.join(skillDir, "SKILL.md"),
        "---\nname: interview-and-create-plan\n---\n\n# Custom interview\n\nAsk one sharp question.\n"
      );
      const playbook = await loadPlanningPlaybook(root);
      expect(playbook).toContain("Custom interview");
      expect(playbook).not.toContain("name: interview-and-create-plan");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("write_plan supervisor tool", () => {
  test("authors PLAN.md so isPlanAuthored becomes true", async () => {
    const root = await tempRoot();
    try {
      const result = await executeSupervisorTool(
        "write_plan",
        { content: "# Plan\n\n## Goal\n- Ship the planning gate\n" },
        { sessionKey: "sess-1", worktree: root }
      );
      expect(result).toContain('"authored": true');
      const pctx = await loadPlanContext(root);
      expect(await isPlanAuthored(pctx)).toBe(true);
      const plan = await readTextFile(protocolFilePath(pctx, "PLAN.md"));
      expect(plan).toContain("Ship the planning gate");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects empty content", async () => {
    const root = await tempRoot();
    try {
      const result = await executeSupervisorTool(
        "write_plan",
        { content: "   " },
        { sessionKey: "sess-1", worktree: root }
      );
      expect(result).toContain('"ok": false');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
