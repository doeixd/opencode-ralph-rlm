import { defineHandler, readBody } from "nitro/h3";
import { getSessionIdFromEvent, requireEngine } from "../../../../lib/loops-api.js";

/** OpenAPI: POST /api/loops/:sessionId/stop */
export default defineHandler(async (event) => {
  const sessionId = getSessionIdFromEvent(event);
  const { engine } = await requireEngine(event, sessionId);

  if (!engine) {
    return { ok: false, sessionId, error: "No active loop for this session." };
  }

  const body = (await readBody<{ reason?: string }>(event).catch(() => undefined)) ?? {};
  const reason = typeof body.reason === "string" ? body.reason : undefined;
  await engine.stop(reason);

  return { ok: true, sessionId, stopped: true, status: await engine.status() };
});