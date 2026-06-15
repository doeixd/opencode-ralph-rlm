import { defineHandler, readBody } from "nitro/h3";
import {
  buildCompletionResponse,
  streamCompletionText,
  type OpenAIChatCompletionRequest,
} from "../../../lib/openai-compat.js";
import {
  assertValidSessionContext,
  resolveSessionContext,
} from "../../../lib/session-context.js";
import {
  buildSessionDebugSnapshot,
  isSessionDebugEnabled,
  logSessionDebug,
} from "../../../lib/session-debug.js";
import { resolveWorktree } from "../../../lib/worktree.js";
import { supervisorTurn } from "../../../lib/supervisor-agent.js";

export default defineHandler(async (event): Promise<Response> => {
  const body = await readBody<OpenAIChatCompletionRequest>(event);
  if (!body?.messages?.length) {
    return new Response(
      JSON.stringify({
        error: {
          message: "messages array is required",
          type: "invalid_request_error",
        },
      }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  const firstUser = body.messages.find((m) => m.role === "user");
  const firstUserText =
    typeof firstUser?.content === "string" ? firstUser.content : undefined;

  const session = resolveSessionContext(event, firstUserText);
  const worktree = resolveWorktree(session);

  if (isSessionDebugEnabled()) {
    logSessionDebug(buildSessionDebugSnapshot(session, event.req.headers));
  }

  try {
    assertValidSessionContext(session);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({
        error: { message, type: "invalid_request_error" },
      }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  let turn;
  try {
    turn = await supervisorTurn({
      sessionKey: session.sessionKey,
      worktree,
      messages: body.messages,
      ...(body.model ? { model: body.model } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({
        error: { message, type: "api_error" },
      }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  const headers = {
    "x-ralph-session-key": session.sessionKey,
    "x-ralph-session-source": session.source,
    "x-ralph-supervisor-mode": turn.mode,
  };

  if (body.stream) {
    const stream = streamCompletionText(body, turn.content);
    return new Response(stream, {
      headers: {
        ...headers,
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  const completion = buildCompletionResponse(body, turn.content);
  return new Response(JSON.stringify(completion), {
    headers: {
      ...headers,
      "content-type": "application/json",
    },
  });
});