/**
 * content/features/replies.ts — Feature 6: rich quote-reply references.
 *
 * claude.ai's own "reply" action drops the quoted passage into the composer as
 * a markdown blockquote, so the sent user message begins with `>`-prefixed
 * lines followed by the actual reply. Rendered plainly, a quoted table or
 * emphasised passage collapses to flat text and there is no way back to where
 * it came from.
 *
 * This feature, working entirely from the CONVERSATION MODEL (network truth,
 * never DOM scraping for identity):
 *  - recognises a reply: a visible human message whose text starts with a
 *    blockquote, whose quoted passage is found in an earlier message;
 *  - styles the quoted passage in the reply as a reference (CSS Custom
 *    Highlight API — no mutation of the React-owned message row) with a
 *    clickable accent bar overlaid in the notes-style gutter host;
 *  - hovering the bar shows a popover that renders the quoted passage with its
 *    ORIGINAL formatting (the source message's markdown), tables and all;
 *  - clicking glides to the source message and highlights the exact span.
 *
 * Failure behavior: a reply whose source can't be located shows nothing (the
 * site's own blockquote stays); every geometry read is live; the glide is
 * cancelled by any genuine user input, moving only by a relative delta.
 */
import { cssVar, FONT_SANS, FONT_MONO, UI, Z_CONTENT, Z_EXTENSION_OVERLAY } from "../../shared/tokens";
import { renderMarkdown } from "../../shared/markdown";
import { denseIndex, findDenseFirst } from "../../shared/text-match";
import type { TreeNode } from "../../shared/tree";
import { sel } from "../../shared/selectors";
import { subscribe } from "../observer";
import { indexText, rangeFromOffsets } from "./anchoring";
import type { Ctx, Feature } from "../ctx";

/** Keys that scroll the chat — pressing one cancels an in-flight glide. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

interface ReplyInfo {
  /** The reply (human) message. */
  replyUuid: string;
  /** The quoted passage, blockquote markers stripped. */
  quote: string;
  /** The source message and the quoted span's offsets in its (markdown) text. */
  sourceUuid: string;
  sourceStart: number;
  sourceEnd: number;
}

/** Leading blockquote of a message → the quoted passage (markers stripped). */
export function parseQuoteReply(text: string): string | null {
  const lines = text.split("\n");
  const quoted: string[] = [];
  let i = 0;
  while (i < lines.length && /^\s*>/.test(lines[i]!)) {
    quoted.push(lines[i]!.replace(/^\s*>\s?/, ""));
    i++;
  }
  const quote = quoted.join("\n").trim();
  return quote ? quote : null;
}

export class RepliesFeature implements Feature {
  readonly id = "replies" as const;

