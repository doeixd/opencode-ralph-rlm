import { defineHandler, readBody } from "nitro/h3";
import {
  buildCompletionResponse,
  encodeSseChunk,
  makeCompletionId,
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
import { supervisorTurn, supervisorTurnStreaming } from "../../../lib/supervisor-agent.js";

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

  const baseHeaders = {
    "x-ralph-session-key": session.sessionKey,
    "x-ralph-session-source": session.source,
  };

  const turnInput = {
    sessionKey: session.sessionKey,
    worktree,
    messages: body.messages,
    ...(body.model ? { model: body.model } : {}),
  };

  // Streaming: emit live progress markers as the turn's tool rounds run (the
  // slow part), then stream the final answer — instead of blocking until the
  // whole turn finishes and dumping it at once.
  if (body.stream) {
    const id = makeCompletionId();
    const model = body.model ?? "ralph-rlm/supervisor";
    const created = Math.floor(Date.now() / 1000);
    const encoder = new TextEncoder();
    const delta = (content: string) =>
      encoder.encode(
        encodeSseChunk({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: { content }, finish_reason: null }],
        })
      );

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        // An immediate keep-alive delta so the client shows activity at once.
        controller.enqueue(delta(""));
        try {
          const turn = await supervisorTurnStreaming(turnInput, (text) =>
            controller.enqueue(delta(text))
          );
          for (const piece of (turn.content || "Done.").split(/(\s+)/)) {
            if (piece) controller.enqueue(delta(piece));
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          controller.enqueue(delta(`\n\n[error] ${message}`));
        }
        controller.enqueue(
          encoder.encode(
            encodeSseChunk({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })
          )
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        ...baseHeaders,
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  let turn;
  try {
    turn = await supervisorTurn(turnInput);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({
        error: { message, type: "api_error" },
      }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  const completion = buildCompletionResponse(body, turn.content);
  return new Response(JSON.stringify(completion), {
    headers: {
      ...baseHeaders,
      "x-ralph-supervisor-mode": turn.mode,
      "content-type": "application/json",
    },
  });
});