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
   * The message TEXT element of a row — for highlight effects that must not
   * cover the hover-toolbar space under the text. Human rows have the
   * user-message hook; assistant rows use the direct child holding the most
   * text that doesn't contain the action bar. Falls back to the row itself.
   */
  contentElOf(row: DomRow): HTMLElement {
    if (row.sender === "human") {
      const el = row.el.querySelector<HTMLElement>(sel("userMessage"));
      if (el) return el;
    }
    let best: HTMLElement | null = null;
    let bestLen = 0;
    for (const child of row.el.children) {
      if (!(child instanceof HTMLElement)) continue;
      if (child.querySelector(sel("actionBarCopy")) || child.querySelector(sel("actionBarRetry"))) continue;
      const len = (child.textContent ?? "").length;
      if (len > bestLen) {
        bestLen = len;
        best = child;
      }
    }
    return best ?? row.el;
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

    // Align to the active path by sender sequence.
    if (tree) {
      const path: TreeNode[] = tree.activePath();
      let pathIdx = 0;
      for (const row of domRows) {
        while (pathIdx < path.length && path[pathIdx]!.sender !== row.sender) pathIdx++;
        if (pathIdx < path.length) {
          row.uuid = path[pathIdx]!.uuid;
          pathIdx++;
        }
      }
    }

    this.rows = domRows;
    for (const row of domRows) {
      if (row.uuid) this.byUuid.set(row.uuid, row);
    }

    // Scroll container: nearest scrollable ancestor of the message list.
    let sc: HTMLElement | null = container;
    while (sc) {
      const style = getComputedStyle(sc);
      if (
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        sc.scrollHeight > sc.clientHeight + 4
      ) {
        break;
      }
      sc = sc.parentElement;
    }
    this.scrollContainer =
      sc ?? (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
  }
}
