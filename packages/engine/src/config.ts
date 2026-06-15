import path from "node:path";
import { ConfigError, fileExists, readTextFile } from "./fs.js";

export type StatusVerbosity = "minimal" | "normal" | "verbose";

export type VerifyConfig = {
  command: string[];
  cwd?: string;
};

export type SwarmScriptRunner = "deno" | "bun" | "auto";

export type SwarmConfigInput = {
  enabled?: boolean;
  maxConcurrent?: number;
  maxTasksPerRun?: number;
  defaultTimeoutMinutes?: number;
  scriptRunner?: SwarmScriptRunner;
  unsafeEvalEnabled?: boolean;
  /** Max `client.session.create` calls allowed inside one unsafe script run. */
  maxUnsafeScriptSpawns?: number;
};

export type ResolvedSwarmConfig = {
  enabled: boolean;
  maxConcurrent: number;
  maxTasksPerRun: number;
  defaultTimeoutMinutes: number;
  scriptRunner: SwarmScriptRunner;
  unsafeEvalEnabled: boolean;
  maxUnsafeScriptSpawns: number;
};

export type RalphConfigInput = {
  enabled?: boolean;
  autoStartOnMainIdle?: boolean;
  statusVerbosity?: StatusVerbosity;
  maxAttempts?: number;
  heartbeatMinutes?: number;
  strategistHandoffMinutes?: number;
  strategistHandoffMaxRetries?: number;
  verifyTimeoutMinutes?: number;
  verify?: VerifyConfig;
  gateDestructiveToolsUntilContextLoaded?: boolean;
  maxRlmSliceLines?: number;
  requireGrepBeforeLargeSlice?: boolean;
  grepRequiredThresholdLines?: number;
  subAgentEnabled?: boolean;
  maxSubAgents?: number;
  maxConversationLines?: number;
  conversationArchiveCount?: number;
  reviewerEnabled?: boolean;
  reviewerRequireExplicitReady?: boolean;
  reviewerMaxRunsPerAttempt?: number;
  reviewerOutputDir?: string;
  reviewerPostToConversation?: boolean;
  agentMdPath?: string;
  swarm?: SwarmConfigInput;
};

export type ResolvedConfig = {
  enabled: boolean;
  autoStartOnMainIdle: boolean;
  statusVerbosity: StatusVerbosity;
  maxAttempts: number;
  heartbeatMinutes: number;
  strategistHandoffMinutes: number;
  strategistHandoffMaxRetries: number;
  verifyTimeoutMinutes: number;
  verify?: VerifyConfig;
  gateDestructiveToolsUntilContextLoaded: boolean;
  maxRlmSliceLines: number;
  requireGrepBeforeLargeSlice: boolean;
  grepRequiredThresholdLines: number;
  subAgentEnabled: boolean;
  maxSubAgents: number;
  maxConversationLines: number;
  conversationArchiveCount: number;
  reviewerEnabled: boolean;
  reviewerRequireExplicitReady: boolean;
  reviewerMaxRunsPerAttempt: number;
  reviewerOutputDir: string;
  reviewerPostToConversation: boolean;
  agentMdPath: string;
  swarm: ResolvedSwarmConfig;
};

