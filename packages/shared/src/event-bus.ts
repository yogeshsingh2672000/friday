import type { CancellationToken } from './cancellation.js';

export type Listener<T> = (payload: T) => void | Promise<void>;

export interface Subscription {
  unsubscribe(): void;
}

/**
 * Typed, lifecycle-aware in-process event bus. Listeners can be tied to a
 * CancellationToken so they self-detach when the associated turn/session ends.
 */
export class EventBus<EventMap extends Record<string, any>> {
  private listeners = new Map<keyof EventMap, Set<Listener<any>>>();
  private wildcard = new Set<(name: keyof EventMap, payload: unknown) => void>();

  on<K extends keyof EventMap>(name: K, fn: Listener<EventMap[K]>, token?: CancellationToken): Subscription {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(fn as Listener<any>);
    const sub: Subscription = {
      unsubscribe: () => {
        const s = this.listeners.get(name);
        if (s) s.delete(fn as Listener<any>);
      },
    };
    if (token) token.onCancel(() => sub.unsubscribe());
    return sub;
  }

  once<K extends keyof EventMap>(name: K, fn: Listener<EventMap[K]>): Subscription {
    const sub = this.on(name, async (p) => {
      sub.unsubscribe();
      await fn(p);
    });
    return sub;
  }

  onAny(fn: (name: keyof EventMap, payload: unknown) => void): Subscription {
    this.wildcard.add(fn);
    return { unsubscribe: () => this.wildcard.delete(fn) };
  }

  async emit<K extends keyof EventMap>(name: K, payload: EventMap[K]): Promise<void> {
    const set = this.listeners.get(name);
    if (set) {
      for (const fn of [...set]) {
        try {
          await fn(payload);
        } catch (err) {
          // never let one listener kill the others
          console.error(`[event-bus] listener for ${String(name)} threw`, err);
        }
      }
    }
    for (const w of [...this.wildcard]) {
      try {
        w(name, payload);
      } catch (err) {
        console.error(`[event-bus] wildcard listener threw`, err);
      }
    }
  }

  removeAll(): void {
    this.listeners.clear();
    this.wildcard.clear();
  }
}
