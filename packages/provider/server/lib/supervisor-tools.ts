import path from "node:path";
import {
  PROTOCOL_FILES,
  addPendingAnswer,
  applyPatch,
  appendTextFile,
  clampLines,
  listUnansweredQuestions,
  nowISO,
  readPendingInput,
  readTextFile,
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
        "Bootstrap protocol files (PLAN.md, RLM_INSTRUCTIONS.md, …) if needed and start attempt 1 with a background worker. Call when the user delegates a goal or implementation task.",
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
  const line = `- ${nowISO()} supervisor goal: ${goal.trim()}\n`;
  await appendTextFile(path.join(worktree, PROTOCOL_FILES.SUPERVISOR_LOG), line);
  await appendTextFile(path.join(worktree, PROTOCOL_FILES.CONVERSATION), line);
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

      await engine.start({
        sessionId: ctx.sessionKey,
        worktree: ctx.worktree,
        bootstrap,
      });

      const status = await engine.status();
      return JSON.stringify(
        {
          ok: true,
          message: `Started loop — attempt ${status.attempt} running in background.`,
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
      const raw = await readTextFile(path.join(ctx.worktree, file)).catch(() => "");
      return JSON.stringify(
        { ok: true, file, text: clampLines(raw, maxLines) },
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
      await applyPatch(ctx.worktree, patch);
      await appendTextFile(
        path.join(ctx.worktree, PROTOCOL_FILES.PLAN),
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
      await applyPatch(ctx.worktree, patch);
      await appendTextFile(
        path.join(ctx.worktree, PROTOCOL_FILES.RLM_INSTR),
        `\n- ${nowISO()} ${reason}\n`
      );
      return JSON.stringify({ ok: true, updated: PROTOCOL_FILES.RLM_INSTR }, null, 2);
    }

    case "last_verify_output": {
      const status = await engine.status();
      if (!status.lastVerify) {
        return JSON.stringify({ ok: false, error: "No verify run recorded yet." }, null, 2);
      }
      return JSON.stringify({ ok: true, lastVerify: status.lastVerify }, null, 2);
    }

    case "list_worker_questions": {
      const pending = listUnansweredQuestions(await readPendingInput(ctx.worktree));
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

      const pending = listUnansweredQuestions(await readPendingInput(ctx.worktree));
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

      await addPendingAnswer(ctx.worktree, questionId, answer);
      const line = `- ${nowISO()} supervisor answered ${questionId}: ${answer.trim()}\n`;
      await appendTextFile(path.join(ctx.worktree, PROTOCOL_FILES.CONVERSATION), line);
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