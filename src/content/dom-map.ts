/**
 * content/dom-map.ts — maps rendered message rows in claude.ai's DOM to
 * message uuids in the ConversationTree's active path (and back).
 *
 * Strategy (all hooks from the selector registry — no inline selectors):
 *  1. User rows are identified by [data-testid="user-message"]; assistant
 *     rows by the presence of a copy/retry action bar. (The captures confirm
 *     no per-message uuid exists in the DOM, so identity comes from order.)
 *  2. The message-list container is the lowest ancestor containing all
 *     message markers; rows are its direct children holding one marker each.
 *  3. Rows are aligned to the model's active path by sender sequence: the
 *     rendered chat is exactly one root-to-leaf path, so the nth human row is
 *     the nth human message on the path, ditto assistant.
 *
 * KNOWN LIMITATION (flagged in the recon report): assistant rows have no
 * dedicated data-testid in the captures; the action-bar heuristic degrades if
 * that toolbar is restructured. Failure mode: rows go unmapped, features that
 * need mapping (panel click-scroll, branch ghosting, note anchoring) disable
 * gracefully per row rather than mis-targeting.
 */
import { qa, sel } from "../shared/selectors";
import { isNoteText } from "../shared/note-protocol";
import type { ConversationTree, TreeNode } from "../shared/tree";

export interface DomRow {
  el: HTMLElement;
  sender: "human" | "assistant";
  /** Mapped message uuid, or null if alignment failed for this row. */
  uuid: string | null;
}

export class DomMap {
  rows: DomRow[] = [];
  /** The message-list container (rows are its direct children). */
  container: HTMLElement | null = null;
  /** Nearest scrollable ancestor of the container (the chat scroll area). */
  scrollContainer: HTMLElement | null = null;

  private byUuid = new Map<string, DomRow>();

  rowByUuid(uuid: string): DomRow | null {
    return this.byUuid.get(uuid) ?? null;
  }

  /** Finds the mapped row containing an arbitrary descendant element. */
  rowForElement(el: Element): DomRow | null {
    for (const row of this.rows) {
      if (row.el.contains(el)) return row;
    }
    return null;
  }

  /**
   * True when a human row renders a note prompt. Reads the MESSAGE BODY
   * element, not the whole row — rows can start with toolbar/screen-reader
   * text that would defeat a prefix check on row.el.textContent.
   */
  static isNoteRow(row: DomRow): boolean {
    if (row.sender !== "human") return false;
    const body = row.el.querySelector<HTMLElement>(sel("userMessage"));
    return !!body && isNoteText((body.textContent ?? "").trimStart());
  }

  /**
   * The message BOX of a row — the element highlight effects should cover.
   * Prompts: the full bubble (the padded parent of the user-message text).
   * Responses: the deepest wrapper holding the reply text but NOT the hover
   * toolbar, found by descending out of any wrapper the toolbar shares with
   * the text. Falls back to the row itself.
   */
  contentElOf(row: DomRow): HTMLElement {
    if (row.sender === "human") {
      const textEl = row.el.querySelector<HTMLElement>(sel("userMessage"));
      if (textEl) {
        const bubble = textEl.parentElement;
        return bubble && bubble !== row.el ? bubble : textEl;
      }
      return row.el;
    }
    const hasBar = (el: HTMLElement) =>
      !!el.querySelector(sel("actionBarCopy")) || !!el.querySelector(sel("actionBarRetry"));
    let el: HTMLElement = row.el;
    for (let depth = 0; depth < 8 && hasBar(el); depth++) {
      const kids = [...el.children].filter((c): c is HTMLElement => c instanceof HTMLElement);
      // best text-holder that already excludes the toolbar
      let clean: HTMLElement | null = null;
      let cleanLen = 0;
      for (const kid of kids) {
        if (hasBar(kid)) continue;
        const len = (kid.textContent ?? "").length;
        if (len > cleanLen) {
          cleanLen = len;
          clean = kid;
        }
      }
      const shared = kids.find(hasBar) ?? null;
      const sharedLen = shared ? (shared.textContent ?? "").length : 0;
      if (clean && cleanLen >= sharedLen) return clean;
      if (shared) {
        el = shared; // text and toolbar share this wrapper — descend into it
        continue;
      }
      break;
    }
    return hasBar(el) ? row.el : el;
  }

