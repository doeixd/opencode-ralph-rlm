import { defineHandler } from "nitro/h3";
import { getOpencodeRuntime } from "../../lib/runtime.js";
import { isTestMode, loadSupervisorLlmConfig } from "../../lib/supervisor-config.js";

/** OpenAPI: GET /api/health — provider + OpenCode connectivity + supervisor readiness */
export default defineHandler(async () => {
  const runtime = getOpencodeRuntime();
  const worktree = process.env.RALPH_WORKTREE?.trim() || process.cwd();
  const [opencode, supervisor] = await Promise.all([
    runtime.health(),
    loadSupervisorLlmConfig(worktree),
  ]);

  const supervisorReady = supervisor.apiKey.length > 0 || isTestMode();

  return {
    healthy: true,
    provider: "@doeixd/opencode-ralph-rlm",
    version: "0.3.0",
    opencode: {
      baseUrl: runtime.baseUrl,
      ...opencode,
    },
    supervisor: {
      ready: supervisorReady,
      model: supervisor.model,
      baseUrl: supervisor.baseUrl,
      source: supervisor.source,
      ...(supervisorReady
        ? {}
        : {
            hint: "No supervisor API key found (env RALPH_SUPERVISOR_API_KEY, .opencode/ralph-provider.json, or OpenCode auth). Authenticate a provider in OpenCode or set a key before delegating goals.",
          }),
    },
  };
});