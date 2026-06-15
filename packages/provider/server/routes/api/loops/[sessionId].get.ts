import { defineHandler } from "nitro/h3";
import { getSessionIdFromEvent, requireEngine } from "../../../lib/loops-api.js";

/** OpenAPI: GET /api/loops/:sessionId — full loop status */
export default defineHandler(async (event) => {
  const sessionId = getSessionIdFromEvent(event);
  const { engine, worktree, status } = await requireEngine(event, sessionId);

  if (!engine || !status) {
    return {
      ok: false,
      sessionId,
      error: "No active loop for this session.",
    };
  }

  return {
    ok: true,
    sessionId,
    worktree,
    status,
  };
});