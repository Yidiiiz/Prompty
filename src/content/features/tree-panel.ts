/**
 * content/features/tree-panel.ts — Feature 2: the "Prompt history" panel.
 *
 * A quiet, borderless (shadow-elevated) panel overlaid on the left margin of
 * the chat, spanning the viewport below the site header. The conversation is
 * shown as prompt/response PAIRS: each prompt is a row, its response nests
 * beneath it with a rounded-L indicator, dimmer and on a darker background.
 * Messages with branches become section headers (fork glyph + k/n count) with
 * their numbered branch options directly beneath — first two visible, the
 * rest behind a caret; the current branch uses the extension's signature
 * quote-chip style (accent left bar, darker background, dark text). Sub-pairs
 * hang off a guide line that ends at the last item.
 *
 * Modes, computed each tick purely from available space (never from the
 * conversation's length — a short branch must not collapse the panel):
 *   full  — the gap between the scroll-area edge and the chat column fits
 *           ~300px and the viewport is ≥ 1100px
 *   strip — icon-only rail (~36px): dots per pair, fork glyphs for branch
 *           points, tooltips, same jump clicks; also the user-collapsed state
 *   hidden — not even the strip fits
 *
 * Rendering is driven by the ConversationTree model (bus "tree-updated"),
 * never DOM diffing; a render-signature check and a summary memo keep
 * streaming updates cheap. Branch switching goes through the
 * branch-navigation adapter (native-arrow stepping, no reload).
 */
import { cssVar, FONT_SANS, UI, Z_PANEL } from "../../shared/tokens";
import { summarizer } from "../../shared/summary";
import { getPanelCollapsed, setPanelCollapsed } from "../../shared/storage";
import { escapeHtml, rafThrottle, waitUntil } from "../../shared/util";
import type { TreeNode } from "../../shared/tree";
import { subscribe } from "../observer";
import { NativeArrowsAdapter, type BranchSwitchAdapter } from "../branch-switch";
import type { Ctx, Feature } from "../ctx";
import type { DomRow } from "../dom-map";

const MIN_VIEWPORT_FOR_FULL = 1100;
const FULL_WIDTH = 280;
const STRIP_WIDTH = 36;
const OPTIONS_SHOWN_COLLAPSED = 2;

type PanelMode = "full" | "strip" | "hidden";

/** A prompt and (when already answered) its response. */
interface Pair {
  prompt: TreeNode;
  response: TreeNode | null;
}

