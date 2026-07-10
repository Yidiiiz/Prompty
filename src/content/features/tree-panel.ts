/**
 * content/features/tree-panel.ts — Feature 2: the "Prompt Tree" panel.
 *
 * A collapsible panel overlaid on the left edge of the chat scroll area
 * (position: fixed, geometry recomputed from the scroll container's rect on
 * each observer tick — reads batched before writes). One entry per message on
 * the currently active path; entries are local text summaries (swappable
 * summarizer module). Messages with siblings get a k/n badge and expandable
 * sibling stubs; clicking a stub switches branches through the
 * branch-navigation adapter (direct jump, any sibling to any sibling).
 *
 * Rendering is driven by the ConversationTree model (bus "tree-updated"),
 * never DOM diffing; a render-signature check keeps streaming updates cheap.
 *
 * Degradation: with no mappable chat container the panel hides itself; if
 * branch switching fails the adapter shows its own one-time toast.
 *
 * Compact mode (viewport < 1100px or chat < 4 messages): a minimal vertical
 * node strip — dots and fork glyphs with tooltips, same click behavior.
 */
import { cssVar, FONT_SANS } from "../../shared/tokens";
import { summarizer } from "../../shared/summary";
import { getPanelCollapsed, setPanelCollapsed } from "../../shared/storage";
import { escapeHtml, rafThrottle } from "../../shared/util";
import { subscribe } from "../observer";
import { LeafPutAdapter, type BranchSwitchAdapter } from "../branch-switch";
import type { Ctx, Feature } from "../ctx";

const COMPACT_VIEWPORT = 1100;
const COMPACT_MIN_MESSAGES = 4;

