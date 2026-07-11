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
 *    it as a hidden IN-THREAD message parented to the current thread tail
 *    (no branch is created; the conversation — and its context — continues
 *    underneath the note), persist anchoring metadata the moment the
 *    pre-generated uuids are known, stream into the card;
 *  - the fullscreen modal; the unanchored/deleted drawer feed for the panel.
 *
 * Note content is read from the conversation tree itself (the hidden pair
 * persists server-side); chrome.storage holds only anchoring metadata.
 * Deleting a note is a soft delete: the card disappears but the record stays
 * restorable from the panel's "Deleted notes" drawer.
 *
 * Failure behavior: an unresolvable quote pins the card to the message top
 * flagged "anchor moved"; a missing anchor message routes the note to the
 * panel's unanchored drawer; a failed send renders a failed card that can be
 * retried only by re-asking (the draft text is preserved by autosave).
 */
import { cssVar, FONT_SANS, FONT_MONO, UI, Z_CONTENT, Z_EXTENSION_OVERLAY } from "../../shared/tokens";
import { renderMarkdown } from "../../shared/markdown";
import { buildNotePrompt, parseNotePrompt, type NoteMeta } from "../../shared/note-protocol";
import { summarizer } from "../../shared/summary";
import { uuidv7 } from "../../shared/uuid";
import { getNotes, saveNote, type NoteRecord } from "../../shared/storage";
import { clamp } from "../../shared/util";
import type { ConversationTree } from "../../shared/tree";
import { requestTick, subscribe } from "../observer";
import { toastOnce } from "../toast";
import { getComposerDockRect } from "../composer";
import type { Ctx } from "../ctx";
import { findAnchorText, findQuote, firstLineRect, indexText, type TextIndex } from "./anchoring";

const GUTTER_WIDTH = 300;
const GUTTER_MIN_WIDTH = 200;
const CARD_GAP = 8;

/**
 * claude.ai routes stray keystrokes to the main composer via document-level
 * handlers. Events inside our shadow roots retarget to the light-DOM host and
 * bubble on — stopping them here keeps typing inside note/comment textareas
 * without ever calling preventDefault (the inputs behave natively).
 */
function isolateInputEvents(host: HTMLElement): void {
  for (const type of ["keydown", "keypress", "keyup", "beforeinput", "input", "paste"]) {
    host.addEventListener(type, (ev) => ev.stopPropagation());
  }
}

export type GutterAnchor = Omit<NoteRecord, "noteId" | "noteBranchRootUuid" | "createdAt">;

/** One in-flight Q&A stream. Streams are keyed by a stream id: the record's
 *  noteId for the first pair, `noteId#<n>` for "Continue" follow-ups. */
interface LiveState {
  /** The owning record's noteId. */
  recordId: string;
  /** Human uuid of this pair, known from note-send-started onward. */
  rootUuid?: string;
  question: string;
  reply: string;
  status: "sending" | "streaming" | "done" | "failed";
  reason?: string;
}

type PairStatus = LiveState["status"] | "saved" | "missing";

/** One rendered Q&A of a card's thread. */
interface ThreadPair {
  question: string;
  reply: string;
  status: PairStatus;
}

interface ResolvedCard {
  record: NoteRecord;
  y: number;
  anchorState: "ok" | "moved";
  pairs: ThreadPair[];
}

interface ComposerState {
  kind: "note" | "comment";
  anchor: GutterAnchor;
  quoteDisplay: string | null;
  /** Set when this composer continues an existing card's thread. */
  followUpOf: NoteRecord | null;
  el: HTMLElement;
}

/** `noteId#3` → `noteId`; plain ids pass through. */
function baseNoteId(streamId: string): string {
  const hash = streamId.indexOf("#");
  return hash < 0 ? streamId : streamId.slice(0, hash);
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
      const humanUuid = msg.turnMessageUuids.human_message_uuid;
      const record = this.records.find((r) => r.noteId === baseNoteId(msg.noteId));
      if (record) {
        if (msg.noteId === record.noteId) {
          record.noteBranchRootUuid = humanUuid;
        } else {
          record.followUpRootUuids = [...(record.followUpRootUuids ?? []), humanUuid];
        }
        void saveNote(record);
      }
      const live = this.live.get(msg.noteId);
      if (live) {
        live.status = "streaming";
        live.rootUuid = humanUuid;
      }
    });
    ctx.bus.on("note-stream-delta", (msg) => {
      const live = this.live.get(msg.noteId);
      if (live) {
        live.status = "streaming";
        live.reply += msg.text;
        this.updateCardContent(baseNoteId(msg.noteId));
      }
    });
    ctx.bus.on("note-stream-done", (msg) => {
      const live = this.live.get(msg.noteId);
      if (live) {
        live.status = "done";
        live.reply = msg.text;
        this.updateCardContent(baseNoteId(msg.noteId));
      }
    });
    ctx.bus.on("note-send-failed", (msg) => {
      const live = this.live.get(msg.noteId);
      if (live) {
        live.status = "failed";
        live.reason = msg.reason;
        this.updateCardContent(baseNoteId(msg.noteId));
      }
      toastOnce(`note-failed-${msg.noteId}`, `Prompt Tree: note failed — ${msg.reason}`);
    });
    ctx.bus.on("unanchored-note-open", (msg) => this.openModal(msg.noteId));
    ctx.bus.on("deleted-note-restore", (msg) => void this.restoreNote(msg.noteId));
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
      `position:absolute;top:0;bottom:0;left:100%;width:0;pointer-events:none;z-index:${Z_CONTENT};`;
    isolateInputEvents(this.host);
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

  openComposer(
    kind: "note" | "comment",
    anchor: GutterAnchor,
    quoteDisplay: string | null,
    initialText = "",
    followUpOf: NoteRecord | null = null
  ): void {
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
      // hand the composer's position to the pending card so the swap is
      // seamless — the card mounts in the same frame the composer closes
      const topPx = this.composer?.el.style.top ?? "";
      this.closeComposer();
      if (followUpOf) this.submitFollowUp(followUpOf, text);
      else this.submitNote(kind, anchor, text, topPx);
    };
    el.querySelector<HTMLButtonElement>("button.primary")!.addEventListener("click", submit);
    el.querySelector<HTMLButtonElement>("button.ghost")!.addEventListener("click", () => this.closeComposer());
    // Position at the anchor BEFORE inserting and focus without scrolling —
    // focusing an unpositioned (top: 0) element would yank the page to the top.
    this.composer = { kind, anchor, quoteDisplay, followUpOf, el };
    const y = this.resolveComposerY();
    if (y !== null) el.style.top = `${Math.max(0, Math.round(y))}px`;
    layer.appendChild(el);
    textarea.focus({ preventScroll: true });
    requestTick(); // shadow-DOM insert doesn't wake the observer: lay out now
  }

  closeComposer(): void {
    if (!this.composer) return;
    this.composer.el.remove();
    this.composer = null;
    requestTick();
    const conversationUuid = this.ctx.getCurrentConversation();
    if (conversationUuid) this.ctx.bus.emit("note-composer-closed", { conversationUuid });
  }

  /* -------------------------------------------------------------- submit */

  private buildMeta(kind: "note" | "comment", anchor: GutterAnchor, tree: ConversationTree): NoteMeta {
    return kind === "note"
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
  }

  submitNote(
    kind: "note" | "comment",
    anchor: GutterAnchor,
    question: string,
    initialTopPx = ""
  ): void {
    const conversationUuid = this.ctx.getCurrentConversation();
    const tree = this.ctx.getTree();
    if (!conversationUuid || !tree) return;
    const meta = this.buildMeta(kind, anchor, tree);
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
    this.live.set(noteId, { recordId: noteId, question, reply: "", status: "sending" });
    // Mount the pending card immediately at the composer's position so the
    // send reads as the composer transforming into the card, not vanishing.
    const layer = this.ensureGutter();
    if (layer) {
      const el = this.buildCardEl(record);
      if (initialTopPx) el.style.top = initialTopPx;
      this.renderCard(el, {
        record,
        y: 0,
        anchorState: "ok",
        pairs: [{ question, reply: "", status: "sending" }],
      });
      layer.appendChild(el);
      this.cardEls.set(noteId, el);
      requestTick();
    }
    // The note goes ON the current branch: parent it to the real thread tail
    // (which may itself be a previous note's reply). No branch is created and
    // the conversation continues underneath — the anchor lives only in the
    // metadata JSON and the local record.
    const parentMessageUuid = tree.activeLeafUuid ?? anchor.anchorMessageUuid;
    this.ctx.sendToPage({
      type: "send-side-branch",
      noteId,
      conversationUuid,
      parentMessageUuid,
      prompt: buildNotePrompt(meta, question),
    });
  }

  /** "Continue": sends another hidden pair appended to an existing card. */
  submitFollowUp(record: NoteRecord, question: string): void {
    const conversationUuid = this.ctx.getCurrentConversation();
    const tree = this.ctx.getTree();
    if (!conversationUuid || !tree) return;
    const anchor = record as GutterAnchor & NoteRecord;
    const meta = this.buildMeta(record.kind, anchor, tree);
    // stream id ties the events back to this record without a second record
    const streamId = `${record.noteId}#${uuidv7().slice(0, 8)}`;
    this.live.set(streamId, { recordId: record.noteId, question, reply: "", status: "sending" });
    this.updateCardContent(record.noteId);
    requestTick();
    this.ctx.sendToPage({
      type: "send-side-branch",
      noteId: streamId,
      conversationUuid,
      parentMessageUuid: tree.activeLeafUuid ?? record.anchorMessageUuid,
      prompt: buildNotePrompt(meta, question),
    });
  }

  /** Opens the composer to continue an existing card's thread. */
  private openFollowUpComposer(record: NoteRecord): void {
    this.openComposer(record.kind, record as GutterAnchor & NoteRecord, record.quote ?? null, "", record);
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

  /** Soft delete: the card goes away instantly; the record stays restorable
   *  from the panel's "Deleted notes" drawer. */
  private async removeNote(noteId: string): Promise<void> {
    const record = this.records.find((r) => r.noteId === noteId);
    if (!record) return;
    record.deleted = true;
    this.cardEls.get(noteId)?.remove();
    this.cardEls.delete(noteId);
    this.connEls.get(noteId)?.remove();
    this.connEls.delete(noteId);
    this.lastUnanchoredSig = ""; // force the drawer feed to re-emit
    requestTick(); // shadow-DOM removal doesn't wake the observer: relayout now
    await saveNote(record);
  }

  private async restoreNote(noteId: string): Promise<void> {
    const record = this.records.find((r) => r.noteId === noteId);
    if (!record?.deleted) return;
    record.deleted = false;
    this.lastUnanchoredSig = "";
    requestTick();
    await saveNote(record);
  }

  openModal(noteId: string): void {
    const record = this.records.find((r) => r.noteId === noteId);
    if (!record) return;
    const pairs = this.resolveThread(record);
    this.modalHost?.remove();
    const host = document.createElement("div");
    host.id = "pt-note-modal";
    isolateInputEvents(host);
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
        ${pairs.map(() => `<div class="mpair"><div class="question"></div><div class="answer md"></div></div>`).join("")}
      </div>`;
    if (record.quote) overlay.querySelector(".quote")!.textContent = record.quote;
    const pairEls = overlay.querySelectorAll<HTMLElement>(".mpair");
    pairs.forEach((pair, i) => {
      pairEls[i]!.querySelector<HTMLElement>(".question")!.textContent = pair.question;
      pairEls[i]!.querySelector<HTMLElement>(".answer")!.innerHTML = renderMarkdown(
        pair.reply || "(no reply)"
      );
    });
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

  /** One Q&A pair from its human uuid, with an optional live overlay. */
  private resolvePair(rootUuid: string | undefined, live: LiveState | undefined): ThreadPair {
    if (live && live.status !== "done") {
      return { question: live.question, reply: live.reply, status: live.status };
    }
    const tree = this.ctx.getTree();
    const root = rootUuid ? tree?.nodes.get(rootUuid) : undefined;
    if (root) {
      const parsed = parseNotePrompt(root.text);
      const children = root.children
        .map((u) => tree!.nodes.get(u))
        .filter((n): n is NonNullable<typeof n> => !!n)
        .sort((a, b) => b.index - a.index);
      return {
        question: parsed?.question ?? live?.question ?? "(question unavailable)",
        reply: children[0]?.text ?? live?.reply ?? "",
        status: live?.status ?? "saved",
      };
    }
    if (live) return { question: live.question, reply: live.reply, status: live.status };
    return { question: "(note content unavailable)", reply: "", status: "missing" };
  }

  /** A card's full thread: the first pair, saved follow-ups, then any
   *  just-submitted follow-up whose uuid isn't known yet. */
  private resolveThread(record: NoteRecord): ThreadPair[] {
    const pairs: ThreadPair[] = [
      this.resolvePair(record.noteBranchRootUuid || undefined, this.live.get(record.noteId)),
    ];
    const followUpLives = [...this.live.entries()].filter(
      ([id, l]) => l.recordId === record.noteId && id !== record.noteId
    );
    const liveByRoot = new Map(
      followUpLives.filter(([, l]) => l.rootUuid).map(([, l]) => [l.rootUuid!, l])
    );
    for (const uuid of record.followUpRootUuids ?? []) {
      pairs.push(this.resolvePair(uuid, liveByRoot.get(uuid)));
    }
    for (const [, l] of followUpLives) {
      if (!l.rootUuid) pairs.push({ question: l.question, reply: l.reply, status: l.status });
    }
    return pairs;
  }

  /* -------------------------------------------------------- tick / layout */

  private onTick(): void {
    if (!this.anyEnabled) return;
    const conversationUuid = this.ctx.getCurrentConversation();
    const tree = this.ctx.getTree();
    const layer = this.ensureGutter();
    if (!conversationUuid || !tree || !layer || !this.ctx.domMap.container) return;

    /* geometry: stay right of the chat column AND clear of the prompt box
       (cards scroll past it vertically, so any horizontal overlap intrudes);
       when the margin can't fit the gutter, hide it entirely — never overlap. */
    const containerRect = this.ctx.domMap.container.getBoundingClientRect();
    let offset = 24;
    const dockRect = getComposerDockRect();
    if (dockRect && dockRect.right > containerRect.right + offset - 16) {
      offset = dockRect.right - containerRect.right + 16;
    }
    const fits = containerRect.right + offset + GUTTER_MIN_WIDTH <= window.innerWidth - 8;
    if (this.host) {
      const display = fits ? "" : "none";
      if (this.host.style.display !== display) this.host.style.display = display;
      if (!fits) return;
      const width = clamp(
        window.innerWidth - containerRect.right - offset - 8,
        GUTTER_MIN_WIDTH,
        GUTTER_WIDTH
      );
      const widthPx = `${Math.round(width)}px`;
      const marginPx = `${Math.round(offset)}px`;
      if (this.host.style.width !== widthPx) this.host.style.width = widthPx;
      if (this.host.style.marginLeft !== marginPx) this.host.style.marginLeft = marginPx;
    }

    /* read phase: resolve anchors */
    const indexCache = new Map<HTMLElement, TextIndex>();
    const resolved: ResolvedCard[] = [];
    const unanchored: NoteRecord[] = [];
    for (const record of this.records) {
      if (record.deleted || !this.kinds[record.kind]) continue;
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
      resolved.push({ record, y: Math.max(0, y), anchorState, pairs: this.resolveThread(record) });
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
      <div class="thread"></div>
      <div class="foot">
        <span class="status"></span>
        <button class="cont" type="button" title="Ask a follow-up in this note">Continue</button>
        <button class="icon expand" type="button" title="Expand">⤢</button>
        <button class="icon delete" type="button" title="Delete note">🗑</button>
      </div>`;
    el.querySelector<HTMLElement>(".quote")!.textContent = record.quote
      ? `“${record.quote.slice(0, 120)}”`
      : record.kind === "comment"
        ? "Comment"
        : "Note";
    el.querySelector<HTMLButtonElement>(".cont")!.addEventListener("click", () =>
      this.openFollowUpComposer(record)
    );
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
    this.renderThread(el, card.pairs);
  }

  private updateCardContent(noteId: string): void {
    const el = this.cardEls.get(noteId);
    const record = this.records.find((r) => r.noteId === noteId);
    if (!el || !record) return;
    this.renderThread(el, this.resolveThread(record));
  }

  private renderThread(el: HTMLElement, pairs: ThreadPair[]): void {
    const last = pairs[pairs.length - 1]!;
    const busy = last.status === "sending" || last.status === "streaming";
    const statusEl = el.querySelector<HTMLElement>(".status")!;
    const statusText =
      last.status === "sending"
        ? "sending"
        : last.status === "streaming"
          ? "thinking"
          : last.status === "failed"
            ? "failed"
            : last.status === "missing"
              ? "content unavailable"
              : "";
    if (statusEl.textContent !== statusText) statusEl.textContent = statusText;
    if (statusEl.classList.contains("busy") !== busy) statusEl.classList.toggle("busy", busy);
    const contBtn = el.querySelector<HTMLElement>(".cont");
    if (contBtn) {
      const display = busy || last.status === "missing" ? "none" : "";
      if (contBtn.style.display !== display) contBtn.style.display = display;
    }

    const sig = pairs.map((p) => `${p.status}:${p.question.length}:${p.reply.length}`).join("|");
    if (el.getAttribute("data-sig") === sig) return;
    el.setAttribute("data-sig", sig);
    const threadEl = el.querySelector<HTMLElement>(".thread")!;
    threadEl.innerHTML = pairs.map(() => `<div class="pair"><div class="q"></div><div class="a"></div></div>`).join("");
    const pairEls = threadEl.querySelectorAll<HTMLElement>(".pair");
    pairs.forEach((pair, i) => {
      const pairEl = pairEls[i]!;
      pairEl.querySelector<HTMLElement>(".q")!.textContent = pair.question;
      const answerEl = pairEl.querySelector<HTMLElement>(".a")!;
      if (pair.status === "sending" || pair.status === "streaming") answerEl.textContent = pair.reply;
      else answerEl.innerHTML = renderMarkdown(pair.reply);
    });
  }

  /* --------------------------------------------------- unanchored drawer */

  private emitUnanchoredList(unanchored: NoteRecord[]): void {
    const conversationUuid = this.ctx.getCurrentConversation();
    if (!conversationUuid) return;
    const label = (r: NoteRecord) => summarizer.summarize(this.resolveThread(r)[0]!.question, 6);
    const items = unanchored.map((r) => ({ noteId: r.noteId, label: label(r) }));
    const deletedItems = this.records
      .filter((r) => r.deleted && this.kinds[r.kind])
      .map((r) => ({ noteId: r.noteId, label: label(r) }));
    const sig = JSON.stringify([items, deletedItems]);
    if (sig === this.lastUnanchoredSig) return;
    this.lastUnanchoredSig = sig;
    this.ctx.bus.emit("unanchored-notes", { conversationUuid, items, deletedItems });
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
    line-height: 1.5;
    color: ${cssVar("--text-200")};
    background: ${cssVar("--bg-000")};
    border-radius: ${UI.radiusMd};
    box-shadow: ${UI.shadowSm};
    padding: 10px 12px;
    transition: top 160ms ease, box-shadow ${UI.transition};
    animation: pt-card-in 180ms ease-out;
  }
  @keyframes pt-card-in {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .card:hover { box-shadow: ${UI.shadowMd}; }
  .card:focus-within {
    box-shadow: inset 3px 0 0 0 ${cssVar("--accent-main-100", 0.55)}, ${UI.shadowMd};
    border-radius: 0 ${UI.radiusMd} ${UI.radiusMd} 0;
  }
  .card .quote {
    font-size: 11px;
    color: ${cssVar("--text-400")};
    background: ${cssVar("--bg-100")};
    border-left: 2px solid ${cssVar("--accent-main-100", 0.55)};
    border-radius: 0 6px 6px 0;
    padding: 3px 8px 3px 8px;
    margin-bottom: 7px;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .card .quote.plain { border-left-color: ${cssVar("--accent-secondary-100", 0.55)}; }
  .card .moved {
    display: none;
    font-size: 10px;
    color: ${cssVar("--danger-100")};
    margin-bottom: 5px;
  }
  .card .thread { max-height: 260px; overflow-y: auto; scrollbar-width: thin; }
  .card .pair + .pair {
    margin-top: 8px; padding-top: 8px;
    box-shadow: 0 -1px 0 0 ${cssVar("--border-300", 0.6)};
  }
  .card .q { font-weight: 600; color: ${cssVar("--text-100")}; margin-bottom: 5px; white-space: pre-wrap; }
  .card .a { white-space: normal; overflow-wrap: anywhere; }
  .card .a p { margin: 0 0 6px 0; }
  .card .a p:last-child { margin-bottom: 0; }
  .card .a pre { background: ${cssVar("--bg-200")}; border-radius: ${UI.radiusSm}; padding: 7px 8px; overflow-x: auto; }
  .card .a code { font-family: ${FONT_MONO}; font-size: 11px; }
  .card .a a { color: ${cssVar("--accent-secondary-100")}; }
  .card .foot { display: flex; align-items: center; gap: 4px; margin-top: 7px; }
  .card .status { flex: 1; font-size: 10.5px; color: ${cssVar("--text-400")}; font-style: italic; }
  .card .status.busy::after {
    content: "…";
    display: inline-block; width: 1em; text-align: left;
    animation: pt-dots 1.2s steps(4, end) infinite;
  }
  @keyframes pt-dots {
    0% { clip-path: inset(0 100% 0 0); }
    100% { clip-path: inset(0 -0.2em 0 0); }
  }
  .card .cont {
    border: none; background: none; cursor: pointer; padding: 3px 5px;
    color: ${cssVar("--accent-main-200")}; font-size: 11px; line-height: 1;
    border-radius: ${UI.radiusSm}; font-family: inherit; font-weight: 500;
    transition: color ${UI.transition};
  }
  .card .cont:hover { color: ${cssVar("--accent-main-100")}; text-decoration: underline; }
  .card .icon {
    border: none; background: none; cursor: pointer; padding: 3px 5px;
    color: ${cssVar("--text-400")}; font-size: 12px; line-height: 1;
    border-radius: ${UI.radiusSm}; font-family: inherit;
    transition: background ${UI.transition}, color ${UI.transition};
  }
  .card .icon:hover { background: ${cssVar("--bg-300")}; color: ${cssVar("--text-100")}; }
  .card .icon:focus-visible { outline: 2px solid ${cssVar("--accent-main-100", 0.6)}; outline-offset: 1px; }
  .card textarea {
    width: 100%; box-sizing: border-box; resize: vertical; min-height: 56px;
    font-family: ${FONT_SANS}; font-size: 12px; line-height: 1.5;
    color: ${cssVar("--text-100")};
    background: ${cssVar("--bg-100")};
    border: 1px solid ${cssVar("--border-200", 0.4)};
    border-radius: ${UI.radiusSm}; padding: 7px 9px; outline: none;
    transition: border-color ${UI.transition};
  }
  .card textarea::placeholder { color: ${cssVar("--text-500")}; }
  .card textarea:focus { border-color: ${cssVar("--accent-main-100")}; }
  .card .foot .primary {
    border: none; cursor: pointer; border-radius: ${UI.radiusSm}; padding: 5px 14px;
    background: ${cssVar("--accent-main-100")}; color: ${cssVar("--oncolor-100")};
    font-family: inherit; font-size: 12px; font-weight: 500;
    transition: background ${UI.transition}, transform ${UI.transition};
  }
  .card .foot .primary:hover { background: ${cssVar("--accent-main-200")}; }
  .card .foot .primary:active { transform: scale(0.98); }
  .card .foot .ghost {
    border: 1px solid ${cssVar("--border-200", 0.4)}; background: none; cursor: pointer;
    border-radius: ${UI.radiusSm}; padding: 4px 12px; color: ${cssVar("--text-400")};
    font-family: inherit; font-size: 12px;
    transition: background ${UI.transition}, color ${UI.transition};
  }
  .card .foot .ghost:hover { background: ${cssVar("--bg-300")}; color: ${cssVar("--text-100")}; }
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
    width: 26px; height: 26px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-family: ${FONT_SANS}; font-size: 13px; line-height: 1;
    color: ${cssVar("--text-300")};
    background: ${cssVar("--bg-000")};
    border: none;
    /* symmetric shadow — a round button with an offset shadow reads off-center */
    box-shadow: 0 0 0 0.5px ${cssVar("--border-300", 0.3)}, 0 0 6px ${cssVar("--always-black", 0.1)};
    z-index: 5;
    transition: background ${UI.transition}, color ${UI.transition}, transform ${UI.transition}, box-shadow ${UI.transition};
  }
  /* generous invisible hit area — the pointer travels from the text */
  .entry::after { content: ""; position: absolute; inset: -10px; border-radius: 50%; }
  .entry:hover {
    background: ${cssVar("--bg-200")};
    color: ${cssVar("--text-100")};
    box-shadow: 0 0 0 0.5px ${cssVar("--border-200", 0.4)}, 0 0 10px ${cssVar("--always-black", 0.14)};
  }
  .entry:focus-visible { outline: 2px solid ${cssVar("--accent-main-100", 0.6)}; outline-offset: 1px; }
  .conn {
    position: absolute; left: -10px; width: 9px;
    border-left: 1px solid ${cssVar("--border-200")};
    border-top: 1px solid ${cssVar("--border-200")};
    border-top-left-radius: 4px;
    pointer-events: none;
  }
`;

const MODAL_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .overlay {
    position: fixed; inset: 0; z-index: ${Z_EXTENSION_OVERLAY};
    background: hsl(0 0% 0% / 0.4);
    backdrop-filter: blur(4px);
    display: flex; align-items: center; justify-content: center;
    animation: pt-fade-in 140ms ease-out;
  }
  @keyframes pt-fade-in { from { opacity: 0; } to { opacity: 1; } }
  .modal {
    font-family: ${FONT_SANS}; font-size: 14px; line-height: 1.55;
    color: ${cssVar("--text-100")};
    background: ${cssVar("--bg-000")};
    border-radius: ${UI.radiusLg};
    box-shadow: ${UI.shadowLg};
    width: min(640px, calc(100vw - 48px));
    max-height: calc(100vh - 96px);
    overflow-y: auto; scrollbar-width: thin;
    padding: 20px 24px;
    animation: pt-modal-in 160ms cubic-bezier(0.2, 0, 0.2, 1);
  }
  @keyframes pt-modal-in {
    from { opacity: 0; transform: scale(0.97) translateY(6px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
  }
  .head { display: flex; align-items: center; margin-bottom: 12px; }
  .kind {
    flex: 1; font-size: 11px; font-weight: 600;
    color: ${cssVar("--text-400")};
    text-transform: uppercase; letter-spacing: 0.08em;
  }
  .close {
    border: none; background: none; cursor: pointer; font-size: 14px;
    color: ${cssVar("--text-400")}; border-radius: ${UI.radiusSm};
    padding: 5px 7px; font-family: inherit; line-height: 1;
    transition: background ${UI.transition}, color ${UI.transition};
  }
  .close:hover { background: ${cssVar("--bg-300")}; color: ${cssVar("--text-100")}; }
  .quote {
    margin: 0 0 12px 0; padding: 8px 12px;
    border-left: 3px solid ${cssVar("--accent-main-100", 0.6)};
    background: ${cssVar("--bg-100")};
    color: ${cssVar("--text-300")}; font-size: 13px;
    border-radius: 0 ${UI.radiusSm} ${UI.radiusSm} 0;
  }
  .mpair + .mpair {
    margin-top: 14px; padding-top: 14px;
    box-shadow: 0 -1px 0 0 ${cssVar("--border-300", 0.6)};
  }
  .question { font-weight: 600; margin-bottom: 12px; white-space: pre-wrap; }
  .answer p { margin: 0 0 10px 0; }
  .answer pre { background: ${cssVar("--bg-200")}; border-radius: ${UI.radiusSm}; padding: 10px 12px; overflow-x: auto; }
  .answer code { font-family: ${FONT_MONO}; font-size: 13px; }
  .answer a { color: ${cssVar("--accent-secondary-100")}; }
`;
