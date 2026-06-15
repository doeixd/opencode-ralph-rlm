import { defineHandler } from "nitro/h3";
import { getSwarmIdFromEvent, requireSwarm } from "../../../lib/swarms-api.js";

/** OpenAPI: GET /api/swarms/:swarmId — full swarm status */
export default defineHandler(async (event) => {
  const swarmId = getSwarmIdFromEvent(event);
  const { runner, status } = requireSwarm(swarmId);
  if (!runner || !status) {
    return { ok: false, error: `Swarm not found: ${swarmId}` };
  }
  return { ok: true, status };
});