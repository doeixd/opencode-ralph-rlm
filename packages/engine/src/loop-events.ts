export type LoopEventName =
  | "attempt.started"
  | "worker.spawned"
  | "worker.idle"
  | "verify.done"
  | "rollover"
  | "loop.done"
  | "loop.max_attempts"
  | "loop.paused"
  | "loop.resumed"
  | "loop.stopped"
  | "loop.error"
  | "worker.question";

export type LoopEventPayload = {
  sessionId: string;
  attempt?: number;
  workerSessionId?: string;
  verdict?: string;
  details?: string;
  reason?: string;
  questionId?: string;
  question?: string;
  error?: string;
};

export type LoopEventHandler = (payload: LoopEventPayload) => void;

export class LoopEventBus {
  private readonly handlers = new Map<LoopEventName, Set<LoopEventHandler>>();

  on(event: LoopEventName, handler: LoopEventHandler): () => void {
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

  emit(event: LoopEventName, payload: LoopEventPayload): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of set) {
      handler(payload);
    }
  }
}