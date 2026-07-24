/**
 * content/features/anchoring.ts — robust text anchoring for notes/comments.
 *
 * Notes anchor to a quote with prefix/suffix disambiguation and a charOffset
 * tiebreaker (never bare indexes). Comments anchor to a text snippet with an
 * offsetRatio fallback (never raw pixels). All positions are resolved against
 * the RENDERED text of a message row at layout time, so zoom, reflow, and
 * markdown re-renders keep anchors correct.
 *
 * Matching is WHITESPACE-INSENSITIVE (see shared/text-match): a DOM selection's
 * toString() inserts a newline at every block boundary that the rendered text
 * nodes don't contain, so an exact indexOf of a multi-line quote always failed
 * and pinned the card to the message top. Every lookup runs on the dense
 * projection and maps back to source offsets.
 *
 * Failure behavior: resolvers return null; callers show "anchor moved" cards
 * pinned to the top of the message, or the unanchored drawer if the whole
 * message is gone.
 */
import { denseIndex, densify, findDense, findDenseFirst } from "../../shared/text-match";

export interface TextIndex {
  text: string;
  /** Text nodes with their start offsets in `text`, in document order. */
  nodes: Array<{ node: Text; start: number }>;
}

/** Concatenates all visible text nodes of a row into one searchable string. */
export function indexText(root: HTMLElement): TextIndex {
  const nodes: TextIndex["nodes"] = [];
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      // skip our own injected UI (namespaced) — anchors target native content
      if (parent.closest('[class^="pt-"], [id^="pt-"]')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const textNode = n as Text;
    nodes.push({ node: textNode, start: text.length });
    text += textNode.data;
  }
  return { text, nodes };
}

/** Builds a DOM Range spanning [start, end) character offsets of the index. */
export function rangeFromOffsets(index: TextIndex, start: number, end: number): Range | null {
  const locate = (offset: number, preferEnd: boolean): { node: Text; local: number } | null => {
    for (let i = index.nodes.length - 1; i >= 0; i--) {
      const entry = index.nodes[i]!;
      const nodeEnd = entry.start + entry.node.data.length;
      if (offset > entry.start || (offset === entry.start && (!preferEnd || i === 0))) {
        if (offset <= nodeEnd) return { node: entry.node, local: offset - entry.start };
      }
    }
    const first = index.nodes[0];
    return first ? { node: first.node, local: 0 } : null;
  };
  const s = locate(start, false);
  const e = locate(end, true);
  if (!s || !e) return null;
  try {
    const range = document.createRange();
    range.setStart(s.node, Math.min(s.local, s.node.data.length));
    range.setEnd(e.node, Math.min(e.local, e.node.data.length));
    return range;
  } catch {
    return null;
  }
}

/** Character offset of a boundary point within the indexed text, or null. */
export function offsetOfPoint(index: TextIndex, node: Node, nodeOffset: number): number | null {
  // If the point is an element boundary, descend to the nearest text position.
  if (node.nodeType === Node.TEXT_NODE) {
    const entry = index.nodes.find((e) => e.node === node);
    return entry ? entry.start + nodeOffset : null;
  }
  const child = node.childNodes[nodeOffset] ?? node.childNodes[nodeOffset - 1] ?? node;
  for (const entry of index.nodes) {
    if (child.contains(entry.node) || entry.node === child) return entry.start;
  }
  return null;
}

export interface QuoteMatch {
  start: number;
  end: number;
}

/**
 * Finds `quote` in the indexed text: prefix/suffix matches disambiguate
 * duplicate occurrences; charOffset proximity is the final tiebreaker. Matching
 * ignores whitespace differences (dense projection), so a quote spanning block
 * boundaries — where the selection carried newlines the DOM text lacks — is
 * still located instead of collapsing the card to the message top.
 */
export function findQuote(
  index: TextIndex,
  quote: string,
  prefix: string | undefined,
  suffix: string | undefined,
  charOffset: number | undefined
): QuoteMatch | null {
  if (!quote) return null;
  const di = denseIndex(index.text);
  const matches = findDense(di, quote);
  if (!matches.length) return null;
  const dPrefix = prefix ? densify(prefix) : "";
  const dSuffix = suffix ? densify(suffix) : "";
  let best = matches[0]!;
  let bestScore = -Infinity;
  for (const m of matches) {
    let score = 0;
    if (dPrefix && di.dense.slice(Math.max(0, m.denseStart - dPrefix.length), m.denseStart) === dPrefix) score += 2;
    if (dSuffix && di.dense.slice(m.denseEnd, m.denseEnd + dSuffix.length) === dSuffix) score += 2;
    if (charOffset !== undefined) score -= Math.abs(m.start - charOffset) / Math.max(index.text.length, 1);
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return { start: best.start, end: best.end };
}

/** Finds a comment's anchorText; returns its start offset or null. */
export function findAnchorText(index: TextIndex, anchorText: string): number | null {
  if (!anchorText) return null;
  const m = findDenseFirst(denseIndex(index.text), anchorText);
  return m ? m.start : null;
}

/** Viewport rect of the first line of a character range (for gutter y). */
export function firstLineRect(index: TextIndex, start: number, end: number): DOMRect | null {
  const range = rangeFromOffsets(index, start, end);
  if (!range) return null;
  const rects = range.getClientRects();
  return rects.length ? rects[0]! : range.getBoundingClientRect();
}
