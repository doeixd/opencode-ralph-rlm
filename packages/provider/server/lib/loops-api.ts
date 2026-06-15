import { getRouterParams, type HTTPEvent } from "nitro/h3";
import { loopRegistry } from "./loop-registry.js";
import { resolveWorktree } from "./worktree.js";
import type { SessionContext } from "./session-context.js";

export function getSessionIdFromEvent(event: HTTPEvent): string {
  const params = getRouterParams(event);
  const sessionId = params.sessionId;
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    throw new Error("sessionId path parameter is required");
  }
  return sessionId.trim();
}

export function resolveLoopWorktree(
  event: HTTPEvent,
  session: SessionContext
): string {
  const params = getRouterParams(event);
  const directory =
    typeof params.directory === "string"
      ? params.directory
      : session.directory;
  return resolveWorktree({
    ...session,
    ...(directory ? { directory } : {}),
  });
}

export async function requireEngine(event: HTTPEvent, sessionKey: string) {
  const session: SessionContext = {
    sessionKey,
    source: "query:session_id",
    rawSessionId: sessionKey,
  };
  const worktree = resolveLoopWorktree(event, session);
  const engine = loopRegistry.get(sessionKey);
  if (!engine) {
    return { engine: null, worktree, status: null };
  }
  const status = await engine.status();
  return { engine, worktree, status };
}