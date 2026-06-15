import path from "node:path";
import { loadConfig } from "./config.js";
import { appendTextFile } from "./fs.js";
import {
  extractSessionIdFromEvent,
  subscribeOpencodeEvents,
  type OpencodeEventSubscription,
  type OpencodeRuntime,
} from "./opencode-client.js";
import { PROTOCOL_FILES } from "./protocol-files.js";
import { SwarmEventBus, type SwarmEventHandler, type SwarmEventName } from "./swarm-events.js";
import {
  createSwarmTasks,
  toSwarmStatus,
  type SpawnSwarmInput,
  type SwarmRunConfig,
  type SwarmRunState,
  type SwarmStatus,
  type SwarmTask,
} from "./swarm-run.js";
import { createAsyncEventQueue } from "./async-event-queue.js";
import { nowISO } from "./text.js";
import { loadWorkerSpawnConfig } from "./worker-spawn.js";
import { DEFAULT_TEMPLATES, type EngineTemplates } from "./templates.js";

export type SwarmRunnerOptions = {
  runtime: OpencodeRuntime;
  templates?: EngineTemplates;
  subscribeEvents?: (
    onEvent: (event: unknown) => void | Promise<void>
  ) => Promise<OpencodeEventSubscription>;
};

export type SwarmRunner = {
  readonly state: SwarmRunState;
  on: (event: SwarmEventName, handler: SwarmEventHandler) => () => void;
  start: () => Promise<void>;
  cancel: (reason?: string) => Promise<void>;
  status: () => SwarmStatus;
  collect: (maxLines?: number) => Promise<Array<{ name: string; status: string; note: string }>>;
  handleEvent: (event: unknown) => Promise<void>;
  dispose: () => void;
};

function eventType(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const type = (event as Record<string, unknown>).type;
  return typeof type === "string" ? type : undefined;
}

function eventStatus(event: unknown): string {
  if (typeof event !== "object" || event === null) return "";
  const record = event as Record<string, unknown>;
  const direct = record.status ?? record.data;
  if (typeof direct === "object" && direct !== null) {
    const nested = (direct as Record<string, unknown>).status;
    if (typeof nested === "string") return nested.toLowerCase();
  }
  return typeof direct === "string" ? direct.toLowerCase() : "";
}

function taskBySessionId(state: SwarmRunState, sessionId: string): SwarmTask | undefined {
  return state.tasks.find((task) => task.sessionId === sessionId);
}

