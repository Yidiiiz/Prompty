/**
 * content/features/note-cards.ts — the shared gutter/card manager behind
 * Features 3 (Notes) and 4 (Comments).
 *
 * Owns, for the current conversation:
 *  - the right-margin gutter column, mounted INSIDE the message-list
 *    container so cards scroll with their messages;
 *  - anchor resolution each observer tick (quote/prefix/suffix/charOffset for
 *    notes; anchorText/offsetRatio for comments) against rendered text;
 *  - card rendering (quote, question, streamed/markdown reply, expand,
 *    delete), Google-Docs-style collision push-down, and connector lines;
 *  - the single note/comment composer (typed in the gutter, never the main
 *    composer) and the whole submit flow: build the !@#%NOTE!@ prompt, send
 *    as a side branch via the page script, persist anchoring metadata the
 *    moment the pre-generated uuids are known, stream into the card;
 *  - the fullscreen modal; the unanchored-notes drawer feed for the panel.
 *
 * Note content is read from Claude's own tree (the side branch persists
 * server-side); chrome.storage holds only anchoring metadata. Deleting a note
 * removes local metadata and the card; the branch remains, orphaned and
 * harmless.
 *
 * Failure behavior: an unresolvable quote pins the card to the message top
 * flagged "anchor moved"; a missing anchor message routes the note to the
 * panel's unanchored drawer; a failed send renders a failed card that can be
 * retried only by re-asking (the draft text is preserved by autosave).
 */
import { cssVar, FONT_SANS, FONT_MONO } from "../../shared/tokens";
import { renderMarkdown } from "../../shared/markdown";
import { buildNotePrompt, parseNotePrompt, type NoteMeta } from "../../shared/note-protocol";
import { summarizer } from "../../shared/summary";
import { uuidv7 } from "../../shared/uuid";
import {
  deleteNote,
  getNotes,
  saveNote,
  type NoteRecord,
} from "../../shared/storage";
import { clamp } from "../../shared/util";
import type { ConversationTree } from "../../shared/tree";
import { subscribe } from "../observer";
import { toastOnce } from "../toast";
import type { Ctx } from "../ctx";
import { findAnchorText, findQuote, firstLineRect, indexText, type TextIndex } from "./anchoring";

const GUTTER_WIDTH = 300;
const GUTTER_MIN_WIDTH = 200;
const CARD_GAP = 8;

export type GutterAnchor = Omit<NoteRecord, "noteId" | "noteBranchRootUuid" | "createdAt">;

interface LiveState {
  question: string;
  reply: string;
  status: "sending" | "streaming" | "done" | "failed";
  reason?: string;
}

interface ResolvedCard {
  record: NoteRecord;
  y: number;
  anchorState: "ok" | "moved";
  question: string;
  reply: string;
  status: LiveState["status"] | "saved" | "missing";
}

interface ComposerState {
  kind: "note" | "comment";
  anchor: GutterAnchor;
  quoteDisplay: string | null;
  el: HTMLElement;
}

export class NoteCardManager {
  private kinds = { note: false, comment: false };
  private records: NoteRecord[] = [];
  private live = new Map<string, LiveState>();
  private host: HTMLElement | null = null;
  private layer: HTMLElement | null = null;
  private cardEls = new Map<string, HTMLElement>();
  private connEls = new Map<string, HTMLElement>();
  private entryButtons = new Map<string, HTMLElement>();
  private composer: ComposerState | null = null;
  private modalHost: HTMLElement | null = null;
  private lastUnanchoredSig = "";

