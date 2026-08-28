/**
 * Small typed event emitter.
 *
 * Systems communicate through explicit event maps instead of reaching into
 * each other. Handlers are stored in insertion order; `on` returns an
 * unsubscribe function so callers cannot leak listeners by forgetting the
 * exact handler reference.
 */

export type EventMap = Record<string, unknown>;

export type Handler<T> = (payload: T) => void;

export type Unsubscribe = () => void;

export class Emitter<M extends EventMap> {
  private readonly handlers = new Map<keyof M, Set<Handler<never>>>();

  on<K extends keyof M>(event: K, handler: Handler<M[K]>): Unsubscribe {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => {
      set?.delete(handler as Handler<never>);
    };
  }

  /** Subscribes for exactly one emission. */
  once<K extends keyof M>(event: K, handler: Handler<M[K]>): Unsubscribe {
    const off = this.on(event, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off<K extends keyof M>(event: K, handler: Handler<M[K]>): void {
    this.handlers.get(event)?.delete(handler as Handler<never>);
  }

  emit<K extends keyof M>(event: K, payload: M[K]): void {
    const set = this.handlers.get(event);
    if (!set || set.size === 0) return;
    // Copy before iterating: a handler may subscribe or unsubscribe during
    // dispatch, and mutating a Set mid-iteration is a subtle source of bugs.
    for (const handler of [...set]) {
      try {
        (handler as Handler<M[K]>)(payload);
      } catch (error) {
        // One broken listener must not prevent the others from running, and
        // must not silently vanish either.
        console.error(`[events] handler for "${String(event)}" threw:`, error);
      }
    }
  }

  listenerCount<K extends keyof M>(event: K): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  clear(event?: keyof M): void {
    if (event === undefined) this.handlers.clear();
    else this.handlers.delete(event);
  }
}
