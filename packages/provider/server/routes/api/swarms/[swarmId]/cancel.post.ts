import { defineHandler, readBody } from "nitro/h3";
import { getSwarmIdFromEvent } from "../../../../lib/swarms-api.js";
import { swarmRegistry } from "../../../../lib/swarm-registry.js";

/** OpenAPI: POST /api/swarms/:swarmId/cancel — cancel swarm + abort children */
export default defineHandler(async (event) => {
  const swarmId = getSwarmIdFromEvent(event);
  const body = (await readBody(event).catch(() => ({}))) as Record<string, unknown>;
  const reason = typeof body.reason === "string" ? body.reason : undefined;
  const cancelled = await swarmRegistry.cancel(swarmId, reason);
  if (!cancelled) {
    return { ok: false, error: `Swarm not found: ${swarmId}` };
  }
  const runner = swarmRegistry.get(swarmId);
  return {
    ok: true,
    swarmId,
    cancelled: true,
    status: runner?.status() ?? null,
  };
});