/**
 * shared/summary.ts — the swappable message-summary module used by the Prompt
 * Tree panel. v1 is pure local text truncation (no API calls): strip markdown
 * syntax, take the first N words, ellipsize. The `Summarizer` interface is the
 * seam where an LLM-generated summary could be plugged in later.
 *
 * Failure behavior: none — pure text transforms; empty input yields "(empty)".
 */

export interface Summarizer {
  /** Short summary for a panel row (~6 words). */
  summarize(text: string, maxWords: number): string;
}

/** Removes common markdown syntax so summaries read as plain prose. */
export function stripMarkdown(text: string): string {
  return (
    text
      // fenced code blocks -> their content placeholder
      .replace(/```[\s\S]*?```/g, " [code] ")
      .replace(/`([^`]*)`/g, "$1")
      // images/links -> label
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // emphasis/headers/quotes/list markers
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^\s*>\s?/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+\.\s+/gm, "")
      .replace(/(\*\*|__|\*|_|~~)/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

export const localSummarizer: Summarizer = {
  summarize(text: string, maxWords: number): string {
    const plain = stripMarkdown(text);
    if (!plain) return "(empty)";
    const words = plain.split(" ");
    if (words.length <= maxWords) return plain;
    return words.slice(0, maxWords).join(" ") + "…";
  },
};

/** The active summarizer. Swap this assignment to change the strategy. */
export let summarizer: Summarizer = localSummarizer;

export function setSummarizer(s: Summarizer): void {
  summarizer = s;
}
