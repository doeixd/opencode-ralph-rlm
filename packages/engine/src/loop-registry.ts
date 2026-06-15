import { CONFIG_DEFAULTS } from "./config.js";
import { createLoopEngine, type LoopEngine, type LoopEngineOptions } from "./loop-engine.js";
import { toLoopStatus, type LoopRunConfig, type LoopStatus } from "./loop-run.js";
import type { LoopEventHandler, LoopEventName } from "./loop-events.js";

/** Maps supervisor session IDs to loop engines (one loop per session). */
export class LoopRegistry {
  private readonly engines = new Map<string, LoopEngine>();

  get(sessionId: string): LoopEngine | undefined {
    return this.engines.get(sessionId);
  }

  /**
   * Synchronous snapshot from in-memory state (no pending-question file reads).
   * Prefer {@link listAsync} for full status including `pendingQuestions`.
   */
  list(): LoopStatus[] {
    return [...this.engines.values()].map((engine) =>
      toLoopStatus(engine.state, CONFIG_DEFAULTS.maxAttempts)
    );
  }

  async listAsync(): Promise<LoopStatus[]> {
    const statuses = await Promise.all(
      [...this.engines.values()].map((engine) => engine.status())
    );
    return statuses;
  }

  async getOrCreate(
    config: LoopRunConfig,
    options: LoopEngineOptions
  ): Promise<LoopEngine> {
    const existing = this.engines.get(config.sessionId);
    if (existing) return existing;

    const engine = createLoopEngine(config, options);
    this.engines.set(config.sessionId, engine);
    return engine;
  }

  async start(
    config: LoopRunConfig,
    options: LoopEngineOptions
  ): Promise<LoopEngine> {
    const engine = await this.getOrCreate(config, options);
    await engine.start(config);
    return engine;
  }

  on(
    sessionId: string,
    event: LoopEventName,
    handler: LoopEventHandler
  ): (() => void) | undefined {
    return this.engines.get(sessionId)?.on(event, handler);
  }

  remove(sessionId: string): void {
    const engine = this.engines.get(sessionId);
    if (!engine) return;
    engine.dispose();
    this.engines.delete(sessionId);
  }

  dispose(): void {
    for (const engine of this.engines.values()) {
      engine.dispose();
    }
    this.engines.clear();
  }
}