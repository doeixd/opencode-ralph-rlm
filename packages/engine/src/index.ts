export {
  CONFIG_DEFAULTS,
  loadConfig,
  readRawConfig,
  updateRawConfig,
  resolveConfig,
  isSwarmUnsafeEvalEnabled,
  type RalphConfigInput,
  type FffConfigInput,
  type ResolvedConfig,
  type ResolvedFffConfig,
  type ResolvedSwarmConfig,
  type SwarmConfigInput,
  type SwarmScriptRunner,
  type StatusVerbosity,
  type VerifyConfig,
} from "./config.js";

export {
  clearFffSearchCache,
  fffFileSearch,
  fffGlob,
  fffGrep,
  getFffAvailability,
  type FffLoader,
  type FffSearchOptions,
  type FffUnavailable,
  type NormalizedFileSearchItem,
  type NormalizedFileSearchResult,
  type NormalizedGlobResult,
  type NormalizedGrepResult,
} from "./fff-search.js";

export {
  FileError,
  PatchError,
  ConfigError,
  readTextFile,
  writeTextFile,
  appendTextFile,
  fileExists,
  ensureTextFile,
} from "./fs.js";

export {
  clampLines,
  interpolate,
  nowISO,
  extractHeadings,
  regexFromQuery,
} from "./text.js";

export {
  DEFAULT_TEMPLATES,
  buildWorkerPrompt,
  PLAN_GOAL_PLACEHOLDER,
  PLAN_DOD_PLACEHOLDER,
  type EngineTemplates,
} from "./templates.js";

export {
  PROTOCOL_FILES,
  bootstrapProtocolFiles,
  isPlanAuthored,
  writePlanFile,
  applyPatch,
  applyProtocolPatch,
  loadPlanContext,
  type BootstrapOptions,
  type ProtocolFileName,
} from "./protocol-files.js";

export {
  resolvePlansConfig,
  resolvePlanContext,
  readActivePlan,
  writeActivePlan,
  listPlans,
  normalizePlanName,
  protocolFilePath,
  stateFilePath,
  DEFAULT_PLANS_DIR,
  DEFAULT_PLAN_NAME,
  type PlansConfigInput,
  type ResolvedPlansConfig,
  type PlansMode,
  type PlanContext,
} from "./plan-paths.js";

export {
  runCommand,
  runVerify,
  runAndParseVerify,
  parseVerifyResult,
  formatVerifyJson,
  stopAllVerifyCommands,
  type VerifyVerdict,
  type VerifyResult,
  type ParsedVerify,
} from "./verify.js";

export { rolloverState, writeDoneFile } from "./rollover.js";

export {
  createLoopRunState,
  toLoopStatus,
  type LoopRunConfig,
  type LoopRunState,
  type LoopStatus,
  type LoopOutcome,
  type LastVerifySnapshot,
} from "./loop-run.js";

export {
  LOOP_ATTEMPT_REL_PATH,
  writeLoopAttemptMarker,
  readLoopAttemptMarker,
  type LoopAttemptMarker,
} from "./loop-attempt.js";

export {
  createAsyncEventQueue,
  DEFAULT_MAX_EVENT_QUEUE_SIZE,
} from "./async-event-queue.js";

export {
  WorktreeEventBridge,
  getWorktreeEventBridge,
  subscribeWorktreeEvents,
  disposeAllWorktreeEventBridges,
  type WorktreeEventHandler,
} from "./worktree-event-bridge.js";

export {
  LoopEventBus,
  type LoopEventName,
  type LoopEventPayload,
  type LoopEventHandler,
} from "./loop-events.js";

export {
  createOpencodeRuntime,
  subscribeOpencodeEvents,
  extractSessionIdFromEvent,
  type OpencodeRuntime,
  type OpencodeRuntimeOptions,
  type OpencodeEventSubscription,
} from "./opencode-client.js";

export {
  createLoopEngine,
  createDefaultLoopEngine,
  type LoopEngine,
  type LoopEngineOptions,
} from "./loop-engine.js";

export { LoopRegistry } from "./loop-registry.js";

export {
  createSwarmRunner,
  newSwarmId,
  validateSpawnSwarmInput,
  type SwarmRunner,
  type SwarmRunnerOptions,
} from "./swarm-runner.js";

export { SwarmRegistry } from "./swarm-registry.js";

export {
  SwarmEventBus,
  type SwarmEventName,
  type SwarmEventPayload,
  type SwarmEventHandler,
} from "./swarm-events.js";

export {
  createSwarmTasks,
  toSwarmStatus,
  type SpawnSwarmInput,
  type SwarmRunConfig,
  type SwarmRunState,
  type SwarmStatus,
  type SwarmTask,
  type SwarmTaskInput,
  type SwarmTaskStatus,
  type SwarmWaitPolicy,
} from "./swarm-run.js";

export {
  runSwarmScript,
  isUnsafeEvalAllowed,
  type SwarmScriptRunInput,
  type SwarmScriptRunResult,
} from "./swarm-script-runner.js";

export {
  loadWorkerSpawnConfig,
  RALPH_WORKER_AGENT,
  type WorkerSpawnConfig,
} from "./worker-spawn.js";

export {
  PENDING_INPUT_REL_PATH,
  readPendingInput,
  writePendingInput,
  listUnansweredQuestions,
  addPendingAnswer,
  type PendingInputData,
  type PendingQuestion,
  type PendingAnswer,
} from "./pending-input.js";

export {
  detectProjectDefaults,
  checkSetup,
  runDoctor,
  formatDoctorReport,
  type SetupDiagnostics,
  type DoctorReport,
} from "./doctor.js";

export {
  setupProject,
  formatSetupResult,
  type SetupAction,
  type SetupActionStatus,
  type SetupOptions,
  type SetupResult,
} from "./setup.js";
