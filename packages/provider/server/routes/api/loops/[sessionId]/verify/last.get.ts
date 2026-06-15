import { defineHandler } from "nitro/h3";
import { getSessionIdFromEvent, requireEngine } from "../../../../../lib/loops-api.js";

/** OpenAPI: GET /api/loops/:sessionId/verify/last */
export default defineHandler(async (event) => {
  const sessionId = getSessionIdFromEvent(event);
  const { engine, status } = await requireEngine(event, sessionId);

  if (!engine || !status) {
    return { ok: false, sessionId, error: "No active loop for this session." };
  }

  if (!status.lastVerify) {
    return { ok: false, sessionId, error: "No verify run recorded yet." };
  }

  return {
    ok: true,
    sessionId,
    lastVerify: status.lastVerify,
  };
});