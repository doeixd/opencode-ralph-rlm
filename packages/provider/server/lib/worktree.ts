import path from "node:path";
import type { SessionContext } from "./session-context.js";

export function resolveWorktree(session: SessionContext): string {
  if (session.directory) {
    return path.resolve(session.directory);
  }

  const fromEnv = process.env.RALPH_WORKTREE?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }

  return process.cwd();
}