  private enabled = false;
  private host: HTMLElement | null = null;
  private layer: HTMLElement | null = null;
  private popoverHost: HTMLElement | null = null;
  private barEls = new Map<string, HTMLElement>();
  private replies = new Map<string, ReplyInfo>();
  /** Structural signature the reply set was last computed for. */
  private replySig = "";
  private glideId = 0;
  private sourceClearTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private ctx: Ctx) {
    subscribe(() => this.onTick());
    ctx.bus.on("conversation-changed", () => this.reset());
  }

  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    if (!on) this.reset();
  }

  onConversation(): void {
    /* handled via the conversation-changed bus event */
  }

  private reset(): void {
    this.glideId++;
    this.replies.clear();
    this.replySig = "";
    this.barEls.clear();
    this.host?.remove();
    this.host = null;
    this.layer = null;
    this.hidePopover();
    if (this.sourceClearTimer) {
      clearTimeout(this.sourceClearTimer);
      this.sourceClearTimer = null;
    }
    this.clearHighlight("pt-reply-quote");
    this.clearHighlight("pt-reply-source");
  }

  /* --------------------------------------------------------------- model */

  /** Recompute the reply set from the current tree (network truth) — only
   *  when the conversation's structure/text changed, never per scroll frame
   *  (source lookup scans earlier messages). */
  private computeReplies(): void {
    const tree = this.ctx.getTree();
    if (!tree) {
      this.replies.clear();
      this.replySig = "";
      return;
    }
    const path = tree.visiblePath();
    const sig = `${path.length}|${path.map((n) => n.text.length).join(",")}`;
    if (sig === this.replySig) return;
    this.replySig = sig;
    this.replies.clear();
    for (let i = 0; i < path.length; i++) {
      const node = path[i]!;
      if (node.sender !== "human") continue;
      const quote = parseQuoteReply(node.text);
      if (!quote) continue;
      const source = this.findSource(path, i, quote);
      if (!source) continue; // a genuine user blockquote (no source): leave it
      this.replies.set(node.uuid, {
        replyUuid: node.uuid,
        quote,
        sourceUuid: source.node.uuid,
        sourceStart: source.start,
        sourceEnd: source.end,
      });
    }
  }

  /** Nearest earlier message on the path whose markdown contains the quote. */
  private findSource(
    path: TreeNode[],
    replyIdx: number,
    quote: string
  ): { node: TreeNode; start: number; end: number } | null {
    for (let i = replyIdx - 1; i >= 0; i--) {
      const node = path[i]!;
      if (!node.text) continue;
      // markdown-insensitive on both sides: the quote is the rendered text,
      // the source is markdown (`**`, `|`, `#`…) — dropping that syntax and
      // whitespace aligns the two.
      const match = findDenseFirst(denseIndex(node.text, true), quote, true);
      if (match) return { node, start: match.start, end: match.end };
    }
    return null;
  }

  /* -------------------------------------------------------------- gutter */

  private ensureLayer(): HTMLElement | null {
    const container = this.ctx.domMap.container;
    if (!container) {
      this.host?.remove();
      this.host = null;
      this.layer = null;
      return null;
    }
    if (this.host?.isConnected && this.host.parentElement === container) return this.layer;
    this.host?.remove();
    if (getComputedStyle(container).position === "static") container.style.position = "relative";
    this.host = document.createElement("div");
    this.host.id = "pt-reply-host";
    this.host.style.cssText =
      `position:absolute;inset:0;pointer-events:none;z-index:${Z_CONTENT};`;
    const shadow = this.host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = REPLY_CSS;
    this.layer = document.createElement("div");
    this.layer.className = "layer";
    shadow.append(style, this.layer);
    container.appendChild(this.host);
    return this.layer;
  }

  /* ---------------------------------------------------------------- tick */

  private onTick(): void {
    if (!this.enabled) return;
    this.computeReplies();
    // The overwhelming majority of conversations have no quote-replies — don't
    // stand up an overlay host or touch the highlight registry for them.
    if (this.replies.size === 0) {
      if (this.host) {
        this.host.remove();
        this.host = null;
        this.layer = null;
        this.barEls.clear();
        this.clearHighlight("pt-reply-quote");
      }
      return;
    }
    const layer = this.ensureLayer();
    const container = this.ctx.domMap.container;
    if (!layer || !container) return;
    const containerRect = container.getBoundingClientRect();

    const quoteHl = new Set<Range>();
    const seen = new Set<string>();

    for (const info of this.replies.values()) {
      const row = this.ctx.domMap.rowByUuid(info.replyUuid);
      const body = row?.el.querySelector<HTMLElement>(sel("userMessage"));
      if (!body) continue;
      const index = indexText(body);
      const match = findDenseFirst(denseIndex(index.text, true), info.quote, true);
      if (!match) continue;
      const range = rangeFromOffsets(index, match.start, match.end);
      if (!range) continue;
      const rect = range.getBoundingClientRect();
      if (rect.height <= 0) continue;
      quoteHl.add(range);
      seen.add(info.replyUuid);

      let bar = this.barEls.get(info.replyUuid);
      if (!bar || !bar.isConnected) {
        bar = this.buildBar(info);
        layer.appendChild(bar);
        this.barEls.set(info.replyUuid, bar);
      }
      const top = Math.round(rect.top - containerRect.top);
      const left = Math.round(rect.left - containerRect.left - 10);
      bar.style.top = `${top}px`;
      bar.style.left = `${Math.max(0, left)}px`;
      bar.style.height = `${Math.round(rect.height)}px`;
    }

    for (const [uuid, bar] of this.barEls) {
      if (!seen.has(uuid)) {
        bar.remove();
        this.barEls.delete(uuid);
      }
    }
    this.setHighlight("pt-reply-quote", quoteHl);
  }

  private buildBar(info: ReplyInfo): HTMLElement {
    const bar = document.createElement("button");
    bar.type = "button";
    bar.className = "bar";
    bar.title = "Jump to the quoted message";
    bar.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void this.jumpToSource(info);
    });
    bar.addEventListener("mouseenter", () => this.showPopover(bar, info));
    bar.addEventListener("mouseleave", () => this.scheduleHidePopover());
    return bar;
  }

  /* ------------------------------------------------------------- popover */

  private popoverHideTimer: ReturnType<typeof setTimeout> | null = null;

  private showPopover(bar: HTMLElement, info: ReplyInfo): void {
    if (this.popoverHideTimer) {
      clearTimeout(this.popoverHideTimer);
      this.popoverHideTimer = null;
    }
    const node = this.ctx.getTree()?.nodes.get(info.sourceUuid);
    if (!node) return;
    // widen to whole lines so a quoted table/list renders as a block
    let s = node.text.lastIndexOf("\n", Math.max(0, info.sourceStart - 1)) + 1;
    let e = node.text.indexOf("\n", info.sourceEnd);
    if (e < 0) e = node.text.length;
    const markdown = node.text.slice(s, e).trim();

    this.hidePopover();
    const host = document.createElement("div");
    host.id = "pt-reply-popover";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = POPOVER_CSS;
    const card = document.createElement("div");
    card.className = "pop";
    card.innerHTML = `<div class="cap">Replying to</div><div class="body md"></div>`;
    card.querySelector<HTMLElement>(".body")!.innerHTML = renderMarkdown(markdown);
    card.addEventListener("mouseenter", () => {
      if (this.popoverHideTimer) {
        clearTimeout(this.popoverHideTimer);
        this.popoverHideTimer = null;
      }
    });
    card.addEventListener("mouseleave", () => this.scheduleHidePopover());
    shadow.append(style, card);
    document.body.appendChild(host);
    this.popoverHost = host;

    const barRect = bar.getBoundingClientRect();
    const width = Math.min(360, Math.max(220, window.innerWidth - barRect.right - 24));
    card.style.width = `${width}px`;
    // measure after content, then place to the right of the bar (or above)
    const ph = card.getBoundingClientRect().height;
    let top = barRect.top;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8 - ph);
    host.style.cssText =
      `position:fixed;z-index:${Z_EXTENSION_OVERLAY};left:${Math.round(barRect.right + 8)}px;top:${Math.round(top)}px;`;
  }

  private scheduleHidePopover(): void {
    if (this.popoverHideTimer) clearTimeout(this.popoverHideTimer);
    this.popoverHideTimer = setTimeout(() => this.hidePopover(), 140);
  }

  private hidePopover(): void {
    this.popoverHost?.remove();
    this.popoverHost = null;
  }

  /* ---------------------------------------------------------- highlights */

  private setHighlight(name: string, ranges: Set<Range>): void {
    const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    if (!reg || typeof Highlight === "undefined") return;
    if (!ranges.size) {
      reg.delete(name);
      return;
    }
    reg.set(name, new Highlight(...ranges));
  }

  private clearHighlight(name: string): void {
    (CSS as unknown as { highlights?: Map<string, unknown> }).highlights?.delete(name);
  }

  /* --------------------------------------------------------------- glide */

  /** Glide to the source message and flash the quoted span. Moves only by a
   *  relative delta each frame and cancels on any genuine user input. */
  private async jumpToSource(info: ReplyInfo): Promise<void> {
    const sc = this.ctx.domMap.scrollContainer;
    const tree = this.ctx.getTree();
    if (!sc || !tree) return;
    const path = tree.visiblePath();
    const targetIdx = path.findIndex((n) => n.uuid === info.sourceUuid);
    if (targetIdx < 0) return;
    this.hidePopover();

    const id = ++this.glideId;
    let cancelled = false;
    const onInput = () => {
      cancelled = true;
    };
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null;
      if (t && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (SCROLL_KEYS.has(ev.key)) cancelled = true;
    };
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    window.addEventListener("wheel", onInput, opts);
    window.addEventListener("touchstart", onInput, opts);
    window.addEventListener("mousedown", onInput, opts);
    window.addEventListener("keydown", onKey, opts);

    try {
      const mounted = this.ctx.domMap.rows.filter((r) => r.uuid);
      const firstMountedIdx = mounted.length ? path.findIndex((n) => n.uuid === mounted[0]!.uuid) : -1;
      const upward = firstMountedIdx < 0 || targetIdx < firstMountedIdx;
      const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));
      let stalled = 0;
      let lastHeight = -1;
      sc.style.scrollBehavior = "auto";

      while (!cancelled && id === this.glideId && sc.isConnected) {
        this.ctx.domMap.rebuild(tree);
        const row = this.ctx.domMap.rowByUuid(info.sourceUuid);
        let remaining: number;
        if (row) {
          remaining = row.el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 40;
          if (Math.abs(remaining) < 3) {
            this.flashSource(info);
            return;
          }
        } else {
          remaining = upward ? -sc.scrollTop : sc.scrollHeight - sc.clientHeight - sc.scrollTop;
          if (Math.abs(remaining) < 2) {
            stalled = sc.scrollHeight === lastHeight ? stalled + 1 : 0;
            lastHeight = sc.scrollHeight;
            if (stalled > 30) return;
            await nextFrame();
            continue;
          }
        }
        const step = Math.min(
          Math.abs(remaining),
          Math.max(40, Math.abs(remaining) * 0.2),
          sc.clientHeight / 2
        );
        const before = sc.scrollTop;
        sc.scrollTop += Math.sign(remaining) * step;
        if (row && sc.scrollTop === before) {
          this.flashSource(info);
          return;
        }
        await nextFrame();
      }
    } finally {
      sc.style.scrollBehavior = "";
      window.removeEventListener("wheel", onInput, opts);
      window.removeEventListener("touchstart", onInput, opts);
      window.removeEventListener("mousedown", onInput, opts);
      window.removeEventListener("keydown", onKey, opts);
    }
  }

  /** Highlight the quoted span in the source message for a couple of seconds. */
  private flashSource(info: ReplyInfo): void {
    const tree = this.ctx.getTree();
    const row = this.ctx.domMap.rowByUuid(info.sourceUuid);
    const node = tree?.nodes.get(info.sourceUuid);
    if (!row || !node) return;
    const index = indexText(row.el);
    // re-locate the quote against the RENDERED text (offsets differ from the
    // markdown source), whitespace/markdown-insensitive
    const match = findDenseFirst(denseIndex(index.text, true), info.quote, true);
    const range = match ? rangeFromOffsets(index, match.start, match.end) : null;
    if (range) {
      this.setHighlight("pt-reply-source", new Set([range]));
      if (this.sourceClearTimer) clearTimeout(this.sourceClearTimer);
      this.sourceClearTimer = setTimeout(() => {
        this.sourceClearTimer = null;
        this.clearHighlight("pt-reply-source");
      }, 2500);
    }
  }
}

