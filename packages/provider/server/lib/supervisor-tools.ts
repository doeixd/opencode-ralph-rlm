import path from "node:path";
import {
  PROTOCOL_FILES,
  addPendingAnswer,
  applyProtocolPatch,
  appendTextFile,
  clampLines,
  fffFileSearch,
  fffGlob,
  fffGrep,
  isPlanAuthored,
  listPlans,
  listUnansweredQuestions,
  loadConfig,
  loadPlanContext,
  nowISO,
  protocolFilePath,
  readActivePlan,
  readPendingInput,
  readRawConfig,
  readTextFile,
  resolvePlanContext,
  runAndParseVerify,
  updateRawConfig,
  writeActivePlan,
  writePlanFile,
  type LoopEngine,
  type OpencodeEventSubscription,
  type OpencodeRuntime,
} from "@doeixd/opencode-ralph-rlm-engine";
import { getEngineForSession } from "./loop-service.js";
import {
  getSwarmRegistry,
  parseSpawnSwarmInput,
  runUnsafeSwarmScript,
  spawnSwarmForSession,
} from "./swarm-service.js";

export type SupervisorToolContext = {
  sessionKey: string;
  worktree: string;
  /** Test override — defaults to provider singleton runtime. */
  runtime?: OpencodeRuntime;
  subscribeEvents?: (
    onEvent: (event: unknown) => void | Promise<void>
  ) => Promise<OpencodeEventSubscription>;
};

export type OpenAIToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

const PROTOCOL_ALLOWLIST = new Set<string>(Object.values(PROTOCOL_FILES));

