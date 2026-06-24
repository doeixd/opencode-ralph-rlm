import { fileExists, readTextFile, writeTextFile } from "./fs.js";
import { stateFilePath, type PlanContext } from "./plan-paths.js";
import { nowISO } from "./text.js";

/** Marker filename, resolved under the plan's state dir. */
export const LOOP_ATTEMPT_FILE = "loop_attempt.json";
/** Legacy relative path (under worktree) — retained for reference. */
export const LOOP_ATTEMPT_REL_PATH = ".opencode/loop_attempt.json";

export type LoopAttemptMarker = {
  attempt: number;
  sessionId: string;
  workerSessionId?: string;
  updatedAt: string;
};

export async function writeLoopAttemptMarker(
  ctx: PlanContext,
  marker: Pick<LoopAttemptMarker, "attempt" | "sessionId"> & {
    workerSessionId?: string;
  }
): Promise<void> {
  const payload: LoopAttemptMarker = {
    attempt: marker.attempt,
    sessionId: marker.sessionId,
    updatedAt: nowISO(),
  };
  if (marker.workerSessionId) {
    payload.workerSessionId = marker.workerSessionId;
  }
  await writeTextFile(
    stateFilePath(ctx, LOOP_ATTEMPT_FILE),
    JSON.stringify(payload, null, 2)
  );
}

/** Returns the current loop attempt from the marker file, if present. */
export async function readLoopAttemptMarker(ctx: PlanContext): Promise<number | undefined> {
  const filePath = stateFilePath(ctx, LOOP_ATTEMPT_FILE);
  if (!(await fileExists(filePath))) return undefined;
  try {
    const parsed = JSON.parse(await readTextFile(filePath)) as Partial<LoopAttemptMarker>;
    if (typeof parsed.attempt !== "number" || !Number.isFinite(parsed.attempt)) {
      return undefined;
    }
    const attempt = Math.trunc(parsed.attempt);
    return attempt > 0 ? attempt : undefined;
  } catch {
    return undefined;
  }
}