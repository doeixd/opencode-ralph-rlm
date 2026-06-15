import type { OpencodeEventSubscription, OpencodeRuntime } from "@doeixd/opencode-ralph-rlm-engine";

export type ProviderMockRuntime = OpencodeRuntime & {
  emitIdle: (sessionId: string) => Promise<void>;
  spawnedWorkers: string[];
};

export function createProviderMockRuntime(): ProviderMockRuntime {
  let workerCounter = 0;
  let eventHandler: ((event: unknown) => void | Promise<void>) | undefined;

  const runtime: ProviderMockRuntime = {
    baseUrl: "mock://opencode",
    spawnedWorkers: [],
    client: {
      session: {
        create: async () => {
          workerCounter += 1;
          const id = `worker-${workerCounter}`;
          runtime.spawnedWorkers.push(id);
          return { data: { id } };
        },
        prompt: async () => {},
        abort: async () => {},
      },
      event: {
        subscribe: async () => ({
          stream: (async function* () {
            // events injected via emitIdle
          })(),
        }),
      },
      global: {
        health: async () => ({ data: { healthy: true, version: "mock" } }),
      },
    } as OpencodeRuntime["client"],
    async health() {
      return { healthy: true, version: "mock" };
    },
    async emitIdle(sessionId: string) {
      await eventHandler?.({
        type: "session.idle",
        properties: { sessionID: sessionId },
      });
    },
  };

  (runtime as ProviderMockRuntime & {
    _bindEvents: (handler: (event: unknown) => void | Promise<void>) => void;
  })._bindEvents = (handler) => {
    eventHandler = handler;
  };

  return runtime;
}

export function mockSubscribe(
  runtime: ProviderMockRuntime,
  onEvent: (event: unknown) => void | Promise<void>
): Promise<OpencodeEventSubscription> {
  const bind = (
    runtime as ProviderMockRuntime & {
      _bindEvents?: (handler: (event: unknown) => void | Promise<void>) => void;
    }
  )._bindEvents;
  bind?.(onEvent);
  return Promise.resolve({ stop: () => {} });
}