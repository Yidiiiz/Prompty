/**
 * content/observer.ts — THE single throttled MutationObserver. All DOM
 * augmentation across every feature is driven by one observer whose callback
 * merely schedules a batched tick on the next animation frame; subscribers do
 * their (cheap, dirty-checked) work inside that tick.
 *
 * No polling timers exist anywhere in the extension. When the tab is hidden,
 * requestAnimationFrame does not fire, so idle CPU is ~0.
 *
 * Subscriber contract: ticks must be fast (<4ms typical) and must not mutate
 * attributes/classes that are already in the desired state (classList.add of
 * a present class is a no-op and fires no mutation), so stable states settle
 * with no further ticks.
 *
 * Failure behavior: a throwing subscriber is logged and skipped for that
 * tick; the observer itself keeps running.
 */
import { rafThrottle } from "../shared/util";

type Tick = () => void;

const subscribers = new Set<Tick>();
let started = false;

const runTick = rafThrottle(() => {
  for (const fn of [...subscribers]) {
    try {
      fn();
    } catch (err) {
      console.error("[prompt-tree] observer subscriber error", err);
    }
  }
});

export function subscribe(fn: Tick): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** Request a tick manually (e.g. after a model update with no DOM mutation). */
export function requestTick(): void {
  runTick();
}

export function startObserver(): void {
  if (started) return;
  started = true;
  const mo = new MutationObserver(() => runTick());
  mo.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "data-mode", "data-testid", "aria-label"],
  });
  window.addEventListener("resize", () => runTick());
  // Scrolling mutates nothing, but geometry-driven features (current-message
  // tracking, gutter anchors) must follow it. Capture catches inner scrollers.
  document.addEventListener("scroll", () => runTick(), { capture: true, passive: true });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) runTick();
  });
}
