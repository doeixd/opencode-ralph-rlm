/** Default cap on queued OpenCode events per loop/swarm runner (prevents unbounded memory growth). */
export const DEFAULT_MAX_EVENT_QUEUE_SIZE = 10_000;

/**
 * Serializes async event processing. Concurrent `push` callers each await full drain
 * completion (no lost wakeups). Replaces recursive `drainQueue` patterns that could
 * return early while another drain was in flight.
 */
export function createAsyncEventQueue(
  processor: (event: unknown) => Promise<void>,
  maxSize = DEFAULT_MAX_EVENT_QUEUE_SIZE
): {
  push: (event: unknown) => Promise<void>;
  readonly size: number;
} {
  const events: unknown[] = [];
  let tail: Promise<void> = Promise.resolve();

  async function flush(): Promise<void> {
    while (events.length > 0) {
      const event = events.shift();
      if (event === undefined) continue;
      await processor(event);
    }
  }

  function push(event: unknown): Promise<void> {
    if (events.length >= maxSize) {
      return Promise.reject(
        new Error(`Event queue overflow (max ${maxSize} events). Possible event storm.`)
      );
    }
    events.push(event);
    tail = tail.then(flush);
    return tail;
  }

  return {
    push,
    get size() {
      return events.length;
    },
  };
}