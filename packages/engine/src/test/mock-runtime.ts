import type { OpencodeEventSubscription, OpencodeRuntime } from "../opencode-client.js";

export type MockRuntime = OpencodeRuntime & {
  emitIdle: (sessionId: string) => Promise<void>;
  emitEvent: (event: unknown) => Promise<void>;
  spawnedWorkers: string[];
  failNextPrompt: boolean;
};

export function createMockRuntime(): MockRuntime {
  let workerCounter = 0;
  let eventHandler: ((event: unknown) => void | Promise<void>) | undefined;
  const streamConsumers: Array<(event: unknown) => void> = [];

  async function broadcast(event: unknown): Promise<void> {
    await eventHandler?.(event);
    for (const consumer of streamConsumers) {
      consumer(event);
    }
  }

  const runtime: MockRuntime = {
    baseUrl: "mock://opencode",
    spawnedWorkers: [],
    failNextPrompt: false,
    client: {
      session: {
        create: async ({ title }: { title?: string }) => {
          workerCounter += 1;
          const id = `worker-${workerCounter}`;
          runtime.spawnedWorkers.push(id);
          return { data: { id, title } };
        },
        prompt: async () => {
          if (runtime.failNextPrompt) {
            runtime.failNextPrompt = false;
            throw new Error("mock prompt failure");
          }
        },
        abort: async () => {},
      },
      event: {
        subscribe: async () => {
          const queue: unknown[] = [];
          let wake: (() => void) | undefined;
          const push = (event: unknown) => {
            queue.push(event);
            wake?.();
            wake = undefined;
          };
          streamConsumers.push(push);

          return {
            stream: (async function* () {
              try {
                while (streamConsumers.includes(push)) {
                  if (queue.length > 0) {
                    const next = queue.shift();
                    if (next !== undefined) yield next;
                    continue;
                  }
                  await new Promise<void>((resolve) => {
                    wake = resolve;
                  });
                }
              } finally {
                const index = streamConsumers.indexOf(push);
                if (index >= 0) streamConsumers.splice(index, 1);
              }
            })(),
          };
        },
      },
      global: {
        health: async () => ({ data: { healthy: true, version: "mock" } }),
      },
    } as OpencodeRuntime["client"],
    async health() {
      return { healthy: true, version: "mock" };
    },
    async emitIdle(sessionId: string) {
      await broadcast({
        type: "session.idle",
        properties: { sessionID: sessionId },
      });
    },
    async emitEvent(event: unknown) {
      await broadcast(event);
    },
  };

  (runtime as MockRuntime & {
    _bindEvents: (handler: (event: unknown) => void | Promise<void>) => void;
  })._bindEvents = (handler) => {
    eventHandler = handler;
  };

  return runtime;
}

export function mockSubscribe(
  runtime: MockRuntime,
  onEvent: (event: unknown) => void | Promise<void>
): Promise<OpencodeEventSubscription> {
  const bind = (
    runtime as MockRuntime & {
      _bindEvents?: (handler: (event: unknown) => void | Promise<void>) => void;
    }
  )._bindEvents;
  bind?.(onEvent);
  return Promise.resolve({ stop: () => {} });
}