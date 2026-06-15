/**
 * Ralph session bridge (M0.4b / M8.1).
 *
 * OpenCode does not forward session IDs to custom provider HTTP requests by default.
 * This plugin tracks the active TUI session and injects correlation headers via the
 * provider auth `fetch` wrapper (same pattern as opencode-helicone-session).
 *
 * Load automatically from `.opencode/plugins/` or add to opencode.json:
 *   "plugin": ["./.opencode/plugins/ralph-session-bridge.ts"]
 */
import type { Plugin } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";

const PROVIDER_ID = "ralph-rlm";
const SESSION_HEADER = "x-opencode-session-id";

function sanitizeForHeader(value: string): string {
  return value.replace(/[\r\n\x00-\x1f\x7f]/g, "").trim();
}

function sessionIdFromEvent(event: Event): string {
  if (event.type !== "session.created" && event.type !== "session.updated" && event.type !== "session.deleted") {
    return "";
  }
  const info = (event.properties as { info?: { id?: string } }).info;
  return sanitizeForHeader(info?.id ?? "");
}

function isRalphProviderRequest(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.port === "8787"
    );
  } catch {
    return false;
  }
}

function withDirectoryParam(url: string, directory: string): string {
  const parsed = new URL(url);
  if (!parsed.searchParams.has("directory") && directory) {
    parsed.searchParams.set("directory", directory);
  }
  return parsed.toString();
}

export const RalphSessionBridgePlugin: Plugin = async ({ client, worktree }) => {
  let currentSessionId = "";

  const log = async (level: "debug" | "info", message: string, extra?: Record<string, unknown>) => {
    await client.app
      .log({
        body: {
          service: "ralph-session-bridge",
          level,
          message,
          ...(extra ? { extra } : {}),
        },
      })
      .catch(() => {});
  };

  return {
    auth: {
      provider: PROVIDER_ID,
      methods: [],
      loader: async () => ({
        fetch: (url: string | URL | Request, init?: RequestInit) => {
          const href =
            typeof url === "string" ? url : url instanceof URL ? url.href : url.url;

          if (!isRalphProviderRequest(href)) {
            return fetch(url, init);
          }

          const headers = new Headers(init?.headers);
          if (currentSessionId && !headers.has(SESSION_HEADER)) {
            headers.set(SESSION_HEADER, currentSessionId);
          }

          const target = withDirectoryParam(href, worktree);
          return fetch(target, { ...init, headers });
        },
      }),
    },

    event: async ({ event }: { event: Event }) => {
      if (event.type === "session.created") {
        currentSessionId = sessionIdFromEvent(event);
        await log("info", "Session bridge bound", { sessionId: currentSessionId });
      } else if (event.type === "session.updated") {
        currentSessionId = sessionIdFromEvent(event);
      } else if (event.type === "session.deleted") {
        const deletedId = sessionIdFromEvent(event);
        if (deletedId && deletedId === currentSessionId) {
          currentSessionId = "";
        }
      }
    },
  };
};

export default RalphSessionBridgePlugin;