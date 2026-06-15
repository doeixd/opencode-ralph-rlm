import { defineHandler } from "nitro/h3";
import { getSessionIdFromEvent, requireEngine } from "../../../../lib/loops-api.js";

/** OpenAPI: POST /api/loops/:sessionId/resume */
export default defineHandler(async (event) => {
  const sessionId = getSessionIdFromEvent(event);
  const { engine } = await requireEngine(event, sessionId);

  if (!engine) {
    return { ok: false, sessionId, error: "No active loop for this session." };
  }

  await engine.resume();
  return { ok: true, sessionId, status: await engine.status() };
});