function toBoundedInt(
  value: number | undefined,
  fallback: number,
  min: number,
  max = Number.MAX_SAFE_INTEGER
): number {
  const candidate = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const n = Math.trunc(candidate);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitizeVerify(verify: VerifyConfig | undefined): VerifyConfig | undefined {
  if (!verify) return undefined;
  const command = verify.command
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (command.length === 0) return undefined;
  const cwd = verify.cwd?.trim();
  return cwd ? { command, cwd } : { command };
}

export const CONFIG_DEFAULTS: ResolvedConfig = {
  enabled: true,
  autoStartOnMainIdle: false,
  statusVerbosity: "normal",
  maxAttempts: 20,
  heartbeatMinutes: 15,
  strategistHandoffMinutes: 5,
  strategistHandoffMaxRetries: 2,
  verifyTimeoutMinutes: 0,
  gateDestructiveToolsUntilContextLoaded: true,
  maxRlmSliceLines: 200,
  requireGrepBeforeLargeSlice: true,
  grepRequiredThresholdLines: 120,
  subAgentEnabled: true,
  maxSubAgents: 5,
  maxConversationLines: 1200,
  conversationArchiveCount: 3,
  reviewerEnabled: false,
  reviewerRequireExplicitReady: true,
  reviewerMaxRunsPerAttempt: 1,
  reviewerOutputDir: ".opencode/reviews",
  reviewerPostToConversation: true,
  agentMdPath: "AGENT.md",
  swarm: {
    enabled: true,
    maxConcurrent: 5,
    maxTasksPerRun: 12,
    defaultTimeoutMinutes: 30,
    scriptRunner: "auto",
    unsafeEvalEnabled: false,
    maxUnsafeScriptSpawns: 10,
  },
};

function resolveSwarmConfig(raw: SwarmConfigInput | undefined): ResolvedSwarmConfig {
  const scriptRunner = raw?.scriptRunner ?? CONFIG_DEFAULTS.swarm.scriptRunner;
  const allowed: SwarmScriptRunner[] = ["deno", "bun", "auto"];
  return {
    enabled: raw?.enabled ?? CONFIG_DEFAULTS.swarm.enabled,
    maxConcurrent: toBoundedInt(
      raw?.maxConcurrent,
      CONFIG_DEFAULTS.swarm.maxConcurrent,
      1,
      50
    ),
    maxTasksPerRun: toBoundedInt(
      raw?.maxTasksPerRun,
      CONFIG_DEFAULTS.swarm.maxTasksPerRun,
      1,
      100
    ),
    defaultTimeoutMinutes: toBoundedInt(
      raw?.defaultTimeoutMinutes,
      CONFIG_DEFAULTS.swarm.defaultTimeoutMinutes,
      1,
      240
    ),
    scriptRunner: allowed.includes(scriptRunner) ? scriptRunner : "auto",
    unsafeEvalEnabled: raw?.unsafeEvalEnabled ?? CONFIG_DEFAULTS.swarm.unsafeEvalEnabled,
    maxUnsafeScriptSpawns: toBoundedInt(
      raw?.maxUnsafeScriptSpawns,
      CONFIG_DEFAULTS.swarm.maxUnsafeScriptSpawns,
      1,
      100
    ),
  };
}

export function isSwarmUnsafeEvalEnabled(swarm: ResolvedSwarmConfig): boolean {
  if (swarm.unsafeEvalEnabled) return true;
  const env = process.env.RALPH_SWARM_UNSAFE_EVAL?.trim();
  return env === "1" || env?.toLowerCase() === "true";
}

export function resolveConfig(raw: RalphConfigInput): ResolvedConfig {
  const verify = sanitizeVerify(raw.verify);
  const maxRlmSliceLines = toBoundedInt(
    raw.maxRlmSliceLines,
    CONFIG_DEFAULTS.maxRlmSliceLines,
    10,
    2000
  );
  const grepRequiredThresholdLines = toBoundedInt(
    raw.grepRequiredThresholdLines,
    CONFIG_DEFAULTS.grepRequiredThresholdLines,
    1,
    maxRlmSliceLines
  );

  const resolved: ResolvedConfig = {
    enabled: raw.enabled ?? CONFIG_DEFAULTS.enabled,
    autoStartOnMainIdle: raw.autoStartOnMainIdle ?? CONFIG_DEFAULTS.autoStartOnMainIdle,
    statusVerbosity: raw.statusVerbosity ?? CONFIG_DEFAULTS.statusVerbosity,
    maxAttempts: toBoundedInt(raw.maxAttempts, CONFIG_DEFAULTS.maxAttempts, 1, 500),
    heartbeatMinutes: toBoundedInt(raw.heartbeatMinutes, CONFIG_DEFAULTS.heartbeatMinutes, 1, 240),
    strategistHandoffMinutes: toBoundedInt(
      raw.strategistHandoffMinutes,
      CONFIG_DEFAULTS.strategistHandoffMinutes,
      1,
      60
    ),
    strategistHandoffMaxRetries: toBoundedInt(
      raw.strategistHandoffMaxRetries,
      CONFIG_DEFAULTS.strategistHandoffMaxRetries,
      0,
      10
    ),
    verifyTimeoutMinutes: toBoundedInt(
      raw.verifyTimeoutMinutes,
      CONFIG_DEFAULTS.verifyTimeoutMinutes,
      0,
      240
    ),
    gateDestructiveToolsUntilContextLoaded:
      raw.gateDestructiveToolsUntilContextLoaded ??
      CONFIG_DEFAULTS.gateDestructiveToolsUntilContextLoaded,
    maxRlmSliceLines,
    requireGrepBeforeLargeSlice:
      raw.requireGrepBeforeLargeSlice ?? CONFIG_DEFAULTS.requireGrepBeforeLargeSlice,
    grepRequiredThresholdLines,
    subAgentEnabled: raw.subAgentEnabled ?? CONFIG_DEFAULTS.subAgentEnabled,
    maxSubAgents: toBoundedInt(raw.maxSubAgents, CONFIG_DEFAULTS.maxSubAgents, 1, 50),
    maxConversationLines: toBoundedInt(
      raw.maxConversationLines,
      CONFIG_DEFAULTS.maxConversationLines,
      200,
      20000
    ),
    conversationArchiveCount: toBoundedInt(
      raw.conversationArchiveCount,
      CONFIG_DEFAULTS.conversationArchiveCount,
      1,
      20
    ),
    reviewerEnabled: raw.reviewerEnabled ?? CONFIG_DEFAULTS.reviewerEnabled,
    reviewerRequireExplicitReady:
      raw.reviewerRequireExplicitReady ?? CONFIG_DEFAULTS.reviewerRequireExplicitReady,
    reviewerMaxRunsPerAttempt: toBoundedInt(
      raw.reviewerMaxRunsPerAttempt,
      CONFIG_DEFAULTS.reviewerMaxRunsPerAttempt,
      1,
      20
    ),
    reviewerOutputDir: raw.reviewerOutputDir?.trim() || CONFIG_DEFAULTS.reviewerOutputDir,
    reviewerPostToConversation:
      raw.reviewerPostToConversation ?? CONFIG_DEFAULTS.reviewerPostToConversation,
    agentMdPath: raw.agentMdPath ?? CONFIG_DEFAULTS.agentMdPath,
    swarm: resolveSwarmConfig(raw.swarm),
  };

  if (verify !== undefined) {
    resolved.verify = verify;
  }

  return resolved;
}

export async function loadConfig(worktree: string): Promise<ResolvedConfig> {
  const cfgPath = path.join(worktree, ".opencode", "ralph.json");
  if (!(await fileExists(cfgPath))) {
    return CONFIG_DEFAULTS;
  }

  const rawText = await readTextFile(cfgPath).catch(() => "{}");
  let json: unknown;
  try {
    json = JSON.parse(rawText) as unknown;
  } catch {
    throw new ConfigError("ralph.json is not valid JSON");
  }

  if (typeof json !== "object" || json === null) {
    return CONFIG_DEFAULTS;
  }

  return resolveConfig(json as RalphConfigInput);
}