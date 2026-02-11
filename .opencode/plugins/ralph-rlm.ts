/**
 * ralph-rlm.ts
 *
 * OpenCode plugin: Ralph (outer supervisor loop) + RLM (inner file-first agent loop).
 * Built with Effect-TS for composable, typed async + error handling.
 *
 * Architecture:
 *   - Ralph outer loop  : watches session.idle → runs verify → rolls state → re-prompts agent
 *   - RLM inner loop    : file-first discipline enforced via tool gating + grep/slice tools
 *   - Sub-agent support : spawn / peek / await child sessions for parallel decomposition
 *
 * Install:
 *   .opencode/plugins/ralph-rlm.ts   (project-level)
 *   ~/.config/opencode/plugins/       (global)
 *
 * Config: .opencode/ralph.json (auto-bootstrapped with defaults if absent)
 *
 * ── Prompt customisation via environment variables ───────────────────────────
 *
 * Every internal prompt/template has a corresponding env var. Values are read
 * at plugin startup and cached for the process lifetime.
 *
 * Supported formats for each env var:
 *   "literal text with \\n escapes"   → \\n is expanded to a real newline
 *   "@relative/path/to/file.txt"      → content read from that file (relative to worktree)
 *   "@/absolute/path/to/file.txt"     → content read from that absolute path
 *
 * Template tokens ({{token}}) are interpolated at call-time, not load-time.
 *
 * ┌─────────────────────────────────────┬────────────────────────────────────────────────────────┐
 * │ Env var                             │ Description + available tokens                         │
 * ├─────────────────────────────────────┼────────────────────────────────────────────────────────┤
 * │ RALPH_SYSTEM_PROMPT                 │ Full system prompt injected on every turn.             │
 * │ RALPH_SYSTEM_PROMPT_APPEND          │ Appended AFTER the default (or custom) system prompt.  │
 * │ RALPH_COMPACTION_CONTEXT            │ Context block injected on session compaction.          │
 * │ RALPH_CONTINUE_PROMPT               │ Re-prompt sent to agent after failed verify.           │
 * │                                     │ Tokens: {{attempt}} {{verdict}}                        │
 * │ RALPH_DONE_FILE_CONTENT             │ Written to AGENT_CONTEXT_FOR_NEXT_RALPH.md on pass.    │
 * │                                     │ Tokens: {{timestamp}}                                  │
 * │ RALPH_SUBAGENT_PROMPT               │ Initial prompt sent to a spawned sub-agent.            │
 * │                                     │ Tokens: {{name}} {{goal}} {{context}} {{stateDir}}     │
 * │                                     │         {{doneSentinel}} {{doneHeading}}                │
 * │ RALPH_SUBAGENT_DONE_SENTINEL        │ Sentinel phrase sub-agent must output when done.       │
 * │                                     │ Default: SUB_AGENT_DONE                                │
 * │ RALPH_SUBAGENT_DONE_HEADING         │ Heading in CURRENT_STATE.md that marks completion.     │
 * │                                     │ Default: ## Final Result                               │
 * │ RALPH_BOOTSTRAP_RLM_INSTRUCTIONS    │ Initial content written to RLM_INSTRUCTIONS.md.        │
 * │                                     │ Tokens: {{timestamp}}                                  │
 * │ RALPH_BOOTSTRAP_CURRENT_STATE       │ Initial content written to CURRENT_STATE.md.           │
 * │ RALPH_CONTEXT_GATE_ERROR            │ Error thrown when destructive tool used without        │
 * │                                     │ calling ralph_load_context() first.                    │
 * │ RALPH_WORKER_SYSTEM_PROMPT          │ System prompt injected into every RLM worker session.  │
 * │ RALPH_WORKER_PROMPT                 │ Initial prompt sent to each spawned RLM worker.        │
 * │                                     │ Tokens: {{attempt}}                                    │
 * │ RALPH_SESSION_SYSTEM_PROMPT         │ System prompt injected into Ralph strategist sessions. │
 * │ RALPH_SESSION_PROMPT                │ Initial prompt sent to each spawned Ralph session.     │
 * │                                     │ Tokens: {{attempt}}                                    │
 * └─────────────────────────────────────┴────────────────────────────────────────────────────────┘
 */

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin/tool";
import * as NodePath from "path";
import { promises as NodeFs } from "fs";
import { spawn } from "child_process";
import {
  Effect,
  Schema,
} from "effect";

// ─────────────────────────────────────────────────────────────────────────────
// § 1. Schemas + Config
// ─────────────────────────────────────────────────────────────────────────────

const VerifyConfigSchema = Schema.Struct({
  command: Schema.Array(Schema.String),
  cwd: Schema.optional(Schema.String),
});

const RalphConfigSchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  autoStartOnMainIdle: Schema.optional(Schema.Boolean),
  statusVerbosity: Schema.optional(Schema.Union(Schema.Literal("minimal"), Schema.Literal("normal"), Schema.Literal("verbose"))),
  maxAttempts: Schema.optional(Schema.Number),
  heartbeatMinutes: Schema.optional(Schema.Number),
  verifyTimeoutMinutes: Schema.optional(Schema.Number),
  verify: Schema.optional(VerifyConfigSchema),
  gateDestructiveToolsUntilContextLoaded: Schema.optional(Schema.Boolean),
  maxRlmSliceLines: Schema.optional(Schema.Number),
  requireGrepBeforeLargeSlice: Schema.optional(Schema.Boolean),
  grepRequiredThresholdLines: Schema.optional(Schema.Number),
  subAgentEnabled: Schema.optional(Schema.Boolean),
  maxSubAgents: Schema.optional(Schema.Number),
  maxConversationLines: Schema.optional(Schema.Number),
  conversationArchiveCount: Schema.optional(Schema.Number),
  reviewerEnabled: Schema.optional(Schema.Boolean),
  reviewerRequireExplicitReady: Schema.optional(Schema.Boolean),
  reviewerMaxRunsPerAttempt: Schema.optional(Schema.Number),
  reviewerOutputDir: Schema.optional(Schema.String),
  reviewerPostToConversation: Schema.optional(Schema.Boolean),
  /**
   * Path (relative to repo root) of the project AGENT.md file.
   * When set, ralph_load_context() reads it and includes its content in the
   * returned context payload so the agent always sees it — even in sub-agents
   * that run in isolated sessions where OpenCode may not inject it automatically.
   *
   * Set to "" or null to disable (content will simply be omitted from the payload).
   * Default: "AGENT.md"
   */
  agentMdPath: Schema.optional(Schema.String),
});

type RalphConfig = Schema.Schema.Type<typeof RalphConfigSchema>;

type ResolvedConfig = {
  enabled: boolean;
  autoStartOnMainIdle: boolean;
  statusVerbosity: "minimal" | "normal" | "verbose";
  maxAttempts: number;
  heartbeatMinutes: number;
  verifyTimeoutMinutes: number;
  verify?: { command: string[]; cwd?: string };
  gateDestructiveToolsUntilContextLoaded: boolean;
  maxRlmSliceLines: number;
  requireGrepBeforeLargeSlice: boolean;
  grepRequiredThresholdLines: number;
  subAgentEnabled: boolean;
  maxSubAgents: number;
  maxConversationLines: number;
  conversationArchiveCount: number;
  reviewerEnabled: boolean;
  reviewerRequireExplicitReady: boolean;
  reviewerMaxRunsPerAttempt: number;
  reviewerOutputDir: string;
  reviewerPostToConversation: boolean;
  /** Relative path to AGENT.md; empty string disables inclusion. */
  agentMdPath: string;
};

