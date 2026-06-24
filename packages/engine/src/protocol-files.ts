import { spawn } from "node:child_process";
import path from "node:path";
import {
  ensureTextFile,
  fileExists,
  PatchError,
  readTextFile,
  removeFile,
  writeTextFile,
} from "./fs.js";
import { interpolate, nowISO } from "./text.js";
import {
  PLAN_DOD_PLACEHOLDER,
  PLAN_GOAL_PLACEHOLDER,
  type EngineTemplates,
} from "./templates.js";
import { loadConfig } from "./config.js";
import {
  protocolFilePath,
  resolvePlanContext,
  type PlanContext,
} from "./plan-paths.js";

export const PROTOCOL_FILES = {
  PLAN: "PLAN.md",
  RLM_INSTR: "RLM_INSTRUCTIONS.md",
  NEXT_RALPH: "AGENT_CONTEXT_FOR_NEXT_RALPH.md",
  RLM_CTX: "CONTEXT_FOR_RLM.md",
  PREV: "PREVIOUS_STATE.md",
  CURR: "CURRENT_STATE.md",
  NOTES: "NOTES_AND_LEARNINGS.md",
  TODOS: "TODOS.md",
  SUPERVISOR_LOG: "SUPERVISOR_LOG.md",
  CONVERSATION: "CONVERSATION.md",
} as const;

export type ProtocolFileName = (typeof PROTOCOL_FILES)[keyof typeof PROTOCOL_FILES];

/** Load the active plan context for a worktree (config + named-plan layout). */
export async function loadPlanContext(
  worktree: string,
  planName?: string
): Promise<PlanContext> {
  const config = await loadConfig(worktree);
  return resolvePlanContext(worktree, config.plans, planName);
}

export type BootstrapOptions = {
  /** User goal woven into PLAN.md. Falls back to a placeholder when absent. */
  goal?: string;
  /** Acceptance criteria woven into the Definition of Done section. */
  definitionOfDone?: string;
};

export async function bootstrapProtocolFiles(
  ctx: PlanContext,
  templates: EngineTemplates,
  options: BootstrapOptions = {}
): Promise<void> {
  const ts = nowISO();
  const goal = options.goal?.trim() || PLAN_GOAL_PLACEHOLDER;
  const definitionOfDone =
    options.definitionOfDone?.trim() || PLAN_DOD_PLACEHOLDER;
  const p = (file: string) => protocolFilePath(ctx, file);

  await Promise.all([
    ensureTextFile(
      p(PROTOCOL_FILES.PLAN),
      interpolate(templates.bootstrapPlan, { timestamp: ts, goal, definitionOfDone })
    ),
    ensureTextFile(
      p(PROTOCOL_FILES.RLM_INSTR),
      interpolate(templates.bootstrapRlmInstructions, { timestamp: ts })
    ),
    ensureTextFile(
      p(PROTOCOL_FILES.NEXT_RALPH),
      `# Next Ralph Context\n\n- ${ts} created\n`
    ),
    ensureTextFile(
      p(PROTOCOL_FILES.RLM_CTX),
      `# Context For RLM\n\n(paste large reference documents here; access via rlm_grep + rlm_slice)\n`
    ),
    ensureTextFile(
      p(PROTOCOL_FILES.PREV),
      `# Previous State\n\n(none yet)\n`
    ),
    ensureTextFile(
      p(PROTOCOL_FILES.CURR),
      templates.bootstrapCurrentState
    ),
    ensureTextFile(
      p(PROTOCOL_FILES.NOTES),
      [
        "# Notes and Learnings",
        "",
        "Curated, durable knowledge for this work. Edit, reorganize, and prune freely —",
        "this is a living knowledge base, not an append-only log. Keep it accurate.",
        "",
        "Prefer linking to authoritative project docs over restating them:",
        "- Domain glossary: (link)",
        "- ADRs / decision records: (link)",
        "- Design docs / runbooks: (link)",
        "",
        "## Learnings",
        `- ${ts} created`,
        "",
      ].join("\n")
    ),
    ensureTextFile(
      p(PROTOCOL_FILES.TODOS),
      `# Todos\n\n- [ ] (optional)\n`
    ),
    ensureTextFile(
      p(PROTOCOL_FILES.SUPERVISOR_LOG),
      `# Supervisor Log (append-only)\n\n- ${ts} created\n`
    ),
    ensureTextFile(
      p(PROTOCOL_FILES.CONVERSATION),
      `# Conversation Log (append-only)\n\n- ${ts} created\n`
    ),
  ]);
}

/**
 * True when PLAN.md exists and has been given a real goal — i.e. it is not the
 * untouched bootstrap placeholder. Both planning paths (the interview skill and
 * the supervisor planning phase) produce an authored plan; this lets start_loop
 * skip re-bootstrapping and launch directly.
 */
export async function isPlanAuthored(ctx: PlanContext): Promise<boolean> {
  const planPath = protocolFilePath(ctx, PROTOCOL_FILES.PLAN);
  if (!(await fileExists(planPath))) return false;
  const raw = await readTextFile(planPath).catch(() => "");
  if (!raw.trim()) return false;
  return !raw.includes(PLAN_GOAL_PLACEHOLDER);
}

/**
 * Write a fully authored PLAN.md (replacing any bootstrap placeholder). Used by
 * the supervisor `write_plan` tool after the interview reaches an approved plan.
 */
export async function writePlanFile(
  ctx: PlanContext,
  content: string
): Promise<void> {
  const body = content.endsWith("\n") ? content : `${content}\n`;
  await writeTextFile(protocolFilePath(ctx, PROTOCOL_FILES.PLAN), body);
}

/**
 * Apply a unified-diff patch that targets a single protocol file. In named-plan
 * mode the patch's path headers (authored against a bare `PLAN.md`) are rewritten
 * to the plan's real location before `git apply` runs in the worktree.
 */
export async function applyProtocolPatch(
  ctx: PlanContext,
  file: string,
  patchText: string
): Promise<void> {
  const patch =
    ctx.mode === "named" && ctx.protocolRel
      ? rewritePatchPaths(patchText, file, `${ctx.protocolRel}/${file}`)
      : patchText;
  await applyPatch(ctx.worktree, patch);
}

/**
 * Rewrite `a/<from>` / `b/<from>` path prefixes to `a/<to>` / `b/<to>`.
 *
 * Only the `a/`,`b/` form is handled because `applyPatch` runs `git apply` with
 * the default `-p1`, which strips exactly one leading component — so a bare
 * `--- PLAN.md` (no prefix) does not apply under `-p1` in either layout and must
 * not be "fixed" here (prepending a dir would then be mis-stripped).
 */
function rewritePatchPaths(patch: string, from: string, to: string): string {
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return patch.replace(new RegExp(`([ab])/${esc}`, "g"), `$1/${to}`);
}

export async function applyPatch(
  worktree: string,
  patchText: string
): Promise<void> {
  const tmp = path.join(worktree, ".opencode", "tmp", `patch-${Date.now()}.diff`);

  try {
    await writeTextFile(tmp, patchText);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "git",
        ["-C", worktree, "apply", "--whitespace=nowarn", tmp],
        { windowsHide: true }
      );
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (err) => reject(new PatchError(String(err))));
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new PatchError(stderr.trim() || `git apply exited ${code}`));
      });
    });
  } catch (err) {
    if (err instanceof PatchError) throw err;
    throw new PatchError(String(err));
  } finally {
    await removeFile(tmp);
  }
}