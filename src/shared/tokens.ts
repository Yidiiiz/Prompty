/**
 * shared/tokens.ts — claude.ai design-token access.
 *
 * The site defines its palette as CSS custom properties holding RAW HSL
 * TRIPLETS (e.g. `--bg-100: 48 33% 97%`), themed via [data-theme][data-mode]
 * on the root. Because custom properties inherit across shadow boundaries,
 * extension CSS references them directly as `hsl(var(--bg-100, <fallback>))`
 * — theme switches (light/dark) are picked up live by the CSS engine itself,
 * no JS observers or repaints of our own needed.
 *
 * This module provides:
 *  - `cssVar()` helpers that build those hsl(var(...)) expressions with warm,
 *    sensible fallbacks for every token we use;
 *  - `validateTokens()` which reads computed styles at startup and logs any
 *    token that is missing (so a site redesign is visible in the console).
 *
 * Failure behavior: missing tokens silently fall back to the bundled palette;
 * the UI stays legible, just less native-looking.
 */

/** Token name -> fallback raw HSL triplet (matches claude.ai's warm light theme). */
export const TOKEN_FALLBACKS: Record<string, string> = {
  "--bg-000": "0 0% 100%",
  "--bg-100": "48 33% 97%",
  "--bg-200": "53 28% 95%",
  "--bg-300": "48 25% 92%",
  "--bg-400": "50 21% 88%",
  "--text-100": "60 3% 14%",
  "--text-200": "60 3% 24%",
  "--text-300": "60 3% 34%",
  "--text-400": "60 2% 45%",
  "--text-500": "60 2% 56%",
  "--border-100": "48 10% 25%",
  "--border-200": "48 11% 82%",
  "--border-300": "48 12% 88%",
  "--accent-main-100": "15 56% 52%",
  "--accent-main-200": "15 60% 45%",
  "--accent-secondary-100": "210 55% 47%",
  "--danger-100": "0 64% 45%",
  "--oncolor-100": "0 0% 100%",
  "--always-black": "0 0% 0%",
};

export const FONT_SANS =
  'var(--font-anthropic-sans, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif)';
export const FONT_MONO =
  'var(--font-anthropic-mono, ui-monospace, "Cascadia Mono", "Segoe UI Mono", monospace)';

/* ------------------------------------------------------- design language */
/**
 * One shared design language for every extension surface, so panel, cards,
 * modal, toast, banner, and header read as a single product.
 */
export const UI = {
  /** Radii: sm = chips/buttons, md = cards/bars, lg = panel/modal. */
  radiusSm: "8px",
  radiusMd: "12px",
  radiusLg: "16px",
  /**
   * The site's own shadow recipe (captured from the live composer): one
   * tight, low-alpha drop shadow plus a half-pixel token-driven ring that
   * hugs the element exactly — no oversized halos. Surfaces are borderless
   * by design; the ring provides the crisp edge and follows the theme.
   */
  shadowSm: `0 0.25rem 1.25rem ${cssVar("--always-black", 0.035)}, 0 0 0 0.5px ${cssVar("--border-300", 0.15)}`,
  shadowMd: `0 0.25rem 1.25rem ${cssVar("--always-black", 0.075)}, 0 0 0 0.5px ${cssVar("--border-200", 0.3)}`,
  shadowLg: `0 0.75rem 2rem ${cssVar("--always-black", 0.12)}, 0 0 0 0.5px ${cssVar("--border-200", 0.3)}`,
  /** Single motion voice. */
  transition: "150ms cubic-bezier(0.2, 0, 0.2, 1)",
} as const;

/** Focus ring applied to interactive extension controls. */
export function focusRing(): string {
  return `outline: 2px solid ${cssVar("--accent-main-100", 0.6)}; outline-offset: 1px;`;
}

/* --------------------------------------------------------- layering policy */
/**
 * claude.ai's overlay layer starts at z-index 50 (Tailwind scale; the
 * captured selection tooltip is z-50 and dialogs/menus render at ≥ 50).
 * ALL extension UI must sit above the chat content but BELOW 50, so the
 * site's settings dialog, account menu, and other overlays always cover it.
 */
export const Z_CONTENT = 20; // in-scroll-container surfaces (gutter cards)
export const Z_PANEL = 30; // panel, branch header bar, draft banner
export const Z_EXTENSION_OVERLAY = 40; // toast stack, note fullscreen modal

/** `cssVar("--bg-100")` -> `hsl(var(--bg-100, 48 33% 97%))` */
export function cssVar(token: string, alpha?: number): string {
  const fallback = TOKEN_FALLBACKS[token] ?? "0 0% 50%";
  const inner = `var(${token}, ${fallback})`;
  return alpha === undefined ? `hsl(${inner})` : `hsl(${inner} / ${alpha})`;
}

/** Logs tokens that are absent from the live page (site redesign detector). */
export function validateTokens(): string[] {
  const styles = getComputedStyle(document.documentElement);
  const missing: string[] = [];
  for (const token of Object.keys(TOKEN_FALLBACKS)) {
    if (!styles.getPropertyValue(token).trim()) missing.push(token);
  }
  if (missing.length) {
    console.warn(
      "[prompt-tree] design tokens missing from claude.ai (using bundled fallbacks):",
      missing
    );
  }
  return missing;
}
