import { defineHandler, readBody } from "nitro/h3";
import { getSessionIdFromEvent, requireEngine } from "../../../../lib/loops-api.js";
import { injectSupervisorMessage } from "../../../../lib/supervisor-message.js";

type MessageBody = {
  message?: string;
  source?: string;
  toast?: boolean;
  runTurn?: boolean;
};

/** OpenAPI: POST /api/loops/:sessionId/message — inject an out-of-band message to the supervisor. */
export default defineHandler(async (event) => {
  const sessionId = getSessionIdFromEvent(event);
  const body = await readBody<MessageBody>(event);
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) {
    return { ok: false, sessionId, error: "message is required" };
  }

  const { engine, worktree } = await requireEngine(event, sessionId);
  const targetWorktree = engine?.state.worktree ?? worktree;

  const result = await injectSupervisorMessage({
    sessionKey: sessionId,
    worktree: targetWorktree,
    message,
    ...(typeof body?.source === "string" ? { source: body.source } : {}),
    ...(typeof body?.toast === "boolean" ? { toast: body.toast } : {}),
    ...(typeof body?.runTurn === "boolean" ? { runTurn: body.runTurn } : {}),
  });

  return { ok: true, sessionId, ...result };
});
