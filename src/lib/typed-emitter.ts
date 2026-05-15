// Typed event emitter primitive. Per ADR-0004.
// Each module owns its own instance and exposes it as the module's `events`.
// `emit()` awaits all listeners sequentially; the first listener that throws
// fails the emit (block-on-failure — audit failures fail the originating op).

type Listener<T> = (event: T) => void | Promise<void>;

export class TypedEmitter<EventMap extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof EventMap, Set<Listener<unknown>>>();

  on<K extends keyof EventMap>(type: K, listener: Listener<EventMap[K]>): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    const erased = listener as Listener<unknown>;
    set.add(erased);
    return () => {
      set?.delete(erased);
    };
  }

  async emit<K extends keyof EventMap>(type: K, event: EventMap[K]): Promise<void> {
    const set = this.listeners.get(type);
    if (!set || set.size === 0) return;
    // Snapshot so a listener disposing itself mid-emit doesn't break iteration.
    for (const listener of Array.from(set)) {
      await listener(event);
    }
  }
}
