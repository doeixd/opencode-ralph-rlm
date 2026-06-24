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

function missingKeyError(source: string): Error {
  return new Error(
    "No supervisor API key found. Ralph looks for one in this order: " +
      "RALPH_SUPERVISOR_API_KEY env, .opencode/ralph-provider.json, then your OpenCode auth " +
      "(~/.local/share/opencode/auth.json — a keyed provider like Google or OpenCode Zen). " +
      "Fixes: authenticate a provider in OpenCode (`opencode auth login`) and restart the provider, " +
      "or set RALPH_SUPERVISOR_API_KEY. (RALPH_TEST_MODE=1 gives scripted responses without an LLM.) " +
      `Resolved source: ${source}.`
  );
}

export async function callSupervisorLlm(
  config: SupervisorLlmConfig,
  messages: OpenAIChatMessage[],
  tools: OpenAIToolDefinition[],
  onToken?: (delta: string) => void
): Promise<LlmCompletionResult> {
  if (!config.apiKey) {
    throw missingKeyError(config.source);
  }

  // When the caller wants live tokens, request an upstream SSE stream and parse
  // deltas as they arrive; otherwise do a single buffered request.
  if (onToken) {
    return streamSupervisorLlm(config, messages, tools, onToken);
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

type StreamToolAcc = { id: string; name: string; arguments: string };

type StreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  error?: { message?: string };
};

/** Streaming variant: parses upstream OpenAI SSE, forwarding content deltas. */
async function streamSupervisorLlm(
  config: SupervisorLlmConfig,
  messages: OpenAIChatMessage[],
  tools: OpenAIToolDefinition[],
  onToken: (delta: string) => void
): Promise<LlmCompletionResult> {
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
      stream: true,
    }),
  });

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => "");
    let message = `LLM request failed (${response.status})`;
    try {
      const parsed = JSON.parse(errText) as OpenAIResponse;
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // non-JSON error body
    }
    throw new Error(message);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason = "stop";
  const toolAcc = new Map<number, StreamToolAcc>();

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(data) as StreamChunk;
    } catch {
      return;
    }
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    if (delta?.content) {
      content += delta.content;
      onToken(delta.content);
    }
    for (const call of delta?.tool_calls ?? []) {
      const idx = call.index ?? 0;
      const cur = toolAcc.get(idx) ?? { id: "", name: "", arguments: "" };
      if (call.id) cur.id = call.id;
      if (call.function?.name) cur.name = call.function.name;
      if (call.function?.arguments) cur.arguments += call.function.arguments;
      toolAcc.set(idx, cur);
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      handleLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer) handleLine(buffer);

  const toolCalls: LlmToolCall[] = [...toolAcc.values()]
    .filter((t) => t.name)
    .map((t, i) => ({
      id: t.id || `call_${i}`,
      name: t.name,
      arguments: t.arguments || "{}",
    }));

  return { content: content.trim(), toolCalls, finishReason };
}