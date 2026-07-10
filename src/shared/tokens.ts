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
};

export const FONT_SANS =
  'var(--font-anthropic-sans, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif)';
export const FONT_MONO =
  'var(--font-anthropic-mono, ui-monospace, "Cascadia Mono", "Segoe UI Mono", monospace)';

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
