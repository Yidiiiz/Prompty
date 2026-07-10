/**
 * shared/util.ts — small dependency-free helpers (debounce, rAF throttle,
 * event bus). No timers are used for correctness anywhere; the debounce here
 * exists only for input coalescing (draft autosave), which is its legitimate
 * use.
 *
 * Failure behavior: none — pure utilities.
 */

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let handle: ReturnType<typeof setTimeout> | null = null;
  return (...args: A) => {
    if (handle !== null) clearTimeout(handle);
    handle = setTimeout(() => {
      handle = null;
      fn(...args);
    }, ms);
  };
}

/**
 * Coalesces bursts of calls into at most one execution per animation frame.
 * Used by the MutationObserver batcher and all position math.
 */
export function rafThrottle(fn: () => void): () => void {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn();
    });
  };
}

/** Minimal typed event bus for intra-content-script communication. */
export class EventBus<Events> {
  private listeners = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as (payload: never) => void);
    return () => set!.delete(fn as (payload: never) => void);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as (p: Events[K]) => void)(payload);
      } catch (err) {
        console.error("[prompt-tree] listener error", event, err);
      }
    }
  }
}

/** Escape a string for safe insertion into innerHTML contexts. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Clamp helper for layout math. */
export function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}
