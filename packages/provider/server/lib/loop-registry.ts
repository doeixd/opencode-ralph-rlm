import { LoopRegistry } from "@ralph-rlm/engine";

/** Process-wide registry keyed by OpenCode / supervisor session ID. */
export const loopRegistry = new LoopRegistry();