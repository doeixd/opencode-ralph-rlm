import { describe, expect, test } from "bun:test";
import {
  assertValidSessionContext,
  isAnonymousSessionAllowed,
  resolveSessionContext,
} from "../lib/session-context.js";

function mockEvent(headers: Record<string, string> = {}, query = ""): Parameters<typeof resolveSessionContext>[0] {
  const url = new URL(`http://localhost/v1/chat/completions${query}`);
  return {
    url,
    req: {
      url: url.toString(),
      headers: {
        get(name: string) {
          return headers[name.toLowerCase()] ?? headers[name] ?? null;
        },
      },
    },
    path: url.pathname,
    context: {},
  } as Parameters<typeof resolveSessionContext>[0];
}

describe("session-context", () => {
  test("resolves x-opencode-session-id header", () => {
    const ctx = resolveSessionContext(
      mockEvent({ "x-opencode-session-id": "sess-abc" }),
      "hello"
    );
    expect(ctx.sessionKey).toBe("sess-abc");
    expect(ctx.source).toBe("header:x-opencode-session-id");
  });

  test("blocks anonymous sessions outside test mode", () => {
    const previousTest = process.env.RALPH_TEST_MODE;
    const previousAllow = process.env.RALPH_ALLOW_ANONYMOUS_SESSION;
    delete process.env.RALPH_TEST_MODE;
    delete process.env.RALPH_ALLOW_ANONYMOUS_SESSION;

    try {
      expect(isAnonymousSessionAllowed()).toBe(false);
      const ctx = resolveSessionContext(mockEvent(), "hello");
      expect(ctx.source).toBe("anonymous");
      expect(() => assertValidSessionContext(ctx)).toThrow(/Anonymous fallback is disabled/);
    } finally {
      if (previousTest === undefined) delete process.env.RALPH_TEST_MODE;
      else process.env.RALPH_TEST_MODE = previousTest;
      if (previousAllow === undefined) delete process.env.RALPH_ALLOW_ANONYMOUS_SESSION;
      else process.env.RALPH_ALLOW_ANONYMOUS_SESSION = previousAllow;
    }
  });

  test("allows anonymous when RALPH_ALLOW_ANONYMOUS_SESSION=1", () => {
    const previous = process.env.RALPH_ALLOW_ANONYMOUS_SESSION;
    delete process.env.RALPH_TEST_MODE;
    process.env.RALPH_ALLOW_ANONYMOUS_SESSION = "1";

    try {
      expect(isAnonymousSessionAllowed()).toBe(true);
      assertValidSessionContext({ sessionKey: "anonymous", source: "anonymous" });
    } finally {
      if (previous === undefined) delete process.env.RALPH_ALLOW_ANONYMOUS_SESSION;
      else process.env.RALPH_ALLOW_ANONYMOUS_SESSION = previous;
    }
  });
});