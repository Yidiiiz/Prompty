/**
 * content/index.ts — content-script entry point (isolated world). Owns:
 *
 *  - the ConversationTree registry, updated exclusively from page-script
 *    events (network truth, never DOM scraping);
 *  - SPA-navigation handling (conversation-changed fan-out);
 *  - the single observer tick: DOM-map rebuild + always-on hygiene (hiding
 *    note side-branch messages that render when their branch is active);
 *  - feature lifecycle (settings toggles from the popup, live).
 *
 * Failure behavior: a feature that throws during construction is skipped and
 * reported with a one-time toast; the rest of the extension continues.
 */
import { EventBus, rafThrottle, waitUntil } from "../shared/util";
import { ConversationTree } from "../shared/tree";
import { ROOT_SENTINEL_UUID } from "../shared/messages";
import { getSettings, onSettingsChanged, type Settings } from "../shared/storage";
import { validateSelectors } from "../shared/selectors";
import { validateTokens } from "../shared/tokens";
import { onPageMessage, sendToPage } from "./bridge";
import { startObserver, subscribe, requestTick } from "./observer";
import { installPageStyles } from "./styles";
import { toastOnce } from "./toast";
import { DomMap } from "./dom-map";
import type { BusEvents, Ctx, Feature } from "./ctx";
import { BranchComposeFeature } from "./features/branch-compose";
import { TreePanelFeature } from "./features/tree-panel";
import { NoteCardManager } from "./features/note-cards";
import { NotesFeature } from "./features/notes";
import { CommentsFeature } from "./features/comments";
import { DraftsFeature } from "./features/drafts";

const CONV_URL_RE = /\/chat\/([0-9a-fA-F-]{36})/;

function conversationUuidFromUrl(url: string): string | null {
  const m = CONV_URL_RE.exec(url);
  return m?.[1] ?? null;
}

