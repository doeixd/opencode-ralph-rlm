import path from "node:path";
import { loadConfig } from "./config.js";
import { appendTextFile, readTextFile } from "./fs.js";
import { LoopEventBus, type LoopEventHandler, type LoopEventName } from "./loop-events.js";
import {
  createLoopRunState,
  toLoopStatus,
  type LoopRunConfig,
  type LoopRunState,
  type LoopStatus,
  type PendingQuestionSnapshot,
} from "./loop-run.js";
import {
  createOpencodeRuntime,
  extractSessionIdFromEvent,
  subscribeOpencodeEvents,
  type OpencodeRuntime,
  type OpencodeEventSubscription,
} from "./opencode-client.js";
import {
  listUnansweredQuestions,
  readPendingInput,
  type PendingQuestion,
} from "./pending-input.js";
import { bootstrapProtocolFiles, loadPlanContext, PROTOCOL_FILES } from "./protocol-files.js";
import { protocolFilePath, type PlanContext } from "./plan-paths.js";
import { rolloverState, writeDoneFile } from "./rollover.js";
import { DEFAULT_TEMPLATES, buildWorkerPrompt, type EngineTemplates } from "./templates.js";
import { clampLines, nowISO } from "./text.js";
import { runAndParseVerify } from "./verify.js";
import { createAsyncEventQueue } from "./async-event-queue.js";
import { writeLoopAttemptMarker } from "./loop-attempt.js";
import { loadWorkerSpawnConfig } from "./worker-spawn.js";

export type LoopToastVariant = "success" | "warning" | "error" | "info";

export type LoopToastNotifier = (input: {
  title: string;
  message: string;
  variant: LoopToastVariant;
}) => Promise<void>;

export type LoopEngineOptions = {
  runtime: OpencodeRuntime;
  templates?: EngineTemplates;
  /** Override OpenCode event subscription (used by tests). */
  subscribeEvents?: (
    onEvent: (event: unknown) => void | Promise<void>
  ) => Promise<OpencodeEventSubscription>;
  onToast?: LoopToastNotifier;
};

