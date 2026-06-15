import {
  subscribeWorktreeEvents,
  type LoopEngine,
  type LoopEngineOptions,
} from "@ralph-rlm/engine";
import { loopRegistry } from "./loop-registry.js";
import { getOpencodeRuntime } from "./runtime.js";

function baseEngineOptions(
  runtime: LoopEngineOptions["runtime"],
  overrides?: Partial<LoopEngineOptions>
): LoopEngineOptions {
  return {
    runtime,
    onToast: async ({ title, message, variant }) => {
      await runtime.client.tui.showToast({ title, message, variant }).catch(() => {});
    },
    ...(overrides?.templates ? { templates: overrides.templates } : {}),
    ...(overrides?.subscribeEvents ? { subscribeEvents: overrides.subscribeEvents } : {}),
    ...(overrides?.onToast ? { onToast: overrides.onToast } : {}),
  };
}

export async function getEngineForSession(
  sessionKey: string,
  worktree: string,
  options?: Partial<LoopEngineOptions>
): Promise<LoopEngine> {
  const runtime = options?.runtime ?? getOpencodeRuntime();
  const subscribeEvents =
    options?.subscribeEvents ??
    ((onEvent) => subscribeWorktreeEvents(worktree, runtime, onEvent));

  return loopRegistry.getOrCreate(
    { sessionId: sessionKey, worktree },
    baseEngineOptions(runtime, { ...options, subscribeEvents })
  );
}