function toBoundedInt(
  value: number | undefined,
  fallback: number,
  min: number,
  max = Number.MAX_SAFE_INTEGER
): number {
  const candidate = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const n = Math.trunc(candidate);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitizeVerify(
  verify: RalphConfig["verify"]
): ResolvedConfig["verify"] {
  if (!verify) return undefined;
  const command = verify.command
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (command.length === 0) return undefined;
  const cwd = verify.cwd?.trim();
  return cwd ? { command, cwd } : { command };
}

const CONFIG_DEFAULTS: ResolvedConfig = {
  enabled: true,
  autoStartOnMainIdle: false,
  statusVerbosity: "normal",
  maxAttempts: 20,
  heartbeatMinutes: 15,
  verifyTimeoutMinutes: 0,
  gateDestructiveToolsUntilContextLoaded: true,
  maxRlmSliceLines: 200,
  requireGrepBeforeLargeSlice: true,
  grepRequiredThresholdLines: 120,
  subAgentEnabled: true,
  maxSubAgents: 5,
  maxConversationLines: 1200,
  conversationArchiveCount: 3,
  reviewerEnabled: false,
  reviewerRequireExplicitReady: true,
  reviewerMaxRunsPerAttempt: 1,
  reviewerOutputDir: ".opencode/reviews",
  reviewerPostToConversation: true,
  agentMdPath: "AGENT.md",
};

function resolveConfig(raw: RalphConfig): ResolvedConfig {
  const verify = sanitizeVerify(raw.verify);
  const maxRlmSliceLines = toBoundedInt(raw.maxRlmSliceLines, CONFIG_DEFAULTS.maxRlmSliceLines, 10, 2000);
  const grepRequiredThresholdLines = toBoundedInt(
    raw.grepRequiredThresholdLines,
    CONFIG_DEFAULTS.grepRequiredThresholdLines,
    1,
    maxRlmSliceLines
  );

  return {
    enabled: raw.enabled ?? CONFIG_DEFAULTS.enabled,
    autoStartOnMainIdle: raw.autoStartOnMainIdle ?? CONFIG_DEFAULTS.autoStartOnMainIdle,
    statusVerbosity: raw.statusVerbosity ?? CONFIG_DEFAULTS.statusVerbosity,
    maxAttempts: toBoundedInt(raw.maxAttempts, CONFIG_DEFAULTS.maxAttempts, 1, 500),
    heartbeatMinutes: toBoundedInt(raw.heartbeatMinutes, CONFIG_DEFAULTS.heartbeatMinutes, 1, 240),
    verifyTimeoutMinutes: toBoundedInt(raw.verifyTimeoutMinutes, CONFIG_DEFAULTS.verifyTimeoutMinutes, 0, 240),
    ...(verify !== undefined
      ? { verify: verify as NonNullable<ResolvedConfig["verify"]> }
      : {}),
    gateDestructiveToolsUntilContextLoaded:
      raw.gateDestructiveToolsUntilContextLoaded ??
      CONFIG_DEFAULTS.gateDestructiveToolsUntilContextLoaded,
    maxRlmSliceLines,
    requireGrepBeforeLargeSlice:
      raw.requireGrepBeforeLargeSlice ?? CONFIG_DEFAULTS.requireGrepBeforeLargeSlice,
    grepRequiredThresholdLines,
    subAgentEnabled: raw.subAgentEnabled ?? CONFIG_DEFAULTS.subAgentEnabled,
    maxSubAgents: toBoundedInt(raw.maxSubAgents, CONFIG_DEFAULTS.maxSubAgents, 1, 50),
    maxConversationLines: toBoundedInt(raw.maxConversationLines, CONFIG_DEFAULTS.maxConversationLines, 200, 20000),
    conversationArchiveCount: toBoundedInt(raw.conversationArchiveCount, CONFIG_DEFAULTS.conversationArchiveCount, 1, 20),
    reviewerEnabled: raw.reviewerEnabled ?? CONFIG_DEFAULTS.reviewerEnabled,
    reviewerRequireExplicitReady:
      raw.reviewerRequireExplicitReady ?? CONFIG_DEFAULTS.reviewerRequireExplicitReady,
    reviewerMaxRunsPerAttempt: toBoundedInt(raw.reviewerMaxRunsPerAttempt, CONFIG_DEFAULTS.reviewerMaxRunsPerAttempt, 1, 20),
    reviewerOutputDir: raw.reviewerOutputDir?.trim() || CONFIG_DEFAULTS.reviewerOutputDir,
    reviewerPostToConversation: raw.reviewerPostToConversation ?? CONFIG_DEFAULTS.reviewerPostToConversation,
    agentMdPath: raw.agentMdPath ?? CONFIG_DEFAULTS.agentMdPath,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// § 1.5. Prompt Templates
// ─────────────────────────────────────────────────────────────────────────────
//
// Each template string may contain {{token}} placeholders that are expanded
// at call-time via interpolate(). Loading is done once at startup via
// loadPromptTemplates(); the result is passed into anything that emits text.
//
// Env var loading rules (applied per-var):
//   - Undefined / empty → use the built-in default below.
//   - Starts with "@"   → treat remainder as a file path; read its contents.
//   - Otherwise         → use the value directly, expanding literal \n → newline.

type PromptTemplates = {
  /** System prompt injected on every turn (full replacement when set). */
  systemPrompt: string;
  /** Text appended after systemPrompt (even when systemPrompt is overridden). */
  systemPromptAppend: string;
  /** Context block injected during session compaction. */
  compactionContext: string;
  /**
   * Re-prompt sent to the agent after a failed verification attempt.
   * Tokens: {{attempt}}, {{verdict}}
   */
  continuePrompt: string;
  /**
   * Content written to AGENT_CONTEXT_FOR_NEXT_RALPH.md when verify passes.
   * Tokens: {{timestamp}}
   */
  doneFileContent: string;
  /**
   * Initial prompt sent to a spawned sub-agent session.
   * Tokens: {{name}}, {{goal}}, {{context}}, {{stateDir}}, {{doneSentinel}}
   */
  subagentPrompt: string;
  /** Sentinel phrase the sub-agent must output on completion. */
  subagentDoneSentinel: string;
  /** Heading in CURRENT_STATE.md that marks sub-agent completion. */
  subagentDoneHeading: string;
  /**
   * Initial content written to RLM_INSTRUCTIONS.md on first bootstrap.
   * Tokens: {{timestamp}}
   */
  bootstrapRlmInstructions: string;
  /** Initial content written to CURRENT_STATE.md on first bootstrap / rollover. */
  bootstrapCurrentState: string;
  /** Error message thrown when a destructive tool is used without loading context. */
  contextGateError: string;
  /**
   * System prompt injected into every spawned RLM worker session.
   * Describes file-first discipline and the one-pass contract.
   */
  workerSystemPrompt: string;
  /**
   * Initial prompt sent to each spawned RLM worker session.
   * Tokens: {{attempt}}, {{nextAttempt}}
   */
  workerPrompt: string;
  /**
   * System prompt injected into Ralph strategist sessions.
   * Tokens: none (static)
   */
  ralphSessionSystemPrompt: string;
  /**
   * Initial prompt sent to each spawned Ralph strategist session.
   * Tokens: {{attempt}}
   */
  ralphSessionPrompt: string;
};

const DEFAULT_TEMPLATES: PromptTemplates = {
  systemPrompt: [
    "RALPH SUPERVISOR:",
    "- You are the Ralph supervisor. You orchestrate RLM worker sessions; you do NOT write code yourself.",
    "- When the user gives you a goal, describe the task briefly and stop — the plugin will spawn an RLM worker automatically.",
    "- Workers are spawned per-attempt with a fresh context window. They load state from protocol files.",
    "- Protocol files (PLAN.md, RLM_INSTRUCTIONS.md, etc.) persist across all attempts — edit them to guide workers.",
    "- After each worker attempt the plugin runs verify and either finishes or spawns the next worker.",
    "- Spawned sessions (Ralph strategist, RLM worker) may send questions via ralph_ask().",
    "  When you receive one, call ralph_respond(id, answer) to unblock the session.",
    "- Use ralph_doctor() to check setup, ralph_bootstrap_plan() to generate PLAN/TODOS,",
    "  ralph_create_supervisor_session() to bind/start explicitly, ralph_pause_supervision()/ralph_resume_supervision() to control execution, and ralph_end_supervision() to stop.",
    "- End supervision when verification has passed and the user confirms they are done, or when the user explicitly asks to stop the loop.",
    "- Optional reviewer flow: worker marks readiness with ralph_request_review(); supervisor runs ralph_run_reviewer().",
    "- Monitor progress in SUPERVISOR_LOG.md, CONVERSATION.md, or via toast notifications.",
  ].join("\n"),

  systemPromptAppend: "",

  compactionContext: [
    "## File-first protocol (authoritative — reload on resume)",
    "- PLAN.md                         — goals, milestones, definition of done",
    "- RLM_INSTRUCTIONS.md             — inner loop operating manual + playbooks",
    "- AGENT_CONTEXT_FOR_NEXT_RALPH.md — shim from previous attempt (verdict + next step)",
    "- CURRENT_STATE.md                — scratch for this attempt only",
    "- PREVIOUS_STATE.md               — snapshot of last attempt's scratch",
    "- NOTES_AND_LEARNINGS.md          — append-only durable learnings",
    "- CONVERSATION.md                 — append-only supervisor-visible status feed",
    "- CONTEXT_FOR_RLM.md              — large reference; access via rlm_grep + rlm_slice",
    "- .opencode/agents/<name>/        — sub-agent state directories",
  ].join("\n"),

  continuePrompt: [
    "Ralph attempt {{attempt}}: continue.",
    "",
    "Rules:",
    "- Call ralph_load_context() FIRST (required before any write/edit/bash).",
    "- Treat PLAN.md + RLM_INSTRUCTIONS.md as authoritative.",
    "- Use rlm_grep / rlm_slice for CONTEXT_FOR_RLM.md — never dump it whole.",
    "- CURRENT_STATE.md is scratch for this attempt; durable changes go to PLAN.md / NOTES_AND_LEARNINGS.md.",
    "- Sub-agents: subagent_spawn → subagent_await → integrate result.",
    "- If verification is unknown or blocked by tooling, fix verify.command / scripts first.",
    "",
    "Objective: fix the failing verification. When fixed, call ralph_verify().",
  ].join("\n"),

  doneFileContent: [
    "# Next Ralph Context",
    "",
    "- {{timestamp}} DONE",
    "",
    "Verification passed. Loop complete.",
    "",
  ].join("\n"),

  subagentPrompt: [
    'You are sub-agent "{{name}}".',
    "",
    "Goal: {{goal}}",
    "{{context}}",
    "",
    "Protocol:",
    "- Your working files are under: {{stateDir}}/",
    "- Keep CURRENT_STATE.md updated as you work (objective, hypothesis, actions, evidence, result).",
    "- Write durable learnings to NOTES_AND_LEARNINGS.md (append-only).",
    '- When you have completed the goal, write your final answer under a "{{doneHeading}}" heading in CURRENT_STATE.md.',
    "- Then output the exact phrase on its own line: {{doneSentinel}}",
  ].join("\n"),

  subagentDoneSentinel: "SUB_AGENT_DONE",

  subagentDoneHeading: "## Final Result",

  bootstrapRlmInstructions: [
    "# RLM Instructions (Inner Loop Operating Manual)",
    "",
    "## Fixed Header (do not remove)",
    "- You are the inner RLM agent.",
    "- You MUST call ralph_load_context() at the start of EVERY attempt.",
    "- Treat PLAN.md and this file as authoritative.",
    "- Use rlm_grep before reading large files. Prefer rlm_grep + rlm_slice.",
    "- CURRENT_STATE.md is scratch for this attempt only.",
    "- Update PLAN.md only for durable changes (milestone completed, new constraint).",
    "- Write durable learnings to NOTES_AND_LEARNINGS.md (append-only).",
    "- Report meaningful progress with ralph_report() so the supervisor can track attempts in SUPERVISOR_LOG.md and CONVERSATION.md.",
    "- Modify these instructions via ralph_update_rlm_instructions(patch, reason).",
    "",
    "## Skills / MCP Registry (editable)",
    "- (list tools, MCP servers, playbooks)",
    "",
    "## Sub-Agent Playbook (editable)",
    "- Delegate isolated sub-tasks with subagent_spawn(name, goal, context?).",
    "- Inspect sub-agent progress with subagent_peek(name, file?).",
    "- Block until done with subagent_await(name).",
    "- Integrate results back into PLAN.md and CURRENT_STATE.md.",
    "",
    "## Debug Playbook (editable)",
    "- rlm_grep → rlm_slice → hypothesize → ralph_verify → fix → ralph_verify",
    "",
    "## Refactor Playbook (editable)",
    "- isolate change → update tests → ralph_verify → integrate",
    "",
    "## Changelog (append-only)",
    "- {{timestamp}} created",
    "",
  ].join("\n"),

  bootstrapCurrentState: [
    "# Current State (scratch for this Ralph attempt)",
    "",
    "- Objective for this loop:",
    "- Hypothesis:",
    "- Actions taken:",
    "- Evidence:",
    "- Verification result:",
    "- Next step:",
    "",
  ].join("\n"),

  contextGateError:
    "File-first rule violated: call ralph_load_context() before using write / edit / bash.",

  workerSystemPrompt: [
    "FILE-FIRST PROTOCOL — RLM Worker:",
    "- ALWAYS call ralph_load_context() before any other work. It contains everything you need.",
    "- PLAN.md and RLM_INSTRUCTIONS.md are authoritative. Follow them.",
    "- CONTEXT_FOR_RLM.md is large. Access via rlm_grep + rlm_slice only. Never full-dump it.",
    "- CURRENT_STATE.md is scratch for this attempt. Write your progress here.",
    "- NOTES_AND_LEARNINGS.md is append-only. Write durable insights here.",
    "- Send status updates with ralph_report() at start, after major milestones, and before ralph_verify().",
    "- Optionally call ralph_set_status(running|blocked|done|error, note) for explicit state handoff.",
    "- When satisfied with your changes, call ralph_verify() once, then STOP.",
    "  The Ralph supervisor evaluates the result and will spawn the next attempt if needed.",
    "- Do NOT re-prompt yourself. One pass per session.",
  ].join("\n"),

  workerPrompt: [
    "Ralph RLM worker — attempt {{attempt}}.",
    "",
    "Instructions:",
    "1. Call ralph_load_context() FIRST. It contains PLAN.md, RLM_INSTRUCTIONS.md, previous state, and all context.",
    "2. Read AGENT_CONTEXT_FOR_NEXT_RALPH.md for the verdict and next step from the previous attempt.",
    "3. Follow RLM_INSTRUCTIONS.md for project-specific playbooks.",
    "4. Immediately call ralph_report() with your plan for this attempt.",
    "5. Optionally call ralph_set_status('running', '...') once you've scoped the approach.",
    "6. Do the work. Write progress to CURRENT_STATE.md throughout and call ralph_report() at meaningful checkpoints.",
    "7. When done, call ralph_set_status('done', '...') and ralph_report() with outcome + remaining risks, then call ralph_verify().",
    "8. STOP — do not send further messages.",
    "   The Ralph supervisor will handle the result and spawn attempt {{nextAttempt}} if needed.",
  ].join("\n"),

  ralphSessionSystemPrompt: [
    "RALPH STRATEGIST SESSION:",
    "- You are Ralph, the strategic supervisor for one attempt.",
    "- You review failures, update plans and instructions, then delegate coding to an RLM worker.",
    "- You do NOT write code yourself.",
    "- After reviewing state and optionally updating PLAN.md / RLM_INSTRUCTIONS.md,",
    "  call ralph_spawn_worker() to hand off to the RLM worker for this attempt.",
    "- Then STOP. The plugin verifies independently and will spawn the next Ralph session if needed.",
  ].join("\n"),

  ralphSessionPrompt: [
    "Ralph strategist — attempt {{attempt}}.",
    "",
    "Instructions:",
    "1. Call ralph_load_context() to review all protocol files.",
    "2. Read AGENT_CONTEXT_FOR_NEXT_RALPH.md — what failed last time and why.",
    "3. Review PLAN.md — is the goal still correct? Any constraints to add?",
    "4. Optionally call ralph_update_plan() or ralph_update_rlm_instructions() to improve",
    "   guidance for the next worker based on patterns in the failures.",
    "5. Optionally call ralph_set_status('running', 'strategy finalized').",
    "6. Call ralph_report() summarizing strategy changes for this attempt.",
    "7. Call ralph_spawn_worker() to delegate the coding work to a fresh RLM worker.",
    "8. STOP — the plugin handles verification and will spawn attempt {{nextAttempt}} if needed.",
    "",
    "You do not write code. Your value is strategic context adjustment between attempts.",
  ].join("\n"),
};

/**
 * Expand a single env var value into a template string.
 *
 * - `@path`    → read file content (path relative to worktree if not absolute)
 * - `text\\n`  → replace literal \n with real newline (and \t with tab)
 */
async function resolveEnvVar(
  raw: string,
  worktree: string
): Promise<string> {
  if (raw.startsWith("@")) {
    const filePath = raw.slice(1);
    const abs = NodePath.isAbsolute(filePath)
      ? filePath
      : NodePath.join(worktree, filePath);
    return NodeFs.readFile(abs, "utf8");
  }
  // Unescape common escape sequences so multi-line prompts fit in a single env var.
  return raw.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

/** Load all prompt templates, merging env vars over the built-in defaults. */
async function loadPromptTemplates(worktree: string): Promise<PromptTemplates> {
  const env = process.env;

  async function pick(
    envKey: string,
    defaultValue: string
  ): Promise<string> {
    const raw = env[envKey];
    if (!raw) return defaultValue;
    try {
      return await resolveEnvVar(raw, worktree);
    } catch (e) {
      return defaultValue;
    }
  }

  const [
    systemPrompt,
    systemPromptAppend,
    compactionContext,
    continuePrompt,
    doneFileContent,
    subagentPrompt,
    subagentDoneSentinel,
    subagentDoneHeading,
    bootstrapRlmInstructions,
    bootstrapCurrentState,
    contextGateError,
    workerSystemPrompt,
    workerPrompt,
    ralphSessionSystemPrompt,
    ralphSessionPrompt,
  ] = await Promise.all([
    pick("RALPH_SYSTEM_PROMPT",              DEFAULT_TEMPLATES.systemPrompt),
    pick("RALPH_SYSTEM_PROMPT_APPEND",       DEFAULT_TEMPLATES.systemPromptAppend),
    pick("RALPH_COMPACTION_CONTEXT",         DEFAULT_TEMPLATES.compactionContext),
    pick("RALPH_CONTINUE_PROMPT",            DEFAULT_TEMPLATES.continuePrompt),
    pick("RALPH_DONE_FILE_CONTENT",          DEFAULT_TEMPLATES.doneFileContent),
    pick("RALPH_SUBAGENT_PROMPT",            DEFAULT_TEMPLATES.subagentPrompt),
    pick("RALPH_SUBAGENT_DONE_SENTINEL",     DEFAULT_TEMPLATES.subagentDoneSentinel),
    pick("RALPH_SUBAGENT_DONE_HEADING",      DEFAULT_TEMPLATES.subagentDoneHeading),
    pick("RALPH_BOOTSTRAP_RLM_INSTRUCTIONS", DEFAULT_TEMPLATES.bootstrapRlmInstructions),
    pick("RALPH_BOOTSTRAP_CURRENT_STATE",    DEFAULT_TEMPLATES.bootstrapCurrentState),
    pick("RALPH_CONTEXT_GATE_ERROR",         DEFAULT_TEMPLATES.contextGateError),
    pick("RALPH_WORKER_SYSTEM_PROMPT",         DEFAULT_TEMPLATES.workerSystemPrompt),
    pick("RALPH_WORKER_PROMPT",                DEFAULT_TEMPLATES.workerPrompt),
    pick("RALPH_SESSION_SYSTEM_PROMPT",        DEFAULT_TEMPLATES.ralphSessionSystemPrompt),
    pick("RALPH_SESSION_PROMPT",               DEFAULT_TEMPLATES.ralphSessionPrompt),
  ]);

  return {
    systemPrompt,
    systemPromptAppend,
    compactionContext,
    continuePrompt,
    doneFileContent,
    subagentPrompt,
    subagentDoneSentinel,
    subagentDoneHeading,
    bootstrapRlmInstructions,
    bootstrapCurrentState,
    contextGateError,
    workerSystemPrompt,
    workerPrompt,
    ralphSessionSystemPrompt,
    ralphSessionPrompt,
  };
}

/**
 * Replace {{token}} placeholders in a template string.
 * Unknown tokens are left as-is so partial application is safe.
 */
function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// § 2. Session State
// ─────────────────────────────────────────────────────────────────────────────

type SubAgentRecord = {
  sessionId: string;
  name: string;
  goal: string;
  spawnedAt: number;
  status: "running" | "done" | "failed";
  result?: string;
};

const PENDING_INPUT_PATH = ".opencode/pending_input.json";
const REVIEWER_STATE_PATH = ".opencode/reviewer_state.json";

type QuestionRecord = {
  id: string;
  from: SessionRole;
  attempt: number;
  question: string;
  context?: string | undefined;
  askedAt: string;
};

type PendingInputData = {
  questions: QuestionRecord[];
  responses: Record<string, { answer: string; respondedAt: string }>;
};

const readPendingInput = async (root: string): Promise<PendingInputData> => {
  try {
    const raw = await NodeFs.readFile(NodePath.join(root, PENDING_INPUT_PATH), "utf8");
    return JSON.parse(raw) as PendingInputData;
  } catch { return { questions: [], responses: {} }; }
};

const writePendingInput = async (root: string, data: PendingInputData): Promise<void> => {
  const p = NodePath.join(root, PENDING_INPUT_PATH);
  await NodeFs.mkdir(NodePath.dirname(p), { recursive: true });
  await NodeFs.writeFile(p, JSON.stringify(data, null, 2), "utf8");
};

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

type ActiveCommand = {
  child: ReturnType<typeof spawn>;
  label: string;
  startedAt: number;
  timedOut: boolean;
  timeoutTimer?: ReturnType<typeof setTimeout> | undefined;
  killTimer?: ReturnType<typeof setTimeout> | undefined;
};

const activeCommands = new Set<ActiveCommand>();

const stopCommand = (cmd: ActiveCommand, reason: string): void => {
  if (cmd.child.killed) return;
  cmd.timedOut = cmd.timedOut || reason === "timeout";
  try { cmd.child.kill(); } catch {}
  cmd.killTimer = setTimeout(() => {
    try { cmd.child.kill("SIGKILL"); } catch {}
  }, 2000);
};

const stopAllCommands = (reason: string): void => {
  for (const cmd of activeCommands) {
    stopCommand(cmd, reason);
  }
};

async function runCommand(
  command: string[],
  cwd: string,
  options?: { timeoutMs?: number; label?: string }
): Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn(command[0] ?? "", command.slice(1), {
      cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    const entry: ActiveCommand = {
      child,
      label: options?.label ?? command.join(" "),
      startedAt: Date.now(),
      timedOut: false,
    };
    activeCommands.add(entry);

    if (options?.timeoutMs && options.timeoutMs > 0) {
      entry.timeoutTimer = setTimeout(() => {
        stopCommand(entry, "timeout");
      }, options.timeoutMs);
    }

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (err) => {
      if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
      if (entry.killTimer) clearTimeout(entry.killTimer);
      activeCommands.delete(entry);
      resolve({ ok: false, code: null, stdout, stderr: `${stderr}\n${String(err)}`.trim() });
    });

    child.on("close", (code) => {
      if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
      if (entry.killTimer) clearTimeout(entry.killTimer);
      activeCommands.delete(entry);
      const timeoutNote = entry.timedOut ? "\n[ralph] command timed out" : "";
      resolve({ ok: code === 0 && !entry.timedOut, code, stdout, stderr: `${stderr}${timeoutNote}`.trim() });
    });
  });
}

type SetupDiagnostics = {
  ready: boolean;
  issues: string[];
  warnings: string[];
  suggestions: string[];
};

type PlanValidation = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  suggestions: string[];
};

/**
 * The role of a spawned session within the Ralph+RLM hierarchy.
 *
 *  "main"     — the user's session where the plugin is loaded (thin meta-supervisor)
 *  "ralph"    — a short-lived Ralph strategist session (one per attempt)
 *  "worker"   — a short-lived RLM coding session (one per attempt, spawned by Ralph)
 *  "subagent" — ad-hoc child session spawned by a worker for parallel decomposition
 */
type SessionRole = "main" | "ralph" | "worker" | "subagent";

/**
 * Per-session state for all spawned sessions (ralph, worker, subagent).
 * The main session uses SupervisorState instead.
 */
type SessionState = {
  role: SessionRole;
  /** Which attempt number this session is handling. */
  attempt: number;
  /** Whether ralph_load_context() has been called this session. */
  loadedContext: boolean;
  /**
   * For Ralph sessions: whether ralph_spawn_worker() has been called.
   * Prevents the plugin from warning about a "barren" Ralph idle.
   */
  workerSpawned: boolean;
  lastGrepAt?: number | undefined;
  lastGrepQuery?: string | undefined;
  /** Optional explicit progress marker reported by the session. */
  reportedStatus?: "running" | "blocked" | "done" | "error" | undefined;
  /** Optional human-readable note for reportedStatus. */
  reportedStatusNote?: string | undefined;
  /** Last time this session sent explicit progress/status. */
  lastProgressAt?: number | undefined;
  /** Sub-agents spawned by this session (workers only). */
  subAgents: SubAgentRecord[];
};

/**
 * Singleton supervisor state — one instance for the entire plugin lifetime.
 * Lives in the main session's process; orchestrates Ralph and worker sessions.
 */
type SupervisorState = {
  /** Session ID of the main session (set on first main-session idle). */
  sessionId?: string | undefined;
  /** Global attempt counter. Increments before each Ralph session spawn. */
  attempt: number;
  /** Session ID of the current Ralph strategist session. */
  currentRalphSessionId?: string | undefined;
  /** Session ID of the current RLM worker session. */
  currentWorkerSessionId?: string | undefined;
  /** True once verification has passed — stops the loop. */
  done: boolean;
  /** Paused supervision: no automatic spawning while true. */
  paused?: boolean | undefined;
  /** Debounce timestamp for main-session idle. */
  lastMainIdleAt?: number | undefined;
  /** Per-attempt explicit review requests. */
  reviewRequested: Record<number, string>;
  /** Per-attempt reviewer run counter. */
  reviewerRuns: Record<number, number>;
  /** Active reviewer metadata if running. */
  activeReviewerName?: string | undefined;
  activeReviewerAttempt?: number | undefined;
  activeReviewerSessionId?: string | undefined;
  activeReviewerOutputPath?: string | undefined;
};

function freshSession(role: SessionRole = "main", attempt = 0): SessionState {
  return {
    role,
    attempt,
    loadedContext: false,
    workerSpawned: false,
    reportedStatus: undefined,
    reportedStatusNote: undefined,
    lastProgressAt: undefined,
    subAgents: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// § 3. Typed errors
// ─────────────────────────────────────────────────────────────────────────────

class FileError extends Schema.TaggedError<FileError>()("FileError", {
  message: Schema.String,
  path: Schema.String,
}) {}

class PatchError extends Schema.TaggedError<PatchError>()("PatchError", {
  message: Schema.String,
}) {}

class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
}) {}

// ─────────────────────────────────────────────────────────────────────────────
// § 5. File I/O effects
// ─────────────────────────────────────────────────────────────────────────────

const readFile = (p: string): Effect.Effect<string, FileError> =>
  Effect.tryPromise({
    try: () => NodeFs.readFile(p, "utf8"),
    catch: (e) => new FileError({ message: String(e), path: p }),
  });

const writeFile = (p: string, content: string): Effect.Effect<void, FileError> =>
  Effect.tryPromise({
    try: async () => {
      await NodeFs.mkdir(NodePath.dirname(p), { recursive: true });
      await NodeFs.writeFile(p, content, "utf8");
    },
    catch: (e) => new FileError({ message: String(e), path: p }),
  });

const appendFile = (p: string, content: string): Effect.Effect<void, FileError> =>
  Effect.tryPromise({
    try: async () => {
      await NodeFs.mkdir(NodePath.dirname(p), { recursive: true });
      await NodeFs.appendFile(p, content, "utf8");
    },
    catch: (e) => new FileError({ message: String(e), path: p }),
  });

const fileExists = (p: string): Effect.Effect<boolean> =>
  Effect.promise((): Promise<boolean> => NodeFs.stat(p).then(() => true, () => false));

const ensureFile = (p: string, defaultContent: string): Effect.Effect<void, FileError> =>
  Effect.gen(function* () {
    const ok = yield* fileExists(p);
    if (!ok) yield* writeFile(p, defaultContent);
  });

// ─────────────────────────────────────────────────────────────────────────────
// § 6. Text helpers
// ─────────────────────────────────────────────────────────────────────────────

const nowISO = () => new Date().toISOString();

function clampLines(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join("\n") + `\n\n…(truncated to ${maxLines} lines)…\n`;
}

function extractHeadings(md: string, max: number): string {
  const out: string[] = [];
  for (const line of md.split(/\r?\n/)) {
    if (/^#{1,6}\s+/.test(line)) out.push(line.trim());
    if (out.length >= max) break;
  }
  return out.join("\n");
}

function regexFromQuery(query: string): RegExp {
  const slashForm = query.match(/^\/(.*)\/([a-z]*)$/i);
  if (slashForm) {
    const [, pattern, flagsRaw] = slashForm;
    const flags = Array.from(new Set((flagsRaw ?? "").split(""))).join("");
    return new RegExp(pattern ?? "", flags.includes("i") ? flags : `${flags}i`);
  }
  try {
    return new RegExp(query, "i");
  } catch {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, "i");
  }
}

const DESTRUCTIVE_TOOLS = new Set(["write", "edit", "bash", "delete", "move", "rename"]);
const SAFE_TOOLS = new Set([
  "ralph_load_context", "rlm_grep", "rlm_slice",
  "subagent_peek", "ralph_verify",
  "ralph_report", "ralph_ask", "ralph_respond",
]);

// ─────────────────────────────────────────────────────────────────────────────
// § 7. Protocol file constants
// ─────────────────────────────────────────────────────────────────────────────

const FILES = {
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

// ─────────────────────────────────────────────────────────────────────────────
// § 8. Config loader (Effect)
// ─────────────────────────────────────────────────────────────────────────────

const loadConfig = (worktree: string): Effect.Effect<ResolvedConfig> =>
  Effect.gen(function* () {
    const cfgPath = NodePath.join(worktree, ".opencode", "ralph.json");
    const ok = yield* fileExists(cfgPath);
    if (!ok) return CONFIG_DEFAULTS;

    const raw = yield* readFile(cfgPath).pipe(Effect.orElseSucceed(() => "{}"));
    const json = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: () => new ConfigError({ message: "ralph.json is not valid JSON" }),
    }).pipe(Effect.orElseSucceed(() => ({}) as unknown));

    const decoded = yield* Schema.decodeUnknown(RalphConfigSchema)(json).pipe(
      Effect.orElseSucceed(() => ({}) as RalphConfig)
    );

    return resolveConfig(decoded);
  });

