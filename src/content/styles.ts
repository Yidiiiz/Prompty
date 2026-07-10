/**
 * content/styles.ts — the small set of pt- namespaced classes applied to
 * claude.ai's own DOM (ghosting, hiding, pulse highlight, the branch button).
 * Everything else the extension renders lives inside Shadow DOM; these
 * classes exist only because they must affect native message rows.
 *
 * All colors come from claude.ai's design tokens via hsl(var(--…, fallback)),
 * so light/dark theme switches apply automatically.
 *
 * Failure behavior: if the style element is removed by the site, features
 * re-install it on the next observer tick (installPageStyles is idempotent
 * and cheap).
 */
import { cssVar, FONT_SANS, UI } from "../shared/tokens";

const STYLE_ID = "pt-page-styles";

const CSS = `
.pt-branch-hidden { display: none !important; }
.pt-note-hidden { display: none !important; }

.pt-branch-ghost {
  opacity: 0.45 !important;
  box-shadow: inset 3px 0 0 0 ${cssVar("--accent-main-100")} !important;
  border-radius: 8px;
  transition: opacity 120ms ease;
}

/* The element's own border-radius (a bubble's rounding) clips the pulse
   background automatically; the fallback radius below only softens elements
   that have none. Applied via a low-specificity where() so a real radius on
   the bubble always wins. */
:where(.pt-highlight-pulse) {
  border-radius: 8px;
}
.pt-highlight-pulse {
  animation: pt-pulse 0.6s ease-out 1;
}
@keyframes pt-pulse {
  0% { background-color: ${cssVar("--accent-main-100", 0.12)}; }
  100% { background-color: transparent; }
}

.pt-branch-btn {
  all: initial;
  font-family: ${FONT_SANS};
  font-size: 12px;
  line-height: 1;
  color: ${cssVar("--text-300")};
  background: transparent;
  border: none;
  border-radius: 8px;
  padding: 6px 8px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
  transition: background ${UI.transition}, color ${UI.transition};
}
.pt-branch-btn:hover {
  background: ${cssVar("--bg-300", 0.8)};
  color: ${cssVar("--text-100")};
}
.pt-branch-btn:focus-visible {
  outline: 2px solid ${cssVar("--accent-main-100", 0.6)};
  outline-offset: 1px;
}
.pt-branch-btn svg { display: block; }
`;

export function installPageStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  (document.head ?? document.documentElement).appendChild(style);
}
