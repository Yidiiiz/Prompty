/**
 * content/features/comments.ts — Feature 4 entry point: hovering an assistant
 * message with no text selected shows a Google-Docs-style "+" button in the
 * right margin, tracking the pointer's vertical position (animation-frame
 * throttled). Clicking opens the gutter composer at that position.
 *
 * Anchoring is position-based, never pixel-based: the pointer position is
 * resolved to the nearest text node (caretRangeFromPoint /
 * caretPositionFromPoint) whose first 40 chars become anchorText, plus an
 * offsetRatio (0–1 within the message) as the re-anchor fallback under any
 * zoom/reflow.
 *
 * Failure behavior: unmapped rows never show the button; if no text node is
 * under the pointer, the anchor degrades to offsetRatio only.
 */
import { clamp, rafThrottle } from "../../shared/util";
import type { Ctx, Feature } from "../ctx";
import type { GutterAnchor, NoteCardManager } from "./note-cards";

export class CommentsFeature implements Feature {
  readonly id = "comments" as const;

  private enabled = false;
  private lastMouse: { x: number; y: number; target: Element } | null = null;
  private buttonShown = false;
  /** Rect of the row the visible button belongs to (the "corridor" band). */
  private shownRowRect: DOMRect | null = null;

  constructor(
    private ctx: Ctx,
    private cards: NoteCardManager
  ) {
    const process = rafThrottle(() => this.processHover());
    document.addEventListener(
      "mousemove",
      (ev) => {
        if (!this.enabled) return;
        this.lastMouse =
          ev.target instanceof Element ? { x: ev.clientX, y: ev.clientY, target: ev.target } : null;
        process();
      },
      { passive: true }
    );
    document.addEventListener("mouseleave", () => this.hide());
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.cards.setKindEnabled("comment", on);
    if (!on) this.hide();
  }

  onConversation(): void {
    this.hide();
  }

  private processHover(): void {
    if (!this.enabled || !this.lastMouse) return;
    // a live selection means the notes flow is in charge
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
      this.hide();
      return;
    }
    const { x, y, target } = this.lastMouse;
    // Pointer over our own gutter (shadow events retarget to the host):
    // the user is traveling to / hovering the button — keep it.
    if (this.buttonShown && target.closest("#pt-gutter-host")) return;
    const row = this.ctx.domMap.rowForElement(target);
    if (!row || row.sender !== "assistant" || !row.uuid) {
      // Corridor: between the message's right edge and the gutter, within the
      // row's vertical band — the pointer is en route to the button; keep it.
      const band = this.shownRowRect;
      if (
        this.buttonShown &&
        band &&
        y >= band.top - 8 &&
        y <= band.bottom + 8 &&
        x >= band.right - 4
      ) {
        return;
      }
      this.hide();
      return;
    }
    const conversationUuid = this.ctx.getCurrentConversation();
    if (!conversationUuid) return;
    const anchorMessageUuid = row.uuid;
    const rowEl = row.el;
    this.buttonShown = true;
    this.shownRowRect = rowEl.getBoundingClientRect();
    this.cards.showEntryButton("comment", y, null, () => {
      const anchor = this.buildAnchor(conversationUuid, anchorMessageUuid, rowEl, x, y);
      this.hide();
      this.cards.openComposer("comment", anchor, null);
    });
  }

  private buildAnchor(
    conversationUuid: string,
    anchorMessageUuid: string,
    rowEl: HTMLElement,
    x: number,
    y: number
  ): GutterAnchor {
    const rect = rowEl.getBoundingClientRect();
    const offsetRatio = clamp(rect.height > 0 ? (y - rect.top) / rect.height : 0, 0, 1);
    let anchorText: string | undefined;
    const caretNode = caretNodeFromPoint(x, y);
    if (caretNode && rowEl.contains(caretNode) && caretNode.nodeType === Node.TEXT_NODE) {
      const data = (caretNode as Text).data;
      if (data.trim()) anchorText = data.slice(0, 40);
    }
    return { kind: "comment", conversationUuid, anchorMessageUuid, anchorText, offsetRatio };
  }

  private hide(): void {
    if (!this.buttonShown) return;
    this.buttonShown = false;
    this.shownRowRect = null;
    this.cards.hideEntryButton("comment");
  }
}

/** caretRangeFromPoint with the standards-track fallback. */
function caretNodeFromPoint(x: number, y: number): Node | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node } | null;
  };
  try {
    if (typeof doc.caretRangeFromPoint === "function") {
      return doc.caretRangeFromPoint(x, y)?.startContainer ?? null;
    }
    if (typeof doc.caretPositionFromPoint === "function") {
      return doc.caretPositionFromPoint(x, y)?.offsetNode ?? null;
    }
  } catch {
    /* out-of-document coordinates */
  }
  return null;
}
