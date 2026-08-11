type Listener = (...args: never[]) => void;

/**
 * Minimal synchronous event emitter.
 *
 * The engine runs both in Node and in the browser, so it carries its own
 * emitter rather than importing `node:events` and dragging a shim into the
 * bundle. Listener errors are isolated: one bad subscriber cannot stop the
 * others from seeing a fill.
 */
export class Emitter {
  private listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  off(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  once(event: string, listener: Listener): this {
    const wrapped = ((...args: never[]) => {
      this.off(event, wrapped);
      listener(...args);
    }) as Listener;
    return this.on(event, wrapped);
  }

  emit(event: string, ...args: unknown[]): boolean {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return false;
    for (const listener of [...set]) {
      try {
        (listener as (...a: unknown[]) => void)(...args);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[sentinal] listener for "${event}" threw:`, err);
      }
    }
    return true;
  }

  removeAllListeners(event?: string): this {
    if (event) this.listeners.delete(event);
    else this.listeners.clear();
    return this;
  }
}
