/**
 * content/bridge.ts — content-script side of the window.postMessage bridge.
 * Mirror image of page/bridge.ts: sends SOURCE_CONTENT, accepts SOURCE_PAGE
 * from this window/origin only.
 *
 * Failure behavior: malformed messages dropped; handler errors logged, never
 * propagated.
 */
import {
  wrap,
  unwrap,
  SOURCE_PAGE,
  SOURCE_CONTENT,
  type PageToContentMessage,
  type ContentToPageMessage,
} from "../shared/messages";

export function sendToPage(msg: ContentToPageMessage): void {
  window.postMessage(wrap(SOURCE_CONTENT, msg), location.origin);
}

export function onPageMessage(fn: (msg: PageToContentMessage) => void): void {
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const msg = unwrap<PageToContentMessage>(event.data, SOURCE_PAGE);
    if (!msg) return;
    try {
      fn(msg);
    } catch (err) {
      console.error("[prompt-tree] content bridge handler error", err);
    }
  });
}
