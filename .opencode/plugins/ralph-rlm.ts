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
 * └─────────────────────────────────────┴────────────────────────────────────────────────────────┘
 */

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin/tool";
import * as NodePath from "path";
import { promises as NodeFs } from "fs";
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
  maxAttempts: Schema.optional(Schema.Number),
  verify: Schema.optional(VerifyConfigSchema),
  gateDestructiveToolsUntilContextLoaded: Schema.optional(Schema.Boolean),
  maxRlmSliceLines: Schema.optional(Schema.Number),
  requireGrepBeforeLargeSlice: Schema.optional(Schema.Boolean),
  grepRequiredThresholdLines: Schema.optional(Schema.Number),
  subAgentEnabled: Schema.optional(Schema.Boolean),
  maxSubAgents: Schema.optional(Schema.Number),
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
  maxAttempts: number;
  verify?: { command: string[]; cwd?: string };
  gateDestructiveToolsUntilContextLoaded: boolean;
  maxRlmSliceLines: number;
  requireGrepBeforeLargeSlice: boolean;
  grepRequiredThresholdLines: number;
  subAgentEnabled: boolean;
  maxSubAgents: number;
  /** Relative path to AGENT.md; empty string disables inclusion. */
  agentMdPath: string;
};

const CONFIG_DEFAULTS: ResolvedConfig = {
  enabled: true,
  maxAttempts: 20,
  gateDestructiveToolsUntilContextLoaded: true,
  maxRlmSliceLines: 200,
  requireGrepBeforeLargeSlice: true,
  grepRequiredThresholdLines: 120,
  subAgentEnabled: true,
  maxSubAgents: 5,
  agentMdPath: "AGENT.md",
};

