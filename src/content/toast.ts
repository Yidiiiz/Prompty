/**
 * content/toast.ts — the single non-blocking notification surface. Used
 * mainly for degradation notices ("Prompty: [feature] unavailable after a
 * claude.ai update"), shown at most once per id per page load.
 *
 * Rendered in its own Shadow DOM host, fixed at the bottom center, above the
 * composer, auto-dismissing via a CSS animation (removal on animationend —
 * event-driven, no timers).
 *
 * Failure behavior: none meaningful — if the toast cannot render, the notice
 * also goes to the console.
 */
import { cssVar, FONT_SANS, UI, Z_EXTENSION_OVERLAY } from "../shared/tokens";

const shownIds = new Set<string>();
let host: HTMLElement | null = null;
let shadow: ShadowRoot | null = null;

function ensureHost(): ShadowRoot | null {
  if (shadow && host?.isConnected) return shadow;
  if (!document.body) return null;
  host = document.createElement("div");
  host.id = "pt-toast-host";
  shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .stack {
      position: fixed;
      top: 68px; /* below the site header; warnings surface at the top */
      left: 50%;
      transform: translateX(-50%);
      z-index: ${Z_EXTENSION_OVERLAY};
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: center;
      pointer-events: none;
    }
    .toast {
      pointer-events: auto;
      font-family: ${FONT_SANS};
      font-size: 12.5px;
      line-height: 1.45;
      color: ${cssVar("--text-200")};
      background: ${cssVar("--bg-100", 0.97)};
      backdrop-filter: blur(8px);
      border-radius: ${UI.radiusMd};
      box-shadow: ${UI.shadowMd};
      padding: 10px 14px;
      max-width: 440px;
      display: flex;
      gap: 10px;
      align-items: baseline;
      animation: life 7s linear forwards;
    }
    .toast::before {
      content: "";
      flex: none;
      align-self: center;
      width: 6px; height: 6px; border-radius: 50%;
      background: ${cssVar("--accent-main-100", 0.75)};
    }
    .toast .close {
      cursor: pointer;
      color: ${cssVar("--text-400")};
      font-size: 13px;
      line-height: 1;
      background: none;
      border: none;
      padding: 2px 3px;
      border-radius: 6px;
      font-family: inherit;
      transition: color ${UI.transition}, background ${UI.transition};
    }
    .toast .close:hover { color: ${cssVar("--text-100")}; background: ${cssVar("--bg-300")}; }
    @keyframes life {
      0% { opacity: 0; transform: translateY(-6px); }
      4% { opacity: 1; transform: translateY(0); }
      92% { opacity: 1; }
      100% { opacity: 0; }
    }
  `;
  const stack = document.createElement("div");
  stack.className = "stack";
  shadow.append(style, stack);
  document.body.appendChild(host);
  return shadow;
}

/**
 * Shows a toast once per `id` per page load. Subsequent calls with the same
 * id are silent (still logged to console for diagnosis).
 */
export function toastOnce(id: string, text: string): void {
  console.warn(`[prompt-tree] ${text}`);
  if (shownIds.has(id)) return;
  shownIds.add(id);
  const root = ensureHost();
  if (!root) return;
  const stack = root.querySelector(".stack");
  if (!stack) return;
  const toast = document.createElement("div");
  toast.className = "toast";
  const span = document.createElement("span");
  span.textContent = text;
  const close = document.createElement("button");
  close.className = "close";
  close.textContent = "✕";
  close.setAttribute("aria-label", "Dismiss");
  close.addEventListener("click", () => toast.remove());
  toast.addEventListener("animationend", () => toast.remove());
  toast.append(span, close);
  stack.appendChild(toast);
}
