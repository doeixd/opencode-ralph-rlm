import path from "node:path";
import { readdir } from "node:fs/promises";
import { fileExists, readTextFile, writeTextFile } from "./fs.js";

/** Well-known plan filename used for legacy-layout auto-detection. */
const PLAN_FILE = "PLAN.md";

/**
 * Where protocol files and sync markers live for a loop. This module is the
 * single seam that knows the on-disk layout — every other module resolves paths
 * through a {@link PlanContext} rather than hard-coding `worktree/PLAN.md`.
 *
 * Two layouts:
 *   - legacy: protocol files at the worktree root, markers under `.opencode/`
 *     (the pre-named-plans behavior; preserved for existing repos).
 *   - named: protocol files under `<plansDir>/<name>/`, markers under
 *     `<plansDir>/<name>/.state/` — multiple named plans you can switch between.
 */

export type PlansConfigInput = {
  /** Base dir for named plans, e.g. ".ralph-rlm/plans". "" / "." = legacy root. */
  dir?: string;
  /** Default active plan name when no active pointer is set. */
  active?: string;
};

export type PlansMode = "auto" | "legacy" | "named";

export type ResolvedPlansConfig = {
  mode: PlansMode;
  dir: string;
  active: string;
};

export const DEFAULT_PLANS_DIR = ".ralph-rlm/plans";
export const DEFAULT_PLAN_NAME = "default";
const ACTIVE_POINTER = ".active";
const STATE_DIRNAME = ".state";
const LEGACY_STATE_DIR = ".opencode";

export function resolvePlansConfig(
  raw: PlansConfigInput | undefined
): ResolvedPlansConfig {
  const active = raw?.active?.trim() || DEFAULT_PLAN_NAME;
  if (raw === undefined || raw.dir === undefined) {
    return { mode: "auto", dir: DEFAULT_PLANS_DIR, active };
  }
  const dir = raw.dir.trim();
  if (dir === "" || dir === ".") {
    return { mode: "legacy", dir: "", active };
  }
  return { mode: "named", dir, active };
}

export type PlanContext = {
  worktree: string;
  mode: "legacy" | "named";
  /** Active plan name; "" in legacy mode. */
  planName: string;
  /** Absolute dir holding PLAN.md, RLM_INSTRUCTIONS.md, … */
  protocolDir: string;
  /** Absolute dir holding loop_attempt.json / pending_input.json. */
  stateDir: string;
  /** protocolDir relative to worktree ("" for legacy root) — for patch prefixes. */
  protocolRel: string;
};

function plansRoot(worktree: string, plans: ResolvedPlansConfig): string {
  return path.join(worktree, plans.dir);
}

/** Sanitize a plan name to a safe single path segment (no traversal). */
export function normalizePlanName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  // Require at least one alphanumeric char so "."/".."/dot-only names can't
  // resolve to the plans root or escape it via path.join.
  if (!/[a-zA-Z0-9]/.test(cleaned)) return DEFAULT_PLAN_NAME;
  return cleaned;
}

export async function readActivePlan(
  worktree: string,
  plans: ResolvedPlansConfig
): Promise<string> {
  const pointer = path.join(plansRoot(worktree, plans), ACTIVE_POINTER);
  if (await fileExists(pointer)) {
    const raw = (await readTextFile(pointer).catch(() => "")).trim();
    if (raw) return normalizePlanName(raw);
  }
  return plans.active;
}

export async function writeActivePlan(
  worktree: string,
  plans: ResolvedPlansConfig,
  name: string
): Promise<string> {
  const normalized = normalizePlanName(name);
  const pointer = path.join(plansRoot(worktree, plans), ACTIVE_POINTER);
  await writeTextFile(pointer, `${normalized}\n`);
  return normalized;
}

export async function listPlans(
  worktree: string,
  plans: ResolvedPlansConfig
): Promise<string[]> {
  if (plans.mode === "legacy") return [];
  const root = plansRoot(worktree, plans);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

function legacyContext(worktree: string): PlanContext {
  return {
    worktree,
    mode: "legacy",
    planName: "",
    protocolDir: worktree,
    stateDir: path.join(worktree, LEGACY_STATE_DIR),
    protocolRel: "",
  };
}

function namedContext(
  worktree: string,
  plans: ResolvedPlansConfig,
  planName: string
): PlanContext {
  const name = normalizePlanName(planName);
  const protocolDir = path.join(plansRoot(worktree, plans), name);
  return {
    worktree,
    mode: "named",
    planName: name,
    protocolDir,
    stateDir: path.join(protocolDir, STATE_DIRNAME),
    protocolRel: path.relative(worktree, protocolDir).split(path.sep).join("/"),
  };
}

/**
 * Resolve the plan context for a worktree. In "auto" mode, an existing root
 * PLAN.md (a legacy install) keeps legacy paths; otherwise the named layout is
 * used. An explicit `plans.dir` (or "" for legacy) always wins.
 */
export async function resolvePlanContext(
  worktree: string,
  plans: ResolvedPlansConfig,
  planName?: string
): Promise<PlanContext> {
  if (plans.mode === "legacy") return legacyContext(worktree);

  if (plans.mode === "auto") {
    const rootPlan = path.join(worktree, PLAN_FILE);
    const namedExists = await fileExists(plansRoot(worktree, plans));
    if ((await fileExists(rootPlan)) && !namedExists) {
      return legacyContext(worktree);
    }
  }

  const name = planName ?? (await readActivePlan(worktree, plans));
  return namedContext(worktree, plans, name);
}

export function protocolFilePath(ctx: PlanContext, file: string): string {
  return path.join(ctx.protocolDir, file);
}

export function stateFilePath(ctx: PlanContext, file: string): string {
  return path.join(ctx.stateDir, file);
}
