/**
 * content/toast.ts — the single non-blocking notification surface. Used
 * mainly for degradation notices ("Prompt Tree: [feature] unavailable after a
 * claude.ai update"), shown at most once per id per page load.
 *
 * Rendered in its own Shadow DOM host, fixed at the bottom center, above the
 * composer, auto-dismissing via a CSS animation (removal on animationend —
 * event-driven, no timers).
 *
 * Failure behavior: none meaningful — if the toast cannot render, the notice
 * also goes to the console.
 */
import { cssVar, FONT_SANS } from "../shared/tokens";

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
      bottom: 96px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483000;
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: center;
      pointer-events: none;
    }
    .toast {
      pointer-events: auto;
      font-family: ${FONT_SANS};
      font-size: 13px;
      color: ${cssVar("--text-100")};
      background: ${cssVar("--bg-000")};
      border: 1px solid ${cssVar("--border-300")};
      border-radius: 10px;
      box-shadow: 0 4px 16px hsl(0 0% 0% / 0.12);
      padding: 10px 14px;
      max-width: 440px;
      display: flex;
      gap: 10px;
      align-items: baseline;
      animation: life 7s linear forwards;
    }
    .toast .close {
      cursor: pointer;
      color: ${cssVar("--text-400")};
      font-size: 14px;
      line-height: 1;
      background: none;
      border: none;
      padding: 0;
      font-family: inherit;
    }
    @keyframes life {
      0% { opacity: 0; transform: translateY(6px); }
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
