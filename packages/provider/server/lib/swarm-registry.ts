import { SwarmRegistry } from "@ralph-rlm/engine";

/** Process-wide swarm runs keyed by swarmId, indexed per supervisor session. */
export const swarmRegistry = new SwarmRegistry();