import {
  createSwarmRunner,
  newSwarmId,
  validateSpawnSwarmInput,
  type SwarmRunner,
  type SwarmRunnerOptions,
} from "./swarm-runner.js";
import type { SpawnSwarmInput, SwarmRunConfig, SwarmStatus } from "./swarm-run.js";
import type { SwarmEventHandler, SwarmEventName } from "./swarm-events.js";

/** Session-scoped registry of active and recently finished swarm runs. */
export class SwarmRegistry {
  private readonly runners = new Map<string, SwarmRunner>();
  private readonly bySession = new Map<string, Set<string>>();

  get(swarmId: string): SwarmRunner | undefined {
    return this.runners.get(swarmId);
  }

  listForSession(sessionKey: string): SwarmStatus[] {
    const ids = this.bySession.get(sessionKey);
    if (!ids) return [];
    return [...ids]
      .map((id) => this.runners.get(id)?.status())
      .filter((status): status is SwarmStatus => status !== undefined);
  }

  listAll(): SwarmStatus[] {
    return [...this.runners.values()].map((runner) => runner.status());
  }

  async spawn(
    sessionKey: string,
    worktree: string,
    input: SpawnSwarmInput,
    options: SwarmRunnerOptions,
    swarmId = newSwarmId()
  ): Promise<SwarmRunner> {
    const validationError = validateSpawnSwarmInput(input);
    if (validationError) {
      throw new Error(validationError);
    }

    const config: SwarmRunConfig = {
      swarmId,
      sessionKey,
      worktree,
      input,
    };

    const runner = createSwarmRunner(config, options);
    this.runners.set(swarmId, runner);

    const prune = () => {
      this.remove(swarmId);
    };
    runner.on("swarm.done", prune);
    runner.on("swarm.cancelled", prune);

    let sessionSet = this.bySession.get(sessionKey);
    if (!sessionSet) {
      sessionSet = new Set();
      this.bySession.set(sessionKey, sessionSet);
    }
    sessionSet.add(swarmId);

    void runner.start().catch(async (err) => {
      runner.state.status = "error";
      runner.state.finishedAt = new Date().toISOString();
      runner.state.error = err instanceof Error ? err.message : String(err);
      prune();
    });

    return runner;
  }

  async cancel(swarmId: string, reason?: string): Promise<boolean> {
    const runner = this.runners.get(swarmId);
    if (!runner) return false;
    await runner.cancel(reason);
    return true;
  }

  on(
    swarmId: string,
    event: SwarmEventName,
    handler: SwarmEventHandler
  ): (() => void) | undefined {
    return this.runners.get(swarmId)?.on(event, handler);
  }

  remove(swarmId: string): void {
    const runner = this.runners.get(swarmId);
    if (!runner) return;
    const sessionKey = runner.state.sessionKey;
    runner.dispose();
    this.runners.delete(swarmId);
    const sessionSet = this.bySession.get(sessionKey);
    sessionSet?.delete(swarmId);
    if (sessionSet?.size === 0) {
      this.bySession.delete(sessionKey);
    }
  }

  dispose(): void {
    for (const runner of this.runners.values()) {
      runner.dispose();
    }
    this.runners.clear();
    this.bySession.clear();
  }
}