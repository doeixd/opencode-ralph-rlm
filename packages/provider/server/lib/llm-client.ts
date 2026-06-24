import type { OpenAIChatMessage } from "./openai-compat.js";
import type { OpenAIToolDefinition } from "./supervisor-tools.js";
import type { SupervisorLlmConfig } from "./supervisor-config.js";

export type LlmToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type LlmCompletionResult = {
  content: string;
  toolCalls: LlmToolCall[];
  finishReason: string;
};

type OpenAIResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string;
  }>;
  error?: { message?: string };
};

export async function callSupervisorLlm(
  config: SupervisorLlmConfig,
  messages: OpenAIChatMessage[],
  tools: OpenAIToolDefinition[]
): Promise<LlmCompletionResult> {
  if (!config.apiKey) {
    throw new Error(
      "No supervisor API key found. Ralph looks for one in this order: " +
        "RALPH_SUPERVISOR_API_KEY env, .opencode/ralph-provider.json, then your OpenCode auth " +
        "(~/.local/share/opencode/auth.json — a keyed provider like Google or OpenCode Zen). " +
        "Fixes: authenticate a provider in OpenCode (`opencode auth login`) and restart the provider, " +
        "or set RALPH_SUPERVISOR_API_KEY. (RALPH_TEST_MODE=1 gives scripted responses without an LLM.) " +
        `Resolved source: ${config.source}.`
    );
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0.2,
    }),
  });

  const body = (await response.json()) as OpenAIResponse;
  if (!response.ok) {
    throw new Error(body.error?.message ?? `LLM request failed (${response.status})`);
  }

  const choice = body.choices?.[0];
  const message = choice?.message;
  const toolCalls: LlmToolCall[] = [];

  for (const call of message?.tool_calls ?? []) {
    toolCalls.push({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    });
  }

  return {
    content: message?.content?.trim() ?? "",
    toolCalls,
    finishReason: choice?.finish_reason ?? "stop",
  };
}