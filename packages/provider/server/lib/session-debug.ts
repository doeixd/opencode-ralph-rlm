import type { SessionContext } from "./session-context.js";

const CORRELATION_HEADERS = [
  "x-opencode-session-id",
  "x-session-id",
  "x-opencode-directory",
  "authorization",
] as const;

export type SessionDebugSnapshot = {
  sessionKey: string;
  source: SessionContext["source"];
  directory?: string;
  forwardedHeaders: Record<string, string>;
  userAgent: string | null;
};

export function isSessionDebugEnabled(): boolean {
  const raw = process.env.RALPH_SESSION_DEBUG?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function collectSessionDebugHeaders(
  headers: { get(name: string): string | null }
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of CORRELATION_HEADERS) {
    const value = headers.get(name)?.trim();
    if (value) {
      out[name] = name === "authorization" ? "[redacted]" : value;
    }
  }
  return out;
}

export function buildSessionDebugSnapshot(
  context: SessionContext,
  headers: { get(name: string): string | null }
): SessionDebugSnapshot {
  return {
    sessionKey: context.sessionKey,
    source: context.source,
    ...(context.directory ? { directory: context.directory } : {}),
    forwardedHeaders: collectSessionDebugHeaders(headers),
    userAgent: headers.get("user-agent"),
  };
}

export function logSessionDebug(snapshot: SessionDebugSnapshot): void {
  console.log(
    `[ralph-session] key=${snapshot.sessionKey} source=${snapshot.source}` +
      (snapshot.directory ? ` directory=${snapshot.directory}` : "") +
      ` headers=${JSON.stringify(snapshot.forwardedHeaders)}`
  );
}