// ─────────────────────────────────────────────────────────────────────────────
// § 9. Protocol file bootstrap (Effect)
// ─────────────────────────────────────────────────────────────────────────────

const bootstrapProtocolFiles = (
  worktree: string,
  templates: PromptTemplates
): Effect.Effect<void, FileError> =>
  Effect.gen(function* () {
    const ts = nowISO();
    const j = (f: string) => NodePath.join(worktree, f);

    yield* Effect.all(
      [
        ensureFile(
          j(FILES.PLAN),
          `# Plan\n\n## Definition of Done\n- (fill in)\n\n## Milestones\n- [ ] (fill in)\n\n## Changelog\n- ${ts} created\n`
        ),
        ensureFile(
          j(FILES.RLM_INSTR),
          interpolate(templates.bootstrapRlmInstructions, { timestamp: ts })
        ),
        ensureFile(j(FILES.NEXT_RALPH), `# Next Ralph Context\n\n- ${ts} created\n`),
        ensureFile(j(FILES.RLM_CTX), `# Context For RLM\n\n(paste large reference documents here; access via rlm_grep + rlm_slice)\n`),
        ensureFile(j(FILES.PREV), `# Previous State\n\n(none yet)\n`),
        ensureFile(j(FILES.CURR), templates.bootstrapCurrentState),
        ensureFile(j(FILES.NOTES), `# Notes and Learnings (append-only)\n\n- ${ts} created\n`),
        ensureFile(j(FILES.TODOS), `# Todos\n\n- [ ] (optional)\n`),
        ensureFile(j(FILES.SUPERVISOR_LOG), `# Supervisor Log (append-only)\n\n- ${ts} created\n`),
        ensureFile(j(FILES.CONVERSATION), `# Conversation Log (append-only)\n\n- ${ts} created\n`),
      ],
      { concurrency: "unbounded" }
    );
  });

// ─────────────────────────────────────────────────────────────────────────────
// § 10. Sub-agent directory helpers
// ─────────────────────────────────────────────────────────────────────────────

const subAgentDir = (worktree: string, name: string) =>
  NodePath.join(worktree, ".opencode", "agents", name);

const bootstrapSubAgent = (
  worktree: string,
  name: string,
  goal: string,
  templates: PromptTemplates
): Effect.Effect<void, FileError> =>
  Effect.gen(function* () {
    const ts = nowISO();
    const base = subAgentDir(worktree, name);
    const j = (f: string) => NodePath.join(base, f);

    yield* Effect.all(
      [
        writeFile(
          j(FILES.PLAN),
          `# Sub-Agent Plan: ${name}\n\n## Goal\n${goal}\n\n## Milestones\n- [ ] (fill in)\n\n## Changelog\n- ${ts} created\n`
        ),
        ensureFile(j(FILES.CURR), templates.bootstrapCurrentState),
        ensureFile(j(FILES.NOTES), `# Sub-Agent Notes and Learnings\n\n- ${ts} created\n`),
        ensureFile(j(FILES.PREV), `# Previous State\n\n(none yet)\n`),
      ],
      { concurrency: "unbounded" }
    );
  });

// ─────────────────────────────────────────────────────────────────────────────
// § 11. Patch application (via git apply)
// ─────────────────────────────────────────────────────────────────────────────

const applyPatch = (
  $: any,
  worktree: string,
  patchText: string
): Effect.Effect<void, PatchError> =>
  Effect.tryPromise({
    try: async () => {
      const tmp = NodePath.join(
        worktree,
        ".opencode",
        "tmp",
        `patch-${Date.now()}.diff`
      );
      await NodeFs.mkdir(NodePath.dirname(tmp), { recursive: true });
      await NodeFs.writeFile(tmp, patchText, "utf8");
      try {
        await $`git -C ${worktree} apply --whitespace=nowarn ${tmp}`.quiet();
      } finally {
        await NodeFs.unlink(tmp).catch(() => {});
      }
    },
    catch: (e) => new PatchError({ message: String(e) }),
  });

// ─────────────────────────────────────────────────────────────────────────────
// § 12. Plugin entry point
// ─────────────────────────────────────────────────────────────────────────────

