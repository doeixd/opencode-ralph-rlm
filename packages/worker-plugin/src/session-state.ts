export type WorkerSessionState = {
  loadedContext: boolean;
  attempt: number;
  lastGrepAt?: number;
  lastGrepQuery?: string;
  reportedStatus?: "running" | "blocked" | "done" | "error";
  reportedStatusNote?: string;
  lastProgressAt?: number;
};

export function freshWorkerSession(attempt = 0): WorkerSessionState {
  return {
    loadedContext: false,
    attempt,
  };
}

export function parseAttemptFromTitle(title: string | undefined): number {
  if (!title) return 0;
  const match = title.match(/rlm-worker-attempt-(\d+)/i);
  if (!match?.[1]) return 0;
  const n = Number.parseInt(match[1], 10);
  return Number.isFinite(n) ? n : 0;
}