const PANEL_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  button { font-family: inherit; border: none; background: none; cursor: pointer; text-align: left; }
  button:focus-visible { outline: 2px solid ${cssVar("--accent-main-100", 0.55)}; outline-offset: 1px; }

  /* Embedded left rail: flat left/bottom edges with INSET shadows so the
     panel reads as recessed beneath the chat; the top-right corner is rounded
     to sit naturally with the site's own surfaces. */
  .panel {
    position: fixed;
    z-index: ${Z_PANEL};
    display: flex;
    flex-direction: column;
    width: ${FULL_WIDTH}px;
    font-family: ${FONT_SANS};
    color: ${cssVar("--text-300")};
    background: ${cssVar("--bg-200", 0.9)};
    border-radius: 0 ${UI.radiusLg} 0 0;
    box-shadow:
      inset -14px 0 18px -14px ${cssVar("--always-black", 0.16)},
      inset 0 14px 14px -14px ${cssVar("--always-black", 0.07)};
    overflow: hidden;
    transition: width ${UI.transition};
  }
  .panel.strip { width: ${STRIP_WIDTH}px; }

  .head {
    display: flex; align-items: center; gap: 6px;
    padding: 11px 8px 7px 14px;
    flex: none;
  }
  .panel.strip .head { padding: 8px 0 4px; justify-content: center; }
  .title {
    flex: 1;
    font-size: 12px; font-weight: 600;
    color: ${cssVar("--text-300")};
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .panel.strip .title { display: none; }
  .chev {
    flex: none;
    width: 22px; height: 22px; border-radius: ${UI.radiusSm};
    display: flex; align-items: center; justify-content: center;
    color: ${cssVar("--text-500")}; font-size: 12px; line-height: 1;
    transition: background ${UI.transition}, color ${UI.transition};
  }
  .chev:hover { background: ${cssVar("--bg-300", 0.7)}; color: ${cssVar("--text-100")}; }
  .chev.off { display: none; }

  .list {
    flex: 1;
    overflow-y: auto; overflow-x: hidden;
    padding: 0 12px 14px 12px;
    scrollbar-width: thin;
    scrollbar-color: ${cssVar("--border-200", 0.35)} transparent;
  }
  .list::-webkit-scrollbar { width: 4px; }
  .list::-webkit-scrollbar-track { background: transparent; }
  .list::-webkit-scrollbar-thumb { background: ${cssVar("--border-200", 0.35)}; border-radius: 2px; }
  .list::-webkit-scrollbar-thumb:hover { background: ${cssVar("--border-200", 0.6)}; }
  .panel.strip .list { padding: 2px 0 10px; }

  /* ------------------------------------------------- branch-point header */
  .hdr {
    display: flex; align-items: flex-start; gap: 7px;
    width: 100%;
    margin-top: 8px;
    padding: 4px 7px;
    border-radius: ${UI.radiusSm};
    font-size: 12px; line-height: 1.4; font-weight: 500;
    color: ${cssVar("--text-200")};
    transition: background ${UI.transition}, color ${UI.transition};
  }
  .hdr:hover { background: ${cssVar("--bg-300", 0.55)}; color: ${cssVar("--text-100")}; }
  /* the pair currently in view in the chat — quote-chip treatment */
  .hdr.current, .prompt.current {
    color: ${cssVar("--text-100")};
    background: ${cssVar("--bg-300", 0.55)};
    box-shadow: inset 2px 0 0 0 ${cssVar("--accent-main-100", 0.75)};
    border-radius: 0 ${UI.radiusSm} ${UI.radiusSm} 0;
  }
  .fork { flex: none; color: ${cssVar("--text-500")}; font-size: 12px; margin-top: 1px; }
  .txt { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .count {
    flex: none; align-self: center;
    font-size: 9.5px; font-variant-numeric: tabular-nums;
    color: ${cssVar("--text-500")};
    background: ${cssVar("--bg-300", 0.7)};
    border-radius: 99px; padding: 1px 6px; line-height: 13px;
  }

  /* ------------------------------------------------------ branch options */
  .opts { margin: 1px 0 2px 20px; display: flex; flex-direction: column; }
  .opt {
    display: flex; align-items: center; gap: 7px;
    padding: 3px 8px;
    border-left: 2px solid transparent;
    border-radius: 0 ${UI.radiusSm} ${UI.radiusSm} 0;
    font-size: 11.5px; line-height: 1.35;
    color: ${cssVar("--text-300")};
    opacity: 0.6;
    transition: opacity ${UI.transition}, background ${UI.transition};
  }
  .opt:hover { opacity: 1; background: ${cssVar("--bg-300", 0.5)}; }
  .opt .num {
    flex: none; min-width: 10px;
    font-size: 10px; font-variant-numeric: tabular-nums;
    color: ${cssVar("--text-500")};
  }
  .caret {
    display: flex; align-items: center; gap: 7px;
    padding: 2px 8px; margin-left: 2px;
    border-radius: ${UI.radiusSm};
    font-size: 10.5px; color: ${cssVar("--text-500")};
    transition: color ${UI.transition}, background ${UI.transition};
  }
  .caret:hover { color: ${cssVar("--text-200")}; background: ${cssVar("--bg-300", 0.5)}; }

  /* --------------------------------------- prompt/response pairs (subs) */
  .subs {
    margin: 3px 0 3px 10px;
    padding-left: 9px;
    border-left: 1px solid ${cssVar("--border-300")};
    display: flex; flex-direction: column; gap: 1px;
  }
  .prompt {
    display: flex; align-items: flex-start; gap: 7px;
    width: 100%;
    padding: 3px 7px;
    border-radius: ${UI.radiusSm};
    font-size: 11.5px; line-height: 1.4;
    color: ${cssVar("--text-300")};
    transition: background ${UI.transition}, color ${UI.transition};
  }
  .prompt:hover { background: ${cssVar("--bg-300", 0.55)}; color: ${cssVar("--text-100")}; }
  .prompt .b { flex: none; color: ${cssVar("--text-500")}; line-height: 1.4; }
  .resp {
    display: flex; align-items: flex-start; gap: 6px;
    width: calc(100% - 12px);
    margin-left: 12px;
    padding: 2px 7px 3px 5px;
    border-radius: ${UI.radiusSm};
    font-size: 11px; line-height: 1.4;
    color: ${cssVar("--text-400")};
    background: ${cssVar("--bg-200", 0.5)};
    opacity: 0.8;
    transition: opacity ${UI.transition}, color ${UI.transition};
  }
  .resp:hover { opacity: 1; color: ${cssVar("--text-200")}; }
  .resp .l {
    flex: none;
    width: 7px; height: 9px;
    margin: -1px 0 0 1px;
    /* grayed out to match the dimmed response text */
    border-left: 1px solid ${cssVar("--text-500", 0.35)};
    border-bottom: 1px solid ${cssVar("--text-500", 0.35)};
    border-bottom-left-radius: 5px;
  }
  /* response paired with a branch header aligns under the header text */
  .hdr-resp { margin-left: 22px; width: calc(100% - 22px); }

  /* -------------------------------------------------- unanchored drawer */
  .drawer {
    flex: none;
    padding: 8px 12px 10px;
    box-shadow: 0 -1px 0 0 ${cssVar("--border-300", 0.7)};
    font-size: 10.5px; color: ${cssVar("--text-500")};
  }
  .drawer .dhead { display: block; margin-top: 4px; }
  .drawer .dhead:first-child { margin-top: 0; }
  .drawer button {
    display: block; width: 100%;
    font-size: 11.5px; color: ${cssVar("--text-300")};
    padding: 3px 6px; margin-top: 2px; border-radius: ${UI.radiusSm};
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    transition: background ${UI.transition}, color ${UI.transition};
  }
  .drawer button:hover { background: ${cssVar("--bg-300", 0.6)}; color: ${cssVar("--text-100")}; }

  /* ------------------------------------------------------- icon strip */
  .mini {
    display: flex; align-items: center; justify-content: center;
    width: 100%; padding: 4px 0;
  }
  .mini .d {
    width: 6px; height: 6px; border-radius: 50%;
    background: ${cssVar("--text-500", 0.6)};
    transition: background ${UI.transition}, transform ${UI.transition};
  }
  .mini .f { font-size: 11px; line-height: 1; color: ${cssVar("--text-400")}; }
  .mini:hover .d { background: ${cssVar("--text-200")}; transform: scale(1.25); }
  .mini:hover .f { color: ${cssVar("--text-100")}; }
  .mini.current .d { background: ${cssVar("--accent-main-100")}; transform: scale(1.25); }
  .mini.current .f { color: ${cssVar("--accent-main-200")}; }
`;

export class TreePanelFeature implements Feature {
  readonly id = "treePanel" as const;

  private enabled = false;
  private host: HTMLElement | null = null;
  private shadow: ShadowRoot | null = null;
  /** User preference: keep the panel as the icon strip. Persisted. */
  private collapsed = false;
  private mode: PanelMode = "hidden";
  /** Whether the full panel would fit (controls the expand chevron). */
  private fullFits = false;
  /** Message uuids whose branch-option list is expanded beyond the first two. */
  private expandedBranches = new Set<string>();
  private drawerItems: Array<{ noteId: string; label: string }> = [];
  private deletedItems: Array<{ noteId: string; label: string }> = [];
  /** Prompt uuid of the pair currently in view in the chat. */
  private currentViewUuid: string | null = null;
  /** True while the user has manually scrolled the panel list; auto-centering
   *  pauses until the chat's current message changes again. */
  private userScrolledPanel = false;
  private panelScrollGuard = false;
  private lastSignature = "";
  /** Summary memo — summarize() runs regexes over full message text, so it
   *  must not run per node per tick. Keyed by uuid+len (streaming-safe). */
  private summaryCache = new Map<string, string>();
  private adapter: BranchSwitchAdapter;
  private render: () => void;

  constructor(private ctx: Ctx) {
    this.adapter = new NativeArrowsAdapter(ctx);
    this.render = rafThrottle(() => this.doRender());
    void getPanelCollapsed().then((c) => {
      this.collapsed = c;
      this.render();
    });
    ctx.bus.on("tree-updated", () => this.render());
    ctx.bus.on("conversation-changed", () => {
      this.expandedBranches.clear();
      this.drawerItems = [];
      this.deletedItems = [];
      this.lastSignature = "";
      this.summaryCache.clear();
      this.render();
    });
    ctx.bus.on("unanchored-notes", (msg) => {
      if (msg.conversationUuid !== ctx.getCurrentConversation()) return;
      this.drawerItems = msg.items;
      this.deletedItems = msg.deletedItems;
      this.lastSignature = "";
      this.render();
    });
    subscribe(() => this.onTick());
  }

  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    if (!on) {
      this.host?.remove();
      this.host = null;
      this.shadow = null;
      this.lastSignature = "";
    } else {
      this.render();
    }
  }

  onConversation(): void {
    /* handled via the conversation-changed bus event */
  }

  /* ------------------------------------------------- geometry & modes */

  private onTick(): void {
    if (!this.enabled || !this.host) return;
    const sc = this.ctx.domMap.scrollContainer;
    const column = this.ctx.domMap.container;
    const panel = this.shadow?.querySelector<HTMLElement>(".panel");
    if (!panel) return;
    if (!sc || !column || !this.ctx.getCurrentConversation()) {
      this.setMode(panel, "hidden");
      return;
    }

    // read phase — the space actually available left of the chat column.
    // Purely space-driven: a short active path (e.g. right after branching
    // off the first message) must NOT collapse the panel.
    const scRect = sc.getBoundingClientRect();
    const gap = column.getBoundingClientRect().left - scRect.left;
    this.fullFits = gap >= FULL_WIDTH + 24 && window.innerWidth >= MIN_VIEWPORT_FOR_FULL;
    const stripFits = gap >= STRIP_WIDTH + 16;
    const mode: PanelMode = !stripFits
      ? "hidden"
      : this.collapsed || !this.fullFits
        ? "strip"
        : "full";

    // flush against the scroll area's left edge — embedded, not floating —
    // with just enough headroom that the chat title stays clear
    const top = Math.round(scRect.top) + 16;
    const left = `${Math.round(scRect.left)}px`;
    const topPx = `${top}px`;
    const height = `${Math.max(160, window.innerHeight - top)}px`;

    // read phase: which pair is currently in view in the chat?
    this.trackCurrentMessage(scRect);

    // write phase (guarded)
    this.setMode(panel, mode);
    if (mode === "hidden") return;
    if (panel.style.left !== left) panel.style.left = left;
    if (panel.style.top !== topPx) panel.style.top = topPx;
    if (panel.style.height !== height) panel.style.height = height;
    this.render(); // signature check makes this cheap when nothing changed
  }

  /**
   * The "current" pair is the row at the chat viewport's CENTER; pinned to
   * the first/last pair when the chat is scrolled to its top/bottom (at the
   * bottom the last prompt+response is what the user is reading).
   */
  private trackCurrentMessage(scRect: DOMRect): void {
    const tree = this.ctx.getTree();
    const sc = this.ctx.domMap.scrollContainer;
    if (!tree || !sc) return;
    const rows = this.ctx.domMap.rows.filter(
      (r) => r.uuid && !r.el.classList.contains("pt-note-hidden")
    );
    if (!rows.length) return;

    let uuid: string | null;
    if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 8) {
      uuid = rows[rows.length - 1]!.uuid;
    } else if (sc.scrollTop <= 8) {
      uuid = rows[0]!.uuid;
    } else {
      // The message being read = the LAST row starting above the viewport
      // center. Monotonic in scroll position, so it never flickers between
      // neighbors the way nearest-edge distance ties did.
      const centerY = scRect.top + scRect.height / 2;
      let best: string | null = rows[0]!.uuid;
      for (const row of rows) {
        if (row.el.getBoundingClientRect().top > centerY) break;
        best = row.uuid;
      }
      uuid = best;
    }

    if (uuid) {
      // normalize responses to their pair's prompt (that's what panel rows key on)
      const node = tree.nodes.get(uuid);
      if (node?.sender === "assistant") {
        const parent = tree.nodes.get(node.parentUuid);
        if (parent && !parent.isNote) uuid = parent.uuid;
      }
    }
    if (uuid !== this.currentViewUuid) {
      this.currentViewUuid = uuid;
      this.userScrolledPanel = false; // the chat moved: resume auto-centering
      this.lastSignature = "";
      this.render();
    }
  }

  private setMode(panel: HTMLElement, mode: PanelMode): void {
    if (this.mode !== mode) {
      this.mode = mode;
      this.lastSignature = "";
      this.render();
    }
    const display = mode === "hidden" ? "none" : "flex";
    if (panel.style.display !== display) panel.style.display = display;
  }

  /* ------------------------------------------------------------ render */

  private ensureHost(): ShadowRoot | null {
    if (this.shadow && this.host?.isConnected) return this.shadow;
    if (!document.body) return null;
    this.host = document.createElement("div");
    this.host.id = "pt-panel-host";
    this.shadow = this.host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = PANEL_CSS;
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.style.display = "none";
    this.shadow.append(style, panel);
    document.body.appendChild(this.host);
    return this.shadow;
  }

  private summarize(uuid: string, text: string, maxWords: number): string {
    const key = `${uuid}:${maxWords}:${text.length}`;
    let value = this.summaryCache.get(key);
    if (value === undefined) {
      value = summarizer.summarize(text, maxWords);
      if (this.summaryCache.size > 4000) this.summaryCache.clear();
      this.summaryCache.set(key, value);
    }
    return value;
  }

  /** Pairs each prompt with its immediate response. */
  private buildPairs(path: TreeNode[]): Pair[] {
    const pairs: Pair[] = [];
    for (let i = 0; i < path.length; i++) {
      const node = path[i]!;
      if (node.sender === "human" && path[i + 1]?.sender === "assistant") {
        pairs.push({ prompt: node, response: path[i + 1]! });
        i++;
      } else {
        pairs.push({ prompt: node, response: null });
      }
    }
    return pairs;
  }

  private branchCount(uuid: string): number {
    return this.ctx.getTree()?.siblingsOf(uuid).length ?? 1;
  }

  private doRender(): void {
    if (!this.enabled) return;
    // The host must exist even while hidden — onTick computes the mode from
    // geometry and needs the host/panel to write to.
    const shadow = this.ensureHost();
    if (!shadow) return;
    if (this.mode === "hidden") return;
    const panel = shadow.querySelector<HTMLElement>(".panel")!;
    const tree = this.ctx.getTree();
    const path = tree ? tree.visiblePath() : [];
    const pairs = this.buildPairs(path);
    const strip = this.mode === "strip";

    const signature = JSON.stringify({
      m: this.mode,
      f: this.fullFits,
      c: this.currentViewUuid,
      d: this.drawerItems,
      dd: this.deletedItems,
      x: [...this.expandedBranches],
      p: path.map((n) => {
        const sibs = tree!.siblingsOf(n.uuid);
        return [
          n.uuid,
          n.sender,
          this.summarize(n.uuid, n.text, 6),
          sibs.map((s) => [s.uuid, this.summarize(s.uuid, s.text, 4)]),
        ];
      }),
    });
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    panel.classList.toggle("strip", strip);

    const chevGlyph = strip ? "»" : "«";
    const chevOff = strip && !this.fullFits ? " off" : "";
    let html = `
      <div class="head">
        <span class="title">Prompt history</span>
        <button class="chev${chevOff}" data-act="toggle"
                title="${strip ? "Expand" : "Collapse"} prompt history"
                aria-label="${strip ? "Expand" : "Collapse"} prompt history">${chevGlyph}</button>
      </div>
      <div class="list">`;

    html += strip ? this.renderStrip(pairs) : this.renderFull(pairs);
    html += `</div>`;

    if (!strip && (this.drawerItems.length || this.deletedItems.length)) {
      html += `<div class="drawer">`;
      if (this.drawerItems.length) {
        html += `<span class="dhead">Unanchored notes</span>`;
        for (const item of this.drawerItems) {
          html += `<button data-act="open-note" data-note="${escapeHtml(item.noteId)}">${escapeHtml(item.label)}</button>`;
        }
      }
      if (this.deletedItems.length) {
        html += `<span class="dhead">Deleted notes</span>`;
        for (const item of this.deletedItems) {
          html += `<button data-act="restore-note" data-note="${escapeHtml(item.noteId)}"
                           title="Click to restore">↩ ${escapeHtml(item.label)}</button>`;
        }
      }
      html += `</div>`;
    }

    const prevScrollTop = panel.querySelector<HTMLElement>(".list")?.scrollTop ?? 0;
    panel.innerHTML = html;
    panel.querySelectorAll<HTMLElement>("[data-act]").forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.handleAction(el.dataset["act"] ?? "", el.dataset["uuid"] ?? "", el.dataset["note"] ?? "");
      });
    });

    // auto-center on the current message unless the user scrolled the panel
    const list = panel.querySelector<HTMLElement>(".list");
    if (list) {
      list.addEventListener(
        "scroll",
        () => {
          if (!this.panelScrollGuard) this.userScrolledPanel = true;
        },
        { passive: true }
      );
      this.panelScrollGuard = true;
      if (!this.userScrolledPanel && this.currentViewUuid) {
        const entry = list.querySelector<HTMLElement>(`[data-uuid="${this.currentViewUuid}"]`);
        if (entry) list.scrollTop = entry.offsetTop - list.clientHeight / 2 + entry.offsetHeight / 2;
      } else {
        // rebuilding innerHTML reset the list; keep the user's position
        list.scrollTop = prevScrollTop;
      }
      requestAnimationFrame(() => (this.panelScrollGuard = false));
    }
  }

  /* --------------------------------------------------- full-mode markup */

  private renderFull(pairs: Pair[]): string {
    let html = "";
    let subs = ""; // open run of ordinary pairs under the current section
    let inSection = false; // pairs before the first branch point render flat
    const flushSubs = () => {
      if (subs) {
        html += inSection ? `<div class="subs">${subs}</div>` : subs;
        subs = "";
      }
    };
    for (const pair of pairs) {
      if (this.branchCount(pair.prompt.uuid) > 1) {
        // branch point → section header + options + its own response
        flushSubs();
        inSection = true;
        html += this.renderHeaderRow(pair.prompt);
        html += this.renderOptions(pair.prompt);
        if (pair.response) {
          html += this.renderResponseRow(pair.response, true);
          if (this.branchCount(pair.response.uuid) > 1) html += this.renderOptions(pair.response);
        }
      } else {
        subs += this.renderPromptRow(pair.prompt);
        if (pair.response) {
          subs += this.renderResponseRow(pair.response, false);
          if (this.branchCount(pair.response.uuid) > 1) {
            flushSubs(); // options render at section level for alignment
            html += this.renderOptions(pair.response);
          }
        }
      }
    }
    flushSubs();
    return html;
  }

  private currentClass(uuid: string): string {
    return uuid === this.currentViewUuid ? " current" : "";
  }

  private renderHeaderRow(node: TreeNode): string {
    const sibs = this.ctx.getTree()!.siblingsOf(node.uuid);
    const idx = sibs.findIndex((s) => s.uuid === node.uuid);
    return `
      <button class="hdr${this.currentClass(node.uuid)}" data-act="jump" data-uuid="${node.uuid}"
              title="${escapeHtml(this.summarize(node.uuid, node.text, 12))}">
        <span class="fork">⑂</span>
        <span class="txt">${escapeHtml(this.summarize(node.uuid, node.text, 6))}</span>
        <span class="count" title="branch ${idx + 1} of ${sibs.length}">${idx + 1}</span>
      </button>`;
  }

  private renderPromptRow(node: TreeNode): string {
    return `
      <button class="prompt${this.currentClass(node.uuid)}" data-act="jump" data-uuid="${node.uuid}"
              title="${escapeHtml(this.summarize(node.uuid, node.text, 12))}">
        <span class="b">·</span>
        <span class="txt">${escapeHtml(this.summarize(node.uuid, node.text, 6))}</span>
      </button>`;
  }

  private renderResponseRow(node: TreeNode, underHeader: boolean): string {
    const sibs = this.ctx.getTree()!.siblingsOf(node.uuid);
    const idx = sibs.findIndex((s) => s.uuid === node.uuid);
    const count =
      sibs.length > 1
        ? `<span class="count" title="branch ${idx + 1} of ${sibs.length}">${idx + 1}</span>`
        : "";
    return `
      <button class="resp${underHeader ? " hdr-resp" : ""}" data-act="jump" data-uuid="${node.uuid}"
              title="${escapeHtml(this.summarize(node.uuid, node.text, 12))}">
        <span class="l"></span>
        <span class="txt">${escapeHtml(this.summarize(node.uuid, node.text, 6))}</span>
        ${count}
      </button>`;
  }

  /** The OTHER branches only, labeled with their real numbers; the row above
   *  (header/response) already represents the current branch. */
  private renderOptions(node: TreeNode): string {
    const sibs = this.ctx.getTree()!.siblingsOf(node.uuid);
    const others = sibs.filter((s) => s.uuid !== node.uuid);
    const expanded = this.expandedBranches.has(node.uuid);
    const shown = expanded ? others : others.slice(0, OPTIONS_SHOWN_COLLAPSED);
    const hidden = others.length - shown.length;
    let html = `<div class="opts">`;
    for (const sib of shown) {
      html += `
        <button class="opt" data-act="switch" data-uuid="${sib.uuid}"
                title="${escapeHtml(this.summarize(sib.uuid, sib.text, 12))}">
          <span class="num">${sibs.indexOf(sib) + 1}</span>
          <span class="txt">${escapeHtml(this.summarize(sib.uuid, sib.text, 4))}</span>
        </button>`;
    }
    if (hidden > 0) {
      html += `<button class="caret" data-act="expand" data-uuid="${node.uuid}">▸ ${hidden} more</button>`;
    } else if (expanded && others.length > OPTIONS_SHOWN_COLLAPSED) {
      html += `<button class="caret" data-act="expand" data-uuid="${node.uuid}">▾ show less</button>`;
    }
    html += `</div>`;
    return html;
  }

  /* -------------------------------------------------- strip-mode markup */

  private renderStrip(pairs: Pair[]): string {
    let html = "";
    for (const pair of pairs) {
      const branched =
        this.branchCount(pair.prompt.uuid) > 1 ||
        (pair.response ? this.branchCount(pair.response.uuid) > 1 : false);
      const label = this.summarize(pair.prompt.uuid, pair.prompt.text, 8);
      html += `
        <button class="mini${this.currentClass(pair.prompt.uuid)}" data-act="jump"
                data-uuid="${pair.prompt.uuid}" title="${escapeHtml(label)}">
          ${branched ? `<span class="f">⑂</span>` : `<span class="d"></span>`}
        </button>`;
    }
    return html;
  }

  /* ------------------------------------------------------------ actions */

  private handleAction(act: string, uuid: string, noteId: string): void {
    const tree = this.ctx.getTree();
    switch (act) {
      case "toggle":
        this.collapsed = !this.collapsed;
        this.lastSignature = "";
        void setPanelCollapsed(this.collapsed);
        // recompute mode immediately so the toggle feels instant
        this.mode = this.collapsed || !this.fullFits ? "strip" : "full";
        this.render();
        break;
      case "expand":
        if (this.expandedBranches.has(uuid)) this.expandedBranches.delete(uuid);
        else this.expandedBranches.add(uuid);
        this.lastSignature = "";
        this.render();
        break;
      case "jump":
        void this.scrollToMessage(uuid);
        break;
      case "switch":
        if (tree) void this.adapter.switchToBranch(tree, uuid);
        break;
      case "open-note":
        this.ctx.bus.emit("unanchored-note-open", { noteId });
        break;
      case "restore-note":
        this.ctx.bus.emit("deleted-note-restore", { noteId });
        break;
    }
  }

  /**
   * Long chats virtualize: the target row may not exist yet. One clean glide
   * — no position estimates: smooth-scroll toward the end the message lies
   * on (rows mount as the viewport passes them), and the moment the target
   * mounts, redirect the same motion onto its exact position.
   */
  private async scrollToMessage(uuid: string): Promise<void> {
    const tree = this.ctx.getTree();
    const sc = this.ctx.domMap.scrollContainer;
    if (!tree || !sc) return;

    const alignTo = (row: DomRow) => {
      const rowRect = row.el.getBoundingClientRect();
      const scRect = sc.getBoundingClientRect();
      sc.scrollTo({ top: sc.scrollTop + (rowRect.top - scRect.top) - 24, behavior: "smooth" });
      this.pulse(row);
    };

    const existing = this.ctx.domMap.rowByUuid(uuid);
    if (existing) {
      alignTo(existing);
      return;
    }

    // Which end is the target on? Compare its path position with the pairs
    // currently mounted (unmounted rows are always beyond the mounted range).
    const path = tree.visiblePath();
    const targetIdx = path.findIndex((n) => n.uuid === uuid);
    if (targetIdx < 0) return;
    const mounted = this.ctx.domMap.rows.filter((r) => r.uuid);
    const firstMountedIdx = mounted.length
      ? path.findIndex((n) => n.uuid === mounted[0]!.uuid)
      : -1;
    const upward = firstMountedIdx < 0 || targetIdx < firstMountedIdx;

    for (let attempt = 0; attempt < 4; attempt++) {
      sc.scrollTo({ top: upward ? 0 : sc.scrollHeight, behavior: "smooth" });
      const found = await waitUntil(() => {
        this.ctx.domMap.rebuild(tree);
        return !!this.ctx.domMap.rowByUuid(uuid);
      }, 4000);
      if (found) {
        const row = this.ctx.domMap.rowByUuid(uuid);
        if (row) alignTo(row); // redirect the glide onto the exact position
        return;
      }
      // the glide finished without the row (scrollHeight grew as content
      // mounted) — re-issue toward the same end with fresh geometry
    }
  }

  /** Pulse the message box itself (full bubble for prompts, text block for
   *  responses) — never the control space beneath it. */
  private pulse(row: DomRow): void {
    const target = this.ctx.domMap.contentElOf(row);
    target.classList.remove("pt-highlight-pulse");
    requestAnimationFrame(() => {
      target.classList.add("pt-highlight-pulse");
      target.addEventListener("animationend", () => target.classList.remove("pt-highlight-pulse"), {
        once: true,
      });
    });
  }
}
