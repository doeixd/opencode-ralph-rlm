import path from "node:path";
import { fileExists, readTextFile, writeTextFile } from "./fs.js";
import { nowISO } from "./text.js";

/** Relative path (under worktree) for the active loop attempt marker. */
export const LOOP_ATTEMPT_REL_PATH = ".opencode/loop_attempt.json";

export type LoopAttemptMarker = {
  attempt: number;
  sessionId: string;
  workerSessionId?: string;
  updatedAt: string;
};

export async function writeLoopAttemptMarker(
  worktree: string,
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
    path.join(worktree, LOOP_ATTEMPT_REL_PATH),
    JSON.stringify(payload, null, 2)
  );
}

/** Returns the current loop attempt from the marker file, if present. */
export async function readLoopAttemptMarker(worktree: string): Promise<number | undefined> {
  const filePath = path.join(worktree, LOOP_ATTEMPT_REL_PATH);
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