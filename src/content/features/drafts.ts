/**
 * content/features/drafts.ts — Feature 5: draft autosave and restore.
 *
 * Captures (debounced ~500ms):
 *  - main-composer input → mode "normal", or "branch" with the ghosted
 *    message's uuid + parent when branch-compose is active;
 *  - note/comment composer input (via bus events from NoteCardManager) →
 *    mode "note"/"comment" with the full anchor object;
 *  - attachments seen entering the composer (file-input change, paste, drop)
 *    → serialized to IndexedDB up to 5 MB total, otherwise flagged
 *    "attachments not saved".
 *
 * Restores: on conversation load, a draft younger than 2 hours shows a slim
 * banner above the composer (italic "autosaved message" + first line +
 * Restore/Clear). Restore re-enters the saved mode — reactivating branch mode
 * on its target or reopening the note/comment composer at the re-resolved
 * anchor — refills the text and reattaches files. A missing target degrades
 * to a normal-text restore with an explanatory toast.
 *
 * Lifecycle: a live draft keeps refreshing savedAt on every input (and on
 * load/visibility when the composer still holds it), so it never expires
 * while in use; expired drafts are purged lazily; a successful send clears
 * the draft.
 *
 * KNOWN LIMITATION (documented in README): files removed from the composer
 * after being captured cannot be observed, so a restored draft may offer
 * files the user had removed; attachment restore uses a synthetic drop and
 * degrades to a notice when the app ignores it.
 */
import { debounce } from "../../shared/util";
import { cssVar, FONT_SANS, UI } from "../../shared/tokens";
import { sel } from "../../shared/selectors";
import {
  clearDraft,
  getDraft,
  getDraftFiles,
  saveDraft,
  saveDraftFiles,
  type DraftMode,
  type DraftRecord,
} from "../../shared/storage";
import { subscribe } from "../observer";
import { toastOnce } from "../toast";
import { attachFilesToComposer, getComposerDock, getComposerEl, getComposerText, setComposerText } from "../composer";
import type { Ctx, Feature } from "../ctx";
import type { BranchComposeFeature } from "./branch-compose";
import type { GutterAnchor, NoteCardManager } from "./note-cards";

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const DRAFT_TTL_MS = 2 * 60 * 60 * 1000;

export class DraftsFeature implements Feature {
  readonly id = "draftAutosave" as const;

  private enabled = false;
  private bannerHost: HTMLElement | null = null;
  private bannerForConversation: string | null = null;
  private composerListenerAttached = new WeakSet<HTMLElement>();
  private sessionFiles = new Map<string, File[]>();
  private lastSendAt = new Map<string, number>();
  private saveMain: () => void;
  private noteDraft: { kind: "note" | "comment"; anchor: GutterAnchor; text: string } | null = null;
  private saveNoteDraft: () => void;

