import path from "node:path";
import { fileExists, readTextFile } from "./fs.js";
import type { EngineTemplates } from "./templates.js";

/**
 * OpenCode agent workers run under. A dedicated agent (defined by the worker
 * plugin's `config` hook) lets us hide the `ralph_*` / `rlm_*` tools from normal
 * sessions (denied globally) while re-allowing them here.
 */
export const RALPH_WORKER_AGENT = "ralph-worker";

export type WorkerSpawnConfig = {
  agent: string;
  systemPrompt: string;
  providerID?: string;
  modelID?: string;
};

type ProviderFile = {
  worker?: {
    agent?: string;
    providerID?: string;
    modelID?: string;
    systemPrompt?: string;
  };
};

export async function loadWorkerSpawnConfig(
  worktree: string,
  templates: EngineTemplates
): Promise<WorkerSpawnConfig> {
  const fromEnv = {
    agent: process.env.RALPH_WORKER_AGENT?.trim(),
    providerID: process.env.RALPH_WORKER_PROVIDER_ID?.trim(),
    modelID: process.env.RALPH_WORKER_MODEL_ID?.trim(),
    systemPrompt: process.env.RALPH_WORKER_SYSTEM_PROMPT?.trim(),
  };

  const file = await readProviderFile(worktree);
  const worker = file.worker ?? {};

  const systemPrompt =
    fromEnv.systemPrompt ||
    worker.systemPrompt?.trim() ||
    templates.workerSystemPrompt;

  const config: WorkerSpawnConfig = {
    agent: fromEnv.agent || worker.agent?.trim() || RALPH_WORKER_AGENT,
    systemPrompt,
  };

  const providerID = fromEnv.providerID || worker.providerID?.trim();
  const modelID = fromEnv.modelID || worker.modelID?.trim();
  // The worker must never run on the supervisor's own provider — that turns the
  // worker session into a second supervisor (it orchestrates instead of coding).
  if (providerID === "ralph-rlm") {
    throw new Error(
      "Worker model is configured to use the 'ralph-rlm' provider (the supervisor). " +
        "Workers must run a real coding model — set worker.providerID / worker.modelID in " +
        ".opencode/ralph-provider.json (e.g. \"opencode\" / \"deepseek-v4-flash-free\"), or the " +
        "RALPH_WORKER_PROVIDER_ID / RALPH_WORKER_MODEL_ID env vars."
    );
  }
  if (providerID && modelID) {
    config.providerID = providerID;
    config.modelID = modelID;
  }

  return config;
}

async function readProviderFile(worktree: string): Promise<ProviderFile> {
  const candidates = [
    path.join(worktree, "ralph-provider.json"),
    path.join(worktree, ".opencode", "ralph-provider.json"),
  ];

  for (const candidate of candidates) {
    if (!(await fileExists(candidate))) continue;
    try {
      const raw = await readTextFile(candidate);
      return JSON.parse(raw) as ProviderFile;
    } catch {
      return {};
    }
  }

  return {};
}