export type OpenAIToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type OpenAIChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
};

export type OpenAIChatCompletionRequest = {
  model?: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
};

export type OpenAIChatCompletionChoice = {
  index: number;
  message: {
    role: "assistant";
    content: string;
  };
  finish_reason: "stop" | "length" | "tool_calls";
};

export type OpenAIChatCompletionResponse = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChatCompletionChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type OpenAIModelsResponse = {
  object: "list";
  data: Array<{
    id: string;
    object: "model";
    created: number;
    owned_by: string;
  }>;
};

export function makeCompletionId(): string {
  return `chatcmpl-ralph-${Date.now().toString(36)}`;
}

export function buildCompletionResponse(
  request: OpenAIChatCompletionRequest,
  content: string
): OpenAIChatCompletionResponse {
  return {
    id: makeCompletionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: request.model ?? "ralph-rlm/supervisor",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

export function encodeSseChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function streamCompletionText(
  request: OpenAIChatCompletionRequest,
  text: string
): ReadableStream<Uint8Array> {
  const id = makeCompletionId();
  const model = request.model ?? "ralph-rlm/supervisor";
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      const words = text.split(/(\s+)/);
      let index = 0;

      const push = () => {
        if (index >= words.length) {
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
          return;
        }

        const piece = words[index] ?? "";
        index += 1;
        controller.enqueue(
          encoder.encode(
            encodeSseChunk({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
            })
          )
        );
        push();
      };

      push();
    },
  });
}