  constructor(private ctx: Ctx) {
    subscribe(() => this.onTick());
    ctx.bus.on("conversation-changed", (msg) => {
      this.reset();
      if (msg.conversationUuid) void this.loadRecords(msg.conversationUuid);
    });
    ctx.bus.on("note-send-started", (msg) => {
      const record = this.records.find((r) => r.noteId === msg.noteId);
      if (record) {
        record.noteBranchRootUuid = msg.turnMessageUuids.human_message_uuid;
        void saveNote(record);
      }
      const live = this.live.get(msg.noteId);
      if (live) live.status = "streaming";
    });
    ctx.bus.on("note-stream-delta", (msg) => {
      const live = this.live.get(msg.noteId);
      if (live) {
        live.status = "streaming";
        live.reply += msg.text;
        this.updateCardContent(msg.noteId);
      }
    });
    ctx.bus.on("note-stream-done", (msg) => {
      const live = this.live.get(msg.noteId);
      if (live) {
        live.status = "done";
        live.reply = msg.text;
        this.updateCardContent(msg.noteId);
      }
    });
    ctx.bus.on("note-send-failed", (msg) => {
      const live = this.live.get(msg.noteId);
      if (live) {
        live.status = "failed";
        live.reason = msg.reason;
        this.updateCardContent(msg.noteId);
      }
      toastOnce(`note-failed-${msg.noteId}`, `Prompt Tree: note failed — ${msg.reason}`);
    });
    ctx.bus.on("unanchored-note-open", (msg) => this.openModal(msg.noteId));
    // initial conversation (constructor runs after navigation may have settled)
    const conv = ctx.getCurrentConversation();
    if (conv) void this.loadRecords(conv);
  }

  /* ------------------------------------------------------------ control */

  setKindEnabled(kind: "note" | "comment", on: boolean): void {
    if (this.kinds[kind] === on) return;
    this.kinds[kind] = on;
    if (!on) {
      this.hideEntryButton(kind);
      if (this.composer?.kind === kind) this.closeComposer();
    }
  }

  private get anyEnabled(): boolean {
    return this.kinds.note || this.kinds.comment;
  }

  private reset(): void {
    this.records = [];
    this.live.clear();
    this.cardEls.clear();
    this.connEls.clear();
    this.entryButtons.clear();
    this.composer = null;
    this.host?.remove();
    this.host = null;
    this.layer = null;
    this.modalHost?.remove();
    this.modalHost = null;
    this.lastUnanchoredSig = "";
  }

  private async loadRecords(conversationUuid: string): Promise<void> {
    const records = await getNotes(conversationUuid);
    if (this.ctx.getCurrentConversation() !== conversationUuid) return;
    this.records = records;
  }

  /* --------------------------------------------------------- gutter DOM */

  private ensureGutter(): HTMLElement | null {
    const container = this.ctx.domMap.container;
    if (!container) {
      this.host?.remove();
      this.host = null;
      this.layer = null;
      return null;
    }
    if (this.host?.isConnected && this.host.parentElement === container) return this.layer;
    this.host?.remove();
    if (getComputedStyle(container).position === "static") {
      // minimal, documented mutation: the gutter needs the message list as
      // its offset parent so cards scroll with their messages
      container.style.position = "relative";
    }
    this.host = document.createElement("div");
    this.host.id = "pt-gutter-host";
    this.host.style.cssText =
      "position:absolute;top:0;bottom:0;left:100%;width:0;pointer-events:none;z-index:20;";
    const shadow = this.host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = GUTTER_CSS;
    this.layer = document.createElement("div");
    this.layer.className = "layer";
    shadow.append(style, this.layer);
    container.appendChild(this.host);
    return this.layer;
  }

  /** Converts a viewport y to gutter (container-content) coordinates. */
  private toGutterY(viewportY: number): number {
    const container = this.ctx.domMap.container;
    if (!container) return 0;
    return viewportY - container.getBoundingClientRect().top;
  }

  private gutterWidth(): number {
    const container = this.ctx.domMap.container;
    if (!container) return GUTTER_MIN_WIDTH;
    const rect = container.getBoundingClientRect();
    const space = window.innerWidth - rect.right - 24;
    return clamp(space, GUTTER_MIN_WIDTH, GUTTER_WIDTH);
  }

  /* -------------------------------------------------------- entry points */