function resolveConfig(raw: RalphConfig): ResolvedConfig {
  return {
    enabled: raw.enabled ?? CONFIG_DEFAULTS.enabled,
    maxAttempts: raw.maxAttempts ?? CONFIG_DEFAULTS.maxAttempts,
    ...(raw.verify !== undefined ? { verify: raw.verify as NonNullable<ResolvedConfig["verify"]> } : {}),
    gateDestructiveToolsUntilContextLoaded:
      raw.gateDestructiveToolsUntilContextLoaded ??
      CONFIG_DEFAULTS.gateDestructiveToolsUntilContextLoaded,
    maxRlmSliceLines: raw.maxRlmSliceLines ?? CONFIG_DEFAULTS.maxRlmSliceLines,
    requireGrepBeforeLargeSlice:
      raw.requireGrepBeforeLargeSlice ?? CONFIG_DEFAULTS.requireGrepBeforeLargeSlice,
    grepRequiredThresholdLines:
      raw.grepRequiredThresholdLines ?? CONFIG_DEFAULTS.grepRequiredThresholdLines,
    subAgentEnabled: raw.subAgentEnabled ?? CONFIG_DEFAULTS.subAgentEnabled,
    maxSubAgents: raw.maxSubAgents ?? CONFIG_DEFAULTS.maxSubAgents,
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
};

const DEFAULT_TEMPLATES: PromptTemplates = {
  systemPrompt: [
    "FILE-FIRST PROTOCOL (Ralph + RLM):",
    "- ALWAYS call ralph_load_context() at the start of every attempt before any other work.",
    "- PLAN.md and RLM_INSTRUCTIONS.md are authoritative. Follow them.",
    "- CONTEXT_FOR_RLM.md is large. Access it via rlm_grep + rlm_slice only. Never full-dump it.",
    "- CURRENT_STATE.md is scratch for the current attempt. It will be rolled into PREVIOUS_STATE.md on rollover.",
    "- NOTES_AND_LEARNINGS.md is append-only. Write durable insights here.",
    "- Sub-agents: subagent_spawn to delegate, subagent_peek to inspect, subagent_await to collect.",
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
      console.warn(`[ralph-rlm] Failed to load ${envKey}: ${e}. Using default.`);
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

type SessionState = {
  loadedContext: boolean;
  attempt: number;
  lastIdleHandledAt?: number;
  lastPluginPromptAt?: number;
  lastGrepAt?: number;
  lastGrepQuery?: string;
  subAgents: SubAgentRecord[];
};

function freshSession(): SessionState {
  return { loadedContext: false, attempt: 0, subAgents: [] };
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

const DESTRUCTIVE_TOOLS = new Set(["write", "edit", "bash", "delete", "move", "rename"]);
const SAFE_TOOLS = new Set(["ralph_load_context", "rlm_grep", "rlm_slice", "subagent_peek", "ralph_verify"]);

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

  // ── Session state (plain Map — bridged from Effect to sync access) ──────────
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
      return yield* Effect.tryPromise({
        try: async () => {
          const output = await $({ cwd })`${verifyCmd}`.text();
          return JSON.stringify({ verdict: "pass", output }, null, 2);
        },
        catch: (err: any) =>
          JSON.stringify(
            {
              verdict: "fail",
              output: typeof err?.stdout === "string" ? err.stdout : "",
              error:
                typeof err?.stderr === "string"
                  ? err.stderr
                  : (err?.message ?? String(err)),
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
      mutateSession(sessionID, (s) => { s.loadedContext = true; });
      const st = getSession(sessionID);
      const cfg = await run(getConfig());
      const j = (f: string) => NodePath.join(root, f);

      return run(
        Effect.gen(function* () {
          const agentMdAbs = cfg.agentMdPath ? j(cfg.agentMdPath) : null;

          const [plan, rlmInstr, nextRalph, curr, prev, notes, todos, rlmRaw, agentMd] =
            yield* Effect.all(
              [
                readFile(j(FILES.PLAN)).pipe(Effect.orElseSucceed(() => "(missing — create PLAN.md)")),
                readFile(j(FILES.RLM_INSTR)).pipe(Effect.orElseSucceed(() => "(missing — create RLM_INSTRUCTIONS.md)")),
                readFile(j(FILES.NEXT_RALPH)).pipe(Effect.orElseSucceed(() => "(none)")),
                readFile(j(FILES.CURR)).pipe(Effect.orElseSucceed(() => "(empty)")),
                readFile(j(FILES.PREV)).pipe(Effect.orElseSucceed(() => "(none yet)")),
                readFile(j(FILES.NOTES)).pipe(Effect.orElseSucceed(() => "(empty)")),
                readFile(j(FILES.TODOS)).pipe(Effect.orElseSucceed(() => "(empty)")),
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
            context_for_rlm: {
              path: FILES.RLM_CTX,
              headings: rlmContext,
              policy: "Use rlm_grep + rlm_slice to access this file. Never dump it fully.",
            },
            sub_agents: st.subAgents,
            session: { attempt: st.attempt, loadedContext: st.loadedContext },
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

          let re: RegExp;
          try {
            re = new RegExp(args.query, "i");
          } catch {
            throw new Error(
              `Invalid regex pattern: ${args.query}. Use a valid JavaScript regex or a plain search string.`
            );
          }

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
  // § 13. Outer loop: handleIdle
  // ────────────────────────────────────────────────────────────────────────────
  const handleIdle = async (sessionID: string): Promise<void> => {
    const st = getSession(sessionID);
    const cfg = await run(getConfig());
    if (!cfg.enabled) return;

    const now = Date.now();
    if (st.lastIdleHandledAt && now - st.lastIdleHandledAt < 800) return;
    mutateSession(sessionID, (s) => { s.lastIdleHandledAt = Date.now(); });

    if (st.attempt >= cfg.maxAttempts) {
      await client.tui.showToast({
        body: {
          title: "Ralph: stopped",
          message: `Max attempts (${cfg.maxAttempts}) reached. Review AGENT_CONTEXT_FOR_NEXT_RALPH.md.`,
          variant: "warning",
        },
      }).catch(() => {});
      return;
    }

    const verifyRaw = await run(runVerify(worktree));
    let verdict: "pass" | "fail" | "unknown" = "unknown";
    let details = "";
    try {
      const p = JSON.parse(verifyRaw);
      verdict = p.verdict ?? "unknown";
      details = p.error ? `${p.error}\n${p.output ?? ""}` : (p.output ?? "");
    } catch {
      details = verifyRaw;
    }

    if (verdict === "pass") {
      await run(
        writeFile(
          NodePath.join(worktree, FILES.NEXT_RALPH),
          interpolate(templates.doneFileContent, { timestamp: nowISO() })
        )
      );
      await client.tui.showToast({
        body: { title: "Ralph: Done", message: "Verification passed. Loop complete.", variant: "success" },
      }).catch(() => {});
      return;
    }

    // Failed → rollover state files.
    mutateSession(sessionID, (s) => { s.attempt += 1; });
    const attemptN = getSession(sessionID).attempt;
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

    // Re-prompt the agent.
    const promptText = interpolate(templates.continuePrompt, {
      attempt: String(attemptN),
      verdict,
    });

    await client.session.prompt({
      path: { id: sessionID },
      body: { parts: [{ type: "text", text: promptText }] },
    }).catch(() => {});

    mutateSession(sessionID, (s) => { s.lastPluginPromptAt = Date.now(); });
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
      subagent_peek: tool_subagent_peek,
      subagent_spawn: tool_subagent_spawn,
      subagent_await: tool_subagent_await,
      subagent_list: tool_subagent_list,
    },

    // ── System prompt injection ──────────────────────────────────────────────
    "experimental.chat.system.transform": async (_input: any, output: any) => {
      output.system = output.system ?? [];
      const full = templates.systemPromptAppend
        ? `${templates.systemPrompt}\n${templates.systemPromptAppend}`
        : templates.systemPrompt;
      output.system.push(full);
    },

    // ── Compaction hook ──────────────────────────────────────────────────────
    "experimental.session.compacting": async (_input: any, output: any) => {
      output.context = output.context ?? [];
      output.context.push(templates.compactionContext);
    },

    // ── Tool gating ──────────────────────────────────────────────────────────
    "tool.execute.before": async (input: any, _output: any) => {
      const cfg = await run(getConfig());
      if (!cfg.gateDestructiveToolsUntilContextLoaded) return;

      const sessionID: string | undefined =
        input.sessionID ?? input.session_id ?? input.session?.id;
      if (!sessionID) return;

      const toolName: string = input.tool ?? input.call?.name ?? "";
      if (!toolName) return;

      if (SAFE_TOOLS.has(toolName)) return;
      if (!DESTRUCTIVE_TOOLS.has(toolName)) return;

      if (!getSession(sessionID).loadedContext) {
        throw new Error(templates.contextGateError);
      }
    },

    // ── Event subscriptions ──────────────────────────────────────────────────
    event: async ({ event }: any) => {
      const sessionID: string | undefined =
        event?.sessionID ?? event?.session_id ?? event?.session?.id;

      if (event?.type === "session.created" && sessionID) {
        getSession(sessionID);
      }

      if (event?.type === "session.idle" && sessionID) {
        await handleIdle(sessionID).catch((err: unknown) => {
          console.error("[ralph-rlm] handleIdle error:", err);
        });
      }
    },
  };
};
