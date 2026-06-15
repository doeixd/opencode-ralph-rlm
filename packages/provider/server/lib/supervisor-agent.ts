import type { OpenAIChatMessage } from "./openai-compat.js";
import { isTestMode, loadSupervisorLlmConfig } from "./supervisor-config.js";
import { callSupervisorLlm } from "./llm-client.js";
import {
  SUPERVISOR_TOOL_DEFINITIONS,
  executeSupervisorTool,
  summarizeLoopStatus,
  type SupervisorToolContext,
} from "./supervisor-tools.js";
import { getEngineForSession } from "./loop-service.js";

export type SupervisorTurnInput = {
  sessionKey: string;
  worktree: string;
  messages: OpenAIChatMessage[];
  model?: string;
};

export type SupervisorTurnResult = {
  content: string;
  toolRounds: number;
  mode: "test" | "llm";
};

const SUPERVISOR_SYSTEM_PROMPT = [
  "You are the **Ralph RLM supervisor** — the user's single interface to a persistent, self-correcting coding loop.",
  "",
  "## Role and boundaries",
  "- Orchestrate the loop via tools. The LoopEngine runs workers, verify, and rollover deterministically.",
  "- You do NOT edit repository source code, run tests directly, or impersonate the worker.",
  "- Workers run in background OpenCode sessions with the ralph-worker plugin (RLM tools + context gate).",
  "- Protocol files (PLAN.md, RLM_INSTRUCTIONS.md, CURRENT_STATE.md, …) are durable memory across attempts.",
  "",
  "## User intent → tool routing",
  "- Delegate a goal / \"implement X\" / \"fix tests\" → `start_loop` with goal (bootstrap true unless files exist).",
  "- Status / progress / \"where are we\" → `loop_status`; optionally `peek_worker` or `last_verify_output`.",
  "- Pause / hold / stop spawning → `pause_loop`. Resume → `resume_loop`. Stop / cancel → `stop_loop`.",
  "- Inspect plan or instructions → `read_protocol` (PLAN.md, RLM_INSTRUCTIONS.md, …).",
  "- Change strategy → `update_plan` or `update_rlm_instructions` (unified diff patches + reason).",
  "- Worker blocked on `ralph_ask` → `list_worker_questions` then `answer_worker` with question id.",
  "- Parallel side tasks → `spawn_swarm` (declarative tasks); `swarm_status` / `swarm_collect` / `swarm_cancel`.",
  "- Unsafe script eval → `swarm_unsafe_runtime_code_eval` only when user explicitly opts in.",
  "",
  "## After start_loop",
  "- Acknowledge immediately: attempt 1 is running in the background; user can ask for status anytime.",
  "- Do not block waiting for verify. Long work happens asynchronously.",
  "",
  "## Communication style",
  "- Concise, action-oriented. Summarize attempt number, worker state, last verify verdict when reporting status.",
  "- When verify fails, explain what failed (from last_verify_output) and what the next attempt will try.",
  "- Never tell the user to call `ralph_spawn_worker`, `ralph_create_supervisor_session`, or other legacy v0.1 plugin tools.",
  "",
  "## Strategy updates",
  "- PLAN.md = goals, milestones, definition of done (user-facing outcomes).",
  "- RLM_INSTRUCTIONS.md = worker playbooks (how to debug, test, navigate this repo).",
  "- Prefer updating protocol files over long chat explanations so the next worker inherits context.",
  "",
  "## Swarms",
  "- Side swarms run parallel to the main verify loop; they do not replace verify.command.",
  "- Merge swarm results into plan/instructions or summarize for the user via `swarm_collect`.",
].join("\n");

function lastUserText(messages: OpenAIChatMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  return typeof lastUser?.content === "string" ? lastUser.content.trim() : "";
}

function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

async function runTestModeTurn(
  input: SupervisorTurnInput,
  ctx: SupervisorToolContext
): Promise<SupervisorTurnResult> {
  const text = lastUserText(input.messages).toLowerCase();
  const engine = await getEngineForSession(ctx.sessionKey, ctx.worktree);

  if (text.includes("status") || text.includes("progress")) {
    const statusJson = await executeSupervisorTool("loop_status", {}, ctx);
    const summary = await summarizeLoopStatus(engine);
    return {
      content: `Status: ${summary}\n\n${statusJson}`,
      toolRounds: 1,
      mode: "test",
    };
  }

  if (text.includes("pause")) {
    await executeSupervisorTool("pause_loop", {}, ctx);
    return { content: "Loop paused.", toolRounds: 1, mode: "test" };
  }

  if (text.includes("resume")) {
    await executeSupervisorTool("resume_loop", {}, ctx);
    const summary = await summarizeLoopStatus(engine);
    return { content: `Loop resumed. ${summary}`, toolRounds: 1, mode: "test" };
  }

  if (text.includes("stop") || text.includes("end")) {
    await executeSupervisorTool("stop_loop", { reason: "user request" }, ctx);
    return { content: "Loop stopped.", toolRounds: 1, mode: "test" };
  }

  if (text.includes("peek") || text.includes("worker")) {
    const peek = await executeSupervisorTool("peek_worker", { maxLines: 80 }, ctx);
    return { content: `Worker peek:\n${peek}`, toolRounds: 1, mode: "test" };
  }

  if (!engine.state.started || engine.state.done) {
    const goal = lastUserText(input.messages) || "Complete the delegated task with tests passing.";
    const result = await executeSupervisorTool(
      "start_loop",
      { goal, bootstrap: true },
      ctx
    );
    return {
      content: `Started loop — attempt 1 running in the background. Ask for status anytime.\n\n${result}`,
      toolRounds: 1,
      mode: "test",
    };
  }

  const summary = await summarizeLoopStatus(engine);
  return {
    content: `Loop already active. ${summary}`,
    toolRounds: 0,
    mode: "test",
  };
}

async function runLlmTurn(
  input: SupervisorTurnInput,
  ctx: SupervisorToolContext
): Promise<SupervisorTurnResult> {
  const config = await loadSupervisorLlmConfig(ctx.worktree);
  const conversation: OpenAIChatMessage[] = [
    { role: "system", content: SUPERVISOR_SYSTEM_PROMPT },
    ...input.messages.filter((m) => m.role !== "system"),
  ];

  let toolRounds = 0;

  for (let round = 0; round < config.maxToolRounds; round += 1) {
    const result = await callSupervisorLlm(config, conversation, SUPERVISOR_TOOL_DEFINITIONS);

    if (result.toolCalls.length === 0) {
      return {
        content: result.content || "Done.",
        toolRounds,
        mode: "llm",
      };
    }

    toolRounds += 1;
    conversation.push({
      role: "assistant",
      content: result.content || null,
      tool_calls: result.toolCalls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: call.arguments },
      })),
    });

    for (const call of result.toolCalls) {
      const output = await executeSupervisorTool(
        call.name,
        parseToolArgs(call.arguments),
        ctx
      );
      conversation.push({
        role: "tool",
        tool_call_id: call.id,
        content: output,
      });
    }
  }

  const status = await executeSupervisorTool("loop_status", {}, ctx);
  return {
    content: `Reached tool round limit. Current status:\n${status}`,
    toolRounds,
    mode: "llm",
  };
}

export async function supervisorTurn(
  input: SupervisorTurnInput
): Promise<SupervisorTurnResult> {
  const ctx: SupervisorToolContext = {
    sessionKey: input.sessionKey,
    worktree: input.worktree,
  };

  if (isTestMode()) {
    return runTestModeTurn(input, ctx);
  }

  return runLlmTurn(input, ctx);
}