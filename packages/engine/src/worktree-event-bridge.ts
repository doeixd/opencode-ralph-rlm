import {
  subscribeOpencodeEvents,
  type OpencodeEventSubscription,
  type OpencodeRuntime,
} from "./opencode-client.js";

export type WorktreeEventHandler = (event: unknown) => void | Promise<void>;

/**
 * Fan-out hub for OpenCode `event.subscribe` streams keyed by worktree directory.
 * One SDK subscription per worktree; loop and swarm engines share it via ref-counted consumers.
 */
export class WorktreeEventBridge {
  private readonly consumers = new Set<WorktreeEventHandler>();
  private subscription: OpencodeEventSubscription | undefined;
  private starting: Promise<void> | undefined;

  constructor(
    private readonly worktree: string,
    private readonly runtime: OpencodeRuntime,
    private readonly registryKey: string
  ) {}

  async subscribe(handler: WorktreeEventHandler): Promise<OpencodeEventSubscription> {
    this.consumers.add(handler);
    await this.ensureStarted();

    let stopped = false;
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        this.consumers.delete(handler);
        if (this.consumers.size === 0) {
          this.stopSubscription();
          bridgeByWorktree.delete(this.registryKey);
        }
      },
    };
  }

  get consumerCount(): number {
    return this.consumers.size;
  }

  private async ensureStarted(): Promise<void> {
    if (this.subscription) return;
    if (this.starting) {
      await this.starting;
      return;
    }

    this.starting = (async () => {
      this.subscription = await subscribeOpencodeEvents(
        this.runtime,
        (event) => {
          for (const handler of this.consumers) {
            void Promise.resolve(handler(event)).catch(() => {});
          }
        },
        { directory: this.worktree }
      );
    })();

    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private stopSubscription(): void {
    this.subscription?.stop();
    this.subscription = undefined;
  }

  dispose(): void {
    this.consumers.clear();
    this.stopSubscription();
    bridgeByWorktree.delete(this.registryKey);
  }
}

const bridgeByWorktree = new Map<string, WorktreeEventBridge>();

/** Returns a shared event bridge for the given worktree (one per normalized path). */
export function getWorktreeEventBridge(
  worktree: string,
  runtime: OpencodeRuntime
): WorktreeEventBridge {
  const key = worktree.replace(/\\/g, "/");
  let bridge = bridgeByWorktree.get(key);
  if (!bridge) {
    bridge = new WorktreeEventBridge(worktree, runtime, key);
    bridgeByWorktree.set(key, bridge);
  }
  return bridge;
}

/** Subscribe to OpenCode events through the shared worktree bridge. */
export function subscribeWorktreeEvents(
  worktree: string,
  runtime: OpencodeRuntime,
  handler: WorktreeEventHandler
): Promise<OpencodeEventSubscription> {
  return getWorktreeEventBridge(worktree, runtime).subscribe(handler);
}

/** Test helper — tear down all bridges. */
export function disposeAllWorktreeEventBridges(): void {
  for (const bridge of bridgeByWorktree.values()) {
    bridge.dispose();
  }
  bridgeByWorktree.clear();
}