export function createSwarmRunner(
  config: SwarmRunConfig,
  options: SwarmRunnerOptions
): SwarmRunner {
  const runtime = options.runtime;
  const templates = options.templates ?? DEFAULT_TEMPLATES;
  const events = new SwarmEventBus();
  const cfg = config.input;

  const state: SwarmRunState = {
    swarmId: config.swarmId,
    sessionKey: config.sessionKey,
    worktree: config.worktree,
    tasks: createSwarmTasks(cfg),
    status: "starting",
    waitPolicy: cfg.waitPolicy ?? "none",
    concurrency: 0,
    timeoutMinutes: 0,
    startedAt: nowISO(),
  };

  if (cfg.label?.trim()) {
    state.label = cfg.label.trim();
  }

  let subscription: OpencodeEventSubscription | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  let startInFlight = false;

  const emit = events.emit.bind(events);

  async function logSwarm(message: string, level: "info" | "warning" | "error"): Promise<void> {
    const line = `- ${nowISO()} [${level}] swarm/${state.swarmId}: ${message}\n`;
    await appendTextFile(path.join(state.worktree, PROTOCOL_FILES.SUPERVISOR_LOG), line).catch(
      () => {}
    );
  }

  async function ensureSubscription(): Promise<void> {
    if (subscription) return;
    const subscribe = options.subscribeEvents ?? ((onEvent) =>
      subscribeOpencodeEvents(runtime, onEvent, { directory: state.worktree }));
    subscription = await subscribe(async (event) => {
      await runner.handleEvent(event);
    });
  }

  function clearTimeoutTimer(): void {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
    }
  }

  function maybeFinish(): void {
    if (state.status === "cancelled" || state.status === "timed_out" || state.status === "error") {
      return;
    }

    const terminal = state.tasks.every(
      (task) =>
        task.status === "idle" ||
        task.status === "error" ||
        task.status === "cancelled"
    );
    if (!terminal) return;

    if (state.waitPolicy === "any") {
      const anyIdle = state.tasks.some((task) => task.status === "idle");
      if (!anyIdle && state.tasks.some((task) => task.status === "running" || task.status === "spawning")) {
        return;
      }
    }

    state.status = state.tasks.some((task) => task.status === "error") ? "error" : "done";
    state.finishedAt = nowISO();
    clearTimeoutTimer();
    emit("swarm.done", { swarmId: state.swarmId, sessionKey: state.sessionKey });
  }

  async function spawnTask(task: SwarmTask): Promise<void> {
    if (cancelled) return;

    task.status = "spawning";
    const spawnDefaults = await loadWorkerSpawnConfig(state.worktree, templates);

    const created = await runtime.client.session.create({
      title: `swarm-${state.swarmId}-${task.name}`,
      directory: state.worktree,
    });
    const sessionId = created.data?.id ?? `swarm-task-${Date.now()}`;
    task.sessionId = sessionId;
    task.spawnedAt = nowISO();
    task.status = "running";

    const agent = task.agent?.trim() || spawnDefaults.agent;
    const promptParts = [task.goal.trim()];
    if (task.context?.trim()) {
      promptParts.push("", `Context:\n${task.context.trim()}`);
    }

    await runtime.client.session.prompt({
      sessionID: sessionId,
      directory: state.worktree,
      noReply: true,
      agent,
      system: spawnDefaults.systemPrompt,
      ...((task.providerID && task.modelID) || (spawnDefaults.providerID && spawnDefaults.modelID)
        ? {
            model: {
              providerID: task.providerID ?? spawnDefaults.providerID!,
              modelID: task.modelID ?? spawnDefaults.modelID!,
            },
          }
        : {}),
      parts: [{ type: "text", text: promptParts.join("\n") }],
    });

    emit("swarm.task.spawned", {
      swarmId: state.swarmId,
      sessionKey: state.sessionKey,
      taskName: task.name,
      sessionId,
    });
    await logSwarm(`Spawned task ${task.name} → ${sessionId}`, "info");
  }

  async function runSpawnPool(): Promise<void> {
    const pending = [...state.tasks];
    const concurrency = Math.max(1, state.concurrency);

    async function worker(): Promise<void> {
      while (pending.length > 0 && !cancelled) {
        const task = pending.shift();
        if (!task) return;
        try {
          await spawnTask(task);
        } catch (err) {
          task.status = "error";
          task.error = err instanceof Error ? err.message : String(err);
          emit("swarm.task.error", {
            swarmId: state.swarmId,
            sessionKey: state.sessionKey,
            taskName: task.name,
            error: task.error,
          });
          await logSwarm(`Task ${task.name} failed: ${task.error}`, "error");
        }
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    state.status = "running";
    maybeFinish();
  }

  function cancelPendingTasks(reason: string): void {
    for (const task of state.tasks) {
      if (task.status === "pending" || task.status === "spawning") {
        task.status = "cancelled";
        task.error = reason;
      }
    }
  }

  async function abortTaskSessions(reason: string): Promise<void> {
    cancelPendingTasks(reason);
    for (const task of state.tasks) {
      if (!task.sessionId) continue;
      if (task.status === "idle" || task.status === "cancelled") continue;
      await runtime.client.session
        .abort({ sessionID: task.sessionId, directory: state.worktree })
        .catch(() => {});
      task.status = "cancelled";
      task.error = reason;
    }
  }

  async function processEvent(event: unknown): Promise<void> {
    const type = eventType(event);

    if (type === "ralph.subscription.error") {
      if (state.status !== "done" && state.status !== "cancelled" && state.status !== "error") {
        state.status = "error";
        state.finishedAt = nowISO();
        state.error =
          typeof (event as Record<string, unknown>).error === "string"
            ? ((event as Record<string, unknown>).error as string)
            : "OpenCode event subscription failed";
        clearTimeoutTimer();
        await logSwarm(state.error, "error");
        emit("swarm.cancelled", {
          swarmId: state.swarmId,
          sessionKey: state.sessionKey,
          reason: state.error,
        });
      }
      return;
    }

    const sessionId = extractSessionIdFromEvent(event);
    if (!sessionId) return;

    const task = taskBySessionId(state, sessionId);
    if (!task) return;

    if (type === "session.status" && eventStatus(event) === "error") {
      task.status = "error";
      task.error = "Session reported error status";
      emit("swarm.task.error", {
        swarmId: state.swarmId,
        sessionKey: state.sessionKey,
        taskName: task.name,
        sessionId,
        error: task.error,
      });
      maybeFinish();
      return;
    }

    if (
      type === "session.closed" ||
      type === "session.ended" ||
      type === "session.deleted"
    ) {
      if (task.status !== "idle" && task.status !== "cancelled") {
        task.status = "error";
        task.error = `Session ended (${type}) before idle`;
        emit("swarm.task.error", {
          swarmId: state.swarmId,
          sessionKey: state.sessionKey,
          taskName: task.name,
          sessionId,
          error: task.error,
        });
        maybeFinish();
      }
      return;
    }

    if (type === "session.idle") {
      if (task.status === "idle" || task.status === "cancelled") return;
      task.status = "idle";
      task.idleAt = nowISO();
      emit("swarm.task.idle", {
        swarmId: state.swarmId,
        sessionKey: state.sessionKey,
        taskName: task.name,
        sessionId,
      });
      await logSwarm(`Task ${task.name} idle`, "info");
      maybeFinish();
    }
  }

  const eventQueue = createAsyncEventQueue(processEvent);

  const runner: SwarmRunner = {
    state,

    on(event, handler) {
      return events.on(event, handler);
    },

    async start() {
      if (startInFlight) {
        throw new Error(`Swarm ${state.swarmId} start() already in progress`);
      }
      if (state.status !== "starting") {
        throw new Error(`Swarm ${state.swarmId} cannot start from status ${state.status}`);
      }
      startInFlight = true;
      try {
        const ralphCfg = await loadConfig(state.worktree);
        if (!ralphCfg.swarm.enabled) {
          throw new Error("Swarm is disabled in .opencode/ralph.json (swarm.enabled=false)");
        }
        if (!ralphCfg.subAgentEnabled) {
          throw new Error("Swarm requires subAgentEnabled=true in .opencode/ralph.json");
        }

        if (state.tasks.length === 0) {
          throw new Error("spawn_swarm requires at least one task");
        }
        if (state.tasks.length > ralphCfg.swarm.maxTasksPerRun) {
          throw new Error(
            `Task count ${state.tasks.length} exceeds swarm.maxTasksPerRun (${ralphCfg.swarm.maxTasksPerRun})`
          );
        }

        const requestedConcurrency = cfg.concurrency ?? state.tasks.length;
        state.concurrency = Math.min(
          requestedConcurrency,
          ralphCfg.swarm.maxConcurrent,
          ralphCfg.maxSubAgents,
          state.tasks.length
        );
        state.timeoutMinutes = cfg.timeoutMinutes ?? ralphCfg.swarm.defaultTimeoutMinutes;

        emit("swarm.started", { swarmId: state.swarmId, sessionKey: state.sessionKey });
        await ensureSubscription();

        if (state.timeoutMinutes > 0) {
          timeoutTimer = setTimeout(() => {
            void (async () => {
              if (state.status === "done" || state.status === "cancelled") return;
              state.status = "timed_out";
              state.finishedAt = nowISO();
              state.error = `Swarm timed out after ${state.timeoutMinutes} minutes`;
              await abortTaskSessions("swarm timeout");
              emit("swarm.cancelled", {
                swarmId: state.swarmId,
                sessionKey: state.sessionKey,
                reason: state.error,
              });
            })();
          }, state.timeoutMinutes * 60_000);
        }

        await runSpawnPool();
      } finally {
        startInFlight = false;
      }
    },

    async cancel(reason) {
      cancelled = true;
      state.status = "cancelled";
      state.finishedAt = nowISO();
      if (reason) state.error = reason;
      clearTimeoutTimer();
      await abortTaskSessions(reason ?? "cancelled");
      emit("swarm.cancelled", {
        swarmId: state.swarmId,
        sessionKey: state.sessionKey,
        ...(reason ? { reason } : {}),
      });
    },

    status() {
      return toSwarmStatus(state);
    },

    async collect(maxLines = 80) {
      return state.tasks.map((task) => {
        const parts = [`goal: ${task.goal}`];
        if (task.sessionId) parts.push(`session: ${task.sessionId}`);
        if (task.error) parts.push(`error: ${task.error}`);
        const note = parts.join(" | ");
        return {
          name: task.name,
          status: task.status,
          note: note.length > maxLines * 4 ? `${note.slice(0, maxLines * 4)}…` : note,
        };
      });
    },

    async handleEvent(event) {
      await eventQueue.push(event);
    },

    dispose() {
      clearTimeoutTimer();
      subscription?.stop();
      subscription = undefined;
    },
  };

  return runner;
}

/** Returns an error message when spawn input is invalid, otherwise `null`. */
export function validateSpawnSwarmInput(input: SpawnSwarmInput): string | null {
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    return "tasks must be a non-empty array";
  }
  const seenNames = new Set<string>();
  for (const task of input.tasks) {
    if (!task.name?.trim()) return "each task requires a name";
    const name = task.name.trim();
    if (seenNames.has(name)) return `duplicate task name: ${name}`;
    seenNames.add(name);
    if (!task.goal?.trim()) return `task "${name}" requires a goal`;
  }
  const waitPolicy = input.waitPolicy;
  if (waitPolicy && !["none", "all", "any"].includes(waitPolicy)) {
    return `invalid waitPolicy: ${waitPolicy}`;
  }
  return null;
}

export function newSwarmId(): string {
  return `swarm-${Date.now().toString(36)}`;
}