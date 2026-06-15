import { defineHandler } from "nitro/h3";
import { getOpencodeRuntime } from "../../lib/runtime.js";

/** OpenAPI: GET /api/health — provider + OpenCode connectivity */
export default defineHandler(async () => {
  const runtime = getOpencodeRuntime();
  const opencode = await runtime.health();

  return {
    healthy: true,
    provider: "@ralph-rlm/provider",
    version: "0.2.0",
    opencode: {
      baseUrl: runtime.baseUrl,
      ...opencode,
    },
  };
});