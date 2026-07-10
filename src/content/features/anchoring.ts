/**
 * content/features/anchoring.ts — robust text anchoring for notes/comments.
 *
 * Notes anchor to a quote with prefix/suffix disambiguation and a charOffset
 * tiebreaker (never bare indexes). Comments anchor to a text snippet with an
 * offsetRatio fallback (never raw pixels). All positions are resolved against
 * the RENDERED text of a message row at layout time, so zoom, reflow, and
 * markdown re-renders keep anchors correct.
 *
 * Failure behavior: resolvers return null; callers show "anchor moved" cards
 * pinned to the top of the message, or the unanchored drawer if the whole
 * message is gone.
 */

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
 * duplicate occurrences; charOffset proximity is the final tiebreaker.
 */
export function findQuote(
  index: TextIndex,
  quote: string,
  prefix: string | undefined,
  suffix: string | undefined,
  charOffset: number | undefined
): QuoteMatch | null {
  if (!quote) return null;
  const positions: number[] = [];
  for (let pos = index.text.indexOf(quote); pos >= 0; pos = index.text.indexOf(quote, pos + 1)) {
    positions.push(pos);
    if (positions.length > 200) break; // pathological repetition guard
  }
  if (!positions.length) return null;
  let best = positions[0]!;
  let bestScore = -Infinity;
  for (const pos of positions) {
    let score = 0;
    if (prefix && index.text.slice(Math.max(0, pos - prefix.length), pos) === prefix) score += 2;
    if (suffix && index.text.slice(pos + quote.length, pos + quote.length + suffix.length) === suffix) score += 2;
    if (charOffset !== undefined) score -= Math.abs(pos - charOffset) / Math.max(index.text.length, 1);
    if (score > bestScore) {
      bestScore = score;
      best = pos;
    }
  }
  return { start: best, end: best + quote.length };
}

/** Finds a comment's anchorText; returns its start offset or null. */
export function findAnchorText(index: TextIndex, anchorText: string): number | null {
  if (!anchorText) return null;
  const pos = index.text.indexOf(anchorText);
  return pos >= 0 ? pos : null;
}

/** Viewport rect of the first line of a character range (for gutter y). */
export function firstLineRect(index: TextIndex, start: number, end: number): DOMRect | null {
  const range = rangeFromOffsets(index, start, end);
  if (!range) return null;
  const rects = range.getClientRects();
  return rects.length ? rects[0]! : range.getBoundingClientRect();
}
