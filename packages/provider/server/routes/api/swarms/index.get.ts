import { defineHandler } from "nitro/h3";
import { getSessionIdQuery } from "../../../lib/swarms-api.js";
import { swarmRegistry } from "../../../lib/swarm-registry.js";

/** OpenAPI: GET /api/swarms — list swarm runs (optional ?sessionId=) */
export default defineHandler(async (event) => {
  const sessionId = getSessionIdQuery(event);
  const swarms = sessionId
    ? swarmRegistry.listForSession(sessionId)
    : swarmRegistry.listAll();
  return { swarms };
});