  constructor(
    private ctx: Ctx,
    private branch: BranchComposeFeature,
    private cards: NoteCardManager
  ) {
    this.saveMain = debounce(() => void this.persistMainDraft(), 500);
    this.saveNoteDraft = debounce(() => void this.persistNoteDraft(), 500);

    subscribe(() => this.onTick());

    ctx.bus.on("note-composer-input", (msg) => {
      if (!this.enabled || msg.conversationUuid !== ctx.getCurrentConversation()) return;
      this.noteDraft = { kind: msg.kind, anchor: msg.anchor as unknown as GutterAnchor, text: msg.text };
      this.saveNoteDraft();
    });
    ctx.bus.on("note-composer-closed", () => {
      this.noteDraft = null;
    });
    ctx.bus.on("note-send-started", (msg) => {
      // note sent: its draft is done
      if (this.enabled) void clearDraft(msg.conversationUuid);
    });
    ctx.bus.on("send-observed", (msg) => {
      this.lastSendAt.set(msg.conversationUuid, Date.now());
    });
    ctx.bus.on("stream-done", (msg) => {
      if (!this.enabled) return;
      void this.clearIfSent(msg.conversationUuid);
    });
    ctx.bus.on("conversation-changed", (msg) => {
      this.removeBanner();
      this.noteDraft = null;
      if (this.enabled && msg.conversationUuid) void this.offerRestore(msg.conversationUuid);
    });

    // Attachment capture: file-input changes, paste, and drop near the composer.
    document.addEventListener(
      "change",
      (ev) => {
        if (!this.enabled) return;
        const input = ev.target;
        if (input instanceof HTMLInputElement && input.matches(sel("fileUpload")) && input.files?.length) {
          this.captureFiles([...input.files]);
        }
      },
      true
    );
    const captureFromDataTransfer = (dt: DataTransfer | null) => {
      if (!this.enabled || !dt?.files.length) return;
      this.captureFiles([...dt.files]);
    };
    document.addEventListener("paste", (ev) => {
      if (ev.isTrusted && this.isInComposer(ev.target)) captureFromDataTransfer(ev.clipboardData);
    }, true);
    document.addEventListener("drop", (ev) => {
      if (ev.isTrusted && this.isInComposer(ev.target)) captureFromDataTransfer(ev.dataTransfer);
    }, true);

    document.addEventListener("visibilitychange", () => {
      if (this.enabled && !document.hidden) void this.bumpIfLive();
    });
  }

  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    if (!on) this.removeBanner();
    else {
      const conv = this.ctx.getCurrentConversation();
      if (conv) void this.offerRestore(conv);
    }
  }

  onConversation(): void {
    /* handled via the conversation-changed bus event */
  }

  /* ------------------------------------------------------------- capture */

  private onTick(): void {
    if (!this.enabled) return;
    const composer = getComposerEl();
    if (composer && !this.composerListenerAttached.has(composer)) {
      this.composerListenerAttached.add(composer);
      composer.addEventListener("input", () => {
        if (this.enabled) this.saveMain();
      });
    }
    // keep the banner docked if the composer remounts
    if (this.bannerHost && !this.bannerHost.isConnected) this.dockBanner();
  }

  private isInComposer(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    const dock = getComposerDock();
    return !!dock && (dock.contains(target) || target.contains(dock));
  }

  private captureFiles(files: File[]): void {
    const conv = this.ctx.getCurrentConversation();
    if (!conv) return;
    const existing = this.sessionFiles.get(conv) ?? [];
    const merged = [...existing];
    for (const file of files) {
      if (!merged.some((f) => f.name === file.name && f.size === file.size)) merged.push(file);
    }
    this.sessionFiles.set(conv, merged);
    this.saveMain();
  }

  private async persistMainDraft(): Promise<void> {
    const conv = this.ctx.getCurrentConversation();
    if (!conv) return;
    const text = getComposerText();
    const files = this.sessionFiles.get(conv) ?? [];
    if (!text.trim() && !files.length) {
      // The user emptied the composer themselves (app-side clears are state
      // changes and fire no input event) — the draft is intentionally gone.
      await clearDraft(conv);
      return;
    }

    let mode: DraftMode = "normal";
    let branchTargetUuid: string | undefined;
    let branchParentUuid: string | undefined;
    const target = this.branch.currentTarget();
    if (target) {
      mode = "branch";
      branchTargetUuid = target.targetUuid;
      branchParentUuid = target.parentUuid;
    }

    let hasAttachments = false;
    let attachmentsSkipped = false;
    if (files.length) {
      const total = files.reduce((sum, f) => sum + f.size, 0);
      if (total <= MAX_ATTACHMENT_BYTES) {
        hasAttachments = await saveDraftFiles(
          conv,
          files.map((f) => ({ name: f.name, type: f.type, blob: f }))
        );
      } else {
        attachmentsSkipped = true;
      }
    }

    const draft: DraftRecord = {
      conversationUuid: conv,
      text,
      mode,
      branchTargetUuid,
      branchParentUuid,
      hasAttachments,
      attachmentsSkipped,
      savedAt: Date.now(),
    };
    await saveDraft(draft);
  }

  private async persistNoteDraft(): Promise<void> {
    const conv = this.ctx.getCurrentConversation();
    if (!conv || !this.noteDraft) return;
    if (!this.noteDraft.text.trim()) return;
    const anchor = this.noteDraft.anchor as GutterAnchor & { anchorMessageUuid: string };
    const draft: DraftRecord = {
      conversationUuid: conv,
      text: this.noteDraft.text,
      mode: this.noteDraft.kind,
      anchor,
      savedAt: Date.now(),
    };
    await saveDraft(draft);
  }

  private async clearIfSent(conversationUuid: string): Promise<void> {
    const sentAt = this.lastSendAt.get(conversationUuid);
    if (!sentAt) return;
    const draft = await getDraft(conversationUuid);
    if (draft && draft.savedAt <= sentAt) {
      await clearDraft(conversationUuid);
      this.sessionFiles.delete(conversationUuid);
      if (this.bannerForConversation === conversationUuid) this.removeBanner();
    }
  }

  private async bumpIfLive(): Promise<void> {
    const conv = this.ctx.getCurrentConversation();
    if (!conv) return;
    const draft = await getDraft(conv);
    if (draft && draft.mode === "normal" && getComposerText() === draft.text && draft.text.trim()) {
      draft.savedAt = Date.now();
      await saveDraft(draft);
    }
  }

  /* ------------------------------------------------------------- restore */

  private async offerRestore(conversationUuid: string): Promise<void> {
    const draft = await getDraft(conversationUuid);
    if (!draft) return;
    if (this.ctx.getCurrentConversation() !== conversationUuid) return;
    if (Date.now() - draft.savedAt > DRAFT_TTL_MS) {
      await clearDraft(conversationUuid); // lazy purge of expired drafts
      return;
    }
    await this.bumpIfLive();
    this.showBanner(draft);
  }

  private showBanner(draft: DraftRecord): void {
    this.removeBanner();
    const host = document.createElement("div");
    host.id = "pt-draft-banner";
    const shadow = host.attachShadow({ mode: "open" });
    const firstLine = (draft.text.split("\n").find((l) => l.trim()) ?? "(attachments only)").slice(0, 120);
    const extras: string[] = [];
    if (draft.mode !== "normal") extras.push(draft.mode === "branch" ? "branch draft" : `${draft.mode} draft`);
    if (draft.attachmentsSkipped) extras.push("attachments not saved");
    shadow.innerHTML = `
      <style>
        :host { all: initial; display: block; }
        .banner {
          display: flex; align-items: center; gap: 10px;
          font-family: ${FONT_SANS}; font-size: 12px; line-height: 1.4;
          color: ${cssVar("--text-300")};
          background: ${cssVar("--bg-200", 0.95)};
          border: 1px solid ${cssVar("--border-300")};
          border-radius: ${UI.radiusMd};
          box-shadow: ${UI.shadowSm};
          padding: 6px 8px 6px 12px; margin: 0 0 8px 0;
          overflow: hidden; white-space: nowrap;
          animation: pt-banner-in 160ms ease-out;
        }
        @keyframes pt-banner-in {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .head { font-style: italic; color: ${cssVar("--text-400")}; flex: none; }
        .line { flex: 1; overflow: hidden; text-overflow: ellipsis; color: ${cssVar("--text-200")}; }
        .extras { flex: none; color: ${cssVar("--text-500")}; font-size: 11px; }
        button {
          flex: none; font-family: inherit; font-size: 12px; cursor: pointer;
          border-radius: ${UI.radiusSm}; padding: 4px 12px;
          transition: background ${UI.transition}, color ${UI.transition};
        }
        button:focus-visible { outline: 2px solid ${cssVar("--accent-main-100", 0.6)}; outline-offset: 1px; }
        .restore { border: none; background: ${cssVar("--accent-main-100")}; color: ${cssVar("--oncolor-100")}; font-weight: 500; }
        .restore:hover { background: ${cssVar("--accent-main-200")}; }
        .clear { border: 1px solid ${cssVar("--border-200")}; background: none; color: ${cssVar("--text-300")}; }
        .clear:hover { background: ${cssVar("--bg-300")}; color: ${cssVar("--text-100")}; }
      </style>
      <div class="banner" role="status">
        <span class="head">autosaved message</span>
        <span class="line"></span>
        ${extras.length ? `<span class="extras">(${extras.join(", ")})</span>` : ""}
        <button class="restore" type="button">Restore</button>
        <button class="clear" type="button">Clear</button>
      </div>`;
    shadow.querySelector(".line")!.textContent = firstLine;
    shadow.querySelector(".restore")!.addEventListener("click", () => void this.restore(draft));
    shadow.querySelector(".clear")!.addEventListener("click", () => {
      void clearDraft(draft.conversationUuid);
      this.sessionFiles.delete(draft.conversationUuid);
      this.removeBanner();
    });
    this.bannerHost = host;
    this.bannerForConversation = draft.conversationUuid;
    this.dockBanner();
  }

  private dockBanner(): void {
    if (!this.bannerHost) return;
    const dock = getComposerDock();
    if (dock?.parentElement) dock.parentElement.insertBefore(this.bannerHost, dock);
  }

  private removeBanner(): void {
    this.bannerHost?.remove();
    this.bannerHost = null;
    this.bannerForConversation = null;
  }

  private async restore(draft: DraftRecord): Promise<void> {
    const tree = this.ctx.getTree(draft.conversationUuid);
    this.removeBanner();

    if (draft.mode === "note" || draft.mode === "comment") {
      const anchor = draft.anchor as (GutterAnchor & { anchorMessageUuid: string }) | undefined;
      if (anchor && tree?.nodes.has(anchor.anchorMessageUuid)) {
        this.cards.openComposer(draft.mode, anchor, anchor.quote ?? null, draft.text);
      } else {
        toastOnce(
          "draft-anchor-gone",
          "Prompt Tree: the message this note draft was attached to no longer exists — restored as a normal draft."
        );
        this.restoreText(draft.text);
      }
      return;
    }

    if (draft.mode === "branch") {
      if (draft.branchTargetUuid && tree?.nodes.has(draft.branchTargetUuid)) {
        this.branch.activate(draft.branchTargetUuid);
      } else {
        toastOnce(
          "draft-branch-gone",
          "Prompt Tree: the message this branch draft targeted no longer exists — restored as a normal draft."
        );
      }
    }

    this.restoreText(draft.text);
    if (draft.hasAttachments) {
      const stored = await getDraftFiles(draft.conversationUuid);
      const files = stored.map((f) => new File([f.blob], f.name, { type: f.type }));
      if (!files.length || !attachFilesToComposer(files)) {
        toastOnce(
          "draft-files",
          "Prompt Tree: saved attachments couldn't be reattached automatically — please re-add them."
        );
      }
    }
  }

  private restoreText(text: string): void {
    if (!setComposerText(text)) {
      toastOnce("draft-text", "Prompt Tree: couldn't write into the composer after a claude.ai update.");
    }
  }
}
