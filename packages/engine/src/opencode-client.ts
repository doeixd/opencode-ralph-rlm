import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

export type OpencodeRuntimeOptions = {
  baseUrl?: string;
};

export type OpencodeRuntime = {
  baseUrl: string;
  client: ReturnType<typeof createOpencodeClient>;
  health: () => Promise<{ healthy: boolean; version?: string; error?: string }>;
};

// localhost, not 127.0.0.1: Node/undici on Windows can time out on the IPv4
// literal while localhost resolves fine (the "cannot reach the server" symptom).
const DEFAULT_BASE_URL = "http://localhost:4096";

export function createOpencodeRuntime(
  options: OpencodeRuntimeOptions = {}
): OpencodeRuntime {
  const baseUrl = options.baseUrl ?? process.env.OPENCODE_BASE_URL ?? DEFAULT_BASE_URL;
  const client = createOpencodeClient({ baseUrl });

  return {
    baseUrl,
    client,
    async health() {
      try {
        const result = await client.global.health();
        const data = result.data;
        const out: { healthy: boolean; version?: string; error?: string } = {
          healthy: data?.healthy === true,
        };
        if (typeof data?.version === "string") {
          out.version = data.version;
        }
        return out;
      } catch (err) {
        return {
          healthy: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

export function extractSessionIdFromEvent(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const record = event as Record<string, unknown>;

  if (
    (record.type === "session.idle" || record.type === "session.status") &&
    typeof record.properties === "object" &&
    record.properties
  ) {
    const props = record.properties as Record<string, unknown>;
    if (typeof props.sessionID === "string") return props.sessionID;
  }

  if (typeof record.sessionID === "string") return record.sessionID;
  if (typeof record.session_id === "string") return record.session_id;

  if (typeof record.session === "object" && record.session) {
    const session = record.session as Record<string, unknown>;
    if (typeof session.id === "string") return session.id;
  }

  return undefined;
}

export type OpencodeEventSubscription = {
  stop: () => void;
};

export async function subscribeOpencodeEvents(
  runtime: OpencodeRuntime,
  onEvent: (event: unknown) => void,
  options?: { directory?: string }
): Promise<OpencodeEventSubscription> {
  const parameters = options?.directory ? { directory: options.directory } : undefined;
  const result = await runtime.client.event.subscribe(parameters);
  let cancelled = false;

  void (async () => {
    try {
      for await (const event of result.stream) {
        if (cancelled) break;
        onEvent(event);
      }
    } catch (err) {
      if (!cancelled) {
        onEvent({
          type: "ralph.subscription.error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  })();

  return {
    stop() {
      cancelled = true;
    },
  };
}