export const RalphRLM: Plugin = async ({ client, $, worktree }) => {
  // ── Load prompt templates once at startup ───────────────────────────────────
  const templates = await loadPromptTemplates(worktree);

  const appLog = async (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    extra?: Record<string, unknown>
  ): Promise<void> => {
    const body = {
      service: "ralph-rlm",
      level,
      message,
      ...(extra !== undefined ? { extra } : {}),
    };
    await client.app.log({
      body,
    }).catch(() => {});
  };

  // ── Config cache — re-read at most once per 10 s to pick up live edits ──────
  // loadConfig() reads+parses a JSON file; calling it on every tool.execute.before
  // (which fires for every tool invocation) would hammer the filesystem.
  let _configCache: { value: ResolvedConfig; expiresAt: number } | null = null;
  const getConfig = (): Effect.Effect<ResolvedConfig> =>
    Effect.gen(function* () {
      const now = Date.now();
      if (_configCache && now < _configCache.expiresAt) return _configCache.value;
      const value = yield* loadConfig(worktree);
      _configCache = { value, expiresAt: now + 10_000 };
      return value;
    });

  // ── Supervisor state (singleton — lives in the main session's plugin process) ─
  const supervisor: SupervisorState = {
    attempt: 0,
    done: false,
    paused: false,
    reviewRequested: {},
    reviewerRuns: {},
  };

  const loadReviewerState = async (): Promise<void> => {
    try {
      const raw = await NodeFs.readFile(NodePath.join(worktree, REVIEWER_STATE_PATH), "utf8");
      const parsed = JSON.parse(raw) as {
        reviewRequested?: Record<string, string>;
        reviewerRuns?: Record<string, number>;
        activeReviewerName?: string;
        activeReviewerAttempt?: number;
        activeReviewerSessionId?: string;
        activeReviewerOutputPath?: string;
      };

      supervisor.reviewRequested = Object.fromEntries(
        Object.entries(parsed.reviewRequested ?? {}).map(([k, v]) => [Number(k), String(v)])
      );
      supervisor.reviewerRuns = Object.fromEntries(
        Object.entries(parsed.reviewerRuns ?? {}).map(([k, v]) => [Number(k), Number(v)])
      );
      supervisor.activeReviewerName = parsed.activeReviewerName;
      supervisor.activeReviewerAttempt = parsed.activeReviewerAttempt;
      supervisor.activeReviewerSessionId = parsed.activeReviewerSessionId;
      supervisor.activeReviewerOutputPath = parsed.activeReviewerOutputPath;
    } catch {
      // no-op: missing or invalid file means empty reviewer state
    }
  };

  const persistReviewerState = async (): Promise<void> => {
    const p = NodePath.join(worktree, REVIEWER_STATE_PATH);
    const payload = {
      reviewRequested: supervisor.reviewRequested,
      reviewerRuns: supervisor.reviewerRuns,
      activeReviewerName: supervisor.activeReviewerName,
      activeReviewerAttempt: supervisor.activeReviewerAttempt,
      activeReviewerSessionId: supervisor.activeReviewerSessionId,
      activeReviewerOutputPath: supervisor.activeReviewerOutputPath,
      updatedAt: nowISO(),
    };
    await NodeFs.mkdir(NodePath.dirname(p), { recursive: true });
    await NodeFs.writeFile(p, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  };

  await loadReviewerState();

  // ── Session state (workers + sub-agents) ────────────────────────────────────
  const sessionMap = new Map<string, SessionState>();

  const getSession = (id: string): SessionState => {
    if (!sessionMap.has(id)) sessionMap.set(id, freshSession());
    return sessionMap.get(id)!;
  };

  const mutateSession = (id: string, f: (s: SessionState) => void): void => {
    const s = getSession(id);
    f(s);
  };

  // Bridge: run an Effect to a Promise (errors surface as thrown exceptions).
  const run = <A>(eff: Effect.Effect<A, any, never>): Promise<A> =>
    Effect.runPromise(eff);

  // Bootstrap protocol files (best-effort on startup).
  await run(
    bootstrapProtocolFiles(worktree, templates).pipe(Effect.orElse(() => Effect.void))
  );

  const messagePassesVerbosity = (
    verbosity: ResolvedConfig["statusVerbosity"],
    level: "info" | "warning" | "error"
  ): boolean => {
    if (verbosity === "verbose") return true;
    if (verbosity === "minimal") return level !== "info";
    return true;
  };

  const rotateConversationLogIfNeeded = async (cfg: ResolvedConfig): Promise<void> => {
    const convPath = NodePath.join(worktree, FILES.CONVERSATION);
    const exists = await run(fileExists(convPath));
    if (!exists) return;

    const raw = await run(readFile(convPath).pipe(Effect.orElseSucceed(() => "")));
    const lines = raw.split(/\r?\n/);
    if (lines.length <= cfg.maxConversationLines) return;

    for (let i = cfg.conversationArchiveCount; i >= 1; i--) {
      const curr = NodePath.join(worktree, `CONVERSATION.${i}.md`);
      if (i === cfg.conversationArchiveCount) {
        await NodeFs.rm(curr, { force: true }).catch(() => {});
        continue;
      }
      const next = NodePath.join(worktree, `CONVERSATION.${i + 1}.md`);
      const ok = await NodeFs.stat(curr).then(() => true).catch(() => false);
      if (ok) {
        await NodeFs.rm(next, { force: true }).catch(() => {});
        await NodeFs.rename(curr, next).catch(() => {});
      }
    }

    await NodeFs.rename(convPath, NodePath.join(worktree, "CONVERSATION.1.md")).catch(() => {});
    await run(writeFile(convPath, `# Conversation Log (append-only)\n\n- ${nowISO()} rotated\n`)).catch(() => {});
  };

  const DEDUPE_WINDOW_MS = 5_000;
  const recentNotices = new Map<string, number>();
  const shouldDedupe = (key: string): boolean => {
    const now = Date.now();
    const last = recentNotices.get(key);
    if (last && now - last < DEDUPE_WINDOW_MS) return true;
    if (recentNotices.size > 200) recentNotices.clear();
    recentNotices.set(key, now);
    return false;
  };

  const appendConversationEntry = async (
    source: string,
    message: string
  ): Promise<void> => {
    if (shouldDedupe(`conv|${source}|${message}`)) return;
    const cfg = await run(getConfig());
    await rotateConversationLogIfNeeded(cfg);
    const ts = nowISO();
    const line = `- [${ts}] [${source}] ${message}\n`;
    await run(appendFile(NodePath.join(worktree, FILES.CONVERSATION), line)).catch((err: unknown) => {
      void appLog("warn", "failed to append CONVERSATION.md", { error: String(err) });
    });
  };

  const notifySupervisor = async (
    source: string,
    message: string,
    level: "info" | "warning" | "error" = "info",
    postToConversation = true,
    originSessionId?: string
  ): Promise<void> => {
    if (shouldDedupe(`sup|${source}|${level}|${message}`)) return;
    const cfg = await run(getConfig());
    if (!messagePassesVerbosity(cfg.statusVerbosity, level)) return;

    const ts = nowISO();
    const logLine = `- [${ts}][${level.toUpperCase()}][${source}] ${message}\n`;
    await run(appendFile(NodePath.join(worktree, FILES.SUPERVISOR_LOG), logLine)).catch((err: unknown) => {
      void appLog("warn", "failed to append SUPERVISOR_LOG.md", { error: String(err) });
    });
    await appendConversationEntry(source, message);

    await client.tui.showToast({
      body: {
        variant: level,
        title: `Ralph [${source}]`,
        message: message.slice(0, 120),
      },
    }).catch(() => {});

    if (postToConversation && supervisor.sessionId && supervisor.sessionId !== originSessionId) {
      await client.session.promptAsync({
        path: { id: supervisor.sessionId },
        body: { parts: [{ type: "text", text: `[${source}] ${message}` }] },
      }).catch(() => {});
    }
  };

  const detectProjectDefaults = (root: string): Effect.Effect<{ verify: string[]; install: string }> =>
    Effect.gen(function* () {
      const j = (f: string) => NodePath.join(root, f);

      const hasBunLock = (yield* fileExists(j("bun.lockb"))) || (yield* fileExists(j("bun.lock")));
      if (hasBunLock) return { verify: ["bun", "run", "verify"], install: "bun install" };

      const hasYarnLock = yield* fileExists(j("yarn.lock"));
      if (hasYarnLock) return { verify: ["yarn", "test"], install: "yarn install" };

      const hasPnpmLock = yield* fileExists(j("pnpm-lock.yaml"));
      if (hasPnpmLock) return { verify: ["pnpm", "test"], install: "pnpm install" };

      const hasPkg = yield* fileExists(j("package.json"));
      if (hasPkg) return { verify: ["npm", "test"], install: "npm install" };

      const hasCargo = yield* fileExists(j("Cargo.toml"));
      if (hasCargo) return { verify: ["cargo", "test"], install: "cargo build" };

      const hasPy = yield* fileExists(j("pyproject.toml"));
      const hasReq = yield* fileExists(j("requirements.txt"));
      if (hasReq) return { verify: ["python", "-m", "pytest"], install: "pip install -r requirements.txt" };
      if (hasPy) return { verify: ["python", "-m", "pytest"], install: "pip install ." };

      const hasMake = yield* fileExists(j("Makefile"));
      if (hasMake) return { verify: ["make", "test"], install: "make" };

      return { verify: ["bun", "run", "verify"], install: "bun install" };
    });

  const checkSetup = async (root: string, cfg: ResolvedConfig): Promise<SetupDiagnostics> => {
    const diagnostics: SetupDiagnostics = {
      ready: true,
      issues: [],
      warnings: [],
      suggestions: [],
    };
    const j = (f: string) => NodePath.join(root, f);

    if (!cfg.verify || cfg.verify.command.length === 0) {
      diagnostics.ready = false;
      diagnostics.issues.push("Missing verify.command in .opencode/ralph.json.");
      const defaults = await run(detectProjectDefaults(root));
      diagnostics.suggestions.push(`Set verify.command, e.g. ${JSON.stringify(defaults.verify)}.`);
    }

    const planExists = await run(fileExists(j(FILES.PLAN)));
    if (!planExists) {
      diagnostics.ready = false;
      diagnostics.issues.push("Missing PLAN.md.");
      diagnostics.suggestions.push("Run ralph_bootstrap_plan() or create PLAN.md manually.");
    } else {
      const planRaw = await run(readFile(j(FILES.PLAN)).pipe(Effect.orElseSucceed(() => "")));
      if (planRaw.includes("(fill in)")) {
        diagnostics.warnings.push("PLAN.md still contains placeholders.");
        diagnostics.suggestions.push("Use ralph_bootstrap_plan() to define goals, milestones, and stopping conditions.");
      }
    }

    if (cfg.agentMdPath && cfg.agentMdPath.trim().length > 0) {
      const agentMdExists = await run(fileExists(j(cfg.agentMdPath)));
      if (!agentMdExists) {
        diagnostics.warnings.push(`${cfg.agentMdPath} is missing.`);
        diagnostics.suggestions.push("Create AGENT.md with static project rules to improve consistency across attempts.");
      }
    }

    return diagnostics;
  };

  const renderPlan = (input: {
    goal: string;
    requirements: string[];
    stoppingConditions: string[];
    features: string[];
    steps: string[];
  }): string => {
    const ts = nowISO();
    const req = input.requirements.length ? input.requirements : ["(none specified)"];
    const stop = input.stoppingConditions.length ? input.stoppingConditions : ["Verification command passes."];
    const feats = input.features.length ? input.features : ["(none specified)"];
    const steps = input.steps.length
      ? input.steps.map((s) => `- [ ] ${s}`)
      : ["- [ ] Break work into milestones", "- [ ] Implement", "- [ ] Verify"];

    return [
      "# Plan",
      "",
      "## Goal",
      input.goal,
      "",
      "## Requirements",
      ...req.map((r) => `- ${r}`),
      "",
      "## Features",
      ...feats.map((f) => `- ${f}`),
      "",
      "## Definition of Done",
      ...stop.map((s) => `- ${s}`),
      "",
      "## Milestones",
      ...steps,
      "",
      "## Changelog",
      `- ${ts} generated by ralph_bootstrap_plan`,
      "",
    ].join("\n");
  };

  const validatePlanContent = (plan: string): PlanValidation => {
    const hasGoal = /(^|\n)##\s+Goal\b/i.test(plan);
    const hasRequirements = /(^|\n)##\s+Requirements\b/i.test(plan);
    const hasDone = /(^|\n)##\s+(Definition\s+of\s+Done|Stopping\s+Conditions)\b/i.test(plan);
    const hasMilestones = /(^|\n)##\s+(Milestones|Steps)\b/i.test(plan);
    const hasChecklist = /-\s+\[\s?[xX ]\s?\]/.test(plan);

    const errors: string[] = [];
    const warnings: string[] = [];
    const suggestions: string[] = [];

    if (!hasGoal) errors.push("PLAN.md is missing a '## Goal' section.");
    if (!hasRequirements) errors.push("PLAN.md is missing a '## Requirements' section.");
    if (!hasDone) errors.push("PLAN.md is missing stopping conditions / definition of done.");
    if (!hasMilestones) warnings.push("PLAN.md is missing a milestones/steps section.");
    if (hasMilestones && !hasChecklist) warnings.push("Milestones exist but no checklist items were found.");
    if (plan.includes("(none specified)")) {
      warnings.push("PLAN.md still contains '(none specified)' placeholders.");
      suggestions.push("Replace placeholders with concrete requirements/features before long runs.");
    }

    if (errors.length === 0 && warnings.length === 0) {
      suggestions.push("Plan structure looks healthy.");
    }

    return { ok: errors.length === 0, errors, warnings, suggestions };
  };

  const markReviewRequested = (attempt: number, note: string): void => {
    supervisor.reviewRequested[attempt] = note;
    void persistReviewerState();
  };

  const clearReviewRequested = (attempt: number): void => {
    delete supervisor.reviewRequested[attempt];
    void persistReviewerState();
  };

  const getReviewerRuns = (attempt: number): number => supervisor.reviewerRuns[attempt] ?? 0;

  const incReviewerRuns = (attempt: number): void => {
    supervisor.reviewerRuns[attempt] = getReviewerRuns(attempt) + 1;
    void persistReviewerState();
  };

  // ── Inline verify (shared between tool and outer loop) ──────────────────────
  const runVerify = (root: string): Effect.Effect<string> =>
    Effect.gen(function* () {
      const cfg = yield* getConfig();
      if (!cfg.verify || !cfg.verify.command.length) {
        return JSON.stringify(
          { verdict: "unknown", reason: "No verify.command in .opencode/ralph.json." },
          null,
          2
        );
      }
      const verifyCmd = cfg.verify.command;
      const cwd = NodePath.join(root, cfg.verify.cwd ?? ".");
      const timeoutMs = cfg.verifyTimeoutMinutes > 0
        ? cfg.verifyTimeoutMinutes * 60_000
        : null;
      return yield* Effect.tryPromise({
        try: async () => {
          const options = timeoutMs
            ? { timeoutMs, label: "verify" }
            : { label: "verify" };
          const result = await runCommand(verifyCmd, cwd, options);
          if (result.ok) {
            return JSON.stringify({ verdict: "pass", output: result.stdout }, null, 2);
          }
          return JSON.stringify(
            {
              verdict: "fail",
              output: result.stdout,
              error: result.stderr,
              exitCode: result.code,
            },
            null,
            2
          );
        },
        catch: (err: unknown) =>
          JSON.stringify(
            {
              verdict: "fail",
              output: "",
              error: err instanceof Error ? err.message : String(err),
            },
            null,
            2
          ),
      }).pipe(
        Effect.orElseSucceed(() =>
          JSON.stringify({ verdict: "unknown", reason: "verify threw unexpectedly" }, null, 2)
        )
      );
    });

  // ────────────────────────────────────────────────────────────────────────────
  // Tool: ralph_load_context
  // ────────────────────────────────────────────────────────────────────────────
  const tool_ralph_load_context = tool({
    description:
      "Load the file-first protocol context. MUST be called at the start of every attempt before any other work.",
    args: {
      includeRlmContextHeadings: tool.schema
        .boolean()
        .optional()
        .describe("Include only headings from CONTEXT_FOR_RLM.md (recommended, default true)."),
      rlmHeadingsMax: tool.schema
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Max headings to return from CONTEXT_FOR_RLM.md (default 80)."),
    },
    async execute(args, ctx) {
      const root = ctx.worktree ?? worktree;
      const sessionID = ctx.sessionID ?? "default";
      // Mark context loaded for both workers and sub-agents.
      mutateSession(sessionID, (s) => { s.loadedContext = true; });
      const st = getSession(sessionID);
      const cfg = await run(getConfig());
      const j = (f: string) => NodePath.join(root, f);

      return run(
        Effect.gen(function* () {
          const agentMdAbs = cfg.agentMdPath ? j(cfg.agentMdPath) : null;

          const [plan, rlmInstr, nextRalph, curr, prev, notes, todos, conversation, rlmRaw, agentMd] =
            yield* Effect.all(
              [
                readFile(j(FILES.PLAN)).pipe(Effect.orElseSucceed(() => "(missing — create PLAN.md)")),
                readFile(j(FILES.RLM_INSTR)).pipe(Effect.orElseSucceed(() => "(missing — create RLM_INSTRUCTIONS.md)")),
                readFile(j(FILES.NEXT_RALPH)).pipe(Effect.orElseSucceed(() => "(none)")),
                readFile(j(FILES.CURR)).pipe(Effect.orElseSucceed(() => "(empty)")),
                readFile(j(FILES.PREV)).pipe(Effect.orElseSucceed(() => "(none yet)")),
                readFile(j(FILES.NOTES)).pipe(Effect.orElseSucceed(() => "(empty)")),
                readFile(j(FILES.TODOS)).pipe(Effect.orElseSucceed(() => "(empty)")),
                readFile(j(FILES.CONVERSATION)).pipe(Effect.orElseSucceed(() => "(empty)")),
                readFile(j(FILES.RLM_CTX)).pipe(Effect.orElseSucceed(() => "")),
                agentMdAbs
                  ? readFile(agentMdAbs).pipe(Effect.orElseSucceed(() => null as string | null))
                  : Effect.succeed(null as string | null),
              ],
              { concurrency: "unbounded" }
            );

          const useHeadings = args.includeRlmContextHeadings ?? true;
          const rlmContext = useHeadings
            ? extractHeadings(rlmRaw, args.rlmHeadingsMax ?? 80)
            : clampLines(rlmRaw, 200);

          const payload: Record<string, unknown> = {
            protocol_files: FILES,
            plan,
            rlm_instructions: rlmInstr,
            agent_context_for_next_ralph: nextRalph,
            current_state: curr,
            previous_state: prev,
            notes_and_learnings: clampLines(notes, 200),
            todos: clampLines(todos, 200),
            conversation_log: clampLines(conversation, 200),
            context_for_rlm: {
              path: FILES.RLM_CTX,
              headings: rlmContext,
              policy: "Use rlm_grep + rlm_slice to access this file. Never dump it fully.",
            },
            sub_agents: st.subAgents,
            session: {
              attempt: supervisor.attempt,
              sessionAttempt: st.attempt,
              role: st.role,
              loadedContext: st.loadedContext,
            },
          };

          // Include AGENT.md when found — surface project-level conventions to every
          // attempt and sub-agent so static rules are always in scope.
          if (agentMd !== null) {
            payload["agent_md"] = {
              path: cfg.agentMdPath,
              content: agentMd,
              note: "Static project rules from AGENT.md. RLM_INSTRUCTIONS.md governs loop-specific behaviour; prefer updating it over AGENT.md for task-specific guidance.",
            };
          }

          return JSON.stringify(payload, null, 2);
        })
      );
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tool: rlm_grep
  // ────────────────────────────────────────────────────────────────────────────
  const tool_rlm_grep = tool({
    description:
      "Search within CONTEXT_FOR_RLM.md (or any file) for matching lines. Returns line numbers + text. Run before rlm_slice for large ranges.",
    args: {
      query: tool.schema.string().describe("Text or regex pattern to search for (case-insensitive)."),
      file: tool.schema
        .string()
        .optional()
        .describe("Relative path under repo root. Defaults to CONTEXT_FOR_RLM.md."),
      maxMatches: tool.schema.number().int().min(1).max(200).optional(),
      contextLines: tool.schema
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe("Lines of context around each match (default 0)."),
    },
    async execute(args, ctx) {
      const root = ctx.worktree ?? worktree;
      const sessionID = ctx.sessionID ?? "default";
      const fileRel = args.file ?? FILES.RLM_CTX;
      const fileAbs = NodePath.join(root, fileRel);

      return run(
        Effect.gen(function* () {
          const raw = yield* readFile(fileAbs);
          const lines = raw.split(/\r?\n/);

          const re = regexFromQuery(args.query);

          const ctx_ = args.contextLines ?? 0;
          const maxM = args.maxMatches ?? 50;

          const matchedIndices: number[] = [];
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i] ?? "")) {
              matchedIndices.push(i);
              if (matchedIndices.length >= maxM) break;
            }
          }

          const results = matchedIndices.map((i) => {
            const start = Math.max(0, i - ctx_);
            const end = Math.min(lines.length - 1, i + ctx_);
            return {
              matchLine: i + 1,
              matchText: lines[i] ?? "",
              context:
                ctx_ > 0
                  ? lines.slice(start, end + 1).map((t, offset) => ({
                      line: start + offset + 1,
                      text: t,
                    }))
                  : undefined,
            };
          });

          mutateSession(sessionID, (s) => {
            s.lastGrepAt = Date.now();
            s.lastGrepQuery = args.query;
          });

          return JSON.stringify({ file: fileRel, totalMatches: results.length, results }, null, 2);
        })
      );
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tool: rlm_slice
  // ────────────────────────────────────────────────────────────────────────────
  const tool_rlm_slice = tool({
    description:
      "Read a line-range slice of a file (1-indexed, inclusive). Use instead of full reads for large files. For slices >= grepRequiredThresholdLines, run rlm_grep first.",
    args: {
      file: tool.schema
        .string()
        .optional()
        .describe("Relative path under repo root. Defaults to CONTEXT_FOR_RLM.md."),
      startLine: tool.schema.number().int().min(1).describe("1-indexed start line."),
      endLine: tool.schema.number().int().min(1).describe("1-indexed end line (inclusive)."),
    },
    async execute(args, ctx) {
      const root = ctx.worktree ?? worktree;
      const sessionID = ctx.sessionID ?? "default";
      const cfg = await run(getConfig());
      const st = getSession(sessionID);
      const fileRel = args.file ?? FILES.RLM_CTX;
      const fileAbs = NodePath.join(root, fileRel);

      if (args.endLine < args.startLine) throw new Error("endLine must be >= startLine.");
      const span = args.endLine - args.startLine + 1;
      if (span > cfg.maxRlmSliceLines) {
        throw new Error(
          `Slice too large: ${span} lines. Max allowed: ${cfg.maxRlmSliceLines}. Use multiple smaller slices.`
        );
      }
      if (cfg.requireGrepBeforeLargeSlice && span >= cfg.grepRequiredThresholdLines) {
        const recentGrep = st.lastGrepAt && Date.now() - st.lastGrepAt < 5 * 60 * 1000;
        if (!recentGrep) {
          throw new Error(
            `Slices >= ${cfg.grepRequiredThresholdLines} lines require a recent rlm_grep call first (within 5 min).`
          );
        }
      }

      return run(
        Effect.gen(function* () {
          const raw = yield* readFile(fileAbs);
          const lines = raw.split(/\r?\n/);
          const slice = lines.slice(args.startLine - 1, args.endLine).join("\n");
          return JSON.stringify(
            { file: fileRel, startLine: args.startLine, endLine: args.endLine, totalFileLines: lines.length, text: slice },
            null,
            2
          );
        })
      );
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tool: ralph_update_plan
  // ────────────────────────────────────────────────────────────────────────────
  const tool_ralph_update_plan = tool({
    description:
      "Update PLAN.md via a unified diff patch. Requires a reason. Appends a changelog entry. Use only for durable changes.",
    args: {
      patch: tool.schema.string().describe("Unified diff patch targeting PLAN.md."),
      reason: tool.schema.string().min(3).describe("Why this plan update is needed."),
    },
    async execute(args, ctx) {
      const root = ctx.worktree ?? worktree;
      if (!args.patch.includes("PLAN.md")) {
        throw new Error("Patch must target PLAN.md (unified diff paths must include 'PLAN.md').");
      }
      await run(applyPatch($, root, args.patch));
      await run(appendFile(NodePath.join(root, FILES.PLAN), `\n- ${nowISO()} plan updated: ${args.reason}\n`));
      return "PLAN.md updated + changelog entry appended.";
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tool: ralph_update_rlm_instructions
  // ────────────────────────────────────────────────────────────────────────────
  const tool_ralph_update_rlm_instructions = tool({
    description:
      "Update RLM_INSTRUCTIONS.md via a unified diff patch. Requires a reason. Do NOT modify the Fixed Header section.",
    args: {
      patch: tool.schema.string().describe("Unified diff patch targeting RLM_INSTRUCTIONS.md."),
      reason: tool.schema.string().min(3).describe("Why this instruction change is needed."),
    },
    async execute(args, ctx) {
      const root = ctx.worktree ?? worktree;
      if (!args.patch.includes("RLM_INSTRUCTIONS.md")) {
        throw new Error("Patch must target RLM_INSTRUCTIONS.md.");
      }
      await run(applyPatch($, root, args.patch));
      await run(appendFile(NodePath.join(root, FILES.RLM_INSTR), `\n- ${nowISO()} instructions updated: ${args.reason}\n`));
      return "RLM_INSTRUCTIONS.md updated + changelog entry appended.";
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tool: ralph_rollover
  // ────────────────────────────────────────────────────────────────────────────
  const tool_ralph_rollover = tool({
    description:
      "End-of-loop rollover: CURRENT_STATE.md → PREVIOUS_STATE.md, resets scratch, writes next-attempt shim. Optionally appends a durable learning.",
    args: {
      verdict: tool.schema.enum(["pass", "fail", "blocked", "unknown"]).describe("Outcome of this loop."),
      summary: tool.schema.string().describe("Compact summary of what happened this loop."),
      nextStep: tool.schema.string().describe("The single most important next action for the next attempt."),
      learning: tool.schema.string().optional().describe("Durable learning to append to NOTES_AND_LEARNINGS.md."),
    },
    async execute(args, ctx) {
      const root = ctx.worktree ?? worktree;
      return run(
        Effect.gen(function* () {
          const ts = nowISO();
          const curr = yield* readFile(NodePath.join(root, FILES.CURR)).pipe(Effect.orElseSucceed(() => ""));
          yield* Effect.all(
            [
              writeFile(NodePath.join(root, FILES.PREV), `# Previous State (snapshot)\n\nCaptured: ${ts}\n\n${curr}\n`),
              writeFile(NodePath.join(root, FILES.CURR), templates.bootstrapCurrentState),
              writeFile(
                NodePath.join(root, FILES.NEXT_RALPH),
                `# Next Ralph Context\n\n- Timestamp: ${ts}\n- Verdict: ${args.verdict}\n\n## Summary\n${args.summary}\n\n## Next Step\n${args.nextStep}\n`
              ),
            ],
            { concurrency: "unbounded" }
          );
          if (args.learning) {
            yield* appendFile(NodePath.join(root, FILES.NOTES), `\n- ${ts} ${args.learning}\n`);
          }
          return "Rollover complete: PREVIOUS_STATE / CURRENT_STATE / NEXT_RALPH updated.";
        })
      );
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tool: ralph_verify
  // ────────────────────────────────────────────────────────────────────────────
  const tool_ralph_verify = tool({
    description:
      "Run the project verification command from .opencode/ralph.json. Returns { verdict: 'pass'|'fail'|'unknown', output, error }.",
    args: {},
    async execute(_args, ctx) {
      const root = ctx.worktree ?? worktree;
      return run(runVerify(root));
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tool: ralph_peek_worker
  // ────────────────────────────────────────────────────────────────────────────
  const tool_ralph_peek_worker = tool({
    description:
      "Snapshot the active RLM worker's CURRENT_STATE.md and optionally post it into the main conversation.",
    args: {
      maxLines: tool.schema.number().int().min(20).max(400).optional(),
      post_to_conversation: tool.schema
        .boolean()
        .optional()
        .describe("Whether to post the peek into the main conversation (default: true)."),
    },
    async execute(args, ctx) {
      const root = ctx.worktree ?? worktree;
      const currPath = NodePath.join(root, FILES.CURR);
      const ok = await run(fileExists(currPath));
      if (!ok) return JSON.stringify({ ok: false, missing: FILES.CURR }, null, 2);

      const raw = await run(readFile(currPath).pipe(Effect.orElseSucceed(() => "")));
      const text = clampLines(raw, args.maxLines ?? 120);
      const attempt = supervisor.attempt;
      const workerId = supervisor.currentWorkerSessionId;
      const header = `Worker peek${attempt ? ` (attempt ${attempt})` : ""}${workerId ? ` — ${workerId}` : ""}`;

      await notifySupervisor("peek", header, "info", false, ctx.sessionID);

      const postToConv = args.post_to_conversation !== false;
      if (postToConv && supervisor.sessionId && supervisor.sessionId !== ctx.sessionID) {
        await client.session.promptAsync({
          path: { id: supervisor.sessionId },
          body: { parts: [{ type: "text", text: `[peek] ${header}\n\n${text}` }] },
        }).catch(() => {});
      }

      return JSON.stringify(
        {
          ok: true,
          attempt: attempt || null,
          workerSessionId: workerId ?? null,
          text,
        },
        null,
        2
      );
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tool: subagent_peek
  // ────────────────────────────────────────────────────────────────────────────
  const tool_subagent_peek = tool({
    description: "Read file-first state from a sub-agent directory (.opencode/agents/<name>/).",
    args: {
      name: tool.schema.string().describe("Sub-agent name."),
      file: tool.schema
        .enum(["PLAN.md", "CURRENT_STATE.md", "PREVIOUS_STATE.md", "NOTES_AND_LEARNINGS.md"] as const)
        .optional()
        .describe("Which file to read. Defaults to CURRENT_STATE.md."),
      maxLines: tool.schema.number().int().min(20).max(400).optional(),
    },
    async execute(args, ctx) {
      const root = ctx.worktree ?? worktree;
      const rel = NodePath.join(".opencode", "agents", args.name, args.file ?? "CURRENT_STATE.md");
      const abs = NodePath.join(root, rel);
      return run(
        Effect.gen(function* () {
          const ok = yield* fileExists(abs);
          if (!ok) return JSON.stringify({ ok: false, missing: rel }, null, 2);
          const raw = yield* readFile(abs);
          return JSON.stringify({ ok: true, file: rel, text: clampLines(raw, args.maxLines ?? 200) }, null, 2);
        })
      );
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tool: subagent_spawn
  // ────────────────────────────────────────────────────────────────────────────
  const tool_subagent_spawn = tool({
    description:
      "Spawn a child session for an isolated sub-task. Bootstraps state files, creates the child session, sends initial prompt. Use subagent_await to collect results.",
    args: {
      name: tool.schema.string().describe("Unique slug name for this sub-agent (e.g. 'auth-tests')."),
      goal: tool.schema.string().describe("The sub-task goal."),
      context: tool.schema.string().optional().describe("Extra context to inject into the sub-agent's first prompt."),
    },
    async execute(args, ctx) {
      const root = ctx.worktree ?? worktree;
      const sessionID = ctx.sessionID ?? "default";
      const cfg = await run(getConfig());
      const st = getSession(sessionID);

      if (!cfg.subAgentEnabled) {
        throw new Error("Sub-agents are disabled. Set subAgentEnabled: true in .opencode/ralph.json.");
      }

      // Reject invalid names early — the name becomes a directory path component.
      if (!/^[a-zA-Z0-9_-]+$/.test(args.name)) {
        throw new Error(
          `Sub-agent name "${args.name}" is invalid. Use only letters, digits, hyphens, and underscores.`
        );
      }

      if (st.subAgents.some((a) => a.name === args.name && a.status === "running")) {
        throw new Error(
          `Sub-agent "${args.name}" is already running. Await it first or choose a different name.`
        );
      }

      if (st.subAgents.filter((a) => a.status === "running").length >= cfg.maxSubAgents) {
        throw new Error(`Max concurrent sub-agents (${cfg.maxSubAgents}) reached.`);
      }

      await run(bootstrapSubAgent(root, args.name, args.goal, templates));

      const stateDir = NodePath.join(".opencode", "agents", args.name);

      const promptText = interpolate(templates.subagentPrompt, {
        name: args.name,
        goal: args.goal,
        context: args.context ? `\nAdditional context:\n${args.context}` : "",
        stateDir,
        doneSentinel: templates.subagentDoneSentinel,
        doneHeading: templates.subagentDoneHeading,
      });

      const childSessionResult = await client.session.create({
        body: { title: `sub-agent: ${args.name}` },
      });
      const childSessionId: string = childSessionResult.data?.id ?? `unknown-${Date.now()}`;

      // Register child role before first prompt so prompt routing/gating applies.
      sessionMap.set(childSessionId, freshSession("subagent", st.attempt));
      mutateSession(childSessionId, (s) => { s.lastProgressAt = Date.now(); });

      await client.session.prompt({
        path: { id: childSessionId },
        body: { parts: [{ type: "text", text: promptText }] },
      });

      mutateSession(sessionID, (s) => {
        s.subAgents.push({
          sessionId: childSessionId,
          name: args.name,
          goal: args.goal,
          spawnedAt: Date.now(),
          status: "running",
        });
      });

      return JSON.stringify(
        {
          ok: true,
          name: args.name,
          sessionId: childSessionId,
          stateDir,
          message: `Sub-agent spawned. Poll with subagent_await("${args.name}") or inspect with subagent_peek("${args.name}").`,
        },
        null,
        2
      );
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tool: subagent_await
  // ────────────────────────────────────────────────────────────────────────────
  const tool_subagent_await = tool({
    description:
      "Poll a sub-agent's CURRENT_STATE.md for completion. Returns { status: 'done'|'running', current_state }. Call periodically; do not busy-loop.",
    args: {
      name: tool.schema.string().describe("Sub-agent name to check."),
      maxLines: tool.schema.number().int().min(20).max(400).optional(),
    },
    async execute(args, ctx) {
      const root = ctx.worktree ?? worktree;
      const sessionID = ctx.sessionID ?? "default";
      const currPath = NodePath.join(root, ".opencode", "agents", args.name, "CURRENT_STATE.md");

      return run(
        Effect.gen(function* () {
          const ok = yield* fileExists(currPath);
          if (!ok) return JSON.stringify({ status: "not_found", name: args.name }, null, 2);

          const raw = yield* readFile(currPath);
          const done =
            raw.includes(templates.subagentDoneHeading) ||
            raw.includes(templates.subagentDoneSentinel);

          if (done) {
            mutateSession(sessionID, (s) => {
              const rec = s.subAgents.find((a) => a.name === args.name);
              if (rec) { rec.status = "done"; rec.result = raw; }
            });
          }

          return JSON.stringify(
            { status: done ? "done" : "running", name: args.name, current_state: clampLines(raw, args.maxLines ?? 200) },
            null,
            2
          );
        })
      );
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tool: subagent_list
  // ────────────────────────────────────────────────────────────────────────────
  const tool_subagent_list = tool({
    description: "List all known sub-agents for the current session.",
    args: {},
    async execute(_args, ctx) {
      const sessionID = ctx.sessionID ?? "default";
      return JSON.stringify({ subAgents: getSession(sessionID).subAgents }, null, 2);
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tool: ralph_spawn_worker  (Ralph strategist sessions only)
  // ────────────────────────────────────────────────────────────────────────────
  // Forward declaration — actual implementation assigned after spawnRlmWorker is defined.
  let tool_ralph_spawn_worker_impl: (args: Record<string, never>, ctx: { sessionID?: string }) => Promise<string>;

  const tool_ralph_spawn_worker = tool({
    description:
      "Spawn a fresh RLM worker session for this attempt. Call this after reviewing protocol files and updating PLAN.md / RLM_INSTRUCTIONS.md as needed. Then STOP — the plugin handles verification.",
    args: {},
    async execute(args, ctx) {
      return tool_ralph_spawn_worker_impl(args as Record<string, never>, ctx);
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tool: ralph_report
  // ────────────────────────────────────────────────────────────────────────────
  const tool_ralph_report = tool({
    description:
      "Report progress to the supervisor. Appends to SUPERVISOR_LOG.md and CONVERSATION.md, shows a toast, and optionally posts a message to the main conversation.",
    args: {
      message: tool.schema.string().describe("Progress message to report."),
      level: tool.schema
        .enum(["info", "warning", "error"] as const)
        .optional()
        .describe("Log level (default: info)."),
      post_to_conversation: tool.schema
        .boolean()
        .optional()
        .describe("Whether to post to the main conversation (default: true)."),
    },
    async execute(args, ctx) {
      const sessionID = ctx.sessionID ?? "default";
      const st = getSession(sessionID);
      mutateSession(sessionID, (s) => { s.lastProgressAt = Date.now(); });
      const level = args.level ?? "info";
      const roleTag = `${st.role}/attempt-${st.attempt}`;
      const postToConv = args.post_to_conversation !== false;
      await notifySupervisor(roleTag, args.message, level, postToConv, sessionID);

      return `Reported: ${args.message}`;
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tool: ralph_set_status
  // ────────────────────────────────────────────────────────────────────────────
  const tool_ralph_set_status = tool({
    description:
      "Set an explicit attempt status (running/blocked/done/error). Optional but useful for supervisor visibility and handoffs.",
    args: {
      status: tool.schema
        .enum(["running", "blocked", "done", "error"] as const)
        .describe("Status for the current role/attempt."),
      note: tool.schema
        .string()
        .optional()
        .describe("Optional short note with context."),
      post_to_conversation: tool.schema
        .boolean()
        .optional()
        .describe("Whether to post this status into the main conversation (default: true)."),
    },
    async execute(args, ctx) {
      const sessionID = ctx.sessionID ?? "default";
      const st = getSession(sessionID);
      const roleTag = `${st.role}/attempt-${st.attempt}`;

      mutateSession(sessionID, (s) => {
        s.reportedStatus = args.status;
        s.reportedStatusNote = args.note;
        s.lastProgressAt = Date.now();
      });

      const level: "info" | "warning" | "error" =
        args.status === "error" ? "error" : args.status === "blocked" ? "warning" : "info";

      const msg = args.note
        ? `Status set to ${args.status}: ${args.note}`
        : `Status set to ${args.status}.`;

      await notifySupervisor(roleTag, msg, level, args.post_to_conversation !== false, sessionID);

      return JSON.stringify(
        {
          ok: true,
          role: st.role,
          attempt: st.attempt,
          status: args.status,
          note: args.note ?? null,
        },
        null,
        2
      );
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tool: ralph_ask
  // ────────────────────────────────────────────────────────────────────────────
  const tool_ralph_ask = tool({
    description:
      "Ask the supervisor a question and wait for a response. Blocks until the supervisor calls ralph_respond() or the timeout expires.",
    args: {
      question: tool.schema.string().describe("The question to ask the supervisor."),
      context: tool.schema.string().optional().describe("Additional context for the question."),
      timeout_minutes: tool.schema
        .number()
        .int()
        .min(1)
        .max(120)
        .optional()
        .describe("How many minutes to wait for a response (default: 15)."),
    },
    async execute(args, ctx) {
      const root = ctx.worktree ?? worktree;
      const sessionID = ctx.sessionID ?? "default";
      const st = getSession(sessionID);
      const id = `ask-${Date.now()}`;
      const roleTag = `${st.role}/attempt-${st.attempt}`;
      const timeoutMinutes = args.timeout_minutes ?? 15;

      const data = await readPendingInput(root);
      const record: QuestionRecord = {
        id,
        from: st.role,
        attempt: st.attempt,
        question: args.question,
        context: args.context,
        askedAt: nowISO(),
      };
      data.questions.push(record);
      await writePendingInput(root, data);
      await appendConversationEntry(roleTag, `Question (${id}): ${args.question}`);

      await client.tui.showToast({
        body: {
          variant: "warning",
          title: "Waiting for supervisor input",
          message: args.question.slice(0, 120),
        },
      }).catch(() => {});

      if (supervisor.sessionId && supervisor.sessionId !== sessionID) {
        const promptMsg = `[${roleTag} asks — ID: ${id}]: ${args.question}\n\nCall ralph_respond('${id}', 'your answer') to unblock.`;
        await client.session.promptAsync({
          path: { id: supervisor.sessionId },
          body: { parts: [{ type: "text", text: promptMsg }] },
        }).catch(() => {});
      }

      const maxIterations = timeoutMinutes * 12;
      for (let i = 0; i < maxIterations; i++) {
        await sleep(5000);
        const current = await readPendingInput(root);
        if (current.responses[id]) {
          return JSON.stringify({ id, answer: current.responses[id].answer });
        }
      }

      throw new Error(`ralph_ask timeout: no response after ${timeoutMinutes} minutes (ID: ${id})`);
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tool: ralph_respond
  // ────────────────────────────────────────────────────────────────────────────
  const tool_ralph_respond = tool({
    description:
      "Respond to a pending question from a spawned session. Unblocks the session that called ralph_ask().",
    args: {
      id: tool.schema.string().describe("The question ID from the ralph_ask() call (format: ask-NNNN)."),
      answer: tool.schema.string().describe("Your answer to the question."),
    },
    async execute(args, ctx) {
      const root = ctx.worktree ?? worktree;
      const data = await readPendingInput(root);
      const known = data.questions.find((q) => q.id === args.id);
      if (!known) {
        const pending = data.questions
          .filter((q) => !data.responses[q.id])
          .map((q) => `  ${q.id}: "${q.question.slice(0, 60)}"`)
          .join("\n");
        throw new Error(
          `Question ID "${args.id}" not found in pending_input.json.` +
          (pending ? `\n\nPending unanswered questions:\n${pending}` : "\n\nNo pending questions found.")
        );
      }
      if (data.responses[args.id]) {
        // Already answered — overwrite and note it.
        data.responses[args.id] = { answer: args.answer, respondedAt: nowISO() };
        await writePendingInput(root, data);
        await appendConversationEntry("supervisor", `Updated response (${args.id}): ${args.answer}`);
        return `Response updated for question ${args.id} (was already answered; new answer overwrites old).`;
      }
      data.responses[args.id] = { answer: args.answer, respondedAt: nowISO() };
      await writePendingInput(root, data);
      await appendConversationEntry("supervisor", `Response (${args.id}): ${args.answer}`);
      return `Response recorded for question ${args.id}.`;
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tool: ralph_doctor
  // ────────────────────────────────────────────────────────────────────────────
  const tool_ralph_doctor = tool({
    description:
      "Check Ralph/RLM setup readiness (config + files). Optionally apply safe autofixes.",
    args: {
      autofix: tool.schema
        .boolean()
        .optional()
        .describe("Create missing baseline setup files and defaults when possible."),
    },
    async execute(args, ctx) {
      const root = ctx.worktree ?? worktree;
      const cfg = await run(getConfig());
      const diagnosticsBefore = await checkSetup(root, cfg);
      const actions: string[] = [];

      if (args.autofix) {
        const defaults = await run(detectProjectDefaults(root));
        const configPath = NodePath.join(root, ".opencode", "ralph.json");
        const configExists = await run(fileExists(configPath));
        if (!configExists) {
          const defaultCfg = {
            enabled: true,
            autoStartOnMainIdle: false,
            statusVerbosity: "normal",
            maxAttempts: 25,
            heartbeatMinutes: 15,
            verify: { command: defaults.verify, cwd: "." },
            gateDestructiveToolsUntilContextLoaded: true,
            maxRlmSliceLines: 200,
            requireGrepBeforeLargeSlice: true,
            grepRequiredThresholdLines: 120,
            subAgentEnabled: true,
            maxSubAgents: 5,
            maxConversationLines: 1200,
            conversationArchiveCount: 3,
            reviewerEnabled: false,
            reviewerRequireExplicitReady: true,
            reviewerMaxRunsPerAttempt: 1,
            reviewerOutputDir: ".opencode/reviews",
            reviewerPostToConversation: true,
            agentMdPath: "AGENT.md",
          };
          await run(writeFile(configPath, `${JSON.stringify(defaultCfg, null, 2)}\n`));
          _configCache = null;
          actions.push("Created .opencode/ralph.json with safe defaults.");
        }

        const agentMdPath = NodePath.join(root, "AGENT.md");
        const agentMdExists = await run(fileExists(agentMdPath));
        if (!agentMdExists) {
          const agentMd = [
            "# Project Agent Rules",
            "",
            "## Build and verify",
            `- Install: ${defaults.install}`,
            `- Verify: ${defaults.verify.join(" ")}`,
            "",
            "## Loop note",
            "- This project uses ralph-rlm.",
            "- Keep static rules in AGENT.md and attempt-specific strategy in RLM_INSTRUCTIONS.md.",
            "",
          ].join("\n");
          await run(writeFile(agentMdPath, agentMd));
          actions.push("Created AGENT.md baseline guidance.");
        }
      }

      const diagnosticsAfter = await checkSetup(root, await run(getConfig()));
      return JSON.stringify(
        {
          ok: diagnosticsAfter.ready,
          before: diagnosticsBefore,
          actions,
          after: diagnosticsAfter,
          hint: diagnosticsAfter.ready
            ? "Setup is ready. Start with ralph_create_supervisor_session() or let auto-start run on idle."
            : "Run ralph_bootstrap_plan() and fix issues listed above.",
        },
        null,
        2
      );
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tool: ralph_bootstrap_plan
  // ────────────────────────────────────────────────────────────────────────────
  const tool_ralph_bootstrap_plan = tool({
    description:
      "Generate PLAN.md and TODOS.md from goals/requirements/features/stopping conditions.",
    args: {
      goal: tool.schema.string().describe("Primary project goal."),
      requirements: tool.schema.array(tool.schema.string()).optional(),
      stopping_conditions: tool.schema.array(tool.schema.string()).optional(),
      features: tool.schema.array(tool.schema.string()).optional(),
      steps: tool.schema.array(tool.schema.string()).optional(),
      todos: tool.schema.array(tool.schema.string()).optional(),
      overwrite_plan: tool.schema.boolean().optional(),
      overwrite_todos: tool.schema.boolean().optional(),
    },
    async execute(args, ctx) {
      const root = ctx.worktree ?? worktree;
      const planPath = NodePath.join(root, FILES.PLAN);
      const todosPath = NodePath.join(root, FILES.TODOS);

      const planExists = await run(fileExists(planPath));
      if (planExists && args.overwrite_plan !== true) {
        throw new Error("PLAN.md already exists. Set overwrite_plan=true to replace it.");
      }

      const plan = renderPlan({
        goal: args.goal,
        requirements: args.requirements ?? [],
        stoppingConditions: args.stopping_conditions ?? [],
        features: args.features ?? [],
        steps: args.steps ?? [],
      });
      await run(writeFile(planPath, plan));

      const todosExists = await run(fileExists(todosPath));
      if (!todosExists || args.overwrite_todos === true) {
        const items = (args.todos ?? args.steps ?? []).map((t) => `- [ ] ${t}`);
        const body = [
          "# Todos",
          "",
          ...(items.length ? items : ["- [ ] (optional)"]),
          "",
        ].join("\n");
        await run(writeFile(todosPath, body));
      }

      await appendConversationEntry("supervisor", `Plan bootstrapped for goal: ${args.goal}`);
      return "PLAN.md and TODOS.md updated.";
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tool: ralph_create_supervisor_session
  // ────────────────────────────────────────────────────────────────────────────
  const tool_ralph_create_supervisor_session = tool({
    description:
      "Bind current session as supervisor and optionally start attempt 1 immediately.",
    args: {
      start_loop: tool.schema.boolean().optional(),
      force_rebind: tool.schema.boolean().optional(),
      restart_if_done: tool.schema
        .boolean()
        .optional()
        .describe("If supervision is done/stopped, reset state to allow a new run."),
    },
    async execute(args, ctx) {
      const sessionID = ctx.sessionID ?? "default";
      const root = ctx.worktree ?? worktree;
      const cfg = await run(getConfig());

      if (supervisor.sessionId && supervisor.sessionId !== sessionID && args.force_rebind !== true) {
        return JSON.stringify(
          {
            ok: false,
            message: `Supervisor is already bound to session ${supervisor.sessionId}. Set force_rebind=true to take over.`,
          },
          null,
          2
        );
      }

      supervisor.sessionId = sessionID;
      supervisor.paused = false;
      await notifySupervisor("supervisor", "Supervisor bound via tool call.", "info", false, sessionID);

      const diagnostics = await checkSetup(root, cfg);
      if (!diagnostics.ready) {
        await notifySupervisor(
          "supervisor",
          "Setup is not ready. Run ralph_doctor(autofix=true) and ralph_bootstrap_plan().",
          "warning",
          true,
          sessionID
        );
        return JSON.stringify({ ok: false, diagnostics }, null, 2);
      }

      const shouldStart = args.start_loop ?? true;
      if (!shouldStart) {
        return JSON.stringify({ ok: true, started: false, diagnostics }, null, 2);
      }

      if (supervisor.done && args.restart_if_done === true) {
        supervisor.done = false;
        supervisor.paused = false;
        supervisor.currentRalphSessionId = undefined;
        supervisor.currentWorkerSessionId = undefined;
        supervisor.activeReviewerName = undefined;
        supervisor.activeReviewerAttempt = undefined;
        supervisor.activeReviewerSessionId = undefined;
        supervisor.activeReviewerOutputPath = undefined;
        await persistReviewerState();
        await notifySupervisor("supervisor", "Supervisor done-state reset for a new run.", "info", true, sessionID);
      }

      if (supervisor.currentRalphSessionId || supervisor.currentWorkerSessionId || supervisor.done) {
        return JSON.stringify(
          {
            ok: true,
            started: false,
            message: "Loop is already running or completed for this process.",
            currentRalphSessionId: supervisor.currentRalphSessionId,
            currentWorkerSessionId: supervisor.currentWorkerSessionId,
            done: supervisor.done,
          },
          null,
          2
        );
      }

      supervisor.attempt = 1;
      await notifySupervisor("supervisor", "Starting Ralph loop at attempt 1 (manual start).", "info", true, sessionID);
      await spawnRalphSession(1);
      return JSON.stringify({ ok: true, started: true, attempt: 1 }, null, 2);
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tool: ralph_end_supervision
  // ────────────────────────────────────────────────────────────────────────────
  const tool_ralph_end_supervision = tool({
    description:
      "Stop Ralph supervision for this process. Prevents further auto-loop orchestration until restarted.",
    args: {
      reason: tool.schema.string().optional().describe("Optional reason for ending supervision."),
      delete_sessions: tool.schema
        .boolean()
        .optional()
        .describe("Also delete child sessions after aborting them (default false)."),
      clear_binding: tool.schema
        .boolean()
        .optional()
        .describe("Clear supervisor session binding after stop (default false)."),
    },
    async execute(args, ctx) {
      const sessionID = ctx.sessionID ?? "default";
      const reason = args.reason?.trim();

      supervisor.done = true;
      supervisor.paused = true;
      const sessionsToAbort = Array.from(sessionMap.keys());
      for (const id of sessionsToAbort) {
        await client.session.abort({ path: { id } }).catch(() => {});
        if (args.delete_sessions) {
          await client.session.delete({ path: { id } }).catch(() => {});
        }
      }
      stopAllCommands("supervision-ended");
      sessionMap.clear();
      supervisor.currentRalphSessionId = undefined;
      supervisor.currentWorkerSessionId = undefined;
      supervisor.activeReviewerName = undefined;
      supervisor.activeReviewerAttempt = undefined;
      supervisor.activeReviewerSessionId = undefined;
      supervisor.activeReviewerOutputPath = undefined;
      await persistReviewerState();

      if (args.clear_binding === true) {
        supervisor.sessionId = undefined;
      }

      await notifySupervisor(
        "supervisor",
        reason
          ? `Supervision ended. Reason: ${reason}`
          : "Supervision ended by user request.",
        "warning",
        true,
        sessionID
      );

      return JSON.stringify(
        {
          ok: true,
          done: supervisor.done,
          clearedBinding: args.clear_binding === true,
          note: "Use ralph_create_supervisor_session(restart_if_done=true) to start again.",
        },
        null,
        2
      );
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tool: ralph_supervision_status
  // ────────────────────────────────────────────────────────────────────────────
  const tool_ralph_supervision_status = tool({
    description:
      "Get current supervision state (binding, attempt, active strategist/worker, done flag).",
    args: {},
    async execute(_args, _ctx) {
      return JSON.stringify(
        {
          supervisor: {
            sessionId: supervisor.sessionId ?? null,
            attempt: supervisor.attempt,
            done: supervisor.done,
            paused: supervisor.paused ?? false,
            currentRalphSessionId: supervisor.currentRalphSessionId ?? null,
            currentWorkerSessionId: supervisor.currentWorkerSessionId ?? null,
            activeReviewerName: supervisor.activeReviewerName ?? null,
            activeReviewerAttempt: supervisor.activeReviewerAttempt ?? null,
            activeReviewerSessionId: supervisor.activeReviewerSessionId ?? null,
            activeReviewerOutputPath: supervisor.activeReviewerOutputPath ?? null,
            reviewRequested: supervisor.reviewRequested,
            reviewerRuns: supervisor.reviewerRuns,
            lastMainIdleAt: supervisor.lastMainIdleAt ?? null,
          },
        },
        null,
        2
      );
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tool: ralph_pause_supervision
  // ────────────────────────────────────────────────────────────────────────────
  const tool_ralph_pause_supervision = tool({
    description: "Pause automatic Ralph orchestration without ending supervision.",
    args: {
      reason: tool.schema.string().optional().describe("Optional pause reason."),
    },
    async execute(args, ctx) {
      const sessionID = ctx.sessionID ?? "default";
      supervisor.paused = true;
      await notifySupervisor(
        "supervisor",
        args.reason ? `Supervision paused: ${args.reason}` : "Supervision paused.",
        "warning",
        true,
        sessionID
      );
      return JSON.stringify({ ok: true, paused: true }, null, 2);
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tool: ralph_resume_supervision
  // ────────────────────────────────────────────────────────────────────────────
  const tool_ralph_resume_supervision = tool({
    description: "Resume supervision after pause. Optionally start loop immediately.",
    args: {
      start_loop: tool.schema.boolean().optional(),
    },
    async execute(args, ctx) {
      const sessionID = ctx.sessionID ?? "default";
      if (!supervisor.sessionId) supervisor.sessionId = sessionID;
      supervisor.paused = false;
      await notifySupervisor("supervisor", "Supervision resumed.", "info", true, sessionID);

      const shouldStart = args.start_loop ?? false;
      if (!shouldStart) return JSON.stringify({ ok: true, resumed: true, started: false }, null, 2);

      if (supervisor.done) {
        return JSON.stringify(
          {
            ok: false,
            resumed: true,
            message: "Loop is marked done. Use ralph_create_supervisor_session(restart_if_done=true).",
          },
          null,
          2
        );
      }

      if (supervisor.currentRalphSessionId || supervisor.currentWorkerSessionId) {
        return JSON.stringify({ ok: true, resumed: true, started: false, message: "Loop already running." }, null, 2);
      }

      supervisor.attempt = Math.max(1, supervisor.attempt || 1);
      await spawnRalphSession(supervisor.attempt);
      return JSON.stringify({ ok: true, resumed: true, started: true, attempt: supervisor.attempt }, null, 2);
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tool: ralph_validate_plan
  // ────────────────────────────────────────────────────────────────────────────
  const tool_ralph_validate_plan = tool({
    description: "Validate PLAN.md structure and readiness for long-running loops.",
    args: {},
    async execute(_args, ctx) {
      const root = ctx.worktree ?? worktree;
      const planPath = NodePath.join(root, FILES.PLAN);
      const exists = await run(fileExists(planPath));
      if (!exists) {
        return JSON.stringify(
          {
            ok: false,
            errors: ["PLAN.md is missing."],
            suggestions: ["Run ralph_bootstrap_plan(...) first."],
          },
          null,
          2
        );
      }

      const plan = await run(readFile(planPath).pipe(Effect.orElseSucceed(() => "")));
      const validation = validatePlanContent(plan);
      return JSON.stringify(validation, null, 2);
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tool: ralph_reset_state
  // ────────────────────────────────────────────────────────────────────────────
  const tool_ralph_reset_state = tool({
    description: "Reset Ralph protocol/runtime state. Requires explicit confirmation token.",
    args: {
      scope: tool.schema
        .enum(["attempt", "full"] as const)
        .describe("attempt = reset scratch only; full = reset protocol + runtime state."),
      confirm: tool.schema
        .string()
        .describe("Must equal RESET_RALPH_STATE to execute."),
      preserve_logs: tool.schema.boolean().optional(),
    },
    async execute(args, ctx) {
      if (args.confirm !== "RESET_RALPH_STATE") {
        throw new Error("Confirmation token mismatch. Set confirm to RESET_RALPH_STATE.");
      }
      const root = ctx.worktree ?? worktree;
      const preserveLogs = args.preserve_logs === true;
      const ts = nowISO();

      await run(writeFile(NodePath.join(root, FILES.CURR), templates.bootstrapCurrentState));
      await run(writeFile(NodePath.join(root, FILES.PREV), `# Previous State (snapshot)\n\nCaptured: ${ts}\n\n(reset)\n`));
      await run(writeFile(NodePath.join(root, FILES.NEXT_RALPH), `# Next Ralph Context\n\n- Timestamp: ${ts}\n- Verdict: reset\n\n## Summary\nManual reset\n\n## Next Step\nSet a new goal and run again.\n`));

      if (args.scope === "full") {
        await run(writeFile(NodePath.join(root, FILES.PLAN), "# Plan\n\n## Goal\n(fill in)\n\n## Requirements\n- (fill in)\n\n## Definition of Done\n- (fill in)\n"));
        await run(writeFile(NodePath.join(root, FILES.RLM_INSTR), interpolate(templates.bootstrapRlmInstructions, { timestamp: ts })));
        await run(writeFile(NodePath.join(root, FILES.TODOS), "# Todos\n\n- [ ] (optional)\n"));
      }

      if (!preserveLogs) {
        await run(writeFile(NodePath.join(root, FILES.SUPERVISOR_LOG), `# Supervisor Log (append-only)\n\n- ${ts} reset\n`));
        await run(writeFile(NodePath.join(root, FILES.CONVERSATION), `# Conversation Log (append-only)\n\n- ${ts} reset\n`));
      }

      supervisor.done = false;
      supervisor.paused = false;
      supervisor.attempt = 0;
      supervisor.currentRalphSessionId = undefined;
      supervisor.currentWorkerSessionId = undefined;
      supervisor.activeReviewerName = undefined;
      supervisor.activeReviewerAttempt = undefined;
      supervisor.activeReviewerSessionId = undefined;
      supervisor.activeReviewerOutputPath = undefined;
      await persistReviewerState();
      supervisor.reviewRequested = {};
      supervisor.reviewerRuns = {};

      await notifySupervisor("supervisor", `State reset (${args.scope}).`, "warning", true, ctx.sessionID ?? "default");
      return JSON.stringify({ ok: true, scope: args.scope, preserveLogs }, null, 2);
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tool: ralph_quickstart_wizard
  // ────────────────────────────────────────────────────────────────────────────
  const tool_ralph_quickstart_wizard = tool({
    description: "Guided setup helper: doctor autofix + plan bootstrap + optional supervisor start.",
    args: {
      goal: tool.schema.string().describe("Primary goal."),
      requirements: tool.schema.array(tool.schema.string()).optional(),
      stopping_conditions: tool.schema.array(tool.schema.string()).optional(),
      features: tool.schema.array(tool.schema.string()).optional(),
      steps: tool.schema.array(tool.schema.string()).optional(),
      todos: tool.schema.array(tool.schema.string()).optional(),
      start_loop: tool.schema.boolean().optional(),
      overwrite_plan: tool.schema.boolean().optional(),
      overwrite_todos: tool.schema.boolean().optional(),
      autofix: tool.schema.boolean().optional(),
    },
    async execute(args, ctx) {
      const root = ctx.worktree ?? worktree;
      const doAutofix = args.autofix !== false;
      const actions: string[] = [];

      if (doAutofix) {
        const configPath = NodePath.join(root, ".opencode", "ralph.json");
        const configExists = await run(fileExists(configPath));
        if (!configExists) {
          const defaults = await run(detectProjectDefaults(root));
          const defaultCfg = {
            enabled: true,
            autoStartOnMainIdle: false,
            statusVerbosity: "normal",
            maxAttempts: 25,
            heartbeatMinutes: 15,
            verify: { command: defaults.verify, cwd: "." },
            gateDestructiveToolsUntilContextLoaded: true,
            maxRlmSliceLines: 200,
            requireGrepBeforeLargeSlice: true,
            grepRequiredThresholdLines: 120,
            subAgentEnabled: true,
            maxSubAgents: 5,
            maxConversationLines: 1200,
            conversationArchiveCount: 3,
            reviewerEnabled: false,
            reviewerRequireExplicitReady: true,
            reviewerMaxRunsPerAttempt: 1,
            reviewerOutputDir: ".opencode/reviews",
            reviewerPostToConversation: true,
            agentMdPath: "AGENT.md",
          };
          await run(writeFile(configPath, `${JSON.stringify(defaultCfg, null, 2)}\n`));
          _configCache = null;
          actions.push("Created .opencode/ralph.json");
        }
      }

      const planPath = NodePath.join(root, FILES.PLAN);
      if (await run(fileExists(planPath)) && args.overwrite_plan !== true) {
        throw new Error("PLAN.md already exists. Set overwrite_plan=true to replace it in quickstart.");
      }
      const plan = renderPlan({
        goal: args.goal,
        requirements: args.requirements ?? [],
        stoppingConditions: args.stopping_conditions ?? [],
        features: args.features ?? [],
        steps: args.steps ?? [],
      });
      await run(writeFile(planPath, plan));
      actions.push("Wrote PLAN.md");

      const todosPath = NodePath.join(root, FILES.TODOS);
      if (!(await run(fileExists(todosPath))) || args.overwrite_todos === true) {
        const items = (args.todos ?? args.steps ?? []).map((t) => `- [ ] ${t}`);
        await run(writeFile(todosPath, ["# Todos", "", ...(items.length ? items : ["- [ ] (optional)"]), ""].join("\n")));
        actions.push("Wrote TODOS.md");
      }

      const validation = validatePlanContent(plan);
      const startLoop = args.start_loop === true;
      if (startLoop) {
        supervisor.sessionId = ctx.sessionID ?? "default";
        supervisor.done = false;
        supervisor.paused = false;
        supervisor.attempt = 1;
        await spawnRalphSession(1);
        actions.push("Started loop at attempt 1");
      }

      await appendConversationEntry("supervisor", `Quickstart completed for goal: ${args.goal}`);
      return JSON.stringify({ ok: validation.ok, actions, validation, started: startLoop }, null, 2);
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tool: ralph_request_review
  // ────────────────────────────────────────────────────────────────────────────
  const tool_ralph_request_review = tool({
    description: "Mark current attempt as ready for reviewer pass.",
    args: {
      note: tool.schema.string().optional().describe("Optional reason/context for review."),
    },
    async execute(args, ctx) {
      const sessionID = ctx.sessionID ?? "default";
      const st = getSession(sessionID);
      const attempt = st.attempt > 0 ? st.attempt : Math.max(1, supervisor.attempt);
      const note = args.note?.trim() || "ready";
      markReviewRequested(attempt, note);
      await notifySupervisor(
        `${st.role}/attempt-${attempt}`,
        `Marked attempt ${attempt} ready for review: ${note}`,
        "info",
        true,
        sessionID
      );
      return JSON.stringify({ ok: true, attempt, note }, null, 2);
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tool: ralph_review_status
  // ────────────────────────────────────────────────────────────────────────────
  const tool_ralph_review_status = tool({
    description: "Show reviewer gating state for current/known attempts.",
    args: {},
    async execute(_args, _ctx) {
      return JSON.stringify(
        {
          activeReviewerName: supervisor.activeReviewerName ?? null,
          activeReviewerAttempt: supervisor.activeReviewerAttempt ?? null,
          activeReviewerSessionId: supervisor.activeReviewerSessionId ?? null,
          activeReviewerOutputPath: supervisor.activeReviewerOutputPath ?? null,
          reviewRequested: supervisor.reviewRequested,
          reviewerRuns: supervisor.reviewerRuns,
        },
        null,
        2
      );
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tool: ralph_run_reviewer
  // ────────────────────────────────────────────────────────────────────────────
  const tool_ralph_run_reviewer = tool({
    description:
      "Run an optional reviewer sub-agent. Honors explicit review readiness and per-attempt run limits.",
    args: {
      force: tool.schema.boolean().optional(),
      wait: tool.schema.boolean().optional(),
      timeout_minutes: tool.schema.number().int().min(1).max(120).optional(),
      output_path: tool.schema.string().optional(),
    },
    async execute(args, ctx) {
      const root = ctx.worktree ?? worktree;
      const sessionID = ctx.sessionID ?? "default";
      const cfg = await run(getConfig());
      const waitForDone = args.wait !== false;
      const force = args.force === true;

      const waitForReviewerCompletion = async (
        reviewerName: string,
        attemptN: number,
        outputPath: string,
        requestedNote: string | undefined
      ): Promise<string> => {
        const maxIterations = (args.timeout_minutes ?? 20) * 12;
        const currPath = NodePath.join(root, ".opencode", "agents", reviewerName, "CURRENT_STATE.md");
        for (let i = 0; i < maxIterations; i++) {
          await sleep(5000);
          const raw = await NodeFs.readFile(currPath, "utf8").catch(() => "");
          const done = raw.includes(templates.subagentDoneHeading) || raw.includes(templates.subagentDoneSentinel);
          if (!done) continue;

          const reportBody = clampLines(raw, 800);
          await run(writeFile(NodePath.join(root, outputPath), [
            `# Reviewer Report — Attempt ${attemptN}`,
            "",
            `- reviewer: ${reviewerName}`,
            `- generated: ${nowISO()}`,
            `- requested: ${requestedNote ?? "(force/manual)"}`,
            "",
            "## Report",
            reportBody,
            "",
          ].join("\n")));

          supervisor.activeReviewerName = undefined;
          supervisor.activeReviewerAttempt = undefined;
          supervisor.activeReviewerSessionId = undefined;
          supervisor.activeReviewerOutputPath = undefined;
          clearReviewRequested(attemptN);
          await persistReviewerState();

          await notifySupervisor(
            `reviewer/attempt-${attemptN}`,
            `Reviewer completed. Report written to ${outputPath}.`,
            "info",
            cfg.reviewerPostToConversation,
            sessionID
          );

          return JSON.stringify({ ok: true, started: true, done: true, outputPath, reviewerName }, null, 2);
        }

        return JSON.stringify(
          {
            ok: true,
            started: true,
            done: false,
            reviewerName,
            outputPath,
            message: "Reviewer still running; call ralph_run_reviewer(wait=true) again or inspect with subagent_peek.",
          },
          null,
          2
        );
      };

      if (!cfg.reviewerEnabled && !force) {
        return JSON.stringify(
          { ok: false, reason: "reviewer disabled", hint: "Set reviewerEnabled=true in .opencode/ralph.json or use force=true." },
          null,
          2
        );
      }

      const st = getSession(sessionID);
      const attempt = st.attempt > 0 ? st.attempt : Math.max(1, supervisor.attempt);
      const requested = supervisor.reviewRequested[attempt];
      const runs = getReviewerRuns(attempt);

      if (!force && cfg.reviewerRequireExplicitReady && !requested) {
        return JSON.stringify(
          { ok: false, reason: "review not requested", hint: "Call ralph_request_review(note) from the worker when ready." },
          null,
          2
        );
      }

      if (!force && runs >= cfg.reviewerMaxRunsPerAttempt) {
        return JSON.stringify(
          { ok: false, reason: "review run limit reached", attempt, runs, limit: cfg.reviewerMaxRunsPerAttempt },
          null,
          2
        );
      }

      if (supervisor.activeReviewerName) {
        if (waitForDone && supervisor.activeReviewerOutputPath && supervisor.activeReviewerAttempt) {
          return waitForReviewerCompletion(
            supervisor.activeReviewerName,
            supervisor.activeReviewerAttempt,
            supervisor.activeReviewerOutputPath,
            supervisor.reviewRequested[supervisor.activeReviewerAttempt]
          );
        }
        return JSON.stringify(
          {
            ok: true,
            started: false,
            message: "Reviewer already running.",
            activeReviewerName: supervisor.activeReviewerName,
            activeReviewerAttempt: supervisor.activeReviewerAttempt,
          },
          null,
          2
        );
      }

      const reviewerName = `reviewer_${attempt}_${Date.now()}`;
      const outputPath = args.output_path?.trim() || NodePath.join(cfg.reviewerOutputDir, `review-attempt-${attempt}.md`);
      const stateDir = NodePath.join(".opencode", "agents", reviewerName);

      await run(bootstrapSubAgent(root, reviewerName, `Review attempt ${attempt}`, templates));
      const reviewerPrompt = [
        `You are reviewer sub-agent \"${reviewerName}\" for attempt ${attempt}.`,
        "",
        "Goal:",
        "- Review the repository changes with focus on correctness, edge cases, regressions, and maintainability.",
        "- Produce concise findings with severity (high/medium/low) and concrete fixes.",
        "",
        "Protocol:",
        `- State directory: ${stateDir}`,
        "- Keep CURRENT_STATE.md updated while reviewing.",
        `- Write final report under heading '${templates.subagentDoneHeading}' in CURRENT_STATE.md.`,
        `- Output '${templates.subagentDoneSentinel}' when finished.`,
        "",
        "Expected report sections:",
        "1) Verdict",
        "2) Findings",
        "3) Risk assessment",
        "4) Recommended next actions",
        "",
      ].join("\n");

      const childSessionResult = await client.session.create({ body: { title: `reviewer: ${reviewerName}` } });
      const reviewerSessionId: string = childSessionResult.data?.id ?? `reviewer-${Date.now()}`;
      sessionMap.set(reviewerSessionId, freshSession("subagent", attempt));
      mutateSession(reviewerSessionId, (s) => { s.lastProgressAt = Date.now(); });

      await client.session.prompt({
        path: { id: reviewerSessionId },
        body: { parts: [{ type: "text", text: reviewerPrompt }] },
      });

      supervisor.activeReviewerName = reviewerName;
      supervisor.activeReviewerAttempt = attempt;
      supervisor.activeReviewerSessionId = reviewerSessionId;
      supervisor.activeReviewerOutputPath = outputPath;
      incReviewerRuns(attempt);
      await persistReviewerState();

      await notifySupervisor(
        `reviewer/attempt-${attempt}`,
        `Started reviewer ${reviewerName}.`,
        "info",
        cfg.reviewerPostToConversation,
        sessionID
      );

      if (!waitForDone) {
        return JSON.stringify({ ok: true, started: true, reviewerName, reviewerSessionId, outputPath, waiting: false }, null, 2);
      }

      return waitForReviewerCompletion(reviewerName, attempt, outputPath, requested);
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // § 13. Outer loop
  // ────────────────────────────────────────────────────────────────────────────

  const emitHeartbeatWarnings = async (): Promise<void> => {
    if (supervisor.done || supervisor.paused) return;
    const cfg = await run(getConfig());
    const thresholdMs = cfg.heartbeatMinutes * 60_000;
    const now = Date.now();

    const maybeWarn = async (sessionId: string | undefined, label: string): Promise<void> => {
      if (!sessionId) return;
      const st = sessionMap.get(sessionId);
      if (!st) return;
      const last = st.lastProgressAt;
      if (!last) return;
      if (now - last < thresholdMs) return;
      await notifySupervisor(
        `${st.role}/attempt-${st.attempt}`,
        `${label} has no progress update for ${cfg.heartbeatMinutes}+ minutes.`,
        "warning",
        true,
        sessionId
      );
      mutateSession(sessionId, (s) => { s.lastProgressAt = now; });
    };

    await maybeWarn(supervisor.currentRalphSessionId, "Strategist");
    await maybeWarn(supervisor.currentWorkerSessionId, "Worker");
  };

  const clearSessionTracking = async (sessionId: string, reason: string): Promise<void> => {
    const st = sessionMap.get(sessionId);
    sessionMap.delete(sessionId);

    let didUpdate = false;
    if (supervisor.currentRalphSessionId === sessionId) {
      supervisor.currentRalphSessionId = undefined;
      didUpdate = true;
    }
    if (supervisor.currentWorkerSessionId === sessionId) {
      supervisor.currentWorkerSessionId = undefined;
      didUpdate = true;
    }
    if (supervisor.activeReviewerSessionId === sessionId) {
      supervisor.activeReviewerSessionId = undefined;
      supervisor.activeReviewerName = undefined;
      supervisor.activeReviewerAttempt = undefined;
      supervisor.activeReviewerOutputPath = undefined;
      didUpdate = true;
      await persistReviewerState();
    }

    if (didUpdate && st) {
      await notifySupervisor(
        `${st.role}/attempt-${st.attempt}`,
        `${st.role} session ended (${reason}).`,
        "info",
        true,
        sessionId
      );
    }
  };

  /** Helper: run verify and parse the result into { verdict, details }. */
  const runAndParseVerify = async (): Promise<{ verdict: "pass" | "fail" | "unknown"; details: string }> => {
    const raw = await run(runVerify(worktree));
    try {
      const p = JSON.parse(raw);
      return {
        verdict: (p.verdict ?? "unknown") as "pass" | "fail" | "unknown",
        details: p.error ? `${p.error}\n${p.output ?? ""}` : (p.output ?? ""),
      };
    } catch {
      return { verdict: "unknown", details: raw };
    }
  };

  /** Roll over state files after a failed attempt. */
  const rolloverState = async (attemptN: number, verdict: string, details: string): Promise<void> => {
    const ts = nowISO();
    const summary = `Attempt ${attemptN} — verification ${verdict}.\n\n${clampLines(details, 120)}`;
    await run(
      Effect.gen(function* () {
        const curr = yield* readFile(NodePath.join(worktree, FILES.CURR)).pipe(Effect.orElseSucceed(() => ""));
        yield* Effect.all(
          [
            writeFile(NodePath.join(worktree, FILES.PREV), `# Previous State (snapshot)\n\nCaptured: ${ts}\n\n${curr}\n`),
            writeFile(NodePath.join(worktree, FILES.CURR), templates.bootstrapCurrentState),
            writeFile(
              NodePath.join(worktree, FILES.NEXT_RALPH),
              `# Next Ralph Context\n\n- Timestamp: ${ts}\n- Verdict: ${verdict}\n\n## Summary\n${summary}\n\n## Next Step\n${interpolate(templates.continuePrompt, { attempt: String(attemptN), verdict })}\n`
            ),
          ],
          { concurrency: "unbounded" }
        );
      })
    );
  };

  /**
   * Spawn an RLM worker session for the given attempt.
   * Called by the `ralph_spawn_worker` tool (invoked by a Ralph strategist session).
   */
  const spawnRlmWorker = async (attempt: number): Promise<string> => {
    const result = await client.session.create({
      body: { title: `rlm-worker-attempt-${attempt}` },
    });
    const workerId = result.data?.id ?? `worker-${Date.now()}`;

    // Register BEFORE sending prompt so session.idle can identify it.
    supervisor.currentWorkerSessionId = workerId;
    sessionMap.set(workerId, freshSession("worker", attempt));
    mutateSession(workerId, (s) => { s.lastProgressAt = Date.now(); });

    const promptText = interpolate(templates.workerPrompt, {
      attempt: String(attempt),
      nextAttempt: String(attempt + 1),
    });

    await client.session.promptAsync({
      path: { id: workerId },
      body: { parts: [{ type: "text", text: promptText }] },
    }).catch(() => {});

    await notifySupervisor(
      `supervisor/attempt-${attempt}`,
      `Spawned worker session ${workerId}.`,
      "info",
      true
    );

    return workerId;
  };

  // Wire the forward-declared spawn tool now that spawnRlmWorker is in scope.
  tool_ralph_spawn_worker_impl = async (_args, ctx) => {
    const sessionID = ctx.sessionID ?? "";
    const st = sessionMap.get(sessionID);

    // Must be called from a Ralph strategist session.
    if (st?.role !== "ralph") {
      throw new Error("ralph_spawn_worker() can only be called from a Ralph strategist session.");
    }
    if (st.workerSpawned) {
      throw new Error("ralph_spawn_worker() has already been called for this attempt.");
    }

    mutateSession(sessionID, (s) => { s.workerSpawned = true; });
    const workerId = await spawnRlmWorker(st.attempt);
    await notifySupervisor(
      `ralph/attempt-${st.attempt}`,
      `Delegated coding to worker session ${workerId}.`,
      "info",
      true,
      sessionID
    );
    return JSON.stringify({ ok: true, workerSessionId: workerId, attempt: st.attempt }, null, 2);
  };

  /**
   * Spawn a fresh Ralph strategist session for the given attempt.
   * Ralph reviews state, optionally updates protocol files, then calls ralph_spawn_worker().
   */
  const spawnRalphSession = async (attempt: number): Promise<void> => {
    const result = await client.session.create({
      body: { title: `ralph-strategist-attempt-${attempt}` },
    });
    const ralphId = result.data?.id ?? `ralph-${Date.now()}`;

    supervisor.currentRalphSessionId = ralphId;
    sessionMap.set(ralphId, freshSession("ralph", attempt));
    mutateSession(ralphId, (s) => { s.lastProgressAt = Date.now(); });

    const promptText = interpolate(templates.ralphSessionPrompt, {
      attempt: String(attempt),
      nextAttempt: String(attempt + 1),
    });

    await client.session.promptAsync({
      path: { id: ralphId },
      body: { parts: [{ type: "text", text: promptText }] },
    }).catch(() => {});

    await notifySupervisor(
      `supervisor/attempt-${attempt}`,
      `Spawned Ralph strategist session ${ralphId}.`,
      "info",
      true
    );
  };

  /**
   * Called when an RLM worker session goes idle.
   * Runs verify; on pass finishes the loop, on fail rolls over and spawns the next Ralph session.
   */
  const handleWorkerIdle = async (workerSessionId: string): Promise<void> => {
    if (supervisor.currentWorkerSessionId !== workerSessionId) return;
    if (supervisor.done) return;

    const cfg = await run(getConfig());
    if (!cfg.enabled) return;
    if (!cfg.autoStartOnMainIdle) return;

    const workerState = sessionMap.get(workerSessionId);
    supervisor.currentWorkerSessionId = undefined;

    if (!workerState?.reportedStatus) {
      await notifySupervisor(
        `worker/attempt-${supervisor.attempt}`,
        "No explicit status reported before idle; continuing with implicit verification flow.",
        "info",
        true,
        workerSessionId
      );
    }

    await notifySupervisor(
      `worker/attempt-${supervisor.attempt}`,
      `Worker ${workerSessionId} is idle; running verification.`,
      "info",
      true,
      workerSessionId
    );

    const { verdict, details } = await runAndParseVerify();

    if (verdict === "pass") {
      supervisor.done = true;
      await run(
        writeFile(
          NodePath.join(worktree, FILES.NEXT_RALPH),
          interpolate(templates.doneFileContent, { timestamp: nowISO() })
        )
      );
      await client.tui.showToast({
        body: { title: "Ralph: Done", message: "Verification passed. Loop complete.", variant: "success" },
      }).catch(() => {});
      await notifySupervisor(
        `worker/attempt-${supervisor.attempt}`,
        "Verification passed. Loop complete.",
        "info",
        true,
        workerSessionId
      );
      return;
    }

    // Fail — check attempt limit then spawn next Ralph session.
    if (supervisor.attempt >= cfg.maxAttempts) {
      await client.tui.showToast({
        body: {
          title: "Ralph: stopped",
          message: `Max attempts (${cfg.maxAttempts}) reached. Review AGENT_CONTEXT_FOR_NEXT_RALPH.md.`,
          variant: "warning",
        },
      }).catch(() => {});
      await notifySupervisor(
        `worker/attempt-${supervisor.attempt}`,
        `Verification ${verdict}. Max attempts (${cfg.maxAttempts}) reached.`,
        "warning",
        true,
        workerSessionId
      );
      return;
    }

    await notifySupervisor(
      `worker/attempt-${supervisor.attempt}`,
      `Verification ${verdict}. Preparing next attempt.`,
      verdict === "fail" ? "warning" : "info",
      true,
      workerSessionId
    );

    supervisor.attempt += 1;
    await rolloverState(supervisor.attempt - 1, verdict, details);
    // Spawn a fresh Ralph strategist session — it reviews failure and delegates to a new worker.
    await spawnRalphSession(supervisor.attempt);
  };

  /**
   * Called when a Ralph strategist session goes idle.
   * If the Ralph session spawned a worker, nothing more to do here — handleWorkerIdle takes over.
   * If it did NOT spawn a worker (e.g. it stopped early), warn via toast.
   */
  const handleRalphSessionIdle = async (ralphSessionId: string): Promise<void> => {
    if (supervisor.currentRalphSessionId !== ralphSessionId) return;
    if (supervisor.done) return;

    supervisor.currentRalphSessionId = undefined;
    const st = sessionMap.get(ralphSessionId);

    if (st && !st.reportedStatus) {
      await notifySupervisor(
        `ralph/attempt-${st.attempt}`,
        "No explicit strategist status reported before idle.",
        "info",
        true,
        ralphSessionId
      );
    }

    if (!st?.workerSpawned) {
      // Ralph finished without spawning a worker — surface this so the user can investigate.
      await client.tui.showToast({
        body: {
          title: "Ralph: no worker spawned",
          message: `Ralph session for attempt ${st?.attempt ?? supervisor.attempt} ended without calling ralph_spawn_worker().`,
          variant: "warning",
        },
      }).catch(() => {});
      await notifySupervisor(
        `ralph/attempt-${st?.attempt ?? supervisor.attempt}`,
        "Strategist went idle without spawning a worker.",
        "warning",
        true,
        ralphSessionId
      );
    }
    // If worker was spawned, handleWorkerIdle will fire when it goes idle.
  };

  /**
   * Called when the main session goes idle.
   * Kicks off attempt 1 if the loop has not started yet.
   */
  const handleMainIdle = async (sessionID: string): Promise<void> => {
    if (supervisor.done) return;
    if (supervisor.paused) return;
    if (supervisor.currentRalphSessionId) return; // Ralph already running.
    if (supervisor.currentWorkerSessionId) return; // Worker already running.

    const cfg = await run(getConfig());
    if (!cfg.enabled) return;

    // Debounce — ignore idle bursts within 800 ms.
    const now = Date.now();
    if (supervisor.lastMainIdleAt && now - supervisor.lastMainIdleAt < 800) return;
    supervisor.lastMainIdleAt = now;

    if (!supervisor.sessionId) {
      supervisor.sessionId = sessionID;
      await notifySupervisor("supervisor", "Bound supervisor to main session.", "info", false, sessionID);
    } else if (sessionID !== supervisor.sessionId) {
      // Ignore unrelated sessions; only the bound supervisor session can kick loops.
      return;
    }

    // Kick off attempt 1: spawn the first Ralph strategist session.
    const diagnostics = await checkSetup(worktree, cfg);
    if (!diagnostics.ready) {
      await notifySupervisor(
        "supervisor",
        "Auto-start skipped: setup incomplete. Run ralph_doctor(autofix=true) and ralph_bootstrap_plan().",
        "warning",
        true,
        sessionID
      );
      return;
    }

    supervisor.attempt = 1;
    await notifySupervisor("supervisor", "Starting Ralph loop at attempt 1.", "info", true, sessionID);
    await spawnRalphSession(1);
  };

  // ────────────────────────────────────────────────────────────────────────────
  // § 14. Plugin return value (tools + hooks)
  // ────────────────────────────────────────────────────────────────────────────
  return {
    tool: {
      ralph_load_context: tool_ralph_load_context,
      rlm_grep: tool_rlm_grep,
      rlm_slice: tool_rlm_slice,
      ralph_update_plan: tool_ralph_update_plan,
      ralph_update_rlm_instructions: tool_ralph_update_rlm_instructions,
      ralph_rollover: tool_ralph_rollover,
      ralph_verify: tool_ralph_verify,
      ralph_peek_worker: tool_ralph_peek_worker,
      ralph_spawn_worker: tool_ralph_spawn_worker,
      subagent_peek: tool_subagent_peek,
      subagent_spawn: tool_subagent_spawn,
      subagent_await: tool_subagent_await,
      subagent_list: tool_subagent_list,
      ralph_report: tool_ralph_report,
      ralph_set_status: tool_ralph_set_status,
      ralph_ask: tool_ralph_ask,
      ralph_respond: tool_ralph_respond,
      ralph_doctor: tool_ralph_doctor,
      ralph_bootstrap_plan: tool_ralph_bootstrap_plan,
      ralph_create_supervisor_session: tool_ralph_create_supervisor_session,
      ralph_end_supervision: tool_ralph_end_supervision,
      ralph_supervision_status: tool_ralph_supervision_status,
      ralph_pause_supervision: tool_ralph_pause_supervision,
      ralph_resume_supervision: tool_ralph_resume_supervision,
      ralph_validate_plan: tool_ralph_validate_plan,
      ralph_reset_state: tool_ralph_reset_state,
      ralph_quickstart_wizard: tool_ralph_quickstart_wizard,
      ralph_request_review: tool_ralph_request_review,
      ralph_review_status: tool_ralph_review_status,
      ralph_run_reviewer: tool_ralph_run_reviewer,
    },

    // ── System prompt injection ──────────────────────────────────────────────
    // Three-way routing:
    //   worker  → RLM file-first protocol prompt
    //   ralph   → Ralph strategist prompt
    //   main / other → supervisor prompt (shown to the user's session)
    "experimental.chat.system.transform": async (input: any, output: any) => {
      output.system = output.system ?? [];
      const sessionID: string | undefined = input.sessionID ?? input.session_id;
      const role = sessionMap.get(sessionID ?? "")?.role;
      const base =
        role === "worker" || role === "subagent" ? templates.workerSystemPrompt :
        role === "ralph"  ? templates.ralphSessionSystemPrompt :
        templates.systemPrompt;
      const full = templates.systemPromptAppend
        ? `${base}\n${templates.systemPromptAppend}`
        : base;
      output.system.push(full);
    },

    // ── Compaction hook ──────────────────────────────────────────────────────
    "experimental.session.compacting": async (_input: any, output: any) => {
      output.context = output.context ?? [];
      output.context.push(templates.compactionContext);
    },

    // ── Tool gating (worker sessions only) ───────────────────────────────────
    // The gate only applies to RLM workers. Ralph's session is not gated
    // (Ralph doesn't do coding; gating it would block sub-agent tools needlessly).
    "tool.execute.before": async (input: any, _output: any) => {
      const cfg = await run(getConfig());
      if (!cfg.gateDestructiveToolsUntilContextLoaded) return;

      const sessionID: string | undefined =
        input.sessionID ?? input.session_id ?? input.session?.id;
      if (!sessionID) return;

      const state = sessionMap.get(sessionID);
      if (state?.role !== "worker" && state?.role !== "subagent") return; // Only gate file-first coding sessions.

      const toolName: string = input.tool ?? input.call?.name ?? "";
      if (!toolName) return;
      if (SAFE_TOOLS.has(toolName)) return;
      if (!DESTRUCTIVE_TOOLS.has(toolName)) return;

      if (!state.loadedContext) {
        throw new Error(templates.contextGateError);
      }
    },

    // ── Event subscriptions ──────────────────────────────────────────────────
    event: async ({ event }: any) => {
      const sessionID: string | undefined =
        event?.sessionID ?? event?.session_id ?? event?.session?.id;

      if (event?.type === "session.created" && sessionID) {
        // Pre-allocate session state for known workers; others will be lazy-init'd.
        if (sessionMap.has(sessionID)) getSession(sessionID);
      }

      if (event?.type === "session.status" && sessionID) {
        if (supervisor.done || supervisor.paused) return;
        const state = sessionMap.get(sessionID);
        if (state?.role === "worker" && supervisor.currentWorkerSessionId !== sessionID) return;
        if (state?.role === "ralph" && supervisor.currentRalphSessionId !== sessionID) return;
        if (state) {
          mutateSession(sessionID, (s) => { s.lastProgressAt = Date.now(); });
          const statusRaw = String(event?.status ?? event?.data?.status ?? "").toLowerCase();
          if (statusRaw === "error") {
            await notifySupervisor(
              `${state.role}/attempt-${state.attempt}`,
              "Session reported error status.",
              "error",
              true,
              sessionID
            );
          }
        }
      }

      if (event?.type === "session.idle" && sessionID) {
        if (supervisor.done || supervisor.paused) return;
        await emitHeartbeatWarnings().catch((err: unknown) => {
          void appLog("error", "heartbeat warning error", { error: String(err) });
        });

        if (supervisor.currentWorkerSessionId === sessionID) {
          // RLM worker went idle — verify and continue the loop.
          await handleWorkerIdle(sessionID).catch((err: unknown) => {
            void appLog("error", "handleWorkerIdle error", { error: String(err), sessionID });
          });
        } else if (supervisor.currentRalphSessionId === sessionID) {
          // Ralph strategist session went idle.
          await handleRalphSessionIdle(sessionID).catch((err: unknown) => {
            void appLog("error", "handleRalphSessionIdle error", { error: String(err), sessionID });
          });
        } else {
          // Main session (or unrelated) went idle — kick off attempt 1 if not started.
          await handleMainIdle(sessionID).catch((err: unknown) => {
            void appLog("error", "handleMainIdle error", { error: String(err), sessionID });
          });
        }
      }

      if (sessionID && (event?.type === "session.closed" || event?.type === "session.ended" || event?.type === "session.deleted")) {
        await clearSessionTracking(sessionID, event.type);
      }
    },
  };
};
