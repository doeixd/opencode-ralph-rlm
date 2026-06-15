export type SwarmTaskStatus =
  | "pending"
  | "spawning"
  | "running"
  | "idle"
  | "error"
  | "cancelled";

export type SwarmTaskInput = {
  name: string;
  goal: string;
  agent?: string;
  context?: string;
  providerID?: string;
  modelID?: string;
};

export type SwarmTask = SwarmTaskInput & {
  status: SwarmTaskStatus;
  sessionId?: string;
  error?: string;
  spawnedAt?: string;
  idleAt?: string;
};

export type SwarmWaitPolicy = "none" | "all" | "any";

export type SwarmRunStatus = "starting" | "running" | "done" | "cancelled" | "error" | "timed_out";

export type SpawnSwarmInput = {
  label?: string;
  tasks: SwarmTaskInput[];
  concurrency?: number;
  waitPolicy?: SwarmWaitPolicy;
  timeoutMinutes?: number;
};

export type SwarmRunConfig = {
  swarmId: string;
  sessionKey: string;
  worktree: string;
  input: SpawnSwarmInput;
};

export type SwarmRunState = {
  swarmId: string;
  sessionKey: string;
  worktree: string;
  label?: string;
  tasks: SwarmTask[];
  status: SwarmRunStatus;
  waitPolicy: SwarmWaitPolicy;
  concurrency: number;
  timeoutMinutes: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  scriptRun?: boolean;
};

export type SwarmStatus = {
  swarmId: string;
  sessionKey: string;
  worktree: string;
  label?: string;
  tasks: SwarmTask[];
  status: SwarmRunStatus;
  waitPolicy: SwarmWaitPolicy;
  concurrency: number;
  timeoutMinutes: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  scriptRun?: boolean;
  elapsedMs: number;
};

export function createSwarmTasks(input: SpawnSwarmInput): SwarmTask[] {
  return input.tasks.map((task) => ({
    ...task,
    status: "pending" as const,
  }));
}

export function toSwarmStatus(state: SwarmRunState): SwarmStatus {
  const started = Date.parse(state.startedAt);
  const ended = state.finishedAt ? Date.parse(state.finishedAt) : Date.now();
  const status: SwarmStatus = {
    swarmId: state.swarmId,
    sessionKey: state.sessionKey,
    worktree: state.worktree,
    tasks: state.tasks,
    status: state.status,
    waitPolicy: state.waitPolicy,
    concurrency: state.concurrency,
    timeoutMinutes: state.timeoutMinutes,
    startedAt: state.startedAt,
    elapsedMs: Math.max(0, ended - started),
  };

  if (state.label) status.label = state.label;
  if (state.finishedAt) status.finishedAt = state.finishedAt;
  if (state.error) status.error = state.error;
  if (state.scriptRun) status.scriptRun = true;

  return status;
}