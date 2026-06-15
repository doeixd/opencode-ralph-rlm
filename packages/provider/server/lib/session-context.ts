import { getRequestURL, type HTTPEvent } from "nitro/h3";
import { isTestMode } from "./supervisor-config.js";

/**
 * M0.4 — Resolve a stable key for correlating OpenCode TUI sessions with LoopRuns.
 *
 * Priority:
 * 1. x-opencode-session-id (proposed bridge header — verify in spike)
 * 2. x-session-id
 * 3. ?session_id= query param on provider baseURL
 * 4. ?directory= query + hash of first user message (fallback)
 * 5. "anonymous" (last resort; logged)
 */
export type SessionContext = {
  sessionKey: string;
  source:
    | "header:x-opencode-session-id"
    | "header:x-session-id"
    | "query:session_id"
    | "query:directory+message"
    | "anonymous";
  directory?: string;
  rawSessionId?: string;
};

function hashString(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (Math.imul(31, h) + input.charCodeAt(i)) | 0;
  }
  return `msg-${Math.abs(h).toString(36)}`;
}

export function resolveSessionContext(
  event: HTTPEvent,
  firstUserMessage?: string
): SessionContext {
  const headers = event.req.headers;

  const opencodeSession = headers.get("x-opencode-session-id")?.trim();
  if (opencodeSession) {
    return {
      sessionKey: opencodeSession,
      source: "header:x-opencode-session-id",
      rawSessionId: opencodeSession,
    };
  }

  const sessionHeader = headers.get("x-session-id")?.trim();
  if (sessionHeader) {
    return {
      sessionKey: sessionHeader,
      source: "header:x-session-id",
      rawSessionId: sessionHeader,
    };
  }

  const url = getRequestURL(event);
  const querySession = url.searchParams.get("session_id")?.trim();
  if (querySession) {
    return {
      sessionKey: querySession,
      source: "query:session_id",
      rawSessionId: querySession,
    };
  }

  const directory = url.searchParams.get("directory")?.trim();
  if (directory && firstUserMessage) {
    return {
      sessionKey: `${directory}::${hashString(firstUserMessage)}`,
      source: "query:directory+message",
      directory,
    };
  }

  if (directory) {
    return {
      sessionKey: `dir-${hashString(directory)}`,
      source: "query:directory+message",
      directory,
    };
  }

  return {
    sessionKey: "anonymous",
    source: "anonymous",
  };
}

/** Whether anonymous session fallback is permitted (test mode or explicit opt-in). */
export function isAnonymousSessionAllowed(): boolean {
  if (isTestMode()) return true;
  const raw = process.env.RALPH_ALLOW_ANONYMOUS_SESSION?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Rejects uncorrelated supervisor sessions in production.
 * Send `x-opencode-session-id`, `x-session-id`, `?session_id=`, or `?directory=`.
 */
export function assertValidSessionContext(context: SessionContext): void {
  if (context.source !== "anonymous") return;
  if (isAnonymousSessionAllowed()) return;

  throw new Error(
    "Cannot correlate supervisor session: provide x-opencode-session-id, x-session-id, " +
      "?session_id=, or ?directory=. Anonymous fallback is disabled outside test mode."
  );
}