function main(): void {
  const bus = new EventBus<BusEvents>();
  const domMap = new DomMap();
  const trees = new Map<string, ConversationTree>();
  /** Accumulated streaming text per assistant message uuid. */
  const streamBuffers = new Map<string, string>();
  let currentConversation: string | null = conversationUuidFromUrl(location.href);
  let settings: Settings | null = null;

  const ctx: Ctx = {
    bus,
    domMap,
    getCurrentConversation: () => currentConversation,
    getTree: (uuid?: string) => {
      const key = uuid ?? currentConversation;
      return key ? trees.get(key) ?? null : null;
    },
    sendToPage,
    getSettings: () => settings ?? {
      branchCompose: false,
      treePanel: false,
      notes: false,
      comments: false,
      draftAutosave: false,
    },
  };

  /* -------------------------------------------------- model maintenance */

  const emitTreeUpdated = rafThrottle(() => {
    if (currentConversation) {
      bus.emit("tree-updated", { conversationUuid: currentConversation });
      requestTick();
    }
  });

  /**
   * Hidden in-thread note messages extend the thread past what the app's own
   * state knows. Whenever a tree changes structurally, tell the page script
   * how to remap the app's next send: parent == last visible message → real
   * tail (the newest note reply). Cleared when the leaf is a visible message.
   */
  function syncThreadTail(conversationUuid: string): void {
    const tree = trees.get(conversationUuid);
    if (!tree) return;
    let from: string | null = null;
    let to: string | null = null;
    let node = tree.activeLeafUuid ? tree.nodes.get(tree.activeLeafUuid) : undefined;
    if (node?.isNote) {
      to = node.uuid;
      while (node && node.isNote) node = tree.nodes.get(node.parentUuid);
      from = node?.uuid ?? null;
      if (!from) to = null; // note chain reaches the root: nothing visible to remap
    }
    sendToPage({ type: "set-thread-tail", conversationUuid, fromUuid: from, toUuid: to });
  }

  onPageMessage((msg) => {
    switch (msg.type) {
      case "conversation-loaded": {
        const tree = ConversationTree.fromConversation(msg.conversation);
        if (!tree) return;
        trees.set(tree.conversationUuid, tree);
        syncThreadTail(tree.conversationUuid);
        if (tree.conversationUuid === currentConversation) emitTreeUpdated();
        break;
      }
      case "send-observed": {
        let tree = trees.get(msg.conversationUuid);
        if (!tree && msg.isNewConversation) {
          tree = new ConversationTree(msg.conversationUuid);
          trees.set(msg.conversationUuid, tree);
        }
        if (tree && msg.turnMessageUuids) {
          tree.applySend({
            humanUuid: msg.turnMessageUuids.human_message_uuid,
            assistantUuid: msg.turnMessageUuids.assistant_message_uuid,
            parentUuid: msg.parentMessageUuid ?? ROOT_SENTINEL_UUID,
            prompt: msg.prompt,
          });
          streamBuffers.set(msg.turnMessageUuids.assistant_message_uuid, "");
          syncThreadTail(msg.conversationUuid);
        }
        bus.emit("send-observed", msg);
        if (msg.conversationUuid === currentConversation) emitTreeUpdated();
        break;
      }
      case "stream-delta": {
        if (!msg.assistantUuid) return;
        const buffer = (streamBuffers.get(msg.assistantUuid) ?? "") + msg.text;
        streamBuffers.set(msg.assistantUuid, buffer);
        trees.get(msg.conversationUuid)?.applyAssistantText(msg.assistantUuid, buffer, false);
        if (msg.conversationUuid === currentConversation) emitTreeUpdated();
        break;
      }
      case "stream-done": {
        if (msg.assistantUuid) {
          trees.get(msg.conversationUuid)?.applyAssistantText(msg.assistantUuid, msg.text, true);
          streamBuffers.delete(msg.assistantUuid);
        }
        bus.emit("stream-done", msg);
        if (msg.conversationUuid === currentConversation) emitTreeUpdated();
        break;
      }
      case "send-failed":
        bus.emit("send-failed", msg);
        break;
      case "leaf-switched": {
        trees.get(msg.conversationUuid)?.setLeaf(msg.leafUuid);
        syncThreadTail(msg.conversationUuid);
        bus.emit("leaf-switched", msg);
        if (msg.conversationUuid === currentConversation) emitTreeUpdated();
        break;
      }
      case "leaf-switch-failed":
        bus.emit("leaf-switch-failed", msg);
        break;
      case "url-changed":
        handleNavigation(msg.url);
        break;
      case "note-send-started":
        bus.emit("note-send-started", msg);
        break;
      case "note-stream-delta":
        bus.emit("note-stream-delta", msg);
        break;
      case "note-stream-done":
        bus.emit("note-stream-done", msg);
        break;
      case "note-send-failed":
        bus.emit("note-send-failed", msg);
        break;
      case "page-ready":
        break;
    }
  });

  /* --------------------------------------------------------- navigation */

  const features: Feature[] = [];

  function handleNavigation(url: string): void {
    const conv = conversationUuidFromUrl(url);
    if (conv === currentConversation) return;
    currentConversation = conv;
    // The app may have loaded the tree before we attached (or from cache);
    // ask the page for a fresh copy whenever we land on a conversation.
    if (conv && !trees.has(conv)) sendToPage({ type: "request-tree", conversationUuid: conv });
    bus.emit("conversation-changed", { conversationUuid: conv });
    for (const feature of features) feature.onConversation(conv);
    requestTick();
    validateWhenReady(); // first conversation of the session validates hooks
  }

  // The app also navigates from /new to /chat/{uuid} on first send without
  // our content script seeing an initial URL for it; send-observed covers the
  // model, and url-changed (history patch) covers the navigation.

  /* ------------------------------------------------------ observer tick */

  subscribe(() => {
    installPageStyles(); // idempotent; survives site style purges
    const tree = ctx.getTree();
    domMap.rebuild(tree);
    // Always-on hygiene: note pairs rendered by the app (after a reload) must
    // never show in the chat. Two independent signals decide hiding:
    //  1. the model — rows mapped to isNote nodes;
    //  2. the DOM itself — a human row whose message body starts with the
    //     note marker, plus the assistant row right after it (safety net for
    //     any alignment failure).
    const rows = domMap.rows;
    const markerHidden = new Set<number>();
    for (let i = 0; i < rows.length; i++) {
      if (DomMap.isNoteRow(rows[i]!)) {
        markerHidden.add(i);
        if (rows[i + 1]?.sender === "assistant") markerHidden.add(i + 1);
      }
    }
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const shouldHide =
        markerHidden.has(i) || (!!tree && !!row.uuid && !!tree.nodes.get(row.uuid)?.isNote);
      if (row.el.classList.contains("pt-note-hidden") !== shouldHide) {
        row.el.classList.toggle("pt-note-hidden", shouldHide);
      }
    }
  });

  /* ----------------------------------------------------------- features */

  void (async () => {
    settings = await getSettings();
    // Construction order matters: drafts needs branch-compose (mode capture)
    // and the card manager (note-composer reopen); notes/comments share the
    // card manager. A constructor failure skips that feature only.
    let branchFeature: BranchComposeFeature | null = null;
    let cardManager: NoteCardManager | null = null;
    const constructors: Array<() => Feature | null> = [
      () => (branchFeature = new BranchComposeFeature(ctx)),
      () => new TreePanelFeature(ctx),
      () => {
        cardManager = new NoteCardManager(ctx);
        return new NotesFeature(ctx, cardManager);
      },
      () => (cardManager ? new CommentsFeature(ctx, cardManager) : null),
      () => (branchFeature && cardManager ? new DraftsFeature(ctx, branchFeature, cardManager) : null),
    ];
    for (const make of constructors) {
      try {
        const feature = make();
        if (feature) features.push(feature);
      } catch (err) {
        console.error("[prompt-tree] feature failed to construct", err);
        toastOnce("feature-construct", "Prompt Tree: a feature failed to start after a claude.ai update.");
      }
    }
    const applySettings = (s: Settings) => {
      settings = s;
      for (const feature of features) feature.setEnabled(s[feature.id]);
      bus.emit("settings-changed", s);
    };
    applySettings(settings);
    onSettingsChanged(applySettings);

    for (const feature of features) feature.onConversation(currentConversation);
    if (currentConversation) {
      sendToPage({ type: "request-tree", conversationUuid: currentConversation });
    }

    startObserver();
    requestTick();
    validateTokens();
    validateWhenReady();
  })();

  /* ------------------------------------------------- selector validation */

  // Selector hooks only exist once a conversation has actually rendered — a
  // restored/unloaded tab needs seconds before rows mount, and validating too
  // early produced false "hooks not found (userMessage)" warnings. Validate
  // once, after the first conversation renders (or honestly times out).
  let selectorsValidated = false;
  function validateWhenReady(): void {
    if (selectorsValidated || !currentConversation) return;
    selectorsValidated = true;
    void (async () => {
      await waitUntil(() => domMap.rows.length > 0, 8000);
      const report = validateSelectors();
      if (report.failed.length) {
        toastOnce(
          "selectors-failed",
          `Prompt Tree: some page hooks were not found (${report.failed.join(", ")}) — features relying on them are limited until updated.`
        );
      }
    })();
  }
}

try {
  main();
} catch (err) {
  console.error("[prompt-tree] content script failed to initialize", err);
}
