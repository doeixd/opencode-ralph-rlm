import {
  SwarmRegistry,
  appendTextFile,
  loadPlanContext,
  newSwarmId,
  nowISO,
  PROTOCOL_FILES,
  protocolFilePath,
  runSwarmScript,
  subscribeWorktreeEvents,
  type SpawnSwarmInput,
  type SwarmRunnerOptions,
  type SwarmTaskInput,
} from "@doeixd/opencode-ralph-rlm-engine";
import { getOpencodeRuntime } from "./runtime.js";
import { swarmRegistry } from "./swarm-registry.js";

function baseSwarmOptions(
  runtime: SwarmRunnerOptions["runtime"],
  overrides?: Partial<SwarmRunnerOptions>
): SwarmRunnerOptions {
  return {
    runtime,
    ...(overrides?.templates ? { templates: overrides.templates } : {}),
    ...(overrides?.subscribeEvents ? { subscribeEvents: overrides.subscribeEvents } : {}),
  };
}

export function getSwarmRegistry(): SwarmRegistry {
  return swarmRegistry;
}

function parseTasks(raw: unknown): SwarmTaskInput[] | null {
  if (!Array.isArray(raw)) return null;
  const tasks: SwarmTaskInput[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return null;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const goal = typeof record.goal === "string" ? record.goal.trim() : "";
    if (!name || !goal) return null;
    const task: SwarmTaskInput = { name, goal };
    if (typeof record.agent === "string" && record.agent.trim()) {
      task.agent = record.agent.trim();
    }
    if (typeof record.context === "string" && record.context.trim()) {
      task.context = record.context.trim();
    }
    if (typeof record.providerID === "string" && record.providerID.trim()) {
      task.providerID = record.providerID.trim();
    }
    if (typeof record.modelID === "string" && record.modelID.trim()) {
      task.modelID = record.modelID.trim();
    }
    tasks.push(task);
  }
  return tasks.length > 0 ? tasks : null;
}

export function parseSpawnSwarmInput(args: Record<string, unknown>): SpawnSwarmInput | string {
  const tasks = parseTasks(args.tasks);
  if (!tasks) return "tasks must be a non-empty array of { name, goal } objects";

  const input: SpawnSwarmInput = { tasks };
  if (typeof args.label === "string" && args.label.trim()) {
    input.label = args.label.trim();
  }
  if (typeof args.concurrency === "number" && Number.isFinite(args.concurrency)) {
    input.concurrency = Math.trunc(args.concurrency);
  }
  if (args.waitPolicy === "none" || args.waitPolicy === "all" || args.waitPolicy === "any") {
    input.waitPolicy = args.waitPolicy;
  }
  if (typeof args.timeoutMinutes === "number" && Number.isFinite(args.timeoutMinutes)) {
    input.timeoutMinutes = Math.trunc(args.timeoutMinutes);
  }
  return input;
}

export async function spawnSwarmForSession(
  sessionKey: string,
  worktree: string,
  input: SpawnSwarmInput,
  options?: Partial<SwarmRunnerOptions>
) {
  const runtime = options?.runtime ?? getOpencodeRuntime();
  const subscribeEvents =
    options?.subscribeEvents ??
    ((onEvent) => subscribeWorktreeEvents(worktree, runtime, onEvent));

  const runner = await swarmRegistry.spawn(
    sessionKey,
    worktree,
    input,
    baseSwarmOptions(runtime, { ...options, subscribeEvents })
  );

  const line = `- ${nowISO()} supervisor spawn_swarm ${runner.state.swarmId} (${input.tasks.length} tasks)\n`;
  const pctx = await loadPlanContext(worktree);
  await appendTextFile(protocolFilePath(pctx, PROTOCOL_FILES.SUPERVISOR_LOG), line).catch(() => {});

  return runner;
}

export async function runUnsafeSwarmScript(
  sessionKey: string,
  worktree: string,
  code: string,
  timeoutMinutes?: number
) {
  const swarmId = newSwarmId();
  const result = await runSwarmScript({
    worktree,
    swarmId,
    code,
    ...(timeoutMinutes !== undefined ? { timeoutMinutes } : {}),
  });

  const line = `- ${nowISO()} supervisor swarm_unsafe_runtime_code_eval ${swarmId} ok=${result.ok}\n`;
  const pctx = await loadPlanContext(worktree);
  await appendTextFile(protocolFilePath(pctx, PROTOCOL_FILES.SUPERVISOR_LOG), line).catch(() => {});

  return { ...result, sessionKey };
}