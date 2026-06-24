import path from "node:path";
import { readTextFile, fileExists } from "@doeixd/opencode-ralph-rlm-engine";
import { detectOpencodeSupervisorCreds } from "./opencode-auth.js";

export type SupervisorLlmConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxToolRounds: number;
  /** Where the credentials came from: "env" | "file" | "opencode-auth:<provider>" | "default". */
  source: string;
};

export type ProviderConfigFile = {
  supervisor?: {
    baseUrl?: string;
    apiKey?: string;
    modelID?: string;
    model?: string;
    maxToolRounds?: number;
  };
};

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";

export function isTestMode(): boolean {
  const raw = process.env.RALPH_TEST_MODE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export async function loadSupervisorLlmConfig(
  worktree: string
): Promise<SupervisorLlmConfig> {
  const fileConfig = await readProviderConfigFile(worktree);

  const envKey = process.env.RALPH_SUPERVISOR_API_KEY?.trim();
  const fileKey = fileConfig.supervisor?.apiKey?.trim();

  // If no key is configured via env or ralph-provider.json, fall back to
  // OpenCode's own auth (a keyed provider you've already authenticated), so the
  // supervisor works without a separate RALPH_SUPERVISOR_API_KEY.
  const auto = !envKey && !fileKey ? await detectOpencodeSupervisorCreds() : null;

  const baseUrl =
    process.env.RALPH_SUPERVISOR_BASE_URL?.trim() ||
    fileConfig.supervisor?.baseUrl?.trim() ||
    auto?.baseUrl ||
    DEFAULT_BASE_URL;

  const apiKey = envKey || fileKey || auto?.apiKey || "";

  const model =
    process.env.RALPH_SUPERVISOR_MODEL?.trim() ||
    fileConfig.supervisor?.modelID?.trim() ||
    fileConfig.supervisor?.model?.trim() ||
    auto?.model ||
    DEFAULT_MODEL;

  const source = envKey
    ? "env"
    : fileKey
      ? "file"
      : auto
        ? auto.source
        : "default";

  const maxToolRounds = toBoundedInt(
    fileConfig.supervisor?.maxToolRounds ??
      Number(process.env.RALPH_SUPERVISOR_MAX_TOOL_ROUNDS),
    8,
    1,
    24
  );

  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey, model, maxToolRounds, source };
}

async function readProviderConfigFile(worktree: string): Promise<ProviderConfigFile> {
  const candidates = [
    path.join(worktree, "ralph-provider.json"),
    path.join(worktree, ".opencode", "ralph-provider.json"),
  ];

  for (const candidate of candidates) {
    if (!(await fileExists(candidate))) continue;
    try {
      const raw = await readTextFile(candidate);
      const parsed = JSON.parse(raw) as ProviderConfigFile;
      return parsed;
    } catch {
      return {};
    }
  }

  return {};
}

function toBoundedInt(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const n = Math.trunc(value);
  return Math.min(max, Math.max(min, n));
}