/* --------------------------------------------------------------- styles */

const REPLY_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .layer { position: relative; width: 100%; height: 100%; pointer-events: none; }
  .bar {
    position: absolute;
    width: 4px; min-height: 14px;
    padding: 0; border: none; cursor: pointer;
    pointer-events: auto;
    background: ${cssVar("--accent-main-100", 0.55)};
    border-radius: 3px;
    transition: background ${UI.transition}, transform ${UI.transition};
  }
  .bar::after { content: ""; position: absolute; inset: -3px -6px; }
  .bar:hover { background: ${cssVar("--accent-main-100")}; transform: scaleX(1.5); }
  .bar:focus-visible { outline: 2px solid ${cssVar("--accent-main-100", 0.6)}; outline-offset: 1px; }
`;

const POPOVER_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .pop {
    font-family: ${FONT_SANS}; font-size: 12px; line-height: 1.5;
    color: ${cssVar("--text-200")};
    background: ${cssVar("--bg-000")};
    border-radius: ${UI.radiusMd};
    box-shadow: ${UI.shadowMd};
    padding: 10px 12px;
    max-height: 60vh; overflow-y: auto; scrollbar-width: thin;
    animation: pt-pop-in 140ms ease-out;
  }
  @keyframes pt-pop-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
  .cap {
    font-size: 10px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase;
    color: ${cssVar("--text-400")}; margin-bottom: 6px;
  }
  .body p { margin: 0 0 6px 0; }
  .body p:last-child { margin-bottom: 0; }
  .body pre { background: ${cssVar("--bg-200")}; border-radius: ${UI.radiusSm}; padding: 7px 8px; overflow-x: auto; }
  .body code { font-family: ${FONT_MONO}; font-size: 11px; }
  .body a { color: ${cssVar("--accent-secondary-100")}; }
  .body mark { background: ${cssVar("--accent-main-100", 0.25)}; color: inherit; border-radius: 2px; padding: 0 1px; }
  .body table { border-collapse: collapse; width: 100%; margin: 4px 0; font-size: 11px; }
  .body th, .body td { border: 1px solid ${cssVar("--border-300", 0.7)}; padding: 3px 6px; text-align: left; }
  .body th { background: ${cssVar("--bg-200", 0.7)}; font-weight: 600; }
  .body blockquote {
    margin: 4px 0; padding: 2px 8px;
    border-left: 2px solid ${cssVar("--border-200")};
    color: ${cssVar("--text-300")};
  }
`;
