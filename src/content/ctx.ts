/**
 * content/ctx.ts — the shared context handed to every feature: typed event
 * bus, the ConversationTree registry accessor, the DOM map, settings, and the
 * channel to the page script. Also defines the Feature contract.
 *
 * Failure behavior: none of its own; it is glue.
 */
import type { EventBus } from "../shared/util";
import type { ConversationTree } from "../shared/tree";
import type { ContentToPageMessage, TurnMessageUuids } from "../shared/messages";
import type { Settings } from "../shared/storage";
import type { DomMap } from "./dom-map";

export interface BusEvents {
  /** The model for a conversation changed (structure, text, or active leaf). */
  "tree-updated": { conversationUuid: string };
  /** The user navigated to a different conversation (or off conversations). */
  "conversation-changed": { conversationUuid: string | null };
  "send-observed": {
    conversationUuid: string;
    parentMessageUuid: string | null;
    prompt: string;
    turnMessageUuids: TurnMessageUuids | null;
    rewriteApplied: boolean;
    isNewConversation: boolean;
  };
  "send-failed": { conversationUuid: string; status: number };
  "stream-done": {
    conversationUuid: string;
    assistantUuid: string | null;
    text: string;
    stopReason: string | null;
  };
  "leaf-switched": { conversationUuid: string; leafUuid: string };
  /** Branch-compose entered (targetUuid set) or exited (null). */
  "branch-mode-changed": { conversationUuid: string; targetUuid: string | null };
  "leaf-switch-failed": { conversationUuid: string; status: number };
  "note-send-started": {
    noteId: string;
    conversationUuid: string;
    turnMessageUuids: TurnMessageUuids;
  };
  "note-stream-delta": { noteId: string; text: string };
  "note-stream-done": { noteId: string; text: string; stopReason: string | null };
  "note-send-failed": { noteId: string; reason: string };
  "settings-changed": Settings;
  /** Drawer feed: unanchored notes plus soft-deleted (restorable) notes. */
  "unanchored-notes": {
    conversationUuid: string;
    items: Array<{ noteId: string; label: string }>;
    deletedItems: Array<{ noteId: string; label: string }>;
  };
  /** Panel drawer click-through: ask the notes feature to open this note. */
  "unanchored-note-open": { noteId: string };
  /** Panel drawer click-through: restore a soft-deleted note. */
  "deleted-note-restore": { noteId: string };
  /** Note/comment composer text changed (draft autosave listens). */
  "note-composer-input": {
    conversationUuid: string;
    kind: "note" | "comment";
    anchor: Record<string, unknown> & { anchorMessageUuid: string };
    text: string;
  };
  /** Note/comment composer closed or submitted (draft cleared). */
  "note-composer-closed": { conversationUuid: string };
}

export interface Ctx {
  bus: EventBus<BusEvents>;
  domMap: DomMap;
  getCurrentConversation(): string | null;
  /** Tree for the given (default: current) conversation, if known. */
  getTree(conversationUuid?: string): ConversationTree | null;
  sendToPage(msg: ContentToPageMessage): void;
  getSettings(): Settings;
}

export interface Feature {
  /** Matches the Settings key that toggles this feature. */
  readonly id: keyof Settings;
  /** Idempotent on/off. Off must remove all UI and listeners' effects. */
  setEnabled(on: boolean): void;
  /** Called on SPA navigation with the new conversation uuid (or null). */
  onConversation(conversationUuid: string | null): void;
}

/**
 * Resolves when `predicate` first passes on a bus event, or with null after
 * `timeoutMs`. The timeout is a failure guard (the awaited network event may
 * never come), not a scheduling mechanism.
 */
export function waitForBusEvent<K extends keyof BusEvents>(
  bus: EventBus<BusEvents>,
  event: K,
  predicate: (payload: BusEvents[K]) => boolean,
  timeoutMs: number
): Promise<BusEvents[K] | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: BusEvents[K] | null) => {
      if (done) return;
      done = true;
      off();
      clearTimeout(guard);
      resolve(value);
    };
    const off = bus.on(event, (payload) => {
      if (predicate(payload)) finish(payload);
    });
    const guard = setTimeout(() => finish(null), timeoutMs);
  });
}