  /**
   * Shows (or moves) the gutter entry button for a kind at a container y.
   * `viewportAvoid` is a rect the button must not overlap (the native
   * selection popover); the button shifts down below it if needed.
   */
  showEntryButton(
    kind: "note" | "comment",
    viewportY: number,
    viewportAvoid: DOMRect | null,
    onClick: () => void
  ): void {
    if (!this.kinds[kind]) return;
    const layer = this.ensureGutter();
    if (!layer) return;
    let btn = this.entryButtons.get(kind) ?? null;
    if (!btn || !btn.isConnected) {
      const created = document.createElement("button");
      created.type = "button";
      created.className = `entry entry-${kind}`;
      created.title = kind === "note" ? "Add a note about the selection" : "Add a comment here";
      created.textContent = kind === "note" ? "✎" : "+";
      layer.appendChild(created);
      this.entryButtons.set(kind, created);
      btn = created;
    }
    // never overlap the native selection popover: it steals clicks
    let y = viewportY;
    if (viewportAvoid) {
      const container = this.ctx.domMap.container;
      const gutterLeft = container ? container.getBoundingClientRect().right : 0;
      const horizontalOverlap = viewportAvoid.right > gutterLeft;
      if (horizontalOverlap && viewportY < viewportAvoid.bottom + 14 && viewportY > viewportAvoid.top - 28) {
        y = viewportAvoid.bottom + 6;
      }
    }
    btn.style.top = `${Math.max(0, Math.round(this.toGutterY(y)))}px`;
    btn.onclick = (ev) => {
      ev.stopPropagation();
      onClick();
    };
  }

  hideEntryButton(kind: "note" | "comment"): void {
    this.entryButtons.get(kind)?.remove();
    this.entryButtons.delete(kind);
  }

  /* ------------------------------------------------------------ composer */

