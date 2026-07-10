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
import { cssVar, FONT_SANS } from "../shared/tokens";

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

.pt-highlight-pulse {
  animation: pt-pulse 1.4s ease-out 1;
  border-radius: 8px;
}
@keyframes pt-pulse {
  0% { background-color: ${cssVar("--accent-main-100", 0.16)}; }
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
  gap: 4px;
  white-space: nowrap;
}
.pt-branch-btn:hover {
  background: ${cssVar("--bg-300", 0.8)};
  color: ${cssVar("--text-100")};
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