/** Controls a single Ralph loop run for one supervisor session. */
export type LoopEngine = {
  readonly state: LoopRunState;
  on: (event: LoopEventName, handler: LoopEventHandler) => () => void;
  start: (config?: Partial<LoopRunConfig>) => Promise<void>;
  pause: (reason?: string) => Promise<void>;
  resume: () => Promise<void>;
  stop: (reason?: string) => Promise<void>;
  status: () => Promise<LoopStatus>;
  peekWorker: (maxLines?: number) => Promise<string>;
  /** Process one OpenCode event (serialized through an internal queue). */
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

function toQuestionSnapshot(question: PendingQuestion): PendingQuestionSnapshot {
  const snapshot: PendingQuestionSnapshot = {
    id: question.id,
    question: question.question,
    askedAt: question.askedAt,
    from: question.from,
    attempt: question.attempt,
  };
  if (question.context) {
    snapshot.context = question.context;
  }
  return snapshot;
}

/** Create a loop engine bound to a supervisor session and worktree. */
export function createLoopEngine(
  config: LoopRunConfig,
  options: LoopEngineOptions
): LoopEngine {
  const runtime = options.runtime;
  const templates = options.templates ?? DEFAULT_TEMPLATES;
  const events = new LoopEventBus();
  const state = createLoopRunState(config);

  let subscription: OpencodeEventSubscription | undefined;
  let spawnInFlight = false;
  let verifyInFlight = false;
  let resumeInFlight = false;

  const emit = events.emit.bind(events);

  let planCtx: PlanContext | undefined;
  /** Resolve (and cache) the active plan context. Refreshed on start(). */
  async function getPlanContext(): Promise<PlanContext> {
    if (!planCtx || planCtx.worktree !== state.worktree) {
      planCtx = await loadPlanContext(state.worktree);
    }
    return planCtx;
  }

  async function appendSupervisorLog(
    tag: string,
    message: string,
    level: "info" | "warning" | "error"
  ): Promise<void> {
    const line = `- ${nowISO()} [${level}] ${tag}: ${message}\n`;
    const ctx = await getPlanContext();
    await appendTextFile(protocolFilePath(ctx, PROTOCOL_FILES.SUPERVISOR_LOG), line).catch(
      () => {}
    );
    await appendTextFile(protocolFilePath(ctx, PROTOCOL_FILES.CONVERSATION), line).catch(
      () => {}
    );
  }

  async function ensureSubscription(): Promise<void> {
    if (subscription) return;
    const subscribe = options.subscribeEvents ?? ((onEvent) =>
      subscribeOpencodeEvents(runtime, onEvent, { directory: state.worktree }));
    subscription = await subscribe(async (event) => {
      await engine.handleEvent(event);
    });
  }

  async function notifyToast(
    title: string,
    message: string,
    variant: LoopToastVariant
  ): Promise<void> {
    if (!options.onToast) return;
    await options.onToast({ title, message, variant }).catch(() => {});
  }

  async function pauseWithReason(reason: string, notify = true): Promise<void> {
    state.paused = true;
    state.pauseReason = reason;
    emit("loop.paused", {
      sessionId: state.sessionId,
      attempt: state.attempt,
      reason,
    });
    emit("loop.error", {
      sessionId: state.sessionId,
      attempt: state.attempt,
      error: reason,
      reason,
    });
    await appendSupervisorLog(`loop/attempt-${state.attempt}`, reason, "error");
    if (notify) {
      await notifyToast("Ralph: paused", reason, "error");
    }
  }

  async function clearWorkerSession(workerId: string | undefined, reason: string): Promise<void> {
    if (!workerId) return;
    if (state.currentWorkerSessionId === workerId) {
      delete state.currentWorkerSessionId;
    }
    await appendSupervisorLog(`worker/attempt-${state.attempt}`, reason, "warning");
  }

  async function emitHeartbeatWarnings(): Promise<void> {
    if (state.done || state.paused) return;
    const cfg = await loadConfig(state.worktree);
    const thresholdMs = cfg.heartbeatMinutes * 60_000;
    const workerId = state.currentWorkerSessionId;
    if (!workerId || !state.lastWorkerProgressAt) return;

    if (Date.now() - state.lastWorkerProgressAt < thresholdMs) return;

    const message = `Worker has no progress update for ${cfg.heartbeatMinutes}+ minutes.`;
    await appendSupervisorLog(`worker/attempt-${state.attempt}`, message, "warning");
    await notifyToast("Ralph: heartbeat", message, "warning");
    state.lastWorkerProgressAt = Date.now();
  }

  async function notifyPendingQuestions(): Promise<void> {
    if (state.done) return;
    const pending = listUnansweredQuestions(await readPendingInput(await getPlanContext()));
    for (const question of pending) {
      if (state.notifiedQuestionIds.has(question.id)) continue;
      state.notifiedQuestionIds.add(question.id);
      emit("worker.question", {
        sessionId: state.sessionId,
        attempt: question.attempt,
        questionId: question.id,
        question: question.question,
      });
      await appendSupervisorLog(
        `worker/attempt-${question.attempt}`,
        `Question (${question.id}): ${question.question}`,
        "warning"
      );
      await notifyToast(
        "Ralph: worker question",
        `${question.id}: ${question.question}`,
        "info"
      );
    }
  }

  async function spawnWorker(attempt: number): Promise<string> {
    const spawnConfig = await loadWorkerSpawnConfig(state.worktree, templates);
    const created = await runtime.client.session.create({
      title: `rlm-worker-attempt-${attempt}`,
      directory: state.worktree,
    });
    const workerId = created.data?.id ?? `worker-${Date.now()}`;

    state.currentWorkerSessionId = workerId;
    state.lastWorkerProgressAt = Date.now();

    const promptText = buildWorkerPrompt(templates, attempt);
    await runtime.client.session.prompt({
      sessionID: workerId,
      directory: state.worktree,
      agent: spawnConfig.agent,
      system: spawnConfig.systemPrompt,
      ...(spawnConfig.providerID && spawnConfig.modelID
        ? { model: { providerID: spawnConfig.providerID, modelID: spawnConfig.modelID } }
        : {}),
      parts: [{ type: "text", text: promptText }],
    });

    await writeLoopAttemptMarker(await getPlanContext(), {
      attempt,
      sessionId: state.sessionId,
      workerSessionId: workerId,
    });

    emit("worker.spawned", {
      sessionId: state.sessionId,
      attempt,
      workerSessionId: workerId,
    });

    return workerId;
  }

  async function spawnWorkerForAttempt(attempt: number): Promise<void> {
    if (spawnInFlight || state.currentWorkerSessionId) return;
    spawnInFlight = true;
    try {
      await spawnWorker(attempt);
    } catch (err) {
      const workerId = state.currentWorkerSessionId;
      delete state.currentWorkerSessionId;
      if (workerId) {
        await runtime.client.session
          .abort({ sessionID: workerId, directory: state.worktree })
          .catch(() => {});
      }
      const message =
        err instanceof Error ? err.message : "Worker spawn or prompt failed.";
      await pauseWithReason(
        `Worker prompt failed; loop paused. Resume after fixing the issue. (${message})`
      );
    } finally {
      spawnInFlight = false;
    }
  }

  async function startNextAttempt(): Promise<void> {
    const cfg = await loadConfig(state.worktree);
    if (!cfg.enabled) return;
    if (state.done || state.paused) return;

    state.attempt += 1;
    delete state.pauseReason;
    emit("attempt.started", {
      sessionId: state.sessionId,
      attempt: state.attempt,
    });

    await spawnWorkerForAttempt(state.attempt);
  }

  async function retryCurrentAttempt(): Promise<void> {
    const cfg = await loadConfig(state.worktree);
    if (!cfg.enabled) return;
    if (state.done || state.paused) return;
    if (state.attempt < 1) {
      await startNextAttempt();
      return;
    }

    delete state.pauseReason;
    emit("attempt.started", {
      sessionId: state.sessionId,
      attempt: state.attempt,
    });
    await spawnWorkerForAttempt(state.attempt);
  }

  async function runVerifyAndContinue(): Promise<void> {
    if (verifyInFlight) return;
    const cfg = await loadConfig(state.worktree);
    if (!cfg.enabled) return;
    if (state.done || state.paused || state.stopped) return;

    verifyInFlight = true;
    try {
      const parsed = await runAndParseVerify(state.worktree, cfg);
      state.lastVerify = {
        verdict: parsed.verdict,
        details: parsed.details,
        at: nowISO(),
      };

      emit("verify.done", {
        sessionId: state.sessionId,
        attempt: state.attempt,
        verdict: parsed.verdict,
        details: parsed.details,
      });

      if (parsed.verdict === "pass") {
        state.done = true;
        await writeDoneFile(await getPlanContext(), templates);
        emit("loop.done", {
          sessionId: state.sessionId,
          attempt: state.attempt,
          verdict: parsed.verdict,
        });
        await notifyToast(
          "Ralph: Done",
          "Verification passed. Loop complete.",
          "success"
        );
        return;
      }

      if (state.attempt >= cfg.maxAttempts) {
        state.done = true;
        emit("loop.max_attempts", {
          sessionId: state.sessionId,
          attempt: state.attempt,
          verdict: parsed.verdict,
          details: parsed.details,
        });
        await notifyToast(
          "Ralph: stopped",
          `Max attempts (${cfg.maxAttempts}) reached.`,
          "warning"
        );
        return;
      }

      emit("rollover", {
        sessionId: state.sessionId,
        attempt: state.attempt,
        verdict: parsed.verdict,
        details: parsed.details,
      });

      await rolloverState(
        await getPlanContext(),
        templates,
        state.attempt,
        parsed.verdict,
        parsed.details
      );

      await startNextAttempt();
    } finally {
      verifyInFlight = false;
    }
  }

  async function handleWorkerIdle(workerSessionId: string): Promise<void> {
    if (state.currentWorkerSessionId !== workerSessionId) return;
    if (state.done) return;

    delete state.currentWorkerSessionId;
    delete state.lastWorkerProgressAt;

    emit("worker.idle", {
      sessionId: state.sessionId,
      attempt: state.attempt,
      workerSessionId,
    });

    if (state.paused || state.stopped) {
      state.workerIdlePendingVerify = true;
      return;
    }

    await runVerifyAndContinue();
  }

  async function processEvent(event: unknown): Promise<void> {
    const type = eventType(event);
    const sessionId = extractSessionIdFromEvent(event);

    if (type === "ralph.subscription.error") {
      if (!state.done && !state.paused && state.started) {
        const message =
          typeof (event as Record<string, unknown>).error === "string"
            ? ((event as Record<string, unknown>).error as string)
            : "OpenCode event subscription failed.";
        await pauseWithReason(`Event subscription error; loop paused. (${message})`);
      }
      return;
    }

    if (!sessionId) return;

    if (type === "session.status") {
      if (state.currentWorkerSessionId === sessionId) {
        state.lastWorkerProgressAt = Date.now();
        if (eventStatus(event) === "error") {
          await clearWorkerSession(sessionId, "Worker session reported error status.");
          await pauseWithReason(
            "Worker session error; loop paused. Inspect worker session and resume when ready."
          );
        }
      }
      return;
    }

    if (
      type === "session.closed" ||
      type === "session.ended" ||
      type === "session.deleted"
    ) {
      if (state.currentWorkerSessionId === sessionId) {
        await clearWorkerSession(sessionId, `Worker session ended (${type}).`);
        if (!state.done && !state.paused) {
          await pauseWithReason(
            `Worker session ended unexpectedly (${type}); loop paused. Resume to spawn a new worker.`
          );
        }
      }
      return;
    }

    if (type === "session.idle") {
      await emitHeartbeatWarnings();
      await notifyPendingQuestions();

      if (state.currentWorkerSessionId === sessionId) {
        await handleWorkerIdle(sessionId);
      }
    }
  }

  const eventQueue = createAsyncEventQueue(processEvent);

  const engine: LoopEngine = {
    state,

    on(event, handler) {
      return events.on(event, handler);
    },

    async start(partial) {
      if (partial?.sessionId) state.sessionId = partial.sessionId;
      if (partial?.worktree) state.worktree = partial.worktree;

      const cfg = await loadConfig(state.worktree);
      if (!cfg.enabled) {
        throw new Error("Ralph loop is disabled in ralph.json (enabled=false)");
      }

      // Refresh the cached plan context for this run (active plan may have changed).
      planCtx = await loadPlanContext(state.worktree);

      if (partial?.bootstrap ?? config.bootstrap ?? true) {
        const goal = partial?.goal ?? config.goal;
        await bootstrapProtocolFiles(
          planCtx,
          templates,
          goal ? { goal } : {}
        );
      }

      const restartingFromDone = state.done;
      state.started = true;
      state.paused = false;
      state.stopped = false;
      state.done = false;
      delete state.pauseReason;
      delete state.stopReason;
      delete state.workerIdlePendingVerify;

      if (restartingFromDone) {
        state.attempt = 0;
        delete state.lastVerify;
        state.notifiedQuestionIds.clear();
      }

      await ensureSubscription();

      if (state.attempt < 1) {
        await startNextAttempt();
      } else if (!state.currentWorkerSessionId) {
        await retryCurrentAttempt();
      }
    },

    async pause(reason) {
      state.paused = true;
      state.stopped = false;

      const workerId = state.currentWorkerSessionId;
      delete state.currentWorkerSessionId;
      delete state.lastWorkerProgressAt;
      if (workerId) {
        await runtime.client.session
          .abort({ sessionID: workerId, directory: state.worktree })
          .catch(() => {});
        await appendSupervisorLog(
          `worker/attempt-${state.attempt}`,
          "Worker aborted because loop was paused.",
          "warning"
        );
      }

      if (reason) {
        state.pauseReason = reason;
      }
      emit("loop.paused", {
        sessionId: state.sessionId,
        attempt: state.attempt,
        ...(reason ? { reason } : {}),
      });
    },

    async resume() {
      if (state.done || resumeInFlight) return;
      resumeInFlight = true;
      try {
        state.paused = false;
        delete state.pauseReason;
        emit("loop.resumed", { sessionId: state.sessionId, attempt: state.attempt });

        if (state.workerIdlePendingVerify) {
          delete state.workerIdlePendingVerify;
          await runVerifyAndContinue();
          return;
        }

        if (!state.currentWorkerSessionId && state.started) {
          await retryCurrentAttempt();
        }
      } finally {
        resumeInFlight = false;
      }
    },

    async stop(reason) {
      state.stopped = true;
      state.done = true;
      state.paused = false;
      delete state.pauseReason;
      delete state.workerIdlePendingVerify;
      if (reason) {
        state.stopReason = reason;
      }

      const workerId = state.currentWorkerSessionId;
      delete state.currentWorkerSessionId;
      delete state.lastWorkerProgressAt;

      if (workerId) {
        await runtime.client.session
          .abort({ sessionID: workerId, directory: state.worktree })
          .catch(() => {});
      }

      emit("loop.stopped", {
        sessionId: state.sessionId,
        attempt: state.attempt,
        ...(reason ? { reason } : {}),
      });
    },

    async status() {
      const cfg = await loadConfig(state.worktree);
      const status = toLoopStatus(state, cfg.maxAttempts);
      const pending = listUnansweredQuestions(await readPendingInput(await getPlanContext()));
      if (pending.length > 0) {
        status.pendingQuestions = pending.map(toQuestionSnapshot);
      }
      return status;
    },

    async peekWorker(maxLines = 120) {
      const ctx = await getPlanContext();
      const raw = await readTextFile(protocolFilePath(ctx, PROTOCOL_FILES.CURR)).catch(() => "");
      return clampLines(raw, maxLines);
    },

    async handleEvent(event) {
      await eventQueue.push(event);
    },

    dispose() {
      subscription?.stop();
      subscription = undefined;
    },
  };

  return engine;
}

export function createDefaultLoopEngine(config: LoopRunConfig): LoopEngine {
  return createLoopEngine(config, {
    runtime: createOpencodeRuntime(),
  });
}