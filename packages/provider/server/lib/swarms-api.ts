import { getQuery, getRouterParams, type HTTPEvent } from "nitro/h3";
import { swarmRegistry } from "./swarm-registry.js";

export function getSwarmIdFromEvent(event: HTTPEvent): string {
  const params = getRouterParams(event);
  const swarmId = params.swarmId;
  if (typeof swarmId !== "string" || !swarmId.trim()) {
    throw new Error("swarmId path parameter is required");
  }
  return swarmId.trim();
}

export function getSessionIdQuery(event: HTTPEvent): string | undefined {
  const query = getQuery(event);
  const sessionId = query.sessionId ?? query.session_id;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : undefined;
}

export function requireSwarm(swarmId: string) {
  const runner = swarmRegistry.get(swarmId);
  if (!runner) {
    return { runner: null, status: null };
  }
  return { runner, status: runner.status() };
}