  openComposer(kind: "note" | "comment", anchor: GutterAnchor, quoteDisplay: string | null, initialText = ""): void {
    if (!this.kinds[kind]) return;
    const layer = this.ensureGutter();
    if (!layer) {
      toastOnce("gutter-missing", "Prompt Tree: chat layout not recognized — notes are unavailable.");
      return;
    }
    this.closeComposer();
    const el = document.createElement("div");
    el.className = "card composer";
    const quoteHtml = quoteDisplay
      ? `<div class="quote"></div>`
      : `<div class="quote plain">${kind === "comment" ? "Comment" : "Note"}</div>`;
    el.innerHTML = `
      ${quoteHtml}
      <textarea rows="3" placeholder="${kind === "note" ? "Ask about the highlighted text…" : "Ask about this part of the reply…"}"></textarea>
      <div class="foot">
        <button class="primary" type="button">Ask</button>
        <button class="ghost" type="button">Cancel</button>
      </div>`;
    if (quoteDisplay) el.querySelector(".quote")!.textContent = `“${quoteDisplay.slice(0, 120)}”`;
    const textarea = el.querySelector("textarea")!;
    textarea.value = initialText;
    textarea.addEventListener("input", () => {
      const conversationUuid = this.ctx.getCurrentConversation();
      if (!conversationUuid) return;
      this.ctx.bus.emit("note-composer-input", {
        conversationUuid,
        kind,
        anchor: anchor as unknown as Record<string, unknown> & { anchorMessageUuid: string },
        text: textarea.value,
      });
    });
    textarea.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") this.closeComposer();
      if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) submit();
    });
    const submit = () => {
      const text = textarea.value.trim();
      if (!text) return;
      this.closeComposer();
      this.submitNote(kind, anchor, text);
    };
    el.querySelector<HTMLButtonElement>("button.primary")!.addEventListener("click", submit);
    el.querySelector<HTMLButtonElement>("button.ghost")!.addEventListener("click", () => this.closeComposer());
    layer.appendChild(el);
    this.composer = { kind, anchor, quoteDisplay, el };
    textarea.focus();
  }

  closeComposer(): void {
    if (!this.composer) return;
    this.composer.el.remove();
    this.composer = null;
    const conversationUuid = this.ctx.getCurrentConversation();
    if (conversationUuid) this.ctx.bus.emit("note-composer-closed", { conversationUuid });
  }

  /* -------------------------------------------------------------- submit */

  submitNote(kind: "note" | "comment", anchor: GutterAnchor, question: string): void {
    const conversationUuid = this.ctx.getCurrentConversation();
    const tree = this.ctx.getTree();
    if (!conversationUuid || !tree) return;
    const meta: NoteMeta =
      kind === "note"
        ? {
            anchorUuid: anchor.anchorMessageUuid,
            quote: anchor.quote ?? "",
            charOffset: anchor.charOffset ?? 0,
          }
        : {
            anchorUuid: anchor.anchorMessageUuid,
            kind: "comment",
            context: this.commentContext(tree, anchor),
          };
    const noteId = uuidv7();
    const record: NoteRecord = {
      noteId,
      kind,
      conversationUuid,
      anchorMessageUuid: anchor.anchorMessageUuid,
      noteBranchRootUuid: "", // filled from the pre-generated uuid at note-send-started
      quote: anchor.quote,
      prefix: anchor.prefix,
      suffix: anchor.suffix,
      charOffset: anchor.charOffset,
      anchorText: anchor.anchorText,
      offsetRatio: anchor.offsetRatio,
      createdAt: Date.now(),
    };
    this.records.push(record);
    this.live.set(noteId, { question, reply: "", status: "sending" });
    // Restore point: the deepest non-note message of the active path — the
    // main thread continues from here after the side branch completes.
    const visible = tree.visiblePath();
    const restoreLeafUuid = visible.length ? visible[visible.length - 1]!.uuid : tree.activeLeafUuid;
    this.ctx.sendToPage({
      type: "send-side-branch",
      noteId,
      conversationUuid,
      parentMessageUuid: anchor.anchorMessageUuid,
      prompt: buildNotePrompt(meta, question),
      restoreLeafUuid,
    });
  }

  /** Surrounding ~200 chars of the anchor message's text, in place of a quote. */
  private commentContext(tree: ConversationTree, anchor: GutterAnchor): string {
    const text = tree.nodes.get(anchor.anchorMessageUuid)?.text ?? "";
    if (!text) return "";
    let center = 0;
    if (anchor.anchorText) {
      const pos = text.indexOf(anchor.anchorText);
      if (pos >= 0) center = pos + Math.floor(anchor.anchorText.length / 2);
      else if (anchor.offsetRatio !== undefined) center = Math.floor(text.length * anchor.offsetRatio);
    } else if (anchor.offsetRatio !== undefined) {
      center = Math.floor(text.length * anchor.offsetRatio);
    }
    const start = clamp(center - 100, 0, Math.max(0, text.length - 200));
    return text.slice(start, start + 200);
  }

  /* ------------------------------------------------------ delete / modal */

  private async removeNote(noteId: string): Promise<void> {
    const conversationUuid = this.ctx.getCurrentConversation();
    this.records = this.records.filter((r) => r.noteId !== noteId);
    this.live.delete(noteId);
    this.cardEls.get(noteId)?.remove();
    this.cardEls.delete(noteId);
    this.connEls.get(noteId)?.remove();
    this.connEls.delete(noteId);
    if (conversationUuid) await deleteNote(conversationUuid, noteId);
    this.lastUnanchoredSig = ""; // force the drawer feed to re-emit next tick
  }

  openModal(noteId: string): void {
    const record = this.records.find((r) => r.noteId === noteId);
    if (!record) return;
    const content = this.resolveContent(record);
    this.modalHost?.remove();
    const host = document.createElement("div");
    host.id = "pt-note-modal";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = MODAL_CSS;
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-label="Note">
        <div class="head">
          <span class="kind">${record.kind === "comment" ? "Comment" : "Note"}</span>
          <button class="close" type="button" aria-label="Close">✕</button>
        </div>
        ${record.quote ? `<blockquote class="quote"></blockquote>` : ""}
        <div class="question"></div>
        <div class="answer md"></div>
      </div>`;
    if (record.quote) overlay.querySelector(".quote")!.textContent = record.quote;
    overlay.querySelector(".question")!.textContent = content.question;
    overlay.querySelector(".answer")!.innerHTML = renderMarkdown(content.reply || "(no reply)");
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) host.remove();
    });
    overlay.querySelector(".close")!.addEventListener("click", () => host.remove());
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        host.remove();
        document.removeEventListener("keydown", onKey, true);
      }
    };
    document.addEventListener("keydown", onKey, true);
    shadow.append(style, overlay);
    document.body.appendChild(host);
    this.modalHost = host;
  }

  /* ----------------------------------------------------- content lookup */

  /** Question/reply for a record: live stream first, else Claude's tree. */
  private resolveContent(record: NoteRecord): { question: string; reply: string; status: ResolvedCard["status"] } {
    const live = this.live.get(record.noteId);
    if (live && live.status !== "done") {
      return { question: live.question, reply: live.reply, status: live.status };
    }
    const tree = this.ctx.getTree();
    const root = record.noteBranchRootUuid ? tree?.nodes.get(record.noteBranchRootUuid) : undefined;
    if (root) {
      const parsed = parseNotePrompt(root.text);
      const question = parsed?.question ?? live?.question ?? "(question unavailable)";
      const children = root.children
        .map((u) => tree!.nodes.get(u))
        .filter((n): n is NonNullable<typeof n> => !!n)
        .sort((a, b) => b.index - a.index);
      const reply = children[0]?.text ?? live?.reply ?? "";
      return { question, reply, status: live?.status ?? "saved" };
    }
    if (live) return { question: live.question, reply: live.reply, status: live.status };
    return { question: "(note content unavailable)", reply: "", status: "missing" };
  }

  /* -------------------------------------------------------- tick / layout */

  private onTick(): void {
    if (!this.anyEnabled) return;
    const conversationUuid = this.ctx.getCurrentConversation();
    const tree = this.ctx.getTree();
    const layer = this.ensureGutter();
    if (!conversationUuid || !tree || !layer || !this.ctx.domMap.container) return;

    const width = this.gutterWidth();
    const widthPx = `${width}px`;
    if (this.host && this.host.style.width !== widthPx) {
      this.host.style.width = widthPx;
      // squeeze toward the content edge when the window is narrow
      const container = this.ctx.domMap.container;
      const space = window.innerWidth - container.getBoundingClientRect().right - 24;
      const overlapLeft = space < width ? `${Math.round(space - width)}px` : "12px";
      this.host.style.marginLeft = overlapLeft;
    }

    /* read phase: resolve anchors */
    const indexCache = new Map<HTMLElement, TextIndex>();
    const resolved: ResolvedCard[] = [];
    const unanchored: NoteRecord[] = [];
    for (const record of this.records) {
      if (!this.kinds[record.kind]) continue;
      const row = this.ctx.domMap.rowByUuid(record.anchorMessageUuid);
      if (!row) {
        if (tree.nodes.has(record.anchorMessageUuid)) continue; // off-path or unrendered: no card, not unanchored
        unanchored.push(record);
        continue;
      }
      let index = indexCache.get(row.el);
      if (!index) {
        index = indexText(row.el);
        indexCache.set(row.el, index);
      }
      const rowRect = row.el.getBoundingClientRect();
      let y: number;
      let anchorState: ResolvedCard["anchorState"] = "ok";
      if (record.kind === "note") {
        const match = findQuote(index, record.quote ?? "", record.prefix, record.suffix, record.charOffset);
        const rect = match ? firstLineRect(index, match.start, match.end) : null;
        if (rect) {
          y = this.toGutterY(rect.top);
        } else {
          y = this.toGutterY(rowRect.top);
          anchorState = "moved"; // quote edited away: pin to message top, flagged
        }
      } else {
        const pos = record.anchorText ? findAnchorText(index, record.anchorText) : null;
        const rect = pos !== null ? firstLineRect(index, pos, pos + (record.anchorText?.length ?? 1)) : null;
        y = rect
          ? this.toGutterY(rect.top)
          : this.toGutterY(rowRect.top) + rowRect.height * (record.offsetRatio ?? 0);
      }
      const content = this.resolveContent(record);
      resolved.push({ record, y: Math.max(0, y), anchorState, ...content });
    }

    /* write phase: cards */
    const seen = new Set<string>();
    for (const card of resolved) {
      seen.add(card.record.noteId);
      let el = this.cardEls.get(card.record.noteId) ?? null;
      if (!el || !el.isConnected) {
        el = this.buildCardEl(card.record);
        layer.appendChild(el);
        this.cardEls.set(card.record.noteId, el);
      }
      this.renderCard(el, card);
    }
    for (const [noteId, el] of this.cardEls) {
      if (!seen.has(noteId)) {
        el.remove();
        this.cardEls.delete(noteId);
        this.connEls.get(noteId)?.remove();
        this.connEls.delete(noteId);
      }
    }

    /* layout: sort by anchor y, push down on collision, draw connectors */
    interface Placed {
      el: HTMLElement;
      anchorY: number;
      noteId: string | null;
    }
    const placed: Placed[] = resolved
      .map((c) => ({ el: this.cardEls.get(c.record.noteId)!, anchorY: c.y, noteId: c.record.noteId }))
      .filter((p) => !!p.el);
    if (this.composer?.el.isConnected) {
      const anchorY = this.resolveComposerY() ?? 0;
      placed.push({ el: this.composer.el, anchorY, noteId: null });
    }
    placed.sort((a, b) => a.anchorY - b.anchorY);
    let cursor = 0;
    for (const p of placed) {
      const top = Math.max(p.anchorY, cursor);
      const topPx = `${Math.round(top)}px`;
      if (p.el.style.top !== topPx) p.el.style.top = topPx;
      cursor = top + p.el.offsetHeight + CARD_GAP;
      if (p.noteId) this.placeConnector(layer, p.noteId, p.anchorY, top);
    }

    this.emitUnanchoredList(unanchored);
  }

  /** The composer tracks its anchor like a card does. */
  private resolveComposerY(): number | null {
    const composer = this.composer;
    if (!composer) return null;
    const row = this.ctx.domMap.rowByUuid(composer.anchor.anchorMessageUuid);
    if (!row) return null;
    const index = indexText(row.el);
    const rowRect = row.el.getBoundingClientRect();
    if (composer.kind === "note") {
      const match = findQuote(
        index,
        composer.anchor.quote ?? "",
        composer.anchor.prefix,
        composer.anchor.suffix,
        composer.anchor.charOffset
      );
      const rect = match ? firstLineRect(index, match.start, match.end) : null;
      return this.toGutterY(rect ? rect.top : rowRect.top);
    }
    const pos = composer.anchor.anchorText ? findAnchorText(index, composer.anchor.anchorText) : null;
    const rect =
      pos !== null ? firstLineRect(index, pos, pos + (composer.anchor.anchorText?.length ?? 1)) : null;
    return rect
      ? this.toGutterY(rect.top)
      : this.toGutterY(rowRect.top) + rowRect.height * (composer.anchor.offsetRatio ?? 0);
  }

  private placeConnector(layer: HTMLElement, noteId: string, anchorY: number, cardTop: number): void {
    let conn = this.connEls.get(noteId) ?? null;
    if (!conn || !conn.isConnected) {
      conn = document.createElement("div");
      conn.className = "conn";
      layer.appendChild(conn);
      this.connEls.set(noteId, conn);
    }
    const top = Math.round(Math.min(anchorY, cardTop + 14));
    const height = Math.max(1, Math.round(Math.abs(cardTop + 14 - anchorY)));
    const style = `top:${top}px;height:${height}px;`;
    if (conn.getAttribute("data-geo") !== style) {
      conn.setAttribute("data-geo", style);
      conn.style.cssText = style;
    }
  }

  /* ------------------------------------------------------- card elements */

  private buildCardEl(record: NoteRecord): HTMLElement {
    const el = document.createElement("div");
    el.className = "card";
    el.innerHTML = `
      <div class="quote"></div>
      <div class="moved">anchor moved</div>
      <div class="q"></div>
      <div class="a"></div>
      <div class="foot">
        <span class="status"></span>
        <button class="icon expand" type="button" title="Expand">⤢</button>
        <button class="icon delete" type="button" title="Delete note">🗑</button>
      </div>`;
    el.querySelector<HTMLElement>(".quote")!.textContent = record.quote
      ? `“${record.quote.slice(0, 120)}”`
      : record.kind === "comment"
        ? "Comment"
        : "Note";
    el.querySelector<HTMLButtonElement>(".expand")!.addEventListener("click", () =>
      this.openModal(record.noteId)
    );
    el.querySelector<HTMLButtonElement>(".delete")!.addEventListener("click", () => {
      void this.removeNote(record.noteId);
    });
    return el;
  }

  private renderCard(el: HTMLElement, card: ResolvedCard): void {
    const movedEl = el.querySelector<HTMLElement>(".moved")!;
    const wantMoved = card.anchorState === "moved" ? "block" : "none";
    if (movedEl.style.display !== wantMoved) movedEl.style.display = wantMoved;
    const qEl = el.querySelector<HTMLElement>(".q")!;
    if (qEl.textContent !== card.question) qEl.textContent = card.question;
    this.renderReply(el, card.reply, card.status);
  }

  private updateCardContent(noteId: string): void {
    const el = this.cardEls.get(noteId);
    const record = this.records.find((r) => r.noteId === noteId);
    if (!el || !record) return;
    const content = this.resolveContent(record);
    const qEl = el.querySelector<HTMLElement>(".q")!;
    if (qEl.textContent !== content.question) qEl.textContent = content.question;
    this.renderReply(el, content.reply, content.status);
  }

  private renderReply(el: HTMLElement, reply: string, status: ResolvedCard["status"]): void {
    const aEl = el.querySelector<HTMLElement>(".a")!;
    const statusEl = el.querySelector<HTMLElement>(".status")!;
    const statusText =
      status === "sending"
        ? "sending…"
        : status === "streaming"
          ? "thinking…"
          : status === "failed"
            ? "failed"
            : status === "missing"
              ? "content unavailable"
              : "";
    if (statusEl.textContent !== statusText) statusEl.textContent = statusText;
    const mode = status === "streaming" || status === "sending" ? "text" : "md";
    if (el.getAttribute("data-mode") !== mode || el.getAttribute("data-len") !== String(reply.length)) {
      el.setAttribute("data-mode", mode);
      el.setAttribute("data-len", String(reply.length));
      if (mode === "text") aEl.textContent = reply;
      else aEl.innerHTML = renderMarkdown(reply);
    }
  }

  /* --------------------------------------------------- unanchored drawer */

  private emitUnanchoredList(unanchored: NoteRecord[]): void {
    const conversationUuid = this.ctx.getCurrentConversation();
    if (!conversationUuid) return;
    const items = unanchored.map((r) => ({
      noteId: r.noteId,
      label: summarizer.summarize(this.resolveContent(r).question, 6),
    }));
    const sig = JSON.stringify(items);
    if (sig === this.lastUnanchoredSig) return;
    this.lastUnanchoredSig = sig;
    this.ctx.bus.emit("unanchored-notes", { conversationUuid, items });
  }
}

/* --------------------------------------------------------------- styles */

const CARD_BASE_CSS = `
  .card {
    position: absolute;
    left: 0;
    width: calc(100% - 8px);
    pointer-events: auto;
    font-family: ${FONT_SANS};
    font-size: 12px;
    line-height: 1.45;
    color: ${cssVar("--text-200")};
    background: ${cssVar("--bg-000")};
    border: 1px solid ${cssVar("--border-300")};
    border-radius: 10px;
    box-shadow: 0 1px 6px hsl(0 0% 0% / 0.07);
    padding: 8px 10px;
    transition: top 160ms ease;
  }
  .card .quote {
    font-size: 11px;
    color: ${cssVar("--text-400")};
    border-left: 2px solid ${cssVar("--accent-main-100", 0.5)};
    padding-left: 6px;
    margin-bottom: 5px;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .card .quote.plain { border-left-color: ${cssVar("--accent-secondary-100", 0.5)}; }
  .card .moved {
    display: none;
    font-size: 10px;
    color: ${cssVar("--danger-100")};
    margin-bottom: 4px;
  }
  .card .q { font-weight: 600; color: ${cssVar("--text-100")}; margin-bottom: 4px; white-space: pre-wrap; }
  .card .a { white-space: normal; overflow-wrap: anywhere; max-height: 220px; overflow-y: auto; }
  .card .a p { margin: 0 0 6px 0; }
  .card .a p:last-child { margin-bottom: 0; }
  .card .a pre { background: ${cssVar("--bg-200")}; border-radius: 6px; padding: 6px; overflow-x: auto; }
  .card .a code { font-family: ${FONT_MONO}; font-size: 11px; }
  .card .foot { display: flex; align-items: center; gap: 4px; margin-top: 6px; }
  .card .status { flex: 1; font-size: 10.5px; color: ${cssVar("--text-400")}; font-style: italic; }
  .card .icon {
    border: none; background: none; cursor: pointer; padding: 2px 4px;
    color: ${cssVar("--text-400")}; font-size: 12px; border-radius: 6px; font-family: inherit;
  }
  .card .icon:hover { background: ${cssVar("--bg-300")}; color: ${cssVar("--text-100")}; }
  .card textarea {
    width: 100%; box-sizing: border-box; resize: vertical;
    font-family: ${FONT_SANS}; font-size: 12px; color: ${cssVar("--text-100")};
    background: ${cssVar("--bg-100")};
    border: 1px solid ${cssVar("--border-200")};
    border-radius: 8px; padding: 6px 8px; outline: none;
  }
  .card textarea:focus { border-color: ${cssVar("--accent-main-100")}; }
  .card .foot .primary {
    border: none; cursor: pointer; border-radius: 8px; padding: 4px 12px;
    background: ${cssVar("--accent-main-100")}; color: ${cssVar("--oncolor-100")};
    font-family: inherit; font-size: 12px;
  }
  .card .foot .primary:hover { background: ${cssVar("--accent-main-200")}; }
  .card .foot .ghost {
    border: 1px solid ${cssVar("--border-200")}; background: none; cursor: pointer;
    border-radius: 8px; padding: 3px 10px; color: ${cssVar("--text-300")};
    font-family: inherit; font-size: 12px;
  }
`;

const GUTTER_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .layer { position: relative; width: 100%; height: 100%; pointer-events: none; }
  ${CARD_BASE_CSS}
  .card.composer .foot { justify-content: flex-end; }
  .entry {
    position: absolute; left: -2px;
    pointer-events: auto; cursor: pointer;
    width: 24px; height: 24px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-family: ${FONT_SANS}; font-size: 13px; line-height: 1;
    color: ${cssVar("--accent-main-200")};
    background: ${cssVar("--bg-000")};
    border: 1px solid ${cssVar("--border-200")};
    box-shadow: 0 1px 4px hsl(0 0% 0% / 0.10);
    z-index: 5;
  }
  .entry:hover { background: ${cssVar("--accent-main-100", 0.1)}; }
  .conn {
    position: absolute; left: -10px; width: 9px;
    border-left: 1px solid ${cssVar("--accent-main-100", 0.45)};
    border-top: 1px solid ${cssVar("--accent-main-100", 0.45)};
    pointer-events: none;
  }
`;

const MODAL_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .overlay {
    position: fixed; inset: 0; z-index: 2147483100;
    background: hsl(0 0% 0% / 0.4);
    display: flex; align-items: center; justify-content: center;
  }
  .modal {
    font-family: ${FONT_SANS}; font-size: 14px; line-height: 1.55;
    color: ${cssVar("--text-100")};
    background: ${cssVar("--bg-000")};
    border: 1px solid ${cssVar("--border-300")};
    border-radius: 14px;
    box-shadow: 0 12px 40px hsl(0 0% 0% / 0.25);
    width: min(640px, calc(100vw - 48px));
    max-height: calc(100vh - 96px);
    overflow-y: auto;
    padding: 18px 22px;
  }
  .head { display: flex; align-items: center; margin-bottom: 10px; }
  .kind { flex: 1; font-size: 12px; font-weight: 600; color: ${cssVar("--text-400")}; text-transform: uppercase; letter-spacing: .05em; }
  .close { border: none; background: none; cursor: pointer; font-size: 14px; color: ${cssVar("--text-400")}; border-radius: 6px; padding: 4px 6px; font-family: inherit; }
  .close:hover { background: ${cssVar("--bg-300")}; color: ${cssVar("--text-100")}; }
  .quote {
    margin: 0 0 10px 0; padding: 6px 10px;
    border-left: 3px solid ${cssVar("--accent-main-100", 0.6)};
    background: ${cssVar("--bg-100")};
    color: ${cssVar("--text-300")}; font-size: 13px; border-radius: 0 8px 8px 0;
  }
  .question { font-weight: 600; margin-bottom: 10px; white-space: pre-wrap; }
  .answer p { margin: 0 0 10px 0; }
  .answer pre { background: ${cssVar("--bg-200")}; border-radius: 8px; padding: 10px; overflow-x: auto; }
  .answer code { font-family: ${FONT_MONO}; font-size: 13px; }
  .answer a { color: ${cssVar("--accent-secondary-100")}; }
`;
