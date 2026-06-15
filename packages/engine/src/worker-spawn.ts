import path from "node:path";
import { fileExists, readTextFile } from "./fs.js";
import type { EngineTemplates } from "./templates.js";

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
    agent: fromEnv.agent || worker.agent?.trim() || "build",
    systemPrompt,
  };

  const providerID = fromEnv.providerID || worker.providerID?.trim();
  const modelID = fromEnv.modelID || worker.modelID?.trim();
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