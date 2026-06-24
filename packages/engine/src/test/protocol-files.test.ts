import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { DEFAULT_TEMPLATES, PLAN_GOAL_PLACEHOLDER } from "../templates.js";
import {
  PROTOCOL_FILES,
  bootstrapProtocolFiles,
  isPlanAuthored,
  writePlanFile,
} from "../protocol-files.js";
import {
  resolvePlanContext,
  resolvePlansConfig,
  type PlanContext,
} from "../plan-paths.js";

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "ralph-plan-"));
}

const legacyCtx = (root: string): Promise<PlanContext> =>
  resolvePlanContext(root, resolvePlansConfig({ dir: "" }));

const namedCtx = (root: string, name = "default"): Promise<PlanContext> =>
  resolvePlanContext(root, resolvePlansConfig({ dir: ".ralph-rlm/plans" }), name);

describe("bootstrapProtocolFiles goal interpolation", () => {
  test("weaves the goal into PLAN.md when provided", async () => {
    const root = await tempRoot();
    try {
      await bootstrapProtocolFiles(await legacyCtx(root), DEFAULT_TEMPLATES, {
        goal: "Add JWT auth with passing tests",
      });
      const plan = await readFile(path.join(root, PROTOCOL_FILES.PLAN), "utf8");
      expect(plan).toContain("Add JWT auth with passing tests");
      expect(plan).not.toContain(PLAN_GOAL_PLACEHOLDER);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("falls back to a placeholder when no goal is given", async () => {
    const root = await tempRoot();
    try {
      await bootstrapProtocolFiles(await legacyCtx(root), DEFAULT_TEMPLATES);
      const plan = await readFile(path.join(root, PROTOCOL_FILES.PLAN), "utf8");
      expect(plan).toContain(PLAN_GOAL_PLACEHOLDER);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not overwrite an existing authored plan", async () => {
    const root = await tempRoot();
    try {
      const ctx = await legacyCtx(root);
      await writePlanFile(ctx, "# Plan\n\n## Goal\n- Pre-authored goal\n");
      await bootstrapProtocolFiles(ctx, DEFAULT_TEMPLATES, { goal: "ignored" });
      const plan = await readFile(path.join(root, PROTOCOL_FILES.PLAN), "utf8");
      expect(plan).toContain("Pre-authored goal");
      expect(plan).not.toContain("ignored");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("named-plan layout", () => {
  test("writes protocol files under plans/<name>/", async () => {
    const root = await tempRoot();
    try {
      const ctx = await namedCtx(root, "jwt-auth");
      await bootstrapProtocolFiles(ctx, DEFAULT_TEMPLATES, { goal: "Add auth" });
      const plan = await readFile(
        path.join(root, ".ralph-rlm", "plans", "jwt-auth", PROTOCOL_FILES.PLAN),
        "utf8"
      );
      expect(plan).toContain("Add auth");
      expect(ctx.protocolRel).toBe(".ralph-rlm/plans/jwt-auth");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("two plans are isolated", async () => {
    const root = await tempRoot();
    try {
      await writePlanFile(await namedCtx(root, "alpha"), "# Plan\n\n## Goal\n- Alpha\n");
      await writePlanFile(await namedCtx(root, "beta"), "# Plan\n\n## Goal\n- Beta\n");
      const alpha = await readFile(
        path.join(root, ".ralph-rlm", "plans", "alpha", PROTOCOL_FILES.PLAN),
        "utf8"
      );
      const beta = await readFile(
        path.join(root, ".ralph-rlm", "plans", "beta", PROTOCOL_FILES.PLAN),
        "utf8"
      );
      expect(alpha).toContain("Alpha");
      expect(beta).toContain("Beta");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("isPlanAuthored", () => {
  test("false when PLAN.md is missing", async () => {
    const root = await tempRoot();
    try {
      expect(await isPlanAuthored(await legacyCtx(root))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("false for the untouched bootstrap placeholder", async () => {
    const root = await tempRoot();
    try {
      const ctx = await legacyCtx(root);
      await bootstrapProtocolFiles(ctx, DEFAULT_TEMPLATES);
      expect(await isPlanAuthored(ctx)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("true once a real goal is written", async () => {
    const root = await tempRoot();
    try {
      const ctx = await legacyCtx(root);
      await bootstrapProtocolFiles(ctx, DEFAULT_TEMPLATES, { goal: "Real concrete goal" });
      expect(await isPlanAuthored(ctx)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("writePlanFile", () => {
  test("ensures trailing newline", async () => {
    const root = await tempRoot();
    try {
      await writePlanFile(await legacyCtx(root), "# Plan\n\n## Goal\n- x");
      const plan = await readFile(path.join(root, PROTOCOL_FILES.PLAN), "utf8");
      expect(plan.endsWith("\n")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
