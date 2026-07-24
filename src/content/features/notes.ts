/**
 * content/features/notes.ts — Feature 3 entry point: highlight text in an
 * assistant message → a note button appears in the right-margin gutter,
 * vertically aligned with the selection's first line
 * (Range.getClientRects()[0]), adjacent to — never overlapping — the native
 * selection popover. Clicking opens the gutter composer; everything after
 * submit (side-branch send, anchoring metadata, card streaming) is owned by
 * NoteCardManager.
 *
 * Anchors are captured at click time: quote (≤300 chars), 20-char
 * prefix/suffix, and the character offset within the message's rendered text.
 *
 * Failure behavior: selections outside mapped assistant rows are ignored; if
 * offsets can't be computed the quote alone anchors (findQuote still works).
 */
import { rafThrottle } from "../../shared/util";
import { q } from "../../shared/selectors";
import { subscribe } from "../observer";
import type { Ctx, Feature } from "../ctx";
import { indexText, offsetOfPoint } from "./anchoring";
import { denseIndex, findDense as findDenseCandidates } from "../../shared/text-match";
import type { GutterAnchor, NoteCardManager } from "./note-cards";

export class NotesFeature implements Feature {
  readonly id = "notes" as const;

  private enabled = false;
  private selectionActive = false;

  constructor(
    private ctx: Ctx,
    private cards: NoteCardManager
  ) {
    const onSelection = rafThrottle(() => this.handleSelection());
    document.addEventListener("selectionchange", () => {
      if (this.enabled) onSelection();
    });
    // reposition against the native popover once it mounts/moves
    subscribe(() => {
      if (this.enabled && this.selectionActive) this.handleSelection();
    });
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.cards.setKindEnabled("note", on);
    if (!on) this.selectionActive = false;
  }

  onConversation(): void {
    this.selectionActive = false;
  }

  private handleSelection(): void {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      this.clear();
      return;
    }
    const range = selection.getRangeAt(0);
    const quote = selection.toString();
    if (!quote.trim()) {
      this.clear();
      return;
    }
    const row = this.ctx.domMap.rowForElement(
      range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement ?? document.body
    );
    if (!row || row.sender !== "assistant" || !row.uuid) {
      this.clear();
      return;
    }
    const conversationUuid = this.ctx.getCurrentConversation();
    if (!conversationUuid) return;

    const rects = range.getClientRects();
    const firstLine = rects.length ? rects[0]! : range.getBoundingClientRect();
    const tooltip = q<HTMLElement>("selectionTooltip");
    const avoid = tooltip ? tooltip.getBoundingClientRect() : null;

    const anchorMessageUuid = row.uuid;
    const rowEl = row.el;
    this.selectionActive = true;
    this.cards.showEntryButton("note", firstLine.top, avoid, () => {
      const anchor = this.buildAnchor(conversationUuid, anchorMessageUuid, rowEl, range, quote);
      this.clear();
      window.getSelection()?.removeAllRanges();
      this.cards.openComposer("note", anchor, quote);
    });
  }

  private buildAnchor(
    conversationUuid: string,
    anchorMessageUuid: string,
    rowEl: HTMLElement,
    range: Range,
    quote: string
  ): GutterAnchor {
    const index = indexText(rowEl);
    const di = denseIndex(index.text);
    // Locate the quote's true SOURCE span (start..end) densely — a multi-line
    // selection's newlines make quote.length differ from the source span, so
    // prefix/suffix must be sliced around the real span, not start+quote.length.
    // The selection-start offset only breaks ties between repeated quotes.
    const pointStart = offsetOfPoint(index, range.startContainer, range.startOffset);
    let start = pointStart ?? 0;
    let end = start + quote.length;
    const matches = findDenseCandidates(di, quote);
    if (matches.length) {
      const chosen =
        pointStart === null
          ? matches[0]!
          : matches.reduce((a, b) =>
              Math.abs(a.start - pointStart) <= Math.abs(b.start - pointStart) ? a : b
            );
      start = chosen.start;
      end = chosen.end;
    }
    return {
      kind: "note",
      conversationUuid,
      anchorMessageUuid,
      quote: quote.slice(0, 300),
      prefix: index.text.slice(Math.max(0, start - 20), start),
      suffix: index.text.slice(end, end + 20),
      charOffset: start,
    };
  }

  private clear(): void {
    if (!this.selectionActive) return;
    this.selectionActive = false;
    this.cards.hideEntryButton("note");
  }
}
