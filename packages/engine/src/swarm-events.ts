export type SwarmEventName =
  | "swarm.started"
  | "swarm.task.spawned"
  | "swarm.task.idle"
  | "swarm.task.error"
  | "swarm.done"
  | "swarm.cancelled"
  | "swarm.script.started"
  | "swarm.script.done"
  | "swarm.script.error";

export type SwarmEventPayload = {
  swarmId: string;
  sessionKey: string;
  taskName?: string;
  sessionId?: string;
  error?: string;
  reason?: string;
};

export type SwarmEventHandler = (payload: SwarmEventPayload) => void;

export class SwarmEventBus {
  private readonly handlers = new Map<SwarmEventName, Set<SwarmEventHandler>>();

  on(event: SwarmEventName, handler: SwarmEventHandler): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  emit(event: SwarmEventName, payload: SwarmEventPayload): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of set) {
      handler(payload);
    }
  }
}