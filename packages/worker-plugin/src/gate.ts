export const DESTRUCTIVE_TOOLS = new Set([
  "write",
  "edit",
  "bash",
  "delete",
  "move",
  "rename",
]);

export const SAFE_TOOLS = new Set([
  "ralph_load_context",
  "rlm_grep",
  "rlm_slice",
  "ralph_verify",
  "ralph_report",
  "ralph_set_status",
  "ralph_ask",
  "ralph_update_plan",
  "ralph_update_rlm_instructions",
]);

export function shouldGateDestructiveTool(input: {
  gateEnabled: boolean;
  loadedContext: boolean;
  toolName: string;
}): boolean {
  if (!input.gateEnabled) return false;
  if (input.loadedContext) return false;
  if (SAFE_TOOLS.has(input.toolName)) return false;
  if (!DESTRUCTIVE_TOOLS.has(input.toolName)) return false;
  return true;
}