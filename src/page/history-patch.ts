/**
 * page/history-patch.ts — SPA navigation detection. claude.ai is a single-page
 * app; conversation switches happen via the History API. We patch pushState /
 * replaceState and listen for popstate, emitting `url-changed` to the content
 * script so features re-initialize per conversation.
 *
 * Failure behavior: if patching throws (frozen History prototype after a
 * browser change), we fall back to popstate-only detection and log a warning;
 * same-document pushState navigations would then be missed and the content
 * script's MutationObserver-driven re-checks become the safety net.
 */
import { postToContent } from "./bridge";

export function installHistoryPatch(): void {
  let lastUrl = location.href;
  const emitIfChanged = () => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      postToContent({ type: "url-changed", url: location.href });
    }
  };
  try {
    const origPush = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);
    history.pushState = function (...args: Parameters<History["pushState"]>) {
      origPush(...args);
      emitIfChanged();
    };
    history.replaceState = function (...args: Parameters<History["replaceState"]>) {
      origReplace(...args);
      emitIfChanged();
    };
  } catch (err) {
    console.warn("[prompt-tree] history patch failed; SPA nav detection degraded", err);
  }
  window.addEventListener("popstate", emitIfChanged);
}