export const SUPERVISOR_TOOL_DEFINITIONS: OpenAIToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "loop_status",
      description:
        "Read loop snapshot: attempt number, started/done/paused/stopped, worker session id, last verify verdict, pending worker questions.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "start_loop",
      description:
        "Bootstrap protocol files (PLAN.md, RLM_INSTRUCTIONS.md, …) if needed and start attempt 1 with a background worker. Prefer authoring PLAN.md first (planning interview → write_plan) so the loop runs against a real goal; only start cold if the user says to skip planning. Launches against an existing authored plan without overwriting it.",
      parameters: {
        type: "object",
        properties: {
          goal: {
            type: "string",
            description: "User goal / definition of done in plain language.",
          },
          bootstrap: {
            type: "boolean",
            description: "Create protocol files when missing (default true).",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pause_loop",
      description: "Pause background orchestration (no new workers).",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "resume_loop",
      description: "Resume a paused loop and spawn next worker if idle.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "stop_loop",
      description: "Stop the loop and abort the active worker session.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Optional stop reason for logs." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "peek_worker",
      description: "Read the tail of CURRENT_STATE.md for the active attempt.",
      parameters: {
        type: "object",
        properties: {
          maxLines: { type: "integer", minimum: 20, maximum: 400 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_protocol",
      description: "Read an allowlisted protocol file by name (e.g. PLAN.md).",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string", description: "Protocol filename from the allowlist." },
          maxLines: { type: "integer", minimum: 20, maximum: 2000 },
        },
        required: ["file"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "repo_search",
      description:
        "Planning-phase repo discovery. Fuzzy-find files by name, or list files by glob (e.g. **/*.ts). Use during the planning interview to understand the codebase before writing a plan.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Fuzzy file-name query." },
          glob: { type: "string", description: "Glob pattern, e.g. src/**/*.ts." },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "repo_grep",
      description:
        "Planning-phase content search across the repo. Cross-reference user claims against the actual code during the interview.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query (plain text by default)." },
          mode: { type: "string", enum: ["plain", "regex", "fuzzy"] },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_verify",
      description:
        "Read the current verify.command (the loop's single stop condition) + cwd + timeout from ralph.json.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "set_verify",
      description:
        "Set verify.command in ralph.json — the command the loop runs to decide 'done' (exit 0 = pass). Develop a strong one WITH the user: it must genuinely test the goal (not just exit 0), be deterministic, and fail before the work is done. Validate with run_verify first.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "array",
            items: { type: "string" },
            description: "Argv array, e.g. [\"npm\",\"test\"] or [\"bash\",\"-c\",\"npm run lint && npm test\"].",
          },
          cwd: { type: "string", description: "Working directory relative to the repo (default '.')." },
          timeoutMinutes: { type: "integer", minimum: 0, maximum: 240, description: "0 = no timeout." },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_verify",
      description:
        "Run verify.command once, OUT of the loop, and return the verdict + output. Use to validate the command with the user — e.g. confirm it FAILS before the work is done (so a future pass is meaningful) and isn't trivially passing.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "write_plan",
      description:
        "Write the authored PLAN.md after the planning interview reaches an approved plan. Replaces the bootstrap placeholder. Call this BEFORE start_loop so the loop launches against a real plan.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description:
              "Full PLAN.md markdown. Lead with Goal and domain info; include ## Goal, ## Definition of Done, ## Milestones, plus open questions / invariants / decisions as needed. No file paths or code snippets.",
          },
        },
        required: ["content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_plans",
      description:
        "List named plans under the configured plans directory and the active one. Use when the user asks which plans/versions exist or wants to switch.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "select_plan",
      description:
        "Switch the active named plan. Subsequent read_protocol / write_plan / start_loop target this plan's directory.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Plan name to activate." } },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "new_plan",
      description:
        "Create and activate a new named plan (a fresh empty plan directory). Follow with write_plan to author it, then start_loop. Use to keep a separate version without disturbing existing plans.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "New plan name." } },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_plan",
      description: "Apply a unified diff patch to PLAN.md and append a changelog note.",
      parameters: {
        type: "object",
        properties: {
          patch: { type: "string", description: "Unified diff patch text." },
          reason: { type: "string", description: "Why the plan changed." },
        },
        required: ["patch"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_rlm_instructions",
      description: "Apply a unified diff patch to RLM_INSTRUCTIONS.md.",
      parameters: {
        type: "object",
        properties: {
          patch: { type: "string", description: "Unified diff patch text." },
          reason: { type: "string", description: "Why instructions changed." },
        },
        required: ["patch"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "last_verify_output",
      description: "Return raw output from the most recent verify run for this loop.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "list_worker_questions",
      description: "List unanswered worker questions blocked on ralph_ask().",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "spawn_swarm",
      description:
        "Start parallel background OpenCode agent sessions (side swarm; does not replace the main verify loop).",
      parameters: {
        type: "object",
        properties: {
          label: { type: "string" },
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                goal: { type: "string" },
                agent: { type: "string" },
                context: { type: "string" },
                providerID: { type: "string" },
                modelID: { type: "string" },
              },
              required: ["name", "goal"],
            },
          },
          concurrency: { type: "integer", minimum: 1, maximum: 50 },
          waitPolicy: { type: "string", enum: ["none", "all", "any"] },
          timeoutMinutes: { type: "integer", minimum: 1, maximum: 240 },
        },
        required: ["tasks"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "swarm_status",
      description: "Read status for one swarm or all swarms for this supervisor session.",
      parameters: {
        type: "object",
        properties: {
          swarmId: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "swarm_cancel",
      description: "Cancel a swarm run and abort active child sessions.",
      parameters: {
        type: "object",
        properties: {
          swarmId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["swarmId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "swarm_collect",
      description: "Aggregate per-task notes for a swarm run.",
      parameters: {
        type: "object",
        properties: {
          swarmId: { type: "string" },
          maxLines: { type: "integer", minimum: 20, maximum: 400 },
        },
        required: ["swarmId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "swarm_unsafe_runtime_code_eval",
      description:
        "UNSAFE: execute supervisor-authored TypeScript with injected OpenCode SDK client (opt-in only).",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string" },
          timeoutMinutes: { type: "integer", minimum: 1, maximum: 240 },
        },
        required: ["code"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "answer_worker",
      description: "Respond to a blocked worker question (writes pending_input.json).",
      parameters: {
        type: "object",
        properties: {
          questionId: { type: "string" },
          answer: { type: "string" },
        },
        required: ["questionId", "answer"],
        additionalProperties: false,
      },
    },
  },
];

async function logGoal(worktree: string, goal: string): Promise<void> {
  const pctx = await loadPlanContext(worktree);
  const line = `- ${nowISO()} supervisor goal: ${goal.trim()}\n`;
  await appendTextFile(protocolFilePath(pctx, PROTOCOL_FILES.SUPERVISOR_LOG), line);
  await appendTextFile(protocolFilePath(pctx, PROTOCOL_FILES.CONVERSATION), line);
}

export async function executeSupervisorTool(
  name: string,
  args: Record<string, unknown>,
  ctx: SupervisorToolContext
): Promise<string> {
  switch (name) {
    case "spawn_swarm": {
      const parsed = parseSpawnSwarmInput(args);
      if (typeof parsed === "string") {
        return JSON.stringify({ ok: false, error: parsed }, null, 2);
      }
      try {
        const runner = await spawnSwarmForSession(ctx.sessionKey, ctx.worktree, parsed, {
          ...(ctx.runtime ? { runtime: ctx.runtime } : {}),
          ...(ctx.subscribeEvents ? { subscribeEvents: ctx.subscribeEvents } : {}),
        });
        return JSON.stringify(
          {
            ok: true,
            swarmId: runner.state.swarmId,
            message: `Swarm ${runner.state.swarmId} started (${parsed.tasks.length} tasks). Main loop unchanged.`,
            status: runner.status(),
          },
          null,
          2
        );
      } catch (err) {
        return JSON.stringify(
          {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          },
          null,
          2
        );
      }
    }

    case "swarm_status": {
      const registry = getSwarmRegistry();
      const swarmId = typeof args.swarmId === "string" ? args.swarmId.trim() : "";
      if (swarmId) {
        const runner = registry.get(swarmId);
        if (!runner) {
          return JSON.stringify({ ok: false, error: `Swarm not found: ${swarmId}` }, null, 2);
        }
        return JSON.stringify({ ok: true, status: runner.status() }, null, 2);
      }
      const statuses = registry.listForSession(ctx.sessionKey);
      return JSON.stringify({ ok: true, swarms: statuses }, null, 2);
    }

    case "swarm_cancel": {
      const swarmId = typeof args.swarmId === "string" ? args.swarmId.trim() : "";
      if (!swarmId) {
        return JSON.stringify({ ok: false, error: "swarmId is required" }, null, 2);
      }
      const reason = typeof args.reason === "string" ? args.reason : undefined;
      const cancelled = await getSwarmRegistry().cancel(swarmId, reason);
      if (!cancelled) {
        return JSON.stringify({ ok: false, error: `Swarm not found: ${swarmId}` }, null, 2);
      }
      return JSON.stringify({ ok: true, swarmId, cancelled: true }, null, 2);
    }

    case "swarm_collect": {
      const swarmId = typeof args.swarmId === "string" ? args.swarmId.trim() : "";
      if (!swarmId) {
        return JSON.stringify({ ok: false, error: "swarmId is required" }, null, 2);
      }
      const runner = getSwarmRegistry().get(swarmId);
      if (!runner) {
        return JSON.stringify({ ok: false, error: `Swarm not found: ${swarmId}` }, null, 2);
      }
      const maxLines = typeof args.maxLines === "number" ? args.maxLines : 80;
      const items = await runner.collect(maxLines);
      return JSON.stringify({ ok: true, swarmId, items, status: runner.status() }, null, 2);
    }

    case "swarm_unsafe_runtime_code_eval": {
      const code = typeof args.code === "string" ? args.code : "";
      const timeoutMinutes =
        typeof args.timeoutMinutes === "number" ? args.timeoutMinutes : undefined;
      const result = await runUnsafeSwarmScript(
        ctx.sessionKey,
        ctx.worktree,
        code,
        timeoutMinutes
      );
      return JSON.stringify(result, null, 2);
    }

    default:
      break;
  }

  const engine = await getEngineForSession(ctx.sessionKey, ctx.worktree);

  switch (name) {
    case "loop_status": {
      const status = await engine.status();
      return JSON.stringify(status, null, 2);
    }

    case "start_loop": {
      const goal = typeof args.goal === "string" ? args.goal.trim() : "";
      const bootstrap = args.bootstrap !== false;

      if (
        engine.state.started &&
        !engine.state.done &&
        !engine.state.paused &&
        !engine.state.stopped
      ) {
        const status = await engine.status();
        return JSON.stringify(
          {
            ok: true,
            alreadyRunning: true,
            message: "Loop already running.",
            status,
          },
          null,
          2
        );
      }

      if (goal) {
        await logGoal(ctx.worktree, goal);
      }

      const authoredPlan = await isPlanAuthored(await loadPlanContext(ctx.worktree));

      // verify.command is the loop's only automatic stop condition. Warn (but
      // don't block) when it's missing — the loop would never auto-complete.
      const startCfg = await loadConfig(ctx.worktree);
      const verifyWarning =
        !startCfg.verify || startCfg.verify.command.length === 0
          ? "No verify.command set — the loop has NO automatic stop condition and will run until maxAttempts. Strongly recommend set_verify (validate with run_verify) before relying on it."
          : undefined;

      await engine.start({
        sessionId: ctx.sessionKey,
        worktree: ctx.worktree,
        bootstrap,
        ...(goal ? { goal } : {}),
      });

      const status = await engine.status();
      return JSON.stringify(
        {
          ok: true,
          authoredPlan,
          message: authoredPlan
            ? `Started loop against the authored PLAN.md — attempt ${status.attempt} running in background.`
            : `Started loop — attempt ${status.attempt} running in background.`,
          ...(verifyWarning ? { warning: verifyWarning } : {}),
          status,
        },
        null,
        2
      );
    }

    case "pause_loop": {
      await engine.pause();
      return JSON.stringify({ ok: true, paused: true }, null, 2);
    }

    case "resume_loop": {
      await engine.resume();
      const status = await engine.status();
      return JSON.stringify({ ok: true, resumed: true, status }, null, 2);
    }

    case "stop_loop": {
      const reason = typeof args.reason === "string" ? args.reason : undefined;
      await engine.stop(reason);
      const status = await engine.status();
      return JSON.stringify(
        {
          ok: true,
          stopped: true,
          done: true,
          reason: reason ?? null,
          status,
        },
        null,
        2
      );
    }

    case "peek_worker": {
      const maxLines = typeof args.maxLines === "number" ? args.maxLines : 120;
      const text = await engine.peekWorker(maxLines);
      return JSON.stringify({ ok: true, file: PROTOCOL_FILES.CURR, text }, null, 2);
    }

    case "read_protocol": {
      const file = typeof args.file === "string" ? args.file.trim() : "";
      if (!PROTOCOL_ALLOWLIST.has(file)) {
        return JSON.stringify(
          {
            ok: false,
            error: `File not allowlisted. Allowed: ${[...PROTOCOL_ALLOWLIST].join(", ")}`,
          },
          null,
          2
        );
      }
      const maxLines = typeof args.maxLines === "number" ? args.maxLines : 400;
      const pctx = await loadPlanContext(ctx.worktree);
      const raw = await readTextFile(protocolFilePath(pctx, file)).catch(() => "");
      return JSON.stringify(
        { ok: true, file, text: clampLines(raw, maxLines) },
        null,
        2
      );
    }

    case "repo_search": {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      const glob = typeof args.glob === "string" ? args.glob.trim() : "";
      const limit = typeof args.limit === "number" ? args.limit : 25;
      const cfg = await loadConfig(ctx.worktree);
      const fffOptions = {
        worktree: ctx.worktree,
        enabled: cfg.fff.enabled,
        scanTimeoutMs: cfg.fff.scanTimeoutMs,
      };
      const result = glob
        ? await fffGlob(fffOptions, glob, limit)
        : await fffFileSearch(fffOptions, query || "*", limit);
      return JSON.stringify({ ok: true, result }, null, 2);
    }

    case "repo_grep": {
      const query = typeof args.query === "string" ? args.query : "";
      if (!query.trim()) {
        return JSON.stringify({ ok: false, error: "query is required" }, null, 2);
      }
      const mode =
        args.mode === "regex" || args.mode === "fuzzy" ? args.mode : "plain";
      const limit = typeof args.limit === "number" ? args.limit : 25;
      const cfg = await loadConfig(ctx.worktree);
      const result = await fffGrep(
        {
          worktree: ctx.worktree,
          enabled: cfg.fff.enabled,
          scanTimeoutMs: cfg.fff.scanTimeoutMs,
        },
        query,
        { mode, maxMatches: limit, contextLines: 1 }
      );
      return JSON.stringify({ ok: true, result }, null, 2);
    }

    case "get_verify": {
      const cfg = await loadConfig(ctx.worktree);
      return JSON.stringify(
        {
          ok: true,
          verify: cfg.verify ?? null,
          verifyTimeoutMinutes: cfg.verifyTimeoutMinutes,
          note: cfg.verify
            ? "verify.command is the loop's only stop condition (exit 0 = pass)."
            : "No verify.command set — the loop would have no automatic stop condition.",
        },
        null,
        2
      );
    }

    case "set_verify": {
      const command = Array.isArray(args.command)
        ? args.command.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
        : [];
      if (command.length === 0) {
        return JSON.stringify({ ok: false, error: "command must be a non-empty string array" }, null, 2);
      }
      const cwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd.trim() : ".";
      const timeoutMinutes =
        typeof args.timeoutMinutes === "number" ? Math.trunc(args.timeoutMinutes) : undefined;
      const { path: file } = await updateRawConfig(ctx.worktree, (raw) => ({
        ...raw,
        verify: { command, cwd },
        ...(timeoutMinutes !== undefined ? { verifyTimeoutMinutes: timeoutMinutes } : {}),
      }));
      return JSON.stringify(
        {
          ok: true,
          updated: file,
          verify: { command, cwd },
          hint: "Validate with run_verify — it should FAIL before the work is done.",
        },
        null,
        2
      );
    }

    case "run_verify": {
      const cfg = await loadConfig(ctx.worktree);
      if (!cfg.verify || cfg.verify.command.length === 0) {
        return JSON.stringify(
          { ok: false, error: "No verify.command set. Use set_verify first." },
          null,
          2
        );
      }
      const result = await runAndParseVerify(ctx.worktree, cfg);
      return JSON.stringify(
        {
          ok: true,
          verdict: result.verdict,
          command: cfg.verify.command,
          output: clampLines(result.details ?? "", 120),
          interpretation:
            result.verdict === "pass"
              ? "Passes NOW. If the work isn't done yet, this command is too weak — a loop would 'succeed' immediately."
              : "Fails NOW — good: a future pass will mean the goal was met.",
        },
        null,
        2
      );
    }

    case "write_plan": {
      const content = typeof args.content === "string" ? args.content : "";
      if (!content.trim()) {
        return JSON.stringify({ ok: false, error: "content is required" }, null, 2);
      }
      const writeCtx = await loadPlanContext(ctx.worktree);
      await writePlanFile(writeCtx, content);
      await appendTextFile(
        protocolFilePath(writeCtx, PROTOCOL_FILES.SUPERVISOR_LOG),
        `- ${nowISO()} supervisor authored PLAN.md (planning phase, plan: ${writeCtx.planName || "root"})\n`
      );
      return JSON.stringify(
        { ok: true, updated: PROTOCOL_FILES.PLAN, plan: writeCtx.planName || null, authored: true },
        null,
        2
      );
    }

    case "update_plan": {
      const patch = typeof args.patch === "string" ? args.patch : "";
      const reason = typeof args.reason === "string" ? args.reason : "supervisor update";
      if (!patch.trim()) {
        return JSON.stringify({ ok: false, error: "patch is required" }, null, 2);
      }
      const planCtx = await loadPlanContext(ctx.worktree);
      await applyProtocolPatch(planCtx, PROTOCOL_FILES.PLAN, patch);
      await appendTextFile(
        protocolFilePath(planCtx, PROTOCOL_FILES.PLAN),
        `\n- ${nowISO()} ${reason}\n`
      );
      return JSON.stringify({ ok: true, updated: PROTOCOL_FILES.PLAN }, null, 2);
    }

    case "update_rlm_instructions": {
      const patch = typeof args.patch === "string" ? args.patch : "";
      const reason = typeof args.reason === "string" ? args.reason : "supervisor update";
      if (!patch.trim()) {
        return JSON.stringify({ ok: false, error: "patch is required" }, null, 2);
      }
      const instrCtx = await loadPlanContext(ctx.worktree);
      await applyProtocolPatch(instrCtx, PROTOCOL_FILES.RLM_INSTR, patch);
      await appendTextFile(
        protocolFilePath(instrCtx, PROTOCOL_FILES.RLM_INSTR),
        `\n- ${nowISO()} ${reason}\n`
      );
      return JSON.stringify({ ok: true, updated: PROTOCOL_FILES.RLM_INSTR }, null, 2);
    }

    case "list_plans": {
      const cfg = await loadConfig(ctx.worktree);
      if (cfg.plans.mode === "legacy") {
        return JSON.stringify(
          { ok: true, mode: "legacy", plans: [], active: null, note: "Named plans are not enabled (legacy root layout)." },
          null,
          2
        );
      }
      const [plans, active] = await Promise.all([
        listPlans(ctx.worktree, cfg.plans),
        readActivePlan(ctx.worktree, cfg.plans),
      ]);
      return JSON.stringify({ ok: true, mode: cfg.plans.mode, plans, active }, null, 2);
    }

    case "select_plan": {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) {
        return JSON.stringify({ ok: false, error: "name is required" }, null, 2);
      }
      const cfg = await loadConfig(ctx.worktree);
      if (cfg.plans.mode === "legacy") {
        return JSON.stringify(
          { ok: false, error: "Named plans are not enabled (legacy root layout)." },
          null,
          2
        );
      }
      const active = await writeActivePlan(ctx.worktree, cfg.plans, name);
      return JSON.stringify({ ok: true, active }, null, 2);
    }

    case "new_plan": {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) {
        return JSON.stringify({ ok: false, error: "name is required" }, null, 2);
      }
      const cfg = await loadConfig(ctx.worktree);
      if (cfg.plans.mode === "legacy") {
        return JSON.stringify(
          { ok: false, error: "Named plans are not enabled (legacy root layout)." },
          null,
          2
        );
      }
      const active = await writeActivePlan(ctx.worktree, cfg.plans, name);
      // Resolve the new plan's context so subsequent write_plan / start_loop target it.
      const newCtx = await resolvePlanContext(ctx.worktree, cfg.plans, active);
      return JSON.stringify(
        { ok: true, active, protocolDir: newCtx.protocolRel, note: "Empty plan selected. Use write_plan to author PLAN.md, then start_loop." },
        null,
        2
      );
    }

    case "last_verify_output": {
      const status = await engine.status();
      if (!status.lastVerify) {
        return JSON.stringify({ ok: false, error: "No verify run recorded yet." }, null, 2);
      }
      return JSON.stringify({ ok: true, lastVerify: status.lastVerify }, null, 2);
    }

    case "list_worker_questions": {
      const pctx = await loadPlanContext(ctx.worktree);
      const pending = listUnansweredQuestions(await readPendingInput(pctx));
      return JSON.stringify({ ok: true, questions: pending }, null, 2);
    }

    case "answer_worker": {
      const questionId = typeof args.questionId === "string" ? args.questionId : "";
      const answer = typeof args.answer === "string" ? args.answer : "";
      if (!questionId || !answer) {
        return JSON.stringify(
          { ok: false, error: "questionId and answer are required" },
          null,
          2
        );
      }

      const pctx = await loadPlanContext(ctx.worktree);
      const pending = listUnansweredQuestions(await readPendingInput(pctx));
      if (!pending.some((question) => question.id === questionId)) {
        return JSON.stringify(
          {
            ok: false,
            error: `Question ID "${questionId}" not found among pending questions.`,
            pendingQuestions: pending.map((question) => question.id),
          },
          null,
          2
        );
      }

      await addPendingAnswer(pctx, questionId, answer);
      const line = `- ${nowISO()} supervisor answered ${questionId}: ${answer.trim()}\n`;
      await appendTextFile(protocolFilePath(pctx, PROTOCOL_FILES.CONVERSATION), line);
      return JSON.stringify({ ok: true, questionId, answered: true }, null, 2);
    }

    default:
      return JSON.stringify({ ok: false, error: `Unknown tool: ${name}` }, null, 2);
  }
}

export async function summarizeLoopStatus(engine: LoopEngine): Promise<string> {
  const status = await engine.status();
  const lifecycle =
    status.outcome === "stopped"
      ? "stopped"
      : status.done
        ? status.outcome
        : status.paused
          ? "paused"
          : "running";
  const parts = [`Attempt ${status.attempt}/${status.maxAttempts}`, lifecycle];
  if (status.workerSessionId) {
    parts.push(`worker=${status.workerSessionId}`);
  }
  if (status.lastVerify) {
    parts.push(`last verify=${status.lastVerify.verdict}`);
  }
  if (status.pauseReason) {
    parts.push(`pause reason=${status.pauseReason}`);
  }
  if (status.stopReason) {
    parts.push(`stop reason=${status.stopReason}`);
  }
  if (status.pendingQuestions && status.pendingQuestions.length > 0) {
    parts.push(
      `pending questions=${status.pendingQuestions.map((question) => question.id).join(", ")}`
    );
  }
  return parts.join("; ");
}