  rebuild(tree: ConversationTree | null): void {
    this.rows = [];
    this.byUuid.clear();
    this.container = null;
    this.scrollContainer = null;

    const userEls = qa<HTMLElement>("userMessage");
    const copyEls = qa<HTMLElement>("actionBarCopy");
    const retryEls = qa<HTMLElement>("actionBarRetry");
    const markers: HTMLElement[] = [...userEls, ...copyEls, ...retryEls];
    if (!markers.length) return;

    // Lowest ancestor of the first marker containing every marker.
    let container: HTMLElement | null = markers[0]!;
    while (container && !markers.every((m) => container!.contains(m))) {
      container = container.parentElement;
    }
    if (!container || container === markers[0]) {
      // Degenerate (e.g. single not-yet-replied message): fall back so at
      // least scroll targeting works; row extraction below still functions
      // when the container has row children.
      container = markers[0]!.parentElement;
    }
    if (!container) return;
    this.container = container;

    // Rows: direct children of the container that hold at least one marker.
    const rowSet = new Set<HTMLElement>();
    for (const marker of markers) {
      let el: HTMLElement | null = marker;
      while (el && el.parentElement !== container) el = el.parentElement;
      if (el) rowSet.add(el);
    }
    const ordered = [...container.children].filter((c): c is HTMLElement =>
      rowSet.has(c as HTMLElement)
    );

    const domRows: DomRow[] = ordered.map((el) => ({
      el,
      sender: el.querySelector(sel("userMessage")) ? ("human" as const) : ("assistant" as const),
      uuid: null,
    }));

    // Align rows to the active path. Note pairs live ON the path but are
    // only rendered after a reload (the app never learns of them live), so
    // plain sender-order alignment would mis-map everything after a note.
    // Pass 1 maps rendered note rows (marker-prefixed text) to note nodes;
    // pass 2 maps everything else to the non-note nodes by sender order.
    if (tree) {
      const path: TreeNode[] = tree.activePath();
      const noteHumans = path.filter((n) => n.isNote && n.sender === "human");
      let noteIdx = 0;
      for (let i = 0; i < domRows.length; i++) {
        const row = domRows[i]!;
        if (!DomMap.isNoteRow(row)) continue;
        const node = noteHumans[noteIdx++];
        if (!node) break;
        row.uuid = node.uuid;
        const reply = path[path.indexOf(node) + 1];
        const nextRow = domRows[i + 1];
        if (reply?.isNote && reply.sender === "assistant" && nextRow?.sender === "assistant") {
          nextRow.uuid = reply.uuid;
          i++;
        }
      }
      const visibleNodes = path.filter((n) => !n.isNote);
      let pathIdx = 0;
      for (const row of domRows) {
        if (row.uuid) continue;
        while (pathIdx < visibleNodes.length && visibleNodes[pathIdx]!.sender !== row.sender) pathIdx++;
        if (pathIdx < visibleNodes.length) {
          row.uuid = visibleNodes[pathIdx]!.uuid;
          pathIdx++;
        }
      }
    }

    this.rows = domRows;
    for (const row of domRows) {
      if (row.uuid) this.byUuid.set(row.uuid, row);
    }

    // Scroll container: nearest scroll-styled ancestor of the message list.
    // Deliberately NOT conditioned on scrollHeight > clientHeight — a short
    // chat (e.g. right after switching the first message to a young branch)
    // isn't scrollable yet, but it is still THE chat viewport; falling back
    // to the document made every geometry consumer (panel position, gutter,
    // tracking) jump to the page edge and misbehave.
    let sc: HTMLElement | null = container;
    while (sc) {
      const style = getComputedStyle(sc);
      if ((style.overflowY === "auto" || style.overflowY === "scroll") && sc.clientHeight >= 200) {
        break;
      }
      sc = sc.parentElement;
    }
    this.scrollContainer = sc; // null when the layout isn't recognized
  }
}
