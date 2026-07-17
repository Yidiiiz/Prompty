/**
 * shared/messages.ts — the window.postMessage protocol between the page-world
 * script (fetch/history patching) and the isolated-world content script.
 *
 * Every message is wrapped in an envelope carrying a marker key and a source
 * tag; receivers verify `event.origin === location.origin`, that the event
 * came from this window, and that the source tag is the *other* side.
 *
 * Failure behavior: unknown or malformed messages are ignored silently — the
 * protocol is additive, never breaking.
 */

export const ENVELOPE_KEY = "__promptTree";
export const SOURCE_PAGE = "pt-page";
export const SOURCE_CONTENT = "pt-content";

/** Sentinel parent uuid of root-level messages in claude.ai's tree. */
export const ROOT_SENTINEL_UUID = "00000000-0000-4000-8000-000000000000";

export interface TurnMessageUuids {
  human_message_uuid: string;
  assistant_message_uuid: string;
}

/* ------------------------------------------------- page -> content events */

export type PageToContentMessage =
  | { type: "page-ready" }
  | { type: "url-changed"; url: string }
  /** Full conversation JSON as returned by the tree-load endpoint. */
  | { type: "conversation-loaded"; conversation: unknown }
  /** An app-originated completion send left the page (possibly rewritten by us). */
  | {
      type: "send-observed";
      conversationUuid: string;
      parentMessageUuid: string | null;
      prompt: string;
      turnMessageUuids: TurnMessageUuids | null;
      /** true when we rewrote parent_message_uuid for branch-compose */
      rewriteApplied: boolean;
      /** true when the send embedded create_conversation_params (new chat) */
      isNewConversation: boolean;
    }
  /** Streaming text for an app-originated completion (main thread). */
  | { type: "stream-delta"; conversationUuid: string; assistantUuid: string | null; text: string }
  | {
      type: "stream-done";
      conversationUuid: string;
      assistantUuid: string | null;
      text: string;
      stopReason: string | null;
    }
  | { type: "send-failed"; conversationUuid: string; status: number }
  /** The active leaf changed (native arrows, or our own switch). */
  | { type: "leaf-switched"; conversationUuid: string; leafUuid: string }
  /* --- side-branch (note/comment) sends performed by the page script --- */
  | {
      type: "note-send-started";
      noteId: string;
      conversationUuid: string;
      turnMessageUuids: TurnMessageUuids;
    }
  | { type: "note-stream-delta"; noteId: string; text: string }
  | { type: "note-stream-done"; noteId: string; text: string; stopReason: string | null }
  | { type: "note-send-failed"; noteId: string; reason: string }
  | { type: "leaf-switch-failed"; conversationUuid: string; status: number };

/* ------------------------------------------------- content -> page commands */

export type ContentToPageMessage =
  /**
   * Arm/disarm the branch-compose rewrite: the next app-originated completion
   * send for this conversation gets its parent_message_uuid replaced.
   * `parentMessageUuid: null` cancels a pending override.
   */
  | {
      type: "set-parent-override";
      conversationUuid: string;
      parentMessageUuid: string | null;
    }
  /**
   * Send a note/comment as a hidden in-thread message: raw completion POST
   * (never through the app) parented to the current thread tail, stream
   * events back under `noteId`, then refetch the tree.
   */
  | {
      type: "send-side-branch";
      noteId: string;
      conversationUuid: string;
      parentMessageUuid: string;
      prompt: string;
    }
  /**
   * Thread tails differ from what the app believes wherever hidden note
   * messages extended them: any app request referencing `from` (a visible
   * message) as the thread's end — a send's parent_message_uuid or a branch
   * switch's current_leaf_message_uuid — must be rewritten to `to` (the
   * newest note reply under it), so the conversation continues UNDER the
   * notes and leaf switches always point at true leaves (the server rejects
   * a leaf that still has children). Replaces the conversation's whole map;
   * an empty list clears it.
   */
  | {
      type: "set-thread-tails";
      conversationUuid: string;
      tails: Array<{ from: string; to: string }>;
    }
  /** Switch the active leaf via PUT; optionally refetch the tree after. */
  | { type: "switch-leaf"; conversationUuid: string; leafUuid: string; refetchTree: boolean }
  /** Ask the page to refetch and re-emit the conversation tree. */
  | { type: "request-tree"; conversationUuid: string };

export interface Envelope<T> {
  [ENVELOPE_KEY]: true;
  source: typeof SOURCE_PAGE | typeof SOURCE_CONTENT;
  msg: T;
}

export function wrap<T>(source: Envelope<T>["source"], msg: T): Envelope<T> {
  return { [ENVELOPE_KEY]: true, source, msg } as Envelope<T>;
}

/** Returns the inner message if `data` is a valid envelope from `expectedSource`. */
export function unwrap<T>(data: unknown, expectedSource: Envelope<T>["source"]): T | null {
  if (typeof data !== "object" || data === null) return null;
  const env = data as Partial<Envelope<T>>;
  if (env[ENVELOPE_KEY] !== true || env.source !== expectedSource) return null;
  return (env.msg as T) ?? null;
}