const PANEL_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .panel {
    position: fixed;
    z-index: 900;
    display: flex;
    flex-direction: column;
    font-family: ${FONT_SANS};
    color: ${cssVar("--text-200")};
    background: ${cssVar("--bg-100", 0.92)};
    backdrop-filter: blur(6px);
    border: 1px solid ${cssVar("--border-300")};
    border-radius: 12px;
    box-shadow: 0 2px 10px hsl(0 0% 0% / 0.06);
    overflow: hidden;
    max-width: 236px;
  }
  .head {
    display: flex; align-items: center; gap: 6px;
    padding: 8px 10px;
    font-size: 12px; font-weight: 600;
    color: ${cssVar("--text-300")};
    border-bottom: 1px solid ${cssVar("--border-300")};
    flex: none;
  }
  .head .title { flex: 1; letter-spacing: .02em; }
  .chev {
    cursor: pointer; border: none; background: none; padding: 2px;
    color: ${cssVar("--text-400")}; font-family: inherit; font-size: 12px;
    border-radius: 6px; line-height: 1;
  }
  .chev:hover { background: ${cssVar("--bg-300")}; color: ${cssVar("--text-100")}; }
  .list { overflow-y: auto; overflow-x: hidden; padding: 6px 0; scrollbar-width: thin; }
  .node { position: relative; }
  .entry {
    display: flex; align-items: flex-start; gap: 8px;
    width: 100%; text-align: left;
    padding: 4px 10px 4px 14px;
    border: none; background: none; cursor: pointer;
    font-family: inherit; font-size: 12px; line-height: 1.35;
    color: ${cssVar("--text-200")};
  }
  .entry:hover { background: ${cssVar("--bg-300", 0.7)}; }
  .dot {
    flex: none; width: 8px; height: 8px; border-radius: 50%;
    margin-top: 3px;
    background: ${cssVar("--accent-main-100")};
  }
  .dot.assistant {
    background: ${cssVar("--bg-000")};
    border: 1.5px solid ${cssVar("--text-400")};
    width: 7px; height: 7px;
  }
  .connector {
    position: absolute; left: 17.5px; top: 16px; bottom: -6px; width: 1px;
    background: ${cssVar("--border-200")};
  }
  .node:last-child > .connector { display: none; }
  .summary { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge {
    flex: none; font-size: 10px; padding: 0 5px; border-radius: 7px;
    background: ${cssVar("--accent-main-100", 0.14)};
    color: ${cssVar("--accent-main-200")};
    border: 1px solid ${cssVar("--accent-main-100", 0.3)};
    cursor: pointer; line-height: 15px;
  }
  .stubs { padding: 0 10px 4px 30px; display: flex; flex-direction: column; gap: 2px; }
  .stub {
    display: flex; align-items: center; gap: 6px;
    border: none; background: none; cursor: pointer; text-align: left;
    font-family: inherit; font-size: 11px; color: ${cssVar("--text-400")};
    padding: 2px 6px; border-radius: 6px;
  }
  .stub:hover { background: ${cssVar("--bg-300", 0.7)}; color: ${cssVar("--text-100")}; }
  .stub .fork { flex: none; color: ${cssVar("--accent-main-100")}; }
  .stub.current { color: ${cssVar("--text-200")}; cursor: default; }
  .drawer {
    flex: none; border-top: 1px solid ${cssVar("--border-300")};
    padding: 6px 10px; font-size: 11px; color: ${cssVar("--text-400")};
  }
  .drawer button {
    display: block; width: 100%; text-align: left; border: none; background: none;
    font-family: inherit; font-size: 11px; color: ${cssVar("--text-300")};
    padding: 2px 4px; cursor: pointer; border-radius: 6px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .drawer button:hover { background: ${cssVar("--bg-300")}; }
  /* collapsed edge tab */
  .panel.collapsed { width: 22px; max-width: 22px; }
  .panel.collapsed .head { border-bottom: none; padding: 8px 4px; justify-content: center; }
  .panel.collapsed .title, .panel.collapsed .list, .panel.collapsed .drawer { display: none; }
  /* compact node strip */
  .panel.compact { max-width: 34px; }
  .panel.compact .head { padding: 6px 4px; justify-content: center; }
  .panel.compact .title { display: none; }
  .panel.compact .entry { padding: 3px 0; justify-content: center; }
  .panel.compact .summary, .panel.compact .stubs { display: none; }
  .panel.compact .connector { left: 16.5px; top: 14px; bottom: -4px; }
  .panel.compact .badge {
    position: absolute; right: 1px; top: 0; padding: 0 3px; line-height: 12px; font-size: 8px;
  }
  .panel.compact.collapsed { max-width: 22px; }
`;

export class TreePanelFeature implements Feature {
  readonly id = "treePanel" as const;

  private enabled = false;
  private host: HTMLElement | null = null;
  private shadow: ShadowRoot | null = null;
  private collapsed = false;
  private expandedBadges = new Set<string>();
  private drawerItems: Array<{ noteId: string; label: string }> = [];
  private lastSignature = "";
  /** Summary memo — summarize() runs regexes over full message text, so it
   *  must not run per node per tick. Keyed by uuid+len (streaming-safe). */
  private summaryCache = new Map<string, string>();
  private adapter: BranchSwitchAdapter;
  private render: () => void;

  constructor(private ctx: Ctx) {
    this.adapter = new LeafPutAdapter(ctx);
    this.render = rafThrottle(() => this.doRender());
    void getPanelCollapsed().then((c) => {
      this.collapsed = c;
      this.render();
    });
    ctx.bus.on("tree-updated", () => this.render());
    ctx.bus.on("conversation-changed", () => {
      this.expandedBadges.clear();
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
    // read phase
    const rect = sc.getBoundingClientRect();
    const left = `${Math.round(rect.left + 10)}px`;
    const top = `${Math.round(rect.top + 14)}px`;
    const maxHeight = `${Math.max(120, Math.round(rect.height - 28))}px`;
    // write phase (guarded)
    if (panel.style.display !== "flex") panel.style.display = "flex";
    if (panel.style.left !== left) panel.style.left = left;
    if (panel.style.top !== top) panel.style.top = top;
    if (panel.style.maxHeight !== maxHeight) panel.style.maxHeight = maxHeight;
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
      x: [...this.expandedBadges],
      p: path.map((n) => {
        const sibs = tree!.siblingsOf(n.uuid);
        return [n.uuid, n.sender, this.summarize(n.uuid, n.text, 6), sibs.length, sibs.findIndex((s) => s.uuid === n.uuid)];
      }),
    });
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    panel.classList.toggle("collapsed", this.collapsed);
    panel.classList.toggle("compact", compact);

    const chevGlyph = this.collapsed ? "»" : "«";
    let html = `
      <div class="head">
        <span class="title">Prompt Tree</span>
        <button class="chev" data-act="toggle" title="${this.collapsed ? "Expand" : "Collapse"} Prompt Tree">${chevGlyph}</button>
      </div>
      <div class="list">`;

    for (const node of path) {
      const sibs = tree!.siblingsOf(node.uuid);
      const idx = sibs.findIndex((s) => s.uuid === node.uuid);
      const summary = escapeHtml(this.summarize(node.uuid, node.text, 6));
      const badge =
        sibs.length > 1
          ? `<span class="badge" data-act="expand" data-uuid="${node.uuid}" title="${sibs.length} branches — click to show">${idx + 1}/${sibs.length}</span>`
          : "";
      const forkTitle = sibs.length > 1 ? ` (${idx + 1} of ${sibs.length} branches)` : "";
      html += `
        <div class="node">
          <span class="connector"></span>
          <button class="entry" data-act="jump" data-uuid="${node.uuid}"
                  title="${escapeHtml(this.summarize(node.uuid, node.text, 12))}${forkTitle}">
            <span class="dot ${node.sender === "assistant" ? "assistant" : ""}"></span>
            <span class="summary">${summary}</span>
            ${badge}
          </button>`;
      if (!compact && sibs.length > 1 && this.expandedBadges.has(node.uuid)) {
        html += `<div class="stubs">`;
        for (let s = 0; s < sibs.length; s++) {
          const sib = sibs[s]!;
          const current = sib.uuid === node.uuid;
          html += `
            <button class="stub ${current ? "current" : ""}" data-act="${current ? "" : "switch"}" data-uuid="${sib.uuid}">
              <span class="fork">⑂</span>
              <span>${s + 1}. ${escapeHtml(this.summarize(sib.uuid, sib.text, 4))}${current ? " (current)" : ""}</span>
            </button>`;
        }
        html += `</div>`;
      }
      html += `</div>`;
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
        if (this.expandedBadges.has(uuid)) this.expandedBadges.delete(uuid);
        else this.expandedBadges.add(uuid);
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
    row.el.classList.remove("pt-highlight-pulse");
    // restart the pulse animation reliably on the next frame
    requestAnimationFrame(() => {
      row.el.classList.add("pt-highlight-pulse");
      row.el.addEventListener("animationend", () => row.el.classList.remove("pt-highlight-pulse"), {
        once: true,
      });
    });
  }
}
