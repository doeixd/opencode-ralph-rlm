import { describe, expect, test } from "bun:test";
import {
  buildSessionDebugSnapshot,
  collectSessionDebugHeaders,
  isSessionDebugEnabled,
} from "../lib/session-debug.js";

describe("session-debug", () => {
  test("collects correlation headers and redacts authorization", () => {
    const headers = collectSessionDebugHeaders({
      get(name: string) {
        if (name === "x-opencode-session-id") return "sess-1";
        if (name === "authorization") return "Bearer secret";
        return null;
      },
    });

    expect(headers["x-opencode-session-id"]).toBe("sess-1");
    expect(headers.authorization).toBe("[redacted]");
  });

  test("buildSessionDebugSnapshot includes resolved context", () => {
    const snapshot = buildSessionDebugSnapshot(
      {
        sessionKey: "sess-1",
        source: "header:x-opencode-session-id",
        rawSessionId: "sess-1",
      },
      {
        get(name: string) {
          if (name === "x-opencode-session-id") return "sess-1";
          return null;
        },
      }
    );

    expect(snapshot.sessionKey).toBe("sess-1");
    expect(snapshot.source).toBe("header:x-opencode-session-id");
    expect(snapshot.forwardedHeaders["x-opencode-session-id"]).toBe("sess-1");
  });

  test("isSessionDebugEnabled respects RALPH_SESSION_DEBUG", () => {
    const previous = process.env.RALPH_SESSION_DEBUG;
    process.env.RALPH_SESSION_DEBUG = "1";
    try {
      expect(isSessionDebugEnabled()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.RALPH_SESSION_DEBUG;
      else process.env.RALPH_SESSION_DEBUG = previous;
    }
  });
});