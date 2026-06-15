/**
 * M0.5 — Proof that we can spawn an OpenCode worker session via SDK.
 * Run: bun run spawn-proof (from packages/engine)
 * Requires a running OpenCode server at OPENCODE_BASE_URL (default :4096).
 */
import { createOpencodeRuntime } from "./opencode-client.js";

const runtime = createOpencodeRuntime();

const health = await runtime.health();
if (!health.healthy) {
  console.error(
    `[spawn-proof] OpenCode not reachable at ${runtime.baseUrl}: ${health.error ?? "unhealthy"}`
  );
  console.error("[spawn-proof] Start OpenCode or run: opencode serve --port 4096");
  process.exit(1);
}

console.log(`[spawn-proof] OpenCode healthy (version: ${health.version ?? "unknown"})`);

const created = await runtime.client.session.create({
  title: "ralph-m0-spawn-proof",
});

const sessionId = created.data?.id;
if (!sessionId) {
  console.error("[spawn-proof] session.create returned no id");
  process.exit(1);
}

console.log(`[spawn-proof] Created session: ${sessionId}`);

await runtime.client.session.prompt({
  sessionID: sessionId,
  noReply: true,
  parts: [
    {
      type: "text",
      text: "Ralph M0 spawn proof — context injection only, no AI reply.",
    },
  ],
});

console.log("[spawn-proof] Injected noReply prompt");

const sessions = await runtime.client.session.list();
const count = sessions.data?.length ?? 0;
console.log(`[spawn-proof] session.list count: ${count}`);
console.log("[spawn-proof] OK");