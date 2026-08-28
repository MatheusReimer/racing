// Minimal synchronous event bus. Subsystems that do not own each other
// (audio reacting to a collision, the HUD reacting to a skill firing) talk
// through this rather than holding references.

export class EventBus {
  constructor() {
    this.handlers = new Map();
  }

  on(type, fn) {
    let list = this.handlers.get(type);
    if (!list) {
      list = [];
      this.handlers.set(type, list);
    }
    list.push(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  off(type, fn) {
    const list = this.handlers.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  emit(type, payload) {
    const list = this.handlers.get(type);
    if (!list || list.length === 0) return;
    // Iterate a copy: handlers are allowed to unsubscribe during dispatch.
    for (const fn of list.slice()) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[events] handler for "${type}" threw:`, err);
      }
    }
  }

  clear() {
    this.handlers.clear();
  }
}
