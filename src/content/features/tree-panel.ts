/**
 * content/features/tree-panel.ts — Feature 2: the "Prompt History" panel.
 *
 * A collapsible panel overlaid on the left edge of the chat scroll area
 * (position: fixed; spans the full viewport height below the site header;
 * geometry recomputed from the scroll container's rect on each observer tick,
 * reads batched before writes). One entry per message on the active path,
 * summarized by the swappable summarizer module, drawn on a single continuous
 * rail with sender-distinct dots.
 *
 * Branches: any message with siblings renders an ALWAYS-VISIBLE numbered
 * branch list beneath its entry — the first two branches inline (reduced
 * opacity; the current one full-opacity with an accent tick), the rest behind
 * a caret row. Clicking a branch switches through the branch-navigation
 * adapter (native-arrow stepping, no page reload; API+reload fallback).
 *
 * Rendering is driven by the ConversationTree model (bus "tree-updated"),
 * never DOM diffing; a render-signature check and a summary memo keep
 * streaming updates cheap.
 *
 * Degradation: with no mappable chat container the panel hides itself; if
 * branch switching fails the adapter shows its own one-time toast.
 *
 * Compact mode (viewport < 1100px or chat < 4 messages): a minimal vertical
 * node strip — dots and fork counts with tooltips, same click behavior.
 */
import { cssVar, FONT_SANS, UI, Z_PANEL } from "../../shared/tokens";
import { summarizer } from "../../shared/summary";
import { getPanelCollapsed, setPanelCollapsed } from "../../shared/storage";
import { escapeHtml, rafThrottle } from "../../shared/util";
import type { TreeNode } from "../../shared/tree";
import { subscribe } from "../observer";
import { NativeArrowsAdapter, type BranchSwitchAdapter } from "../branch-switch";
import type { Ctx, Feature } from "../ctx";

const COMPACT_VIEWPORT = 1100;
const COMPACT_MIN_MESSAGES = 4;
const BRANCHES_SHOWN_COLLAPSED = 2;

const PANEL_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  button { font-family: inherit; }
  button:focus-visible { outline: 2px solid ${cssVar("--accent-main-100", 0.6)}; outline-offset: 1px; }

  .panel {
    position: fixed;
    z-index: ${Z_PANEL};
    display: flex;
    flex-direction: column;
    width: 280px;
    font-family: ${FONT_SANS};
    color: ${cssVar("--text-200")};
    background: ${cssVar("--bg-100", 0.88)};
    backdrop-filter: blur(12px) saturate(1.1);
    border: 1px solid ${cssVar("--border-300")};
    border-radius: ${UI.radiusLg};
    box-shadow: ${UI.shadowSm};
    overflow: hidden;
    transition: width ${UI.transition};
  }

  .head {
    display: flex; align-items: center; gap: 8px;
    padding: 12px 10px 10px 16px;
    flex: none;
  }
  .head .title {
    flex: 1;
    font-size: 11px; font-weight: 600;
    letter-spacing: 0.08em; text-transform: uppercase;
    color: ${cssVar("--text-400")};
    white-space: nowrap; overflow: hidden;
  }
  .chev {
    flex: none; cursor: pointer; border: none; background: none;
    width: 24px; height: 24px; border-radius: ${UI.radiusSm};
    display: flex; align-items: center; justify-content: center;
    color: ${cssVar("--text-400")}; font-size: 12px; line-height: 1;
    transition: background ${UI.transition}, color ${UI.transition};
  }
  .chev:hover { background: ${cssVar("--bg-300")}; color: ${cssVar("--text-100")}; }

  .list {
    flex: 1;
    position: relative;
    overflow-y: auto; overflow-x: hidden;
    padding: 4px 8px 12px 8px;
    scrollbar-width: thin;
    scrollbar-color: ${cssVar("--border-200")} transparent;
  }
  .list::-webkit-scrollbar { width: 6px; }
  .list::-webkit-scrollbar-thumb { background: ${cssVar("--border-200")}; border-radius: 3px; }

  /* one continuous rail behind all dots */
  .rail {
    position: absolute; left: 19px; top: 10px; bottom: 12px; width: 2px;
    background: ${cssVar("--border-300")};
    border-radius: 1px;
  }

  .entry {
    position: relative;
    display: flex; align-items: flex-start; gap: 10px;
    width: 100%; text-align: left;
    padding: 6px 8px 6px 4px;
    border: none; background: none; cursor: pointer;
    border-radius: 10px;
    font-size: 12px; line-height: 1.4;
    color: ${cssVar("--text-200")};
    transition: background ${UI.transition}, color ${UI.transition};
  }
  .entry:hover { background: ${cssVar("--bg-300", 0.75)}; color: ${cssVar("--text-100")}; }

  .dot {
    flex: none; position: relative; z-index: 1;
    width: 10px; height: 10px; border-radius: 50%;
    margin: 4px 0 0 3px;
    background: ${cssVar("--accent-main-100")};
    box-shadow: 0 0 0 3px ${cssVar("--bg-100")};
  }
  .dot.assistant {
    width: 8px; height: 8px; margin: 5px 1px 0 4px;
    background: ${cssVar("--bg-100")};
    border: 2px solid ${cssVar("--text-500")};
  }

  .summary { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .count {
    flex: none; align-self: center;
    font-size: 10px; font-variant-numeric: tabular-nums;
    color: ${cssVar("--text-400")};
    background: ${cssVar("--bg-300", 0.8)};
    border-radius: 99px; padding: 1px 7px; line-height: 14px;
  }

  /* --------------------------- always-visible numbered branch list */
  .branches { padding: 0 0 4px 34px; display: flex; flex-direction: column; }
  .branch {
    display: flex; align-items: center; gap: 7px;
    border: none; background: none; cursor: pointer; text-align: left;
    padding: 3px 8px; border-radius: ${UI.radiusSm};
    font-size: 11.5px; line-height: 1.35;
    color: ${cssVar("--text-300")};
    opacity: 0.65;
    transition: opacity ${UI.transition}, background ${UI.transition};
  }
  .branch:hover { opacity: 1; background: ${cssVar("--bg-300", 0.75)}; }
  .branch .num {
    flex: none; font-size: 10px; font-variant-numeric: tabular-nums;
    color: ${cssVar("--text-500")}; min-width: 10px;
  }
  .branch .text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .branch.current {
    opacity: 1; cursor: default;
    color: ${cssVar("--text-100")};
    box-shadow: inset 2px 0 0 0 ${cssVar("--accent-main-100")};
  }
  .branch.current .num { color: ${cssVar("--accent-main-200")}; }
  .branch.current:hover { background: none; }
  .caret {
    display: flex; align-items: center; gap: 7px;
    border: none; background: none; cursor: pointer; text-align: left;
    padding: 2px 8px; border-radius: ${UI.radiusSm};
    font-size: 10.5px; color: ${cssVar("--text-500")};
    transition: color ${UI.transition}, background ${UI.transition};
  }
  .caret:hover { color: ${cssVar("--text-200")}; background: ${cssVar("--bg-300", 0.75)}; }

  /* ------------------------------------------------ unanchored drawer */
  .drawer {
    flex: none; border-top: 1px solid ${cssVar("--border-300")};
    padding: 8px 12px; font-size: 10.5px;
    letter-spacing: 0.05em; text-transform: uppercase;
    color: ${cssVar("--text-500")};
  }
  .drawer button {
    display: block; width: 100%; text-align: left; border: none; background: none;
    font-size: 11.5px; text-transform: none; letter-spacing: 0;
    color: ${cssVar("--text-300")};
    padding: 3px 6px; margin-top: 2px; cursor: pointer; border-radius: ${UI.radiusSm};
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    transition: background ${UI.transition}, color ${UI.transition};
  }
  .drawer button:hover { background: ${cssVar("--bg-300")}; color: ${cssVar("--text-100")}; }

  /* ------------------------------------------------- collapsed edge tab */
  .panel.collapsed { width: 26px; }
  .panel.collapsed .head { padding: 10px 0; justify-content: center; }
  .panel.collapsed .title, .panel.collapsed .list, .panel.collapsed .drawer,
  .panel.collapsed .rail { display: none; }

  /* ------------------------------------------------- compact node strip */
  .panel.compact { width: 40px; }
  .panel.compact .head { padding: 8px 0; justify-content: center; }
  .panel.compact .title { display: none; }
  .panel.compact .rail { left: 18px; }
  .panel.compact .entry { padding: 4px 0; justify-content: center; gap: 0; }
  .panel.compact .dot { margin: 2px 0 0 0; }
  .panel.compact .dot.assistant { margin: 3px 0 0 0; }
  .panel.compact .summary, .panel.compact .branches, .panel.compact .drawer { display: none; }
  .panel.compact .count {
    position: absolute; right: 2px; top: -1px;
    padding: 0 4px; line-height: 12px; font-size: 8.5px;
  }
  .panel.compact.collapsed { width: 26px; }
`;

export class TreePanelFeature implements Feature {
  readonly id = "treePanel" as const;

  private enabled = false;
  private host: HTMLElement | null = null;
  private shadow: ShadowRoot | null = null;
  private collapsed = false;
  /** Message uuids whose branch list is expanded beyond the first two. */
  private expandedBranches = new Set<string>();
  private drawerItems: Array<{ noteId: string; label: string }> = [];
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
      this.lastSignature = "";
      this.summaryCache.clear();
      this.render();
    });
    ctx.bus.on("unanchored-notes", (msg) => {
      if (msg.conversationUuid !== ctx.getCurrentConversation()) return;
      this.drawerItems = msg.items;
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

  /* -------------------------------------------------------- positioning */

  private onTick(): void {
    if (!this.enabled || !this.host) return;
    const sc = this.ctx.domMap.scrollContainer;
    const panel = this.shadow?.querySelector<HTMLElement>(".panel");
    if (!panel) return;
    if (!sc || !this.ctx.getCurrentConversation()) {
      if (panel.style.display !== "none") panel.style.display = "none";
      return;
    }
    // read phase — full viewport height below the site header
    const rect = sc.getBoundingClientRect();
    const top = Math.round(rect.top + 8);
    const left = `${Math.round(rect.left + 10)}px`;
    const topPx = `${top}px`;
    const height = `${Math.max(160, window.innerHeight - top - 12)}px`;
    // write phase (guarded)
    if (panel.style.display !== "flex") panel.style.display = "flex";
    if (panel.style.left !== left) panel.style.left = left;
    if (panel.style.top !== topPx) panel.style.top = topPx;
    if (panel.style.height !== height) panel.style.height = height;
    this.render(); // signature check makes this cheap when nothing changed
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

  private isCompact(pathLength: number): boolean {
    return window.innerWidth < COMPACT_VIEWPORT || pathLength < COMPACT_MIN_MESSAGES;
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

  private doRender(): void {
    if (!this.enabled) return;
    const shadow = this.ensureHost();
    if (!shadow) return;
    const panel = shadow.querySelector<HTMLElement>(".panel")!;
    const tree = this.ctx.getTree();
    const path = tree ? tree.visiblePath() : [];
    const compact = this.isCompact(path.length);

    const signature = JSON.stringify({
      c: this.collapsed,
      k: compact,
      d: this.drawerItems,
      x: [...this.expandedBranches],
      p: path.map((n) => {
        const sibs = tree!.siblingsOf(n.uuid);
        return [
          n.uuid,
          n.sender,
          this.summarize(n.uuid, n.text, 6),
          sibs.map((s) => [s.uuid, this.summarize(s.uuid, s.text, 4)]),
          sibs.findIndex((s) => s.uuid === n.uuid),
        ];
      }),
    });
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    panel.classList.toggle("collapsed", this.collapsed);
    panel.classList.toggle("compact", compact);

    let html = `
      <div class="head">
        <span class="title">Prompt History</span>
        <button class="chev" data-act="toggle"
                title="${this.collapsed ? "Expand" : "Collapse"} Prompt History"
                aria-label="${this.collapsed ? "Expand" : "Collapse"} Prompt History">${this.collapsed ? "»" : "«"}</button>
      </div>
      <div class="list"><span class="rail"></span>`;

    for (const node of path) {
      const sibs = tree!.siblingsOf(node.uuid);
      const idx = sibs.findIndex((s) => s.uuid === node.uuid);
      const summary = escapeHtml(this.summarize(node.uuid, node.text, 6));
      const count =
        sibs.length > 1
          ? `<span class="count" title="${sibs.length} branches">${idx + 1}/${sibs.length}</span>`
          : "";
      html += `
        <button class="entry" data-act="jump" data-uuid="${node.uuid}"
                title="${escapeHtml(this.summarize(node.uuid, node.text, 12))}">
          <span class="dot ${node.sender === "assistant" ? "assistant" : ""}"></span>
          <span class="summary">${summary}</span>
          ${count}
        </button>`;
      if (!compact && sibs.length > 1) html += this.renderBranchList(node, sibs);
    }
    html += `</div>`;

    if (!this.collapsed && this.drawerItems.length) {
      html += `<div class="drawer">Unanchored notes`;
      for (const item of this.drawerItems) {
        html += `<button data-act="open-note" data-note="${escapeHtml(item.noteId)}">${escapeHtml(item.label)}</button>`;
      }
      html += `</div>`;
    }

    panel.innerHTML = html;
    panel.querySelectorAll<HTMLElement>("[data-act]").forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.handleAction(el.dataset["act"] ?? "", el.dataset["uuid"] ?? "", el.dataset["note"] ?? "");
      });
    });
  }

  /** The always-visible numbered branch list under an entry. */
  private renderBranchList(node: TreeNode, sibs: TreeNode[]): string {
    const expanded = this.expandedBranches.has(node.uuid);
    const shown = expanded ? sibs : sibs.slice(0, BRANCHES_SHOWN_COLLAPSED);
    const hidden = sibs.length - shown.length;
    let html = `<div class="branches">`;
    for (let i = 0; i < shown.length; i++) {
      const sib = shown[i]!;
      const current = sib.uuid === node.uuid;
      html += `
        <button class="branch ${current ? "current" : ""}"
                ${current ? "" : `data-act="switch" data-uuid="${sib.uuid}"`}
                title="${escapeHtml(this.summarize(sib.uuid, sib.text, 12))}">
          <span class="num">${sibs.indexOf(sib) + 1}</span>
          <span class="text">${escapeHtml(this.summarize(sib.uuid, sib.text, 4))}</span>
        </button>`;
    }
    if (hidden > 0) {
      html += `<button class="caret" data-act="expand" data-uuid="${node.uuid}">▸ ${hidden} more</button>`;
    } else if (expanded && sibs.length > BRANCHES_SHOWN_COLLAPSED) {
      html += `<button class="caret" data-act="expand" data-uuid="${node.uuid}">▾ show less</button>`;
    }
    html += `</div>`;
    return html;
  }

  private handleAction(act: string, uuid: string, noteId: string): void {
    const tree = this.ctx.getTree();
    switch (act) {
      case "toggle":
        this.collapsed = !this.collapsed;
        this.lastSignature = "";
        void setPanelCollapsed(this.collapsed);
        this.render();
        break;
      case "expand":
        if (this.expandedBranches.has(uuid)) this.expandedBranches.delete(uuid);
        else this.expandedBranches.add(uuid);
        this.lastSignature = "";
        this.render();
        break;
      case "jump":
        this.scrollToMessage(uuid);
        break;
      case "switch":
        if (tree) void this.adapter.switchToBranch(tree, uuid);
        break;
      case "open-note":
        this.ctx.bus.emit("unanchored-note-open", { noteId });
        break;
    }
  }

  private scrollToMessage(uuid: string): void {
    const row = this.ctx.domMap.rowByUuid(uuid);
    const sc = this.ctx.domMap.scrollContainer;
    if (!row || !sc) return;
    const rowRect = row.el.getBoundingClientRect();
    const scRect = sc.getBoundingClientRect();
    sc.scrollTo({ top: sc.scrollTop + (rowRect.top - scRect.top) - 24, behavior: "smooth" });
    // Pulse only the message text, not the row's control space.
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
