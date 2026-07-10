/**
 * content/features/branch-compose.ts — Feature 1: write a branch (an
 * alternative to an existing user message) using the full-power main
 * composer instead of the small inline edit box.
 *
 * Mechanism: reconnaissance confirmed a native edit is just a completion send
 * whose parent_message_uuid is the edited message's parent. Activating branch
 * mode arms a parent override in the page script; the user's next normal send
 * leaves the browser with its parent_message_uuid rewritten to the ghosted
 * message's parent — attachments and every other field pass through
 * untouched. No keystroke simulation, ever.
 *
 * Visual state (ghost + hidden rows + header bar) is REAPPLIED from the
 * uuid-keyed mode state on every observer tick, so scrolling/re-renders never
 * lose it.
 *
 * Failure behavior: if the hover toolbar or composer dock hooks are missing,
 * the entry button simply does not appear (one-time toast). If a send fails,
 * the mode reactivates (override re-armed) and the native error stays
 * visible; the draft is never touched.
 */
import { cssVar, FONT_SANS, UI, Z_PANEL } from "../../shared/tokens";
import { summarizer } from "../../shared/summary";
import { q } from "../../shared/selectors";
import { toastOnce } from "../toast";
import { getComposerDockRect } from "../composer";
import { subscribe } from "../observer";
import type { Ctx, Feature } from "../ctx";

interface ModeState {
  conversationUuid: string;
  targetUuid: string;
  parentUuid: string;
  /** Set once a rewritten send has left; used to reactivate on failure. */
  awaitingOutcome: boolean;
}

const BTN_CLASS = "pt-branch-btn";

export class BranchComposeFeature implements Feature {
  readonly id = "branchCompose" as const;

  private enabled = false;
  private mode: ModeState | null = null;
  private headerHost: HTMLElement | null = null;

