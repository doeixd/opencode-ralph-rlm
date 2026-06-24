import type { VerifyVerdict } from "./verify.js";

/** Snapshot of the most recent verify command result for an attempt. */
export type LastVerifySnapshot = {
  verdict: VerifyVerdict;
  details: string;
  at: string;
};

/**
 * Mutable in-memory state for a single Ralph loop run.
 * Persisted protocol files live under the worktree; this tracks runtime control flow only.
 */
export type LoopRunState = {
  sessionId: string;
  worktree: string;
  attempt: number;
  done: boolean;
  /** User- or error-initiated pause; use {@link resume} to continue. */
  paused: boolean;
  /** Explicit stop via {@link LoopEngine.stop}; restart with {@link LoopEngine.start}. */
  stopped: boolean;
  started: boolean;
  currentWorkerSessionId?: string;
  lastVerify?: LastVerifySnapshot;
  lastWorkerProgressAt?: number;
  pauseReason?: string;
  /**
   * Worker reached idle while paused; verify and rollover are deferred until {@link LoopEngine.resume}.
   */
  workerIdlePendingVerify?: boolean;
  /** Set when the loop was explicitly stopped via {@link LoopEngine.stop}. */
  stopReason?: string;
  notifiedQuestionIds: Set<string>;
};

/** Terminal or in-progress outcome for status reporting. */
export type LoopOutcome = "running" | "passed" | "max_attempts" | "stopped";

export type PendingQuestionSnapshot = {
  id: string;
  question: string;
  context?: string;
  askedAt: string;
  from: string;
  attempt: number;
};

/** Serializable loop status returned by {@link LoopEngine.status}. */
export type LoopStatus = {
  sessionId: string;
  worktree: string;
  attempt: number;
  done: boolean;
  paused: boolean;
  stopped: boolean;
  started: boolean;
  maxAttempts: number;
  workerSessionId?: string;
  lastVerify?: LastVerifySnapshot;
  pauseReason?: string;
  workerIdlePendingVerify?: boolean;
  stopReason?: string;
  outcome: LoopOutcome;
  pendingQuestions?: PendingQuestionSnapshot[];
};

/** Configuration for creating or starting a loop run. */
export type LoopRunConfig = {
  sessionId: string;
  worktree: string;
  bootstrap?: boolean;
  /** User goal woven into PLAN.md when bootstrapping a fresh plan. */
  goal?: string;
};

export function createLoopRunState(config: LoopRunConfig): LoopRunState {
  return {
    sessionId: config.sessionId,
    worktree: config.worktree,
    attempt: 0,
    done: false,
    paused: false,
    stopped: false,
    started: false,
    notifiedQuestionIds: new Set(),
  };
}

function resolveLoopOutcome(state: LoopRunState): LoopOutcome {
  if (!state.done) return "running";
  if (state.stopped) return "stopped";
  if (state.lastVerify?.verdict === "pass") return "passed";
  return "max_attempts";
}

/** Maps internal loop state to a status snapshot (without pending-question file reads). */
export function toLoopStatus(
  state: LoopRunState,
  maxAttempts: number
): LoopStatus {
  const status: LoopStatus = {
    sessionId: state.sessionId,
    worktree: state.worktree,
    attempt: state.attempt,
    done: state.done,
    paused: state.paused,
    stopped: state.stopped,
    started: state.started,
    maxAttempts,
    outcome: resolveLoopOutcome(state),
  };

  if (state.currentWorkerSessionId) {
    status.workerSessionId = state.currentWorkerSessionId;
  }
  if (state.lastVerify) {
    status.lastVerify = state.lastVerify;
  }
  if (state.pauseReason) {
    status.pauseReason = state.pauseReason;
  }
  if (state.workerIdlePendingVerify) {
    status.workerIdlePendingVerify = true;
  }
  if (state.stopReason) {
    status.stopReason = state.stopReason;
  }

  return status;
}