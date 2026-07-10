/**
 * page/bridge.ts — page-world side of the window.postMessage bridge.
 *
 * Outgoing messages are tagged SOURCE_PAGE; incoming messages are accepted
 * only from this same window and origin, tagged SOURCE_CONTENT.
 *
 * Failure behavior: malformed messages are dropped; a throwing handler is
 * caught and logged so the bridge itself never breaks page code.
 */
import {
  wrap,
  unwrap,
  SOURCE_PAGE,
  SOURCE_CONTENT,
  type PageToContentMessage,
  type ContentToPageMessage,
} from "../shared/messages";

export function postToContent(msg: PageToContentMessage): void {
  window.postMessage(wrap(SOURCE_PAGE, msg), location.origin);
}

export function onContentMessage(fn: (msg: ContentToPageMessage) => void): void {
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const msg = unwrap<ContentToPageMessage>(event.data, SOURCE_CONTENT);
    if (!msg) return;
    try {
      fn(msg);
    } catch (err) {
      console.error("[prompt-tree] page bridge handler error", err);
    }
  });
}
