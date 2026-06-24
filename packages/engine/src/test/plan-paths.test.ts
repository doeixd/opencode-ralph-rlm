import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  normalizePlanName,
  resolvePlanContext,
  resolvePlansConfig,
  writeActivePlan,
  readActivePlan,
  listPlans,
} from "../plan-paths.js";

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "ralph-paths-"));
}

describe("normalizePlanName", () => {
  test("rejects traversal / dot-only names", () => {
    expect(normalizePlanName("..")).toBe("default");
    expect(normalizePlanName(".")).toBe("default");
    expect(normalizePlanName("...")).toBe("default");
    expect(normalizePlanName("   ")).toBe("default");
    expect(normalizePlanName("/")).toBe("default");
  });

  test("strips separators and leading/trailing dots", () => {
    expect(normalizePlanName("../etc")).toBe("etc");
    expect(normalizePlanName("foo/bar")).toBe("foo-bar");
    expect(normalizePlanName("  jwt-auth  ")).toBe("jwt-auth");
  });

  test("preserves version-like dots inside the name", () => {
    expect(normalizePlanName("v1.2")).toBe("v1.2");
  });

  test("a traversal name cannot escape the plans dir", async () => {
    const root = await tempRoot();
    try {
      const plans = resolvePlansConfig({ dir: ".ralph-rlm/plans" });
      const ctx = await resolvePlanContext(root, plans, "..");
      // Must stay inside <root>/.ralph-rlm/plans/...
      const base = path.resolve(root, ".ralph-rlm", "plans");
      expect(path.resolve(ctx.protocolDir).startsWith(base)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("resolvePlanContext modes", () => {
  test("legacy: explicit empty dir uses worktree root + .opencode", async () => {
    const root = await tempRoot();
    try {
      const ctx = await resolvePlanContext(root, resolvePlansConfig({ dir: "" }));
      expect(ctx.mode).toBe("legacy");
      expect(ctx.protocolDir).toBe(root);
      expect(ctx.stateDir).toBe(path.join(root, ".opencode"));
      expect(ctx.protocolRel).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("named: explicit dir resolves plans/<active>", async () => {
    const root = await tempRoot();
    try {
      const ctx = await resolvePlanContext(
        root,
        resolvePlansConfig({ dir: ".ralph-rlm/plans", active: "alpha" })
      );
      expect(ctx.mode).toBe("named");
      expect(ctx.planName).toBe("alpha");
      expect(ctx.protocolRel).toBe(".ralph-rlm/plans/alpha");
      expect(ctx.stateDir).toBe(path.join(ctx.protocolDir, ".state"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("auto: existing root PLAN.md keeps legacy", async () => {
    const root = await tempRoot();
    try {
      await writeFile(path.join(root, "PLAN.md"), "# Plan\n");
      const ctx = await resolvePlanContext(root, resolvePlansConfig(undefined));
      expect(ctx.mode).toBe("legacy");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("auto: no root PLAN.md uses named default", async () => {
    const root = await tempRoot();
    try {
      const ctx = await resolvePlanContext(root, resolvePlansConfig(undefined));
      expect(ctx.mode).toBe("named");
      expect(ctx.planName).toBe("default");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("active plan pointer", () => {
  test("write then read round-trips and normalizes", async () => {
    const root = await tempRoot();
    try {
      const plans = resolvePlansConfig({ dir: ".ralph-rlm/plans" });
      const written = await writeActivePlan(root, plans, "JWT Auth!");
      expect(written).toBe("JWT-Auth");
      expect(await readActivePlan(root, plans)).toBe("JWT-Auth");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("listPlans returns dirs, ignoring dotfiles", async () => {
    const root = await tempRoot();
    try {
      const plans = resolvePlansConfig({ dir: ".ralph-rlm/plans" });
      const base = path.join(root, ".ralph-rlm", "plans");
      await mkdir(path.join(base, "alpha"), { recursive: true });
      await mkdir(path.join(base, "beta"), { recursive: true });
      await writeFile(path.join(base, ".active"), "alpha\n");
      expect(await listPlans(root, plans)).toEqual(["alpha", "beta"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
