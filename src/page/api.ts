/**
 * page/api.ts — extension-originated requests against claude.ai's internal
 * API, always via the saved original fetch (so our own traffic is never
 * re-intercepted and never routed through the app).
 *
 * Authentication is same-origin cookies attached automatically by the
 * browser; this module never reads, stores, or transmits session tokens.
 *
 * Covers: tree refetch, leaf switching (PUT), and note/comment side-branch
 * sends. Side-branch payloads are cloned from the last observed app send for
 * the conversation when available (maximum shape fidelity), else built
 * minimally from confirmed-required fields.
 *
 * Failure behavior: every operation reports failure to the content script via
 * bridge events; nothing here throws into the page.
 */
import {
  originalFetch,
  getOrgUuid,
  getSendTemplate,
  getModel,
  noteConversationJson,
} from "./fetch-patch";
import { parseSseStream } from "./sse";
import { postToContent } from "./bridge";
import { uuidv7 } from "../shared/uuid";
import type { TurnMessageUuids } from "../shared/messages";

const TREE_QUERY = "?tree=True&rendering_mode=messages&render_all_tools=true&consistency=strong";

function conversationBase(conversationUuid: string): string | null {
  const org = getOrgUuid();
  if (!org) return null;
  return `${location.origin}/api/organizations/${org}/chat_conversations/${conversationUuid}`;
}

/** Refetches the conversation tree and re-emits `conversation-loaded`. */
export async function fetchTree(conversationUuid: string): Promise<boolean> {
  const base = conversationBase(conversationUuid);
  if (!base) return false;
  try {
    const res = await originalFetch(base + TREE_QUERY, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return false;
    const json: unknown = await res.json();
    noteConversationJson(json);
    postToContent({ type: "conversation-loaded", conversation: json });
    return true;
  } catch (err) {
    console.warn("[prompt-tree] tree refetch failed", err);
    return false;
  }
}

/** PUTs the active leaf. Mirrors the native branch-switch request exactly. */
export async function putLeaf(conversationUuid: string, leafUuid: string): Promise<boolean> {
  const base = conversationBase(conversationUuid);
  if (!base) return false;
  try {
    const res = await originalFetch(`${base}/current_leaf_message_uuid`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ current_leaf_message_uuid: leafUuid }),
    });
    if (res.ok) {
      postToContent({ type: "leaf-switched", conversationUuid, leafUuid });
      return true;
    }
    postToContent({ type: "leaf-switch-failed", conversationUuid, status: res.status });
    return false;
  } catch (err) {
    console.warn("[prompt-tree] leaf switch failed", err);
    postToContent({ type: "leaf-switch-failed", conversationUuid, status: 0 });
    return false;
  }
}

/** Handles a `switch-leaf` command from the content script. */
export async function switchLeaf(
  conversationUuid: string,
  leafUuid: string,
  refetchTree: boolean
): Promise<void> {
  const ok = await putLeaf(conversationUuid, leafUuid);
  if (ok && refetchTree) await fetchTree(conversationUuid);
}

/* -------------------------------------------------- side-branch (notes) */

function buildSideBranchPayload(
  conversationUuid: string,
  parentMessageUuid: string,
  prompt: string,
  turnUuids: TurnMessageUuids
): Record<string, unknown> | null {
  const template = getSendTemplate(conversationUuid);
  let payload: Record<string, unknown>;
  if (template) {
    payload = structuredClone(template);
    delete payload["create_conversation_params"];
  } else {
    const model = getModel(conversationUuid);
    if (!model) return null; // no template and no model: cannot build an honest payload
    payload = {
      model,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale: navigator.language || "en-US",
      tools: [],
      rendering_mode: "messages",
    };
  }
  payload["prompt"] = prompt;
  payload["parent_message_uuid"] = parentMessageUuid;
  payload["turn_message_uuids"] = turnUuids;
  // A note never carries the composer's attachments.
  payload["attachments"] = [];
  payload["files"] = [];
  payload["sync_sources"] = [];
  return payload;
}

/**
 * Sends a note/comment as a side branch and streams the reply back under
 * `noteId`. Afterwards restores the main leaf and refetches the tree so the
 * ConversationTree model includes the new branch.
 */
export async function sendSideBranch(cmd: {
  noteId: string;
  conversationUuid: string;
  parentMessageUuid: string;
  prompt: string;
  restoreLeafUuid: string | null;
}): Promise<void> {
  const fail = (reason: string) =>
    postToContent({ type: "note-send-failed", noteId: cmd.noteId, reason });

  const base = conversationBase(cmd.conversationUuid);
  if (!base) {
    fail("organization uuid not yet observed — open or reload a conversation first");
    return;
  }
  const turnUuids: TurnMessageUuids = {
    human_message_uuid: uuidv7(),
    assistant_message_uuid: uuidv7(),
  };
  const payload = buildSideBranchPayload(
    cmd.conversationUuid,
    cmd.parentMessageUuid,
    cmd.prompt,
    turnUuids
  );
  if (!payload) {
    fail("no send template or model known for this conversation — send one normal message first or reload");
    return;
  }

  // The message uuids are client-generated and adopted by the server, so the
  // content script can write anchoring metadata immediately.
  postToContent({
    type: "note-send-started",
    noteId: cmd.noteId,
    conversationUuid: cmd.conversationUuid,
    turnMessageUuids: turnUuids,
  });

  let result: { text: string; stopReason: string | null; ok: boolean };
  try {
    const res = await originalFetch(`${base}/completion`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      fail(`send rejected (HTTP ${res.status})`);
      return;
    }
    result = await parseSseStream(res.body, {
      onTextDelta: (text) => postToContent({ type: "note-stream-delta", noteId: cmd.noteId, text }),
    });
  } catch (err) {
    console.warn("[prompt-tree] side-branch send failed", err);
    fail("network error during note send");
    return;
  }

  // Restore the main thread's active leaf so the next normal message
  // continues the main conversation, then sync the model.
  if (cmd.restoreLeafUuid) await putLeaf(cmd.conversationUuid, cmd.restoreLeafUuid);
  await fetchTree(cmd.conversationUuid);

  if (result.ok) {
    postToContent({
      type: "note-stream-done",
      noteId: cmd.noteId,
      text: result.text,
      stopReason: result.stopReason,
    });
  } else {
    fail("response stream ended unexpectedly");
  }
}
