import { describe, expect, test, afterEach } from "bun:test";
import { callSupervisorLlm } from "../lib/llm-client.js";
import type { SupervisorLlmConfig } from "../lib/supervisor-config.js";

const config: SupervisorLlmConfig = {
  baseUrl: "https://example.test/v1",
  apiKey: "test-key",
  model: "test-model",
  maxToolRounds: 12,
  source: "env",
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockSse(lines: unknown[]): void {
  const text =
    lines.map((o) => `data: ${JSON.stringify(o)}\n\n`).join("") + "data: [DONE]\n\n";
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Split into two writes to exercise cross-chunk buffering.
      const mid = Math.floor(text.length / 2);
      const enc = new TextEncoder();
      controller.enqueue(enc.encode(text.slice(0, mid)));
      controller.enqueue(enc.encode(text.slice(mid)));
      controller.close();
    },
  });
  globalThis.fetch = (async () =>
    new Response(body, { status: 200 })) as typeof fetch;
}

describe("callSupervisorLlm streaming (onToken)", () => {
  test("forwards content deltas and accumulates the message", async () => {
    mockSse([
      { choices: [{ delta: { content: "Hello" } }] },
      { choices: [{ delta: { content: " world" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);

    const tokens: string[] = [];
    const result = await callSupervisorLlm(config, [], [], (t) => tokens.push(t));

    expect(tokens).toEqual(["Hello", " world"]);
    expect(result.content).toBe("Hello world");
    expect(result.toolCalls).toHaveLength(0);
    expect(result.finishReason).toBe("stop");
  });

  test("reassembles tool calls streamed across deltas", async () => {
    mockSse([
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "start_loop", arguments: "" } }] } },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"goal"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"x"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);

    const result = await callSupervisorLlm(config, [], [], () => {});

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual({
      id: "call_1",
      name: "start_loop",
      arguments: '{"goal":"x"}',
    });
    expect(result.finishReason).toBe("tool_calls");
  });

  test("throws a clear error when no api key (before any fetch)", async () => {
    await expect(
      callSupervisorLlm({ ...config, apiKey: "" }, [], [], () => {})
    ).rejects.toThrow(/No supervisor API key/);
  });
});
