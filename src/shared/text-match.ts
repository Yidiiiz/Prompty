/**
 * shared/text-match.ts — whitespace- (and optionally markdown-) insensitive
 * text matching with a map back to the original offsets.
 *
 * Two strings that describe the same content rarely match character for
 * character:
 *  - a DOM selection's toString() inserts a newline at every block boundary,
 *    while the rendered text nodes it came from have NO character there at
 *    all (a quote spanning a table row, list items or a bold phrase therefore
 *    never matched with indexOf, which pinned notes to the top of a message);
 *  - a message's markdown carries `**`, `|`, `-`, `#` syntax the reader never
 *    sees, so a quote of the RENDERED text cannot be found in the source.
 *
 * Every anchor/quote lookup therefore matches on a DENSE projection: the text
 * with those characters dropped, plus `map[i]` = the source offset of dense
 * character i, so matches come back in source coordinates.
 *
 * Failure behavior: pure functions; a needle that isn't there returns [].
 */

/** Whitespace, plus (markdown mode) the syntax characters rendering removes. */
const WHITESPACE_RE = /\s/g;
const MARKDOWN_RE = /[\s*_~`#>|+-]/g;

export interface DenseIndex {
  /** The source text this projection was built from. */
  source: string;
  /** The projection: source minus every ignored character. */
  dense: string;
  /** dense offset → offset of that character in `source`. */
  map: number[];
}

export interface DenseMatch {
  /** Offsets in the source text. */
  start: number;
  end: number;
  /** Offsets in the dense projection (for prefix/suffix comparison). */
  denseStart: number;
  denseEnd: number;
}

/** The dense projection of `text` (see module header). */
export function densify(text: string, markdown = false): string {
  return text.replace(markdown ? MARKDOWN_RE : WHITESPACE_RE, "");
}

export function denseIndex(text: string, markdown = false): DenseIndex {
  const ignored = markdown ? MARKDOWN_RE : WHITESPACE_RE;
  let dense = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    ignored.lastIndex = 0;
    if (ignored.test(ch)) continue;
    dense += ch;
    map.push(i);
  }
  return { source: text, dense, map };
}

/** Every occurrence of `needle`, densely matched, in source coordinates. */
export function findDense(index: DenseIndex, needle: string, markdown = false, limit = 200): DenseMatch[] {
  const dense = densify(needle, markdown);
  if (!dense) return [];
  const matches: DenseMatch[] = [];
  for (let pos = index.dense.indexOf(dense); pos >= 0; pos = index.dense.indexOf(dense, pos + 1)) {
    const start = index.map[pos];
    const end = index.map[pos + dense.length - 1];
    if (start === undefined || end === undefined) break;
    matches.push({ start, end: end + 1, denseStart: pos, denseEnd: pos + dense.length });
    if (matches.length >= limit) break; // pathological repetition guard
  }
  return matches;
}

/** The first occurrence only. */
export function findDenseFirst(index: DenseIndex, needle: string, markdown = false): DenseMatch | null {
  return findDense(index, needle, markdown, 1)[0] ?? null;
}