  constructor(private ctx: Ctx) {
    subscribe(() => this.onTick());

    ctx.bus.on("send-observed", (msg) => {
      if (!this.mode || msg.conversationUuid !== this.mode.conversationUuid) return;
      if (msg.rewriteApplied) {
        // The branch send has left the browser. Clear the UI immediately so
        // the streaming reply is visible; keep state to reactivate on failure.
        this.mode.awaitingOutcome = true;
        this.clearVisuals();
      }
    });
    ctx.bus.on("stream-done", (msg) => {
      if (this.mode?.awaitingOutcome && msg.conversationUuid === this.mode.conversationUuid) {
        this.mode = null; // success — fully exited
      }
    });
    ctx.bus.on("send-failed", (msg) => {
      if (this.mode?.awaitingOutcome && msg.conversationUuid === this.mode.conversationUuid) {
        // Stay in branch mode: re-arm the override (the page consumed it) and
        // restore visuals. The native error surface and the draft are untouched.
        this.mode.awaitingOutcome = false;
        this.ctx.sendToPage({
          type: "set-parent-override",
          conversationUuid: this.mode.conversationUuid,
          parentMessageUuid: this.mode.parentUuid,
        });
      }
    });
  }

  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    if (!on) {
      this.cancel();
      for (const btn of document.querySelectorAll(`.${BTN_CLASS}`)) btn.remove();
    }
  }

  onConversation(): void {
    // Exiting cleanly on navigation: the target uuid belongs to the old chat.
    this.cancel();
  }

  /* ------------------------------------------------------------- entry */

  private onTick(): void {
    if (!this.enabled) return;
    this.injectButtons();
    if (this.mode && !this.mode.awaitingOutcome) this.applyVisuals();
  }

  private injectButtons(): void {
    // The hover toolbar containing the native edit control is the anchor; a
    // button is added beside it for every user message row we can map.
    for (const row of this.ctx.domMap.rows) {
      if (row.sender !== "human" || !row.uuid) continue;
      const editBtn = q<HTMLElement>("actionBarEdit", row.el);
      const toolbar = editBtn?.parentElement;
      if (!toolbar || toolbar.querySelector(`.${BTN_CLASS}`)) continue;
      const btn = document.createElement("button");
      btn.className = BTN_CLASS;
      btn.type = "button";
      btn.title = "Compose a branch of this message in the main composer";
      btn.innerHTML =
        `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">` +
        `<path d="M4 13V6"/><circle cx="4" cy="14" r="1.6"/><circle cx="4" cy="4" r="1.6"/>` +
        `<circle cx="12" cy="6" r="1.6"/><path d="M4 11c0-3 8-2 8-4"/></svg>` +
        `<span>Branch from here</span>`;
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const targetRow = this.ctx.domMap.rowForElement(btn);
        if (targetRow?.uuid) this.activate(targetRow.uuid);
      });
      toolbar.appendChild(btn);
    }
  }

  /* -------------------------------------------------------------- mode */

  activate(targetUuid: string): void {
    const conversationUuid = this.ctx.getCurrentConversation();
    const tree = this.ctx.getTree();
    const node = tree?.nodes.get(targetUuid);
    if (!conversationUuid || !tree || !node) {
      toastOnce("branch-activate", "Prompt Tree: couldn't resolve that message in the conversation tree.");
      return;
    }
    this.cancel(); // per-activation mode: entering replaces any prior state
    this.mode = {
      conversationUuid,
      targetUuid,
      parentUuid: node.parentUuid, // sentinel uuid when branching the first message
      awaitingOutcome: false,
    };
    this.ctx.sendToPage({
      type: "set-parent-override",
      conversationUuid,
      parentMessageUuid: node.parentUuid,
    });
    this.applyVisuals();
  }

  cancel(): void {
    if (!this.mode) return;
    this.ctx.sendToPage({
      type: "set-parent-override",
      conversationUuid: this.mode.conversationUuid,
      parentMessageUuid: null,
    });
    this.mode = null;
    this.clearVisuals();
  }

  isActive(): boolean {
    return this.mode !== null && !this.mode.awaitingOutcome;
  }

  /** For the drafts feature: what would this send branch from? */
  currentTarget(): { targetUuid: string; parentUuid: string } | null {
    return this.mode && !this.mode.awaitingOutcome
      ? { targetUuid: this.mode.targetUuid, parentUuid: this.mode.parentUuid }
      : null;
  }

  /* ----------------------------------------------------------- visuals */

  private applyVisuals(): void {
    const mode = this.mode;
    if (!mode) return;
    const rows = this.ctx.domMap.rows;
    const targetIdx = rows.findIndex((r) => r.uuid === mode.targetUuid);
    for (let i = 0; i < rows.length; i++) {
      const el = rows[i]!.el;
      const ghost = targetIdx >= 0 && i === targetIdx;
      const hidden = targetIdx >= 0 && i > targetIdx;
      if (el.classList.contains("pt-branch-ghost") !== ghost) el.classList.toggle("pt-branch-ghost", ghost);
      if (el.classList.contains("pt-branch-hidden") !== hidden) el.classList.toggle("pt-branch-hidden", hidden);
    }
    this.ensureHeader(mode);
  }

  private clearVisuals(): void {
    for (const el of document.querySelectorAll(".pt-branch-ghost")) el.classList.remove("pt-branch-ghost");
    for (const el of document.querySelectorAll(".pt-branch-hidden")) el.classList.remove("pt-branch-hidden");
    this.headerHost?.remove();
    this.headerHost = null;
  }

  /** Keeps the floating header aligned just above the prompt box. */
  private positionHeader(): void {
    if (!this.headerHost) return;
    const dockRect = getComposerDockRect();
    if (!dockRect) return;
    const width = Math.min(dockRect.width, 720);
    const left = `${Math.round(dockRect.left + (dockRect.width - width) / 2)}px`;
    // stack above the draft-restore banner when both are showing
    const banner = document.getElementById("pt-draft-banner");
    const lift = banner ? banner.offsetHeight + 8 : 0;
    const bottom = `${Math.round(window.innerHeight - dockRect.top + 8 + lift)}px`;
    const widthPx = `${Math.round(width)}px`;
    const style = this.headerHost.style;
    if (style.left !== left) style.left = left;
    if (style.bottom !== bottom) style.bottom = bottom;
    if (style.width !== widthPx) style.width = widthPx;
  }

  private ensureHeader(mode: ModeState): void {
    if (this.headerHost?.isConnected) {
      this.positionHeader();
      return;
    }
    if (!getComposerDockRect()) {
      toastOnce("branch-dock", "Prompt Tree: composer not found — the branching header can't be shown.");
      return;
    }
    const label = summarizer.summarize(this.ctx.getTree()?.nodes.get(mode.targetUuid)?.text ?? "", 8);
    const host = document.createElement("div");
    host.id = "pt-branch-header";
    // floats above the prompt box instead of sitting inside its container
    host.style.cssText = `position:fixed;z-index:${Z_PANEL};pointer-events:none;`;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .bar {
          pointer-events: auto;
          display: flex; align-items: center; gap: 10px;
          font-family: ${FONT_SANS}; font-size: 12.5px; line-height: 1.4;
          color: ${cssVar("--text-100")};
          background: ${cssVar("--bg-200", 0.97)};
          backdrop-filter: blur(8px);
          box-shadow: inset 3px 0 0 0 ${cssVar("--accent-main-100", 0.8)}, ${UI.shadowMd};
          border-radius: 0 ${UI.radiusMd} ${UI.radiusMd} 0;
          padding: 7px 8px 7px 14px;
          white-space: nowrap; overflow: hidden;
          animation: pt-bar-in 160ms ease-out;
        }
        @keyframes pt-bar-in {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .glyph { flex: none; color: ${cssVar("--accent-main-200")}; display: flex; }
        .label { overflow: hidden; text-overflow: ellipsis; flex: 1; }
        .label em { font-style: normal; font-weight: 500; color: ${cssVar("--text-100")}; }
        button {
          font-family: inherit; font-size: 12px; cursor: pointer;
          color: ${cssVar("--text-300")};
          background: ${cssVar("--bg-000")};
          border: 1px solid ${cssVar("--border-200")};
          border-radius: ${UI.radiusSm}; padding: 4px 12px;
          transition: background ${UI.transition}, color ${UI.transition};
        }
        button:hover { color: ${cssVar("--text-100")}; background: ${cssVar("--bg-300")}; }
        button:focus-visible { outline: 2px solid ${cssVar("--accent-main-100", 0.6)}; outline-offset: 1px; }
      </style>
      <div class="bar" role="status">
        <span class="glyph"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 13V6"/><circle cx="4" cy="14" r="1.6"/><circle cx="4" cy="4" r="1.6"/><circle cx="12" cy="6" r="1.6"/><path d="M4 11c0-3 8-2 8-4"/></svg></span>
        <span class="label">Branching from: <em></em></span>
        <button type="button">Cancel</button>
      </div>`;
    shadow.querySelector("em")!.textContent = `“${label}”`;
    shadow.querySelector("button")!.addEventListener("click", () => this.cancel());
    document.body.appendChild(host);
    this.headerHost = host;
    this.positionHeader();
  }
}
