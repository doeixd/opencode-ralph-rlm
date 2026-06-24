import os from "node:os";
import path from "node:path";
import { fileExists, readTextFile } from "@doeixd/opencode-ralph-rlm-engine";

/**
 * Best-effort discovery of supervisor LLM credentials from OpenCode's own auth
 * store (`~/.local/share/opencode/auth.json`), so an OpenCode user who has a
 * keyed provider authenticated does NOT also need to set RALPH_SUPERVISOR_API_KEY.
 *
 * Only providers with a static API key (`type: "api"`) and a known
 * OpenAI-compatible endpoint are used. OAuth providers (e.g. ChatGPT/Anthropic
 * login) are skipped — their tokens are not API keys. Env / ralph-provider.json
 * always take precedence over this; it is a fallback only.
 */

export type DetectedSupervisorCreds = {
  baseUrl: string;
  apiKey: string;
  model: string;
  source: string;
};

/**
 * Known OpenAI-compatible endpoints + a sensible (tool-calling capable) default
 * model per provider. Endpoints and model ids confirmed against the live
 * OpenCode provider registry (`/config/providers`) and provider docs:
 * - OpenCode Zen gateway uses OPENCODE_API_KEY; free models (`*-free`) are $0.
 * - Google Gemini exposes an OpenAI-compatible endpoint; key = GEMINI_API_KEY.
 */
const PROVIDER_ENDPOINTS: Record<string, { baseUrl: string; model: string }> = {
  // OpenCode Zen — free model (same gateway/key as opencode-go).
  opencode: { baseUrl: "https://opencode.ai/zen/v1", model: "deepseek-v4-flash-free" },
  "opencode-go": { baseUrl: "https://opencode.ai/zen/v1", model: "deepseek-v4-flash-free" },
  // Google Gemini OpenAI-compatible endpoint.
  google: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
  },
  // OpenAI (only used if stored as a static api key, not OAuth).
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-5.4-mini" },
};

/** Order to prefer when several keyed providers are available (free Zen first). */
const PROVIDER_PRIORITY = ["opencode", "opencode-go", "google", "openai"];

function authFilePath(): string {
  const override = process.env.RALPH_OPENCODE_AUTH_PATH?.trim();
  if (override) return override;
  const base = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
  return path.join(base, "opencode", "auth.json");
}

type AuthEntry = { type?: string; key?: string };

export async function detectOpencodeSupervisorCreds(): Promise<DetectedSupervisorCreds | null> {
  const file = authFilePath();
  if (!(await fileExists(file))) return null;

  let auth: Record<string, AuthEntry>;
  try {
    auth = JSON.parse(await readTextFile(file)) as Record<string, AuthEntry>;
  } catch {
    return null;
  }

  for (const provider of PROVIDER_PRIORITY) {
    const entry = auth[provider];
    const endpoint = PROVIDER_ENDPOINTS[provider];
    if (!entry || !endpoint) continue;
    if (entry.type !== "api") continue; // only static API keys
    const key = entry.key?.trim();
    if (!key) continue;
    return {
      baseUrl: endpoint.baseUrl,
      apiKey: key,
      model: endpoint.model,
      source: `opencode-auth:${provider}`,
    };
  }

  return null;
}
