import path from "node:path";
import { readTextFile, fileExists } from "@doeixd/opencode-ralph-rlm-engine";

const SKILL_REL_PATH = "skills/interview-and-create-plan/SKILL.md";

/**
 * Condensed planning playbook used as the supervisor's planning-phase system
 * prompt (Path A — supervisor runs the interview itself). The canonical,
 * human-facing version is the `interview-and-create-plan` skill; this mirror
 * keeps Path A working even when no skill file is present in the worktree.
 */
const DEFAULT_PLANNING_PLAYBOOK = [
  "# Planning phase (interview-and-create-plan)",
  "",
  "You are running the planning interview BEFORE starting the loop. Do NOT call",
  "start_loop until an authored plan exists and the user has approved it.",
  "",
  "## Process",
  "1. Understand — use repo_search / repo_grep to learn the current",
  "   state. Interview the user relentlessly to sharpen the goal. Challenge",
  "   conflicting terms, sharpen fuzzy/overloaded words to canonical ones, probe",
  "   edge cases with concrete scenarios, and cross-reference claims against the",
  "   code — surface contradictions. State assumptions explicitly and confirm them",
  "   with the user (mark which you're guessing). Ask what success looks like (this",
  "   becomes the Definition of Done and should align with verify.command).",
  "2. Sketch — propose where to test the feature (seams). Prefer existing seams;",
  "   use the highest seam possible; fewer is better. Present candidate solutions",
  "   for the user to react to. Do NOT include file paths or code snippets.",
  "3. Plan — once goal and shape are agreed, call write_plan with a complete",
  "   PLAN.md: lead with high-level goals and domain info, then milestones, open",
  "   questions, success criteria, invariants, decisions/quotes, blockers, notes.",
  "   Keep headings ## Goal, ## Definition of Done, ## Milestones. Record",
  "   assumptions in ## Assumptions; for any load-bearing UNVERIFIED assumption,",
  "   add an early milestone to test it before building on it.",
  "4. Verify — agree the verify.command (the loop's only stop condition) WITH the",
  "   user. It must actually test the goal (not just exit 0), be deterministic,",
  "   and FAIL before the work is done. Use set_verify to write it and run_verify",
  "   to validate — a red (failing) baseline now is the goal. Sharpen until it",
  "   genuinely captures 'done'.",
  "5. Review — read the plan + verify command back, confirm details and ordering,",
  "   and loop until the user is satisfied. Disagreement means you're not done.",
  "6. Only after explicit approval, call start_loop (bootstrap false — the plan",
  "   already exists) to launch attempt 1.",
  "",
  "Lead the conversation with questions. One sharp question at a time beats a wall",
  "of them. The plan is authority over chat history for every worker, so make it",
  "bullet-proof.",
].join("\n");

function stripFrontmatter(markdown: string): string {
  const trimmed = markdown.replace(/^﻿/, "");
  if (!trimmed.startsWith("---")) return trimmed;
  const end = trimmed.indexOf("\n---", 3);
  if (end === -1) return trimmed;
  const after = trimmed.indexOf("\n", end + 1);
  return after === -1 ? "" : trimmed.slice(after + 1).trimStart();
}

/**
 * Load the planning playbook. Prefers a worktree-local copy of the skill (so a
 * repo can customize its interview), falling back to the baked-in default.
 */
export async function loadPlanningPlaybook(worktree: string): Promise<string> {
  const skillPath = path.join(worktree, SKILL_REL_PATH);
  if (await fileExists(skillPath)) {
    const raw = await readTextFile(skillPath).catch(() => "");
    const body = stripFrontmatter(raw).trim();
    if (body) return body;
  }
  return DEFAULT_PLANNING_